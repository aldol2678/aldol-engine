// Star Tactics (M5 candidate) — turn-based squad tactics on the shared
// ENGINE-NEXT-01 core. This file holds only the game's rules; entities,
// grid queries, AI state machine, damage, quests, saves and the fixed-step
// runtime all come from src/core/next/.
//
// Turn model on the fixed 1/60 s tick:
//   phase "player": every input frame may carry one command per kind
//     { move: { unit, c, r } }      1 AP per cell along the BFS path
//     { attack: { unit, target } }  class attack (range, optional LOS)
//     { skill: { unit, target } }   class skill (strike or heal, cooldown in turns)
//     { endTurn: true }
//   phase "enemy": no input is read. Every `enemyActionTicks` ticks the
//     next enemy performs one action chosen by its FSM (hold / advance /
//     attack / retreat). When all enemies are done the next player turn
//     starts and player AP is refilled.
//   phase "won" / "lost": terminal (the page restarts with a new session).
// Illegal commands (wrong phase, not enough AP, out of range, blocked line
// of sight, dead or unknown unit, malformed data) are ignored.
// All map, unit and balance data comes from world.json (rule game.tactics).
// Determinism: the only randomness is ctx.rng (damage rolls).

import { createEcs, createEcsState, validateEcsState } from "../../src/core/next/ecs.js";
import { defineGame } from "../../src/core/next/runtime.js";
import { createGrid, floodFill, findPath, lineOfSight, manhattan, isBlocked, DIRS4 } from "../../src/core/next/spatial.js";
import { defineFsm, createFsmState, updateFsm, isValidFsmState } from "../../src/core/next/fsm.js";
import { createHealth, applyDamage, heal, rollDamage, createCooldown, cooldownReady, triggerCooldown } from "../../src/core/next/combat.js";
import { createQuestLog, updateQuests, isValidQuestLog } from "../../src/core/next/quest.js";
import { saveKey } from "../../src/core/next/save.js";
import { loadGameWorld, parseTileRows } from "../../src/core/next/manifest.js";

export const GAME_ID = "star-tactics";
export const SEED = "star-tactics-m5";
export const RULE_TYPE = "game.tactics";
export const SAVE_KEY = saveKey(GAME_ID, "m5");

const TEAMS = ["player", "enemy"];
const PHASES = ["player", "enemy", "won", "lost"];
const isInt = Number.isInteger;

const components = {
  Unit: {
    defaults: { team: "player", cls: "", name: "", src: "", c: 0, r: 0, ap: 0, hurt: false },
    validate: (d) => (TEAMS.includes(d.team) && typeof d.cls === "string" && d.cls && isInt(d.c) && isInt(d.r) && isInt(d.ap) && d.ap >= 0 && typeof d.hurt === "boolean" ? null : "bad unit"),
  },
  Health: { validate: (d) => (isInt(d.hp) && isInt(d.max) && d.max > 0 && d.hp >= 0 && d.hp <= d.max ? null : "bad health") },
  Skill: { defaults: { readyAt: 0 }, validate: (d) => (isInt(d.readyAt) && d.readyAt >= 0 ? null : "bad cooldown") },
  Ai: { validate: (d) => (typeof d.state === "string" && isInt(d.since) ? null : "bad ai state") },
};
const ecs = createEcs({ components });

// Enemy AI. ctx = { seesPlayer, hurt, alerted, lowHp, hasTarget, cornered }.
export const ENEMY_FSM = defineFsm({
  id: "tactics-enemy",
  initial: "hold",
  states: {
    hold: { transitions: [{ to: "advance", when: (c) => c.seesPlayer || c.hurt || c.alerted }] },
    advance: { transitions: [{ to: "retreat", when: (c) => c.lowHp }, { to: "attack", when: (c) => c.hasTarget }] },
    attack: { transitions: [{ to: "retreat", when: (c) => c.lowHp && !c.cornered }, { to: "advance", when: (c) => !c.hasTarget }] },
    retreat: { transitions: [{ to: "attack", when: (c) => c.cornered && c.hasTarget }] },
  },
});

// ---------------------------------------------------------------- world
function checkStrike(spec, where) {
  if (!spec || !isInt(spec.range) || spec.range < 1 || !isInt(spec.base) || spec.base < 0 || !isInt(spec.cost) || spec.cost < 1) throw new Error(`star-tactics: bad ${where}`);
  if (!isInt(spec.variance ?? 0) || (spec.variance ?? 0) < 0 || !((spec.critChance ?? 0) >= 0 && (spec.critChance ?? 0) <= 1)) throw new Error(`star-tactics: bad ${where} roll`);
}
function checkClass(id, cls) {
  if (!cls || !isInt(cls.hp) || cls.hp < 1 || !isInt(cls.ap) || cls.ap < 1 || !isInt(cls.armor ?? 0) || (cls.armor ?? 0) < 0) throw new Error(`star-tactics: bad class ${id}`);
  checkStrike(cls.attack, `class ${id} attack`);
  if (cls.skill) {
    if (!isInt(cls.skill.cooldownTurns) || cls.skill.cooldownTurns < 0) throw new Error(`star-tactics: bad class ${id} skill cooldown`);
    if (cls.skill.kind === "strike") checkStrike(cls.skill, `class ${id} skill`);
    else if (cls.skill.kind === "heal") {
      if (!isInt(cls.skill.range) || cls.skill.range < 0 || !isInt(cls.skill.amount) || cls.skill.amount < 1 || !isInt(cls.skill.cost) || cls.skill.cost < 1) throw new Error(`star-tactics: bad class ${id} heal`);
    } else throw new Error(`star-tactics: class ${id} has unknown skill kind "${cls.skill.kind}"`);
  }
}

// Manifest -> world: shared adapter + per-mission grid and unit list.
// Unit entities carry components["game.unit"] = { mission, team, class };
// their transform position [c, 0, r] is the starting cell.
export function loadWorld(manifest) {
  const base = loadGameWorld(manifest, { ruleType: RULE_TYPE, projectId: GAME_ID });
  const cfg = base.config;
  if (!isInt(cfg.enemyActionTicks) || cfg.enemyActionTicks < 1 || !isInt(cfg.phaseDelayTicks) || cfg.phaseDelayTicks < 0) throw new Error("star-tactics: bad timing config");
  if (!cfg.ai || !isInt(cfg.ai.alertTurn) || !(cfg.ai.retreatHpRatio >= 0 && cfg.ai.retreatHpRatio <= 1)) throw new Error("star-tactics: bad ai config");
  if (!cfg.classes || typeof cfg.classes !== "object") throw new Error("star-tactics: classes missing");
  for (const id of Object.keys(cfg.classes)) checkClass(id, cfg.classes[id]);
  if (!Array.isArray(cfg.missions) || cfg.missions.length === 0) throw new Error("star-tactics: no missions");
  const seenMission = new Set();
  const missions = cfg.missions.map((m) => {
    if (typeof m.id !== "string" || seenMission.has(m.id)) throw new Error(`star-tactics: bad or duplicate mission id ${m.id}`);
    seenMission.add(m.id);
    const tiles = parseTileRows(m.rows);
    const grid = createGrid({ cols: tiles.cols, rows: tiles.rows, blocked: tiles.blocked });
    const taken = new Set();
    const units = base.entities
      .filter((e) => e.components["game.unit"] && e.components["game.unit"].mission === m.id)
      .map((e) => {
        const u = e.components["game.unit"];
        if (!TEAMS.includes(u.team)) throw new Error(`star-tactics: unit ${e.id} has bad team`);
        if (!cfg.classes[u.class]) throw new Error(`star-tactics: unit ${e.id} has unknown class "${u.class}"`);
        if (!isInt(e.x) || !isInt(e.z) || isBlocked(grid, e.x, e.z)) throw new Error(`star-tactics: unit ${e.id} starts on a wall or outside the map`);
        const key = `${e.x},${e.z}`;
        if (taken.has(key)) throw new Error(`star-tactics: two units start on ${key}`);
        taken.add(key);
        return { src: e.id, name: e.name, team: u.team, cls: u.class, c: e.x, r: e.z };
      });
    // Players first, then enemies; manifest order inside a team. Entity ids
    // (and so turn order and tie-breaks) follow this order.
    const ordered = [...units.filter((u) => u.team === "player"), ...units.filter((u) => u.team === "enemy")];
    if (!ordered.some((u) => u.team === "player") || !ordered.some((u) => u.team === "enemy")) throw new Error(`star-tactics: mission ${m.id} needs both teams`);
    return { id: m.id, name: m.name || m.id, cols: tiles.cols, rows: tiles.rows, grid, walls: tiles.blocked.map(([c, r]) => ({ c, r })), units: ordered };
  });
  return { ...base, missions, classes: cfg.classes, ai: cfg.ai, enemyActionTicks: cfg.enemyActionTicks, phaseDelayTicks: cfg.phaseDelayTicks };
}

// ---------------------------------------------------------------- helpers
function spawnMission(state, world) {
  for (const id of ecs.ids()) ecs.despawn(id);
  const mission = world.missions[state.mission];
  for (const u of mission.units) {
    const cls = world.classes[u.cls];
    const comps = {
      Unit: { team: u.team, cls: u.cls, name: u.name, src: u.src, c: u.c, r: u.r, ap: cls.ap, hurt: false },
      Health: createHealth(cls.hp),
    };
    if (cls.skill) comps.Skill = createCooldown();
    if (u.team === "enemy") comps.Ai = createFsmState(ENEMY_FSM, 0);
    ecs.spawn(comps);
  }
  state.turn = 1;
  state.phase = "player";
  state.enemyQueue = [];
  state.nextActAt = 0;
}
function unitAt(c, r) {
  return ecs.find(["Unit"], (id, u) => u.c === c && u.r === r);
}
function teamIds(team) {
  return ecs.query("Unit").filter((id) => ecs.get(id, "Unit").team === team);
}
function canReach(grid, from, to, spec) {
  return manhattan(from, to) <= spec.range && (!spec.los || lineOfSight(grid, from, to));
}
function nearestOf(ids, from) {
  let best = null;
  let bestD = Infinity;
  for (const id of ids) {
    const d = manhattan(from, ecs.get(id, "Unit"));
    if (d < bestD) { bestD = d; best = id; }
  }
  return best === null ? null : { id: best, distance: bestD };
}
// Lowest hp first, then lowest id — the same rule for bots, AI and tests.
function weakest(ids) {
  let best = null;
  for (const id of ids) {
    if (best === null || ecs.get(id, "Health").hp < ecs.get(best, "Health").hp) best = id;
  }
  return best;
}

// Public read helpers (page, bot, tests). They bind the shared ECS to the
// given state first, so they work on a probe copy of the state as well.
export function missionOf(state, world) { return world.missions[state.mission]; }
export function listUnits(state) {
  ecs.bind(state.ecs);
  return ecs.query("Unit").map((id) => {
    const u = ecs.get(id, "Unit");
    const h = ecs.get(id, "Health");
    const sk = ecs.get(id, "Skill");
    const ai = ecs.get(id, "Ai");
    return { id, team: u.team, cls: u.cls, name: u.name, c: u.c, r: u.r, ap: u.ap, hp: h.hp, max: h.max, skillReadyAt: sk ? sk.readyAt : null, ai: ai ? ai.state : null };
  });
}
// Cells the unit can walk to with its current AP: [{ c, r, cost }].
export function reachableCells(state, world, unitId) {
  ecs.bind(state.ecs);
  const u = ecs.isAlive(unitId) ? ecs.get(unitId, "Unit") : null;
  if (!u || u.ap <= 0) return [];
  return floodFill(missionOf(state, world).grid, u, { maxCost: u.ap, isOccupied: (c, r) => unitAt(c, r) !== null })
    .slice(1).map((n) => ({ c: n.c, r: n.r, cost: n.cost }));
}
// Enemy-team ids the unit could attack from `from` (default: where it stands).
export function attackTargets(state, world, unitId, from = null) {
  ecs.bind(state.ecs);
  const u = ecs.isAlive(unitId) ? ecs.get(unitId, "Unit") : null;
  if (!u) return [];
  const spec = world.classes[u.cls].attack;
  const grid = missionOf(state, world).grid;
  return teamIds(u.team === "player" ? "enemy" : "player").filter((id) => canReach(grid, from || u, ecs.get(id, "Unit"), spec));
}
// Valid skill targets: enemies for a strike, wounded allies (and self) for a heal.
export function skillTargets(state, world, unitId, from = null) {
  ecs.bind(state.ecs);
  const u = ecs.isAlive(unitId) ? ecs.get(unitId, "Unit") : null;
  if (!u) return [];
  const spec = world.classes[u.cls].skill;
  if (!spec) return [];
  const grid = missionOf(state, world).grid;
  if (spec.kind === "heal") {
    return teamIds(u.team).filter((id) => {
      const h = ecs.get(id, "Health");
      return h.hp < h.max && canReach(grid, from || u, id === unitId ? (from || u) : ecs.get(id, "Unit"), spec);
    });
  }
  return teamIds(u.team === "player" ? "enemy" : "player").filter((id) => canReach(grid, from || u, ecs.get(id, "Unit"), spec));
}
export function skillReady(state, unitId) {
  ecs.bind(state.ecs);
  const sk = ecs.isAlive(unitId) ? ecs.get(unitId, "Skill") : null;
  return !!sk && cooldownReady(sk, state.turn);
}

// ---------------------------------------------------------------- actions
function strike(state, world, rng, attackerId, targetId, spec) {
  const target = ecs.get(targetId, "Unit");
  const health = ecs.get(targetId, "Health");
  const roll = rollDamage(rng, spec);
  const res = applyDamage(health, roll.amount, { armor: world.classes[target.cls].armor ?? 0 });
  target.hurt = true;
  ecs.emit("hit", { attacker: attackerId, target: targetId, team: target.team, dealt: res.dealt, crit: roll.crit, c: target.c, r: target.r });
  if (res.killed) {
    ecs.emit("defeat", { id: targetId, team: target.team, name: target.name });
    if (target.team === "enemy") state.stats.defeated += 1;
    else state.stats.fallen += 1;
    ecs.despawn(targetId);
  }
}
function settle(state, world) {
  if (teamIds("player").length === 0) {
    state.phase = "lost";
    state.enemyQueue = [];
    ecs.emit("lost", { mission: state.mission, turn: state.turn });
  } else if (teamIds("enemy").length === 0) {
    state.stats.missionsCleared += 1;
    ecs.emit("missionClear", { mission: state.mission, turn: state.turn });
    if (state.mission + 1 < world.missions.length) {
      state.mission += 1;
      spawnMission(state, world);
      ecs.emit("turnStart", { turn: state.turn, mission: state.mission });
    } else {
      state.phase = "won";
      state.enemyQueue = [];
      ecs.emit("won", { turn: state.turn });
    }
  }
}
function ownUnit(id) {
  if (!isInt(id) || !ecs.isAlive(id)) return null;
  const u = ecs.get(id, "Unit");
  return u && u.team === "player" ? u : null;
}

function playerCommands(state, rawInput, rng, world, tick) {
  const mission = missionOf(state, world);
  const grid = mission.grid;
  // Own properties only: a command must be on the input frame itself.
  const input = {};
  for (const key of ["move", "attack", "skill", "endTurn"]) {
    if (Object.prototype.hasOwnProperty.call(rawInput, key)) input[key] = rawInput[key];
  }
  const mv = input.move;
  if (mv && typeof mv === "object" && isInt(mv.c) && isInt(mv.r)) {
    const u = ownUnit(mv.unit);
    if (u && u.ap > 0 && !isBlocked(grid, mv.c, mv.r) && unitAt(mv.c, mv.r) === null) {
      const path = findPath(grid, u, { c: mv.c, r: mv.r }, { maxCost: u.ap, isOccupied: (c, r) => unitAt(c, r) !== null });
      if (path && path.length > 0) {
        u.ap -= path.length;
        u.c = mv.c;
        u.r = mv.r;
        state.stats.moves += 1;
        ecs.emit("move", { id: mv.unit, c: u.c, r: u.r, steps: path.length });
      }
    }
  }
  const at = input.attack;
  if (state.phase === "player" && at && typeof at === "object") {
    const u = ownUnit(at.unit);
    if (u && isInt(at.target) && ecs.isAlive(at.target)) {
      const spec = world.classes[u.cls].attack;
      const t = ecs.get(at.target, "Unit");
      if (t.team === "enemy" && u.ap >= spec.cost && canReach(grid, u, t, spec)) {
        u.ap -= spec.cost;
        strike(state, world, rng, at.unit, at.target, spec);
        settle(state, world);
      }
    }
  }
  const sk = input.skill;
  if (state.phase === "player" && sk && typeof sk === "object") {
    const u = ownUnit(sk.unit);
    const cd = u ? ecs.get(sk.unit, "Skill") : null;
    const spec = u ? world.classes[u.cls].skill : null;
    if (u && cd && spec && isInt(sk.target) && ecs.isAlive(sk.target) && u.ap >= spec.cost && cooldownReady(cd, state.turn)) {
      const t = ecs.get(sk.target, "Unit");
      const th = ecs.get(sk.target, "Health");
      if (spec.kind === "heal" && t.team === "player" && th.hp < th.max && canReach(grid, u, t, spec)) {
        triggerCooldown(cd, state.turn, spec.cooldownTurns);
        u.ap -= spec.cost;
        const healed = heal(th, spec.amount);
        state.stats.healed += healed;
        ecs.emit("heal", { healer: sk.unit, target: sk.target, healed, c: t.c, r: t.r });
      } else if (spec.kind === "strike" && t.team === "enemy" && canReach(grid, u, t, spec)) {
        triggerCooldown(cd, state.turn, spec.cooldownTurns);
        u.ap -= spec.cost;
        strike(state, world, rng, sk.unit, sk.target, spec);
        settle(state, world);
      }
    }
  }
  if (state.phase === "player" && input.endTurn === true) {
    state.phase = "enemy";
    state.enemyQueue = teamIds("enemy");
    for (const id of state.enemyQueue) ecs.get(id, "Unit").ap = world.classes[ecs.get(id, "Unit").cls].ap;
    state.nextActAt = tick + world.phaseDelayTicks;
    ecs.emit("enemyPhase", { turn: state.turn });
  }
}

function startPlayerTurn(state, world) {
  state.turn += 1;
  state.stats.turns += 1;
  state.phase = "player";
  state.enemyQueue = [];
  for (const id of teamIds("player")) ecs.get(id, "Unit").ap = world.classes[ecs.get(id, "Unit").cls].ap;
  ecs.emit("turnStart", { turn: state.turn, mission: state.mission });
}

// Facts the enemy FSM decides on. Exported for tests.
export function enemyContext(state, world, id) {
  ecs.bind(state.ecs);
  const u = ecs.get(id, "Unit");
  const h = ecs.get(id, "Health");
  const cls = world.classes[u.cls];
  const grid = missionOf(state, world).grid;
  const players = teamIds("player");
  const near = nearestOf(players, u);
  const dist = near ? near.distance : Infinity;
  const cornered = !DIRS4.some((d) => {
    const c = u.c + d.dc;
    const r = u.r + d.dr;
    if (isBlocked(grid, c, r) || unitAt(c, r) !== null) return false;
    const n = nearestOf(players, { c, r });
    return n !== null && n.distance > dist;
  });
  return {
    seesPlayer: dist <= (cls.sight ?? 0),
    hurt: u.hurt,
    alerted: state.turn >= world.ai.alertTurn,
    lowHp: !!cls.retreats && h.hp <= h.max * world.ai.retreatHpRatio,
    hasTarget: players.some((p) => canReach(grid, u, ecs.get(p, "Unit"), cls.attack)),
    cornered,
    nearest: near,
  };
}

// One enemy action. Returns true when something visible happened (so the
// phase waits enemyActionTicks before the next one).
function enemyAct(state, world, rng, id, tick) {
  const u = ecs.get(id, "Unit");
  const ai = ecs.get(id, "Ai");
  // The FSM moves one transition per update. When the new state has nothing
  // to do right now (e.g. "advance" while already next to a target) it is
  // updated again, at most twice more, so an enemy does not waste its turn.
  for (let pass = 0; pass < 3; pass++) {
    const ctx = enemyContext(state, world, id);
    const change = updateFsm(ENEMY_FSM, ai, ctx, tick);
    if (change.changed) ecs.emit("ai", { id, from: change.from, to: change.to });
    if (enemyTryAct(state, world, rng, id, ctx, ai.state)) return true;
    if (!change.changed) break;
  }
  u.ap = 0; // nothing useful left to do this turn
  return false;
}
function enemyTryAct(state, world, rng, id, ctx, mode) {
  const u = ecs.get(id, "Unit");
  const cls = world.classes[u.cls];
  const grid = missionOf(state, world).grid;
  const players = teamIds("player");
  if (mode === "attack") {
    const targets = players.filter((p) => canReach(grid, u, ecs.get(p, "Unit"), cls.attack));
    if (targets.length > 0 && u.ap >= cls.attack.cost) {
      u.ap -= cls.attack.cost;
      strike(state, world, rng, id, weakest(targets), cls.attack);
      settle(state, world);
      return true;
    }
  } else if (mode === "advance" && ctx.nearest && u.ap >= 1) {
    const goal = ecs.get(ctx.nearest.id, "Unit");
    const path = findPath(grid, u, goal, { isOccupied: (c, r) => unitAt(c, r) !== null, allowOccupiedGoal: true });
    if (path && path.length > 1) {
      u.ap -= 1;
      u.c = path[0].c;
      u.r = path[0].r;
      ecs.emit("move", { id, c: u.c, r: u.r, steps: 1 });
      return true;
    }
  } else if (mode === "retreat" && ctx.nearest && u.ap >= 1) {
    let best = null;
    let bestD = ctx.nearest.distance;
    for (const d of DIRS4) {
      const c = u.c + d.dc;
      const r = u.r + d.dr;
      if (isBlocked(grid, c, r) || unitAt(c, r) !== null) continue;
      const n = nearestOf(players, { c, r });
      if (n.distance > bestD) { bestD = n.distance; best = { c, r }; }
    }
    if (best) {
      u.ap -= 1;
      u.c = best.c;
      u.r = best.r;
      ecs.emit("move", { id, c: u.c, r: u.r, steps: 1 });
      return true;
    }
  }
  return false;
}

function enemyPhase(state, world, rng, tick) {
  if (tick < state.nextActAt) return;
  // Enemies that pass (holding, out of AP, nothing to do) cost no time: the
  // loop runs on until one of them does something visible.
  while (state.phase === "enemy" && state.enemyQueue.length > 0) {
    const id = state.enemyQueue[0];
    if (!ecs.isAlive(id) || ecs.get(id, "Unit").ap <= 0) { state.enemyQueue.shift(); continue; }
    if (enemyAct(state, world, rng, id, tick)) {
      state.nextActAt = tick + world.enemyActionTicks;
      return;
    }
  }
  if (state.phase === "enemy") startPlayerTurn(state, world);
}

// ---------------------------------------------------------------- game
export const game = defineGame({
  id: GAME_ID,
  version: 1,
  createState(seed, world) {
    const state = {
      ecs: createEcsState(),
      phase: "player",
      mission: 0,
      turn: 1,
      enemyQueue: [],
      nextActAt: 0,
      stars: 0,
      stats: { defeated: 0, fallen: 0, healed: 0, missionsCleared: 0, moves: 0, turns: 0 },
      quests: createQuestLog(world.questDefs),
    };
    ecs.bind(state.ecs);
    spawnMission(state, world);
    return state;
  },
  step(state, input, { rng, world, tick }) {
    ecs.bind(state.ecs);
    ecs.beginTick();
    if (state.phase === "player") playerCommands(state, input, rng, world, tick);
    else if (state.phase === "enemy") enemyPhase(state, world, rng, tick);
    const completed = updateQuests(state.quests, world.questDefs, state.stats, (reward) => {
      if (isInt(reward.stars) && reward.stars > 0) state.stars += reward.stars;
    });
    for (const id of completed) ecs.emit("quest", { id });
    ecs.dispatch();
  },
  validateState(state, world) {
    if (!PHASES.includes(state.phase)) return "phase";
    if (!isInt(state.mission) || state.mission < 0 || state.mission >= world.missions.length) return "mission";
    if (!isInt(state.turn) || state.turn < 1 || !isInt(state.nextActAt) || state.nextActAt < 0 || !isInt(state.stars) || state.stars < 0) return "turn/timing";
    const ecsErr = validateEcsState(state.ecs, ecs.specs());
    if (ecsErr) return "ecs: " + ecsErr;
    const st = state.stats;
    if (!st || ["defeated", "fallen", "healed", "missionsCleared", "moves", "turns"].some((k) => !isInt(st[k]) || st[k] < 0)) return "stats";
    if (!isValidQuestLog(state.quests, world.questDefs)) return "quests";
    const aliveSet = new Set(state.ecs.alive);
    if (!Array.isArray(state.enemyQueue) || state.enemyQueue.some((id) => !isInt(id))) return "enemyQueue";
    const grid = world.missions[state.mission].grid;
    const units = state.ecs.comps.Unit || {};
    const healths = state.ecs.comps.Health || {};
    const ais = state.ecs.comps.Ai || {};
    const cells = new Set();
    for (const key of Object.keys(units)) {
      const u = units[key];
      if (components.Unit.validate(u)) return `unit ${key}`;
      if (!world.classes[u.cls]) return `unit ${key} class`;
      if (isBlocked(grid, u.c, u.r) || cells.has(`${u.c},${u.r}`)) return `unit ${key} cell`;
      cells.add(`${u.c},${u.r}`);
      const h = healths[key];
      if (!h || components.Health.validate(h) || h.hp < 1) return `unit ${key} health`;
      if (u.team === "enemy" && !isValidFsmState(ENEMY_FSM, ais[key])) return `unit ${key} ai`;
    }
    for (const name of ["Health", "Skill", "Ai"]) {
      for (const key of Object.keys(state.ecs.comps[name] || {})) {
        if (!aliveSet.has(Number(key)) || !units[key]) return `${name} without unit`;
        if (components[name].validate(state.ecs.comps[name][key])) return `${name} ${key}`;
      }
    }
    return null;
  },
  summarize(state) {
    const units = listUnits(state);
    return {
      phase: state.phase, mission: state.mission, turn: state.turn, stars: state.stars,
      players: units.filter((u) => u.team === "player").length,
      enemies: units.filter((u) => u.team === "enemy").length,
      stats: { ...state.stats },
      questsDone: state.quests.filter((q) => q.done).length,
    };
  },
});

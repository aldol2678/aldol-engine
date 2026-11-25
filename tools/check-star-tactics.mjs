// Star Tactics (M5 candidate) checks. Run: node --experimental-vm-modules tools/check-star-tactics.mjs (or node tools/check-next-all.mjs)
// (node --experimental-vm-modules tools/check-star-tactics.mjs)
import { createChecker, readJson, readText, syntaxChecks, pageScriptSyntaxChecks, bannedApiChecks, determinismSuite, saveRejectionSuite } from "./next/harness.mjs";
import { validateWorldManifest } from "../src/core/worldforge.js";
import { stateHash } from "../src/core/state-hash.js";
import { createEcs } from "../src/core/next/ecs.js";
import { updateFsm, createFsmState } from "../src/core/next/fsm.js";
import {
  game, loadWorld, GAME_ID, SEED, RULE_TYPE, SAVE_KEY, ENEMY_FSM,
  listUnits, reachableCells, attackTargets, skillTargets, skillReady, enemyContext, missionOf,
} from "../games/star-tactics/tactics.js";
import { planAction, botPlay } from "./next/play/star-tactics-bot.mjs";

const t = createChecker();
const { check, throws } = t;
const SIM = "games/star-tactics/tactics.js";

const manifest = readJson("games/star-tactics/world.json");
const clone = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------ manifest
check("tactics manifest valid", validateWorldManifest(manifest).valid, JSON.stringify(validateWorldManifest(manifest).errors));
const world = loadWorld(manifest);
check("tactics world adapted",
  world.projectId === GAME_ID && world.ruleType === RULE_TYPE && world.missions.length === 2
  && world.missions.every((m) => m.cols === 8 && m.rows === 6 && m.units.filter((u) => u.team === "player").length === 3)
  && world.missions[0].units.filter((u) => u.team === "enemy").length === 4 && world.missions[1].units.filter((u) => u.team === "enemy").length === 5
  && world.questDefs.length === 4 && Object.keys(world.classes).length === 6,
  `missions=${world.missions.length} units=${world.missions.map((m) => m.units.length)} quests=${world.questDefs.length}`);
check("enemy roster has at least two kinds per mission", world.missions.every((m) => new Set(m.units.filter((u) => u.team === "enemy").map((u) => u.cls)).size >= 2));
check("assets are builtin primitives only (no GLB, no URL)", manifest.assets.every((a) => /^builtin:[a-z-]+$/.test(a.uri)));
check("save key", SAVE_KEY === "aldol-engine.star-tactics-m5.save.v1" && game.id === GAME_ID && game.version === 1);

const bad = (mutate) => () => { const m = clone(manifest); mutate(m, m.rules[0].config); loadWorld(m); };
throws("manifest rejected: wrong schema version", bad((m) => { m.schemaVersion = "worldforge/0.2"; }), /invalid world manifest/);
throws("manifest rejected: rule disabled", bad((m) => { m.rules[0].enabled = false; }), /no enabled/);
throws("manifest rejected: other project", bad((m) => { m.project.id = "star-defense"; }), /expected "star-tactics"/);
throws("manifest rejected: unit with unknown class", bad((m) => { m.entities[0].components["game.unit"].class = "dragon"; }), /unknown class/);
throws("manifest rejected: unit on a wall", bad((m) => { m.entities[0].transform.position = [2, 0, 1]; }), /wall or outside/);
throws("manifest rejected: unit outside the map", bad((m) => { m.entities[0].transform.position = [40, 0, 1]; }), /wall or outside/);
throws("manifest rejected: two units on one cell", bad((m) => { m.entities[1].transform.position = m.entities[0].transform.position; }), /two units/);
throws("manifest rejected: ragged tile rows", bad((m, c) => { c.missions[0].rows[2] = "..#"; }), /same non-zero length/);
throws("manifest rejected: mission without enemies", bad((m) => { m.entities = m.entities.filter((e) => !(e.components["game.unit"].mission === "mission-1" && e.components["game.unit"].team === "enemy")); }), /needs both teams/);
throws("manifest rejected: duplicate mission id", bad((m, c) => { c.missions[1].id = c.missions[0].id; }), /duplicate mission/);
throws("manifest rejected: class with zero hp", bad((m, c) => { c.classes.guard.hp = 0; }), /bad class guard/);
throws("manifest rejected: unknown skill kind", bad((m, c) => { c.classes.mender.skill.kind = "teleport"; }), /unknown skill kind/);
throws("manifest rejected: bad timing", bad((m, c) => { c.enemyActionTicks = 0; }), /timing/);
throws("manifest rejected: broken asset ref", bad((m) => { m.entities[0].assetId = "ghost"; }), /E_ASSET_REF_NOT_FOUND/);
throws("manifest rejected: quest without condition", bad((m) => { delete m.quests[0].nodes[1].params; }), /no condition/);

// ------------------------------------------------------------ helpers
// A test arena built from the real manifest: one open 8x6 mission (plus a
// wall column) with hand-placed units, so each rule is tested in isolation.
function arena(units, { rows = null, tweak = null } = {}) {
  const m = clone(manifest);
  const cfg = m.rules[0].config;
  cfg.missions = [{ id: "arena", name: "arena", rows: rows || ["........", "........", "........", "...#....", "........", "........"] }];
  const proto = m.entities[0];
  m.entities = units.map(([team, cls, c, r], i) => ({ ...clone(proto), id: `u${i}`, name: `u${i}`, assetId: `unit-${cls}`, transform: { ...proto.transform, position: [c, 0, r] }, components: { "game.unit": { mission: "arena", team, class: cls } } }));
  if (tweak) tweak(cfg, m);
  const w = loadWorld(m);
  return { w, s: game.start("arena", w) };
}
const unit = (s, id) => listUnits(s.state).find((u) => u.id === id);
const stepN = (s, n, input = {}) => { for (let i = 0; i < n; i++) game.step(s, input); };
function endTurnAndWait(s) {
  game.step(s, { endTurn: true });
  for (let i = 0; i < 2000 && s.state.phase === "enemy"; i++) game.step(s, {});
}

// ------------------------------------------------------------ movement / AP
{
  const { w, s } = arena([["player", "guard", 0, 0], ["player", "archer", 1, 0], ["enemy", "wisp", 7, 5]]);
  check("ids follow manifest order (players first)", listUnits(s.state).map((u) => `${u.id}:${u.cls}`).join(",") === "1:guard,2:archer,3:wisp");
  const reach = reachableCells(s.state, w, 1);
  check("reachable cells respect AP and occupancy", reach.every((c) => c.cost <= 4) && !reach.some((c) => c.c === 1 && c.r === 0) && reach.some((c) => c.c === 0 && c.r === 4) && !reach.some((c) => c.c === 0 && c.r === 5));
  game.step(s, { move: { unit: 1, c: 0, r: 4 } });
  check("move at the AP boundary (4 cells, 4 AP) succeeds", unit(s, 1).r === 4 && unit(s, 1).ap === 0);
  game.step(s, { move: { unit: 1, c: 0, r: 5 } });
  check("move with 0 AP is ignored", unit(s, 1).r === 4);
  game.step(s, { move: { unit: 2, c: 6, r: 0 } });
  check("move beyond AP (5 cells, 4 AP) is ignored", unit(s, 2).c === 1 && unit(s, 2).ap === 4);
  game.step(s, { move: { unit: 2, c: 3, r: 3 } });
  check("move onto a wall is ignored", unit(s, 2).c === 1 && unit(s, 2).ap === 4);
  game.step(s, { move: { unit: 2, c: 0, r: 4 } });
  check("move onto an occupied cell is ignored", unit(s, 2).c === 1 && unit(s, 2).r === 0);
  game.step(s, { move: { unit: 2, c: 99, r: -3 } });
  game.step(s, { move: { unit: 2, c: 1.5, r: 0 } });
  game.step(s, { move: { unit: 3, c: 6, r: 5 } });
  game.step(s, { move: { unit: 404, c: 1, r: 1 } });
  check("out-of-bounds / fractional / enemy-unit / unknown-unit moves are ignored", unit(s, 2).ap === 4 && unit(s, 3).c === 7 && s.state.stats.moves === 1);
  const before = game.hash(s);
  for (const junk of [null, 7, "move", [1, 2], { move: null }, { move: "up" }, { move: { unit: "1", c: 0, r: 0 } }, { attack: 5 }, { attack: { unit: 1 } }, { skill: { unit: 2, target: "x" } }, { endTurn: "yes" }, { select: 1 }, { __proto__: { endTurn: true } }]) game.step(s, junk);
  const after = game.simulate("arena", s.state.tick, [{ move: { unit: 1, c: 0, r: 4 } }], w);
  check("garbage inputs change nothing but the tick", stateHash({ ...after, tick: 0 }) === stateHash({ ...s.state, tick: 0 }) && before !== game.hash(s));
}
{
  // Units block paths: a corridor plugged by an ally cannot be walked through.
  const { w, s } = arena([["player", "guard", 0, 0], ["player", "archer", 1, 0], ["enemy", "wisp", 7, 5]], { rows: ["........", "########", "........", "........", "........", "........"] });
  check("cannot path through another unit", !reachableCells(s.state, w, 1).some((c) => c.c >= 1));
  game.step(s, { move: { unit: 1, c: 2, r: 0 } });
  check("move through a blocking unit is ignored", unit(s, 1).c === 0 && unit(s, 1).ap === 4);
}

// ------------------------------------------------------------ attacks
{
  const { w, s } = arena([["player", "archer", 0, 0], ["player", "guard", 0, 5], ["enemy", "brute", 4, 0], ["enemy", "brute", 5, 0], ["enemy", "wisp", 3, 5]], { rows: ["........", "........", "........", "........", "..#.....", "........"] });
  check("ranged attack: range boundary (4 in, 5 out)", JSON.stringify(attackTargets(s.state, w, 1)) === "[3]");
  game.step(s, { attack: { unit: 1, target: 4 } });
  check("attack out of range is ignored (no AP spent, no RNG drawn)", unit(s, 1).ap === 4 && unit(s, 4).hp === 16 && s.state.rngDraws === 0);
  game.step(s, { attack: { unit: 1, target: 3 } });
  const dmg = 16 - unit(s, 3).hp;
  check("attack in range costs AP, draws 2 RNG values, armor applies", unit(s, 1).ap === 2 && s.state.rngDraws === 2 && dmg >= 2 && dmg <= 9, `dealt=${dmg}`);
  game.step(s, { attack: { unit: 1, target: 3 } });
  game.step(s, { attack: { unit: 1, target: 3 } });
  check("attack without enough AP is ignored", unit(s, 1).ap === 0 && s.state.rngDraws === 4);
  game.step(s, { attack: { unit: 2, target: 1 } });
  game.step(s, { attack: { unit: 2, target: 2 } });
  game.step(s, { attack: { unit: 3, target: 1 } });
  game.step(s, { attack: { unit: 2, target: 77 } });
  check("friendly fire / self / enemy-as-attacker / unknown target ignored", s.state.rngDraws === 4 && unit(s, 1).hp === 10 && unit(s, 2).ap === 4);
  check("melee range boundary (distance 2 is out)", attackTargets(s.state, w, 2).length === 0 && attackTargets(s.state, w, 2, { c: 2, r: 5 }).includes(5));
}
{
  // Line of sight: the wall at (3,3) blocks the archer's row shot.
  const { w, s } = arena([["player", "archer", 1, 3], ["player", "guard", 0, 0], ["enemy", "brute", 5, 3], ["enemy", "brute", 1, 5]]);
  check("line of sight blocked by a wall", JSON.stringify(attackTargets(s.state, w, 1)) === "[4]");
  game.step(s, { attack: { unit: 1, target: 3 } });
  check("attack through a wall is ignored", unit(s, 3).hp === 16 && unit(s, 1).ap === 4);
  check("attack helper with a hypothetical position sees past the wall", attackTargets(s.state, w, 1, { c: 2, r: 2 }).includes(3));
}

// ------------------------------------------------------------ skills / cooldown / heal cap
{
  const { w, s } = arena([["player", "mender", 0, 0], ["player", "guard", 1, 0], ["player", "archer", 4, 0], ["enemy", "wisp", 7, 5]], { tweak: (cfg) => { cfg.ai.alertTurn = 99; cfg.classes.wisp.sight = 0; } });
  check("heal has no target while everyone is at full hp", skillTargets(s.state, w, 1).length === 0);
  game.step(s, { skill: { unit: 1, target: 2 } });
  check("heal on a full-hp ally is ignored (no AP, no cooldown)", unit(s, 1).ap === 4 && skillReady(s.state, 1));
  s.state.ecs.comps.Health[2].hp = 13;
  s.state.ecs.comps.Health[3].hp = 2;
  check("heal targets: wounded allies in range only (range 3 in, 4 out)", JSON.stringify(skillTargets(s.state, w, 1)) === "[2]");
  game.step(s, { skill: { unit: 1, target: 3 } });
  check("heal out of range is ignored", unit(s, 3).hp === 2 && unit(s, 1).ap === 4);
  game.step(s, { skill: { unit: 1, target: 2 } });
  check("heal is capped at max hp and counted as actually healed", unit(s, 2).hp === 16 && s.state.stats.healed === 3 && unit(s, 1).ap === 2 && unit(s, 1).skillReadyAt === 3);
  s.state.ecs.comps.Health[2].hp = 5;
  game.step(s, { skill: { unit: 1, target: 2 } });
  check("skill on cooldown is ignored", unit(s, 2).hp === 5 && unit(s, 1).ap === 2 && !skillReady(s.state, 1));
  endTurnAndWait(s);
  check("turn 2: still cooling down (boundary - 1)", s.state.turn === 2 && !skillReady(s.state, 1));
  game.step(s, { skill: { unit: 1, target: 2 } });
  check("turn 2: skill still refused", unit(s, 2).hp === 5);
  endTurnAndWait(s);
  check("turn 3: cooldown ready exactly at readyAt", s.state.turn === 3 && skillReady(s.state, 1));
  game.step(s, { skill: { unit: 1, target: 2 } });
  check("turn 3: heal works again", unit(s, 2).hp === 11 && s.state.stats.healed === 9);
  check("heal quest completes and pays its star once", s.state.quests.find((q) => q.id === "heal-ally").done && s.state.stars === 1);
  stepN(s, 5);
  check("quest reward is not paid twice", s.state.stars === 1);
  game.step(s, { skill: { unit: 1, target: 4 } });
  check("heal cannot target an enemy", unit(s, 4).hp === 8);
  game.step(s, { skill: { unit: 3, target: 2 } });
  check("strike skill cannot target an ally", unit(s, 2).hp === 11 && skillReady(s.state, 3));
}
{
  const { w, s } = arena([["player", "guard", 2, 2], ["player", "archer", 0, 0], ["enemy", "brute", 3, 2], ["enemy", "wisp", 7, 5]]);
  game.step(s, { skill: { unit: 1, target: 3 } });
  const dealt = 16 - unit(s, 3).hp;
  check("strike skill: bonus damage, AP cost 3, cooldown 3 turns", dealt >= 7 && dealt <= 9 && unit(s, 1).ap === 1 && unit(s, 1).skillReadyAt === 4, `dealt=${dealt}`);
  game.step(s, { skill: { unit: 1, target: 3 } });
  check("strike skill without AP / on cooldown is ignored", 16 - unit(s, 3).hp === dealt);
}

// ------------------------------------------------------------ phases / turn order
{
  const { w, s } = arena([["player", "guard", 0, 0], ["player", "archer", 0, 1], ["enemy", "wisp", 7, 0], ["enemy", "wisp", 7, 2], ["enemy", "hexer", 7, 5]], { tweak: (cfg) => { cfg.ai.alertTurn = 1; } });
  game.step(s, { move: { unit: 1, c: 1, r: 0 } });
  game.step(s, { endTurn: true });
  check("endTurn switches to the enemy phase with the queue in id order", s.state.phase === "enemy" && JSON.stringify(s.state.enemyQueue) === "[3,4,5]");
  const snapshot = brief(s);
  game.step(s, { move: { unit: 1, c: 2, r: 0 }, attack: { unit: 2, target: 3 }, skill: { unit: 2, target: 3 }, endTurn: true });
  check("player commands during the enemy phase are ignored", brief(s) === snapshot && s.state.phase === "enemy");
  const order = [];
  for (let i = 0; i < 2000 && s.state.phase === "enemy"; i++) {
    game.step(s, {});
    for (const ev of s.state.ecs.events) if (ev.type === "move") order.push(ev.data.id);
  }
  check("enemies act one at a time in id order (3 AP each)", order.join(",") === "3,3,3,4,4,4,5,5,5", order.join(","));
  check("next player turn: turn counter +1, player AP refilled", s.state.phase === "player" && s.state.turn === 2 && unit(s, 1).ap === 4 && unit(s, 2).ap === 4);
  check("enemy actions are paced by enemyActionTicks", s.state.tick >= 2 + w.phaseDelayTicks + 8 * w.enemyActionTicks, `tick=${s.state.tick}`);
  function brief(x) { return JSON.stringify(listUnits(x.state).map((u) => [u.id, u.c, u.r, u.hp, u.ap])); }
}

// ------------------------------------------------------------ enemy FSM
{
  const fs = createFsmState(ENEMY_FSM, 0);
  const ctx = (o) => ({ seesPlayer: false, hurt: false, alerted: false, lowHp: false, hasTarget: false, cornered: false, ...o });
  check("fsm: hold stays while unaware", updateFsm(ENEMY_FSM, fs, ctx({}), 1).changed === false && fs.state === "hold");
  check("fsm: hold -> advance on sight", updateFsm(ENEMY_FSM, fs, ctx({ seesPlayer: true }), 2).to === "advance");
  check("fsm: advance -> attack with a target", updateFsm(ENEMY_FSM, fs, ctx({ hasTarget: true }), 3).to === "attack");
  check("fsm: attack -> advance when the target is gone", updateFsm(ENEMY_FSM, fs, ctx({}), 4).to === "advance");
  check("fsm: advance -> retreat on low hp (priority over attack)", updateFsm(ENEMY_FSM, fs, ctx({ lowHp: true, hasTarget: true }), 5).to === "retreat");
  check("fsm: retreat holds until cornered with a target", updateFsm(ENEMY_FSM, fs, ctx({ lowHp: true, hasTarget: true }), 6).changed === false && updateFsm(ENEMY_FSM, fs, ctx({ lowHp: true, hasTarget: true, cornered: true }), 7).to === "attack");
  check("fsm: cornered attacker does not flip back to retreat", updateFsm(ENEMY_FSM, fs, ctx({ lowHp: true, hasTarget: true, cornered: true }), 8).changed === false);
  for (const [name, o] of [["hurt", { hurt: true }], ["alerted", { alerted: true }]]) {
    const f = createFsmState(ENEMY_FSM, 0);
    check(`fsm: hold -> advance when ${name}`, updateFsm(ENEMY_FSM, f, ctx(o), 1).to === "advance");
  }
}
{
  // In-game: a wisp outside sight holds (and costs no time), then advances
  // when a player steps into sight; a hurt hexer retreats; nearest-target
  // ties go to the lower id.
  const { w, s } = arena([["player", "guard", 0, 0], ["player", "archer", 0, 5], ["enemy", "wisp", 7, 0], ["enemy", "hexer", 7, 5]], { tweak: (cfg) => { cfg.ai.alertTurn = 99; cfg.classes.hexer.sight = 0; } });
  check("enemy context: out of sight", enemyContext(s.state, w, 3).seesPlayer === false && enemyContext(s.state, w, 3).nearest.id === 1);
  const t0 = s.state.tick;
  endTurnAndWait(s);
  check("holding enemies pass instantly", unit(s, 3).c === 7 && unit(s, 3).ai === "hold" && s.state.turn === 2 && s.state.tick - t0 <= w.phaseDelayTicks + 2, `ticks=${s.state.tick - t0}`);
  game.step(s, { move: { unit: 1, c: 2, r: 0 } });
  check("enemy context: sight boundary (distance 5 == sight 5)", enemyContext(s.state, w, 3).seesPlayer === true);
  endTurnAndWait(s);
  check("wisp advances 3 cells toward the player; unaware hexer still holds", unit(s, 3).c === 4 && unit(s, 3).ai === "advance" && unit(s, 4).c === 7 && unit(s, 4).ai === "hold");
  // Hurt the hexer to half hp: it wakes up (hurt) and then retreats.
  s.state.ecs.comps.Health[4].hp = 3;
  s.state.ecs.comps.Unit[4].hurt = true;
  s.state.ecs.comps.Unit[4].c = 4; s.state.ecs.comps.Unit[4].r = 5;
  s.state.ecs.comps.Unit[2].c = 2;
  endTurnAndWait(s);
  const hx = unit(s, 4);
  check("hurt hexer wakes, then retreats away from the squad", hx.ai === "retreat" && Math.abs(hx.c - 2) + Math.abs(hx.r - 5) >= 3, `ai=${hx.ai} at=${hx.c},${hx.r}`);
}
{
  const { w, s } = arena([["player", "guard", 3, 0], ["player", "archer", 5, 0], ["enemy", "wisp", 4, 0], ["enemy", "wisp", 7, 5]], { tweak: (cfg) => { cfg.ai.alertTurn = 1; } });
  s.state.ecs.comps.Health[1].hp = 10;
  endTurnAndWait(s);
  check("enemy target tie: equal hp -> lower id is attacked", unit(s, 1).hp < 10 && unit(s, 2).hp === 10, `guard=${unit(s, 1).hp} archer=${unit(s, 2).hp}`);
  const { s: s2 } = arena([["player", "guard", 3, 0], ["player", "archer", 5, 0], ["enemy", "wisp", 4, 0], ["enemy", "wisp", 7, 5]], { tweak: (cfg) => { cfg.ai.alertTurn = 1; } });
  s2.state.ecs.comps.Health[2].hp = 4;
  endTurnAndWait(s2);
  check("enemy target choice: weakest unit in range first", unit(s2, 2).hp < 4 && unit(s2, 1).hp === 16);
}

// ------------------------------------------------------------ win / lose / dead units
{
  const { s } = arena([["player", "guard", 0, 0], ["player", "archer", 0, 1], ["enemy", "wisp", 1, 0], ["enemy", "wisp", 7, 5]], { tweak: (cfg) => { cfg.classes.wisp.hp = 1; } });
  game.step(s, { attack: { unit: 1, target: 3 } });
  check("defeated unit is removed and counted", !unit(s, 3) && s.state.stats.defeated === 1 && s.state.ecs.events.some((e) => e.type === "defeat") && s.state.quests[0].done);
  game.step(s, { attack: { unit: 1, target: 3 } });
  check("attacking a dead unit is ignored", unit(s, 1).ap === 2 && s.state.phase === "player");
  s.state.ecs.comps.Unit[4].c = 1; s.state.ecs.comps.Unit[4].r = 0;
  game.step(s, { attack: { unit: 1, target: 4 } });
  check("last enemy down on the last mission -> won", s.state.phase === "won" && s.state.stats.missionsCleared === 1 && s.state.ecs.events.some((e) => e.type === "won"));
  game.step(s, {});
  const h = game.hash({ ...s.state, tick: 0 });
  game.step(s, { endTurn: true, move: { unit: 1, c: 0, r: 2 } });
  check("commands after victory are ignored", game.hash({ ...s.state, tick: 0 }) === h);
}
{
  const { s } = arena([["player", "mender", 0, 0], ["enemy", "brute", 1, 0], ["enemy", "wisp", 0, 1]], { tweak: (cfg) => { cfg.classes.mender.hp = 2; cfg.ai.alertTurn = 1; } });
  endTurnAndWait(s);
  check("last player unit down -> lost", s.state.phase === "lost" && listUnits(s.state).every((u) => u.team === "enemy") && s.state.stats.fallen === 1);
  const tick = s.state.tick;
  stepN(s, 30, { endTurn: true });
  check("lost is terminal (enemy phase stops)", s.state.phase === "lost" && s.state.tick === tick + 30 && s.state.enemyQueue.length === 0);
}

// ------------------------------------------------------------ full game: bot wins, passive play loses
{
  const run = botPlay(game, world, SEED);
  const sum = game.inspect(run.session).summary;
  check("bot clears both missions with the reference seed", sum.phase === "won" && sum.stats.missionsCleared === 2 && sum.questsDone >= 3, JSON.stringify(sum));
  check("mission 2 follows mission 1 with a fresh squad", sum.mission === 1 && sum.players >= 1 && run.session.state.stars >= 6);
  let wins = 0;
  for (let i = 0; i < 12; i++) if (botPlay(game, world, `bot-${i}`).session.state.phase === "won") wins += 1;
  check("bot wins on 12 further seeds", wins === 12, `wins=${wins}/12`);

  let lost = 0;
  const turns = [];
  for (let i = 0; i < 10; i++) {
    const s = game.start(`passive-${i}`, world);
    for (let f = 0; f < 20000 && s.state.phase !== "lost" && s.state.phase !== "won"; f++) game.step(s, s.state.phase === "player" ? { endTurn: true } : {});
    if (s.state.phase === "lost") lost += 1;
    turns.push(s.state.turn);
  }
  check("passive play (only ending turns) loses on 10 seeds", lost === 10, `lost=${lost}/10 turns=${turns.join(",")}`);

  // Restart: a new session is a clean mission 1 regardless of the old one.
  const fresh = game.start(SEED, world);
  check("restart gives a clean state", fresh.state.mission === 0 && fresh.state.turn === 1 && fresh.state.stats.defeated === 0 && listUnits(fresh.state).length === 7 && game.hash(fresh) === game.hash(game.start(SEED, world)));

  // Mission hand-over: ids keep increasing (never reused) across missions.
  const s = game.start(SEED, world);
  for (const f of run.inputs) { game.step(s, f); if (s.state.mission === 1) break; }
  check("mission 2 spawns new entity ids", s.state.mission === 1 && Math.min(...s.state.ecs.alive) === 8 && s.state.turn === 1 && s.state.phase === "player");

  // Pinned reference vector: SEED + the bot's recorded input script.
  const again = game.simulate(SEED, run.inputs.length, run.inputs, world);
  const ref = game.hash(again);
  check("reference run is reproducible from its input script", ref === game.hash(run.session), `frames=${run.inputs.length}`);
  check("pinned reference hash (seed star-tactics-m5, bot script)", ref === "7cc35f94" && run.inputs.length === 476, `hash=${ref} frames=${run.inputs.length}`);

  // Bot plans are legal: every non-endTurn plan changes the state.
  const p = game.start("legal", world);
  let illegal = 0;
  for (let i = 0; i < 4000 && (p.state.phase === "player" || p.state.phase === "enemy"); i++) {
    const plan = p.state.phase === "player" ? planAction(p.state, world) : null;
    const before = stateHash({ ...p.state, tick: 0 });
    game.step(p, plan ? plan.cmd : {});
    if (plan && stateHash({ ...p.state, tick: 0 }) === before) illegal += 1;
  }
  check("every bot command is accepted by the sim", illegal === 0 && p.state.phase === "won", `illegal=${illegal}`);
}

// ------------------------------------------------------------ G2 determinism (12 seeds)
{
  const seeds = Array.from({ length: 12 }, (_, i) => `tactics-det-${i}`);
  const scripts = new Map(seeds.map((seed) => [seed, botPlay(game, world, seed).inputs]));
  const frames = Math.min(...[...scripts.values()].map((x) => x.length));
  const hashes = determinismSuite(check, { game, world, seeds, frames, makeInputs: (seed) => scripts.get(seed) });
  check("different seeds give different outcomes", new Set(Object.values(hashes)).size === seeds.length);
  // The same script under another seed diverges only through the RNG.
  const a = game.simulate("rng-a", 400, scripts.get(seeds[0]), world);
  const b = game.simulate("rng-b", 400, scripts.get(seeds[0]), world);
  check("damage rolls come from the seeded RNG only", a.rngDraws > 0 && game.hash({ ...a, seed: "" }) !== game.hash({ ...b, seed: "" }));
}

// ------------------------------------------------------------ G3 save
{
  const s = game.start(SEED, world);
  const script = botPlay(game, world, SEED).inputs;
  for (let f = 0; f < 150; f++) game.step(s, script[f]);
  saveRejectionSuite(check, { game, world, session: s, otherGameId: "rune-vault" });
  const v = (mutate) => { const st = game.snapshot(s); mutate(st); return game.validateState(st, world); };
  check("valid mid-battle state accepted", v(() => {}) === null);
  check("state rejected: unknown phase", v((st) => { st.phase = "paused"; }) === "phase");
  check("state rejected: mission out of range", v((st) => { st.mission = 9; }) === "mission");
  check("state rejected: unit on a wall", /cell/.test(v((st) => { st.ecs.comps.Unit[st.ecs.alive[0]].c = 2; st.ecs.comps.Unit[st.ecs.alive[0]].r = 1; }) || ""));
  check("state rejected: two units on one cell", /cell/.test(v((st) => { const [a, b] = st.ecs.alive; st.ecs.comps.Unit[b].c = st.ecs.comps.Unit[a].c; st.ecs.comps.Unit[b].r = st.ecs.comps.Unit[a].r; }) || ""));
  check("state rejected: hp above max", /health/.test(v((st) => { st.ecs.comps.Health[st.ecs.alive[0]].hp = 999; }) || ""));
  check("state rejected: unknown class", /class/.test(v((st) => { st.ecs.comps.Unit[st.ecs.alive[0]].cls = "dragon"; }) || ""));
  check("state rejected: enemy with a bogus AI state", /ai/.test(v((st) => { const id = Object.keys(st.ecs.comps.Ai)[0]; st.ecs.comps.Ai[id].state = "berserk"; }) || ""));
  check("state rejected: unknown component store", /ecs/.test(v((st) => { st.ecs.comps.Hack = {}; }) || ""));
  check("state rejected: negative stat", v((st) => { st.stats.defeated = -1; }) === "stats");
  check("state rejected: quest rewarded but not done", v((st) => { st.quests[3].rewarded = true; }) === "quests");
  throws("restore refuses an invalid state", () => game.restore({ ...game.snapshot(s), phase: "paused" }, world), /cannot restore/);
}

// ------------------------------------------------------------ reuse evidence / hygiene
{
  const src = readText(SIM);
  const modules = [...src.matchAll(/from "\.\.\/\.\.\/src\/core\/next\/([a-z-]+)\.js"/g)].map((m) => m[1]);
  check("sim reuses the shared core (>= 3 modules from src/core/next/)", new Set(modules).size >= 3, modules.join(","));
  for (const mod of ["ecs", "runtime", "spatial", "fsm", "combat", "quest", "save", "manifest"]) check(`sim imports core/next/${mod}.js`, modules.includes(mod));
  check("sim does not import rendering or other games", !/src\/render|three|games\/(supuli|star-fishing|star-defense|rune-vault|star-foundry)/.test(src));
  check("sim hardcodes no class or map data", !/guard|archer|mender|wisp|hexer|brute/.test(src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")));
  const probeEcs = createEcs({ components: { Unit: {}, Health: {}, Skill: {}, Ai: {} } });
  check("state.ecs is a plain shared-ECS state", probeEcs.bind(game.start(SEED, world).state.ecs).query("Unit", "Health").length === 7 && missionOf(game.start(SEED, world).state, world).id === "mission-1");
  const html = pageScriptSyntaxChecks(check, "games/star-tactics/index.html");
  check("page uses the shared HUD kit, board and shell", /render\/hud\.js/.test(html) && /render\/next\/board\.js/.test(html) && /render\/next\/shell\.js/.test(html) && /installProbe\(/.test(html));
  check("page pins three 0.187.0 and uses the per-game save key export", /three@0\.187\.0/.test(html) && /SAVE_KEY/.test(html) && !/latest/.test(html));
}
syntaxChecks(check, [SIM, "tools/next/play/star-tactics.mjs", "tools/next/play/star-tactics-bot.mjs"]);
bannedApiChecks(check, [SIM]);

t.done();

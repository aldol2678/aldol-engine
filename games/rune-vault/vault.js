// Rune Vault (M4 candidate) — top-down puzzle exploration on the shared
// ENGINE-NEXT-01 core. Push crates onto pressure plates, flip levers, pick
// up keys and break seals to reach the goal rune of each room within its
// move limit.
//
// Reuse: this file holds only the puzzle rules. Entities/events come from
// src/core/next/ecs.js, the tile grid from spatial.js, keys and rune rewards
// from inventory.js, objectives from quest.js, the fixed-step session /
// replay / snapshot from runtime.js, the save key from save.js and the world
// from manifest.js. Every room (tiles, objects, move limits) comes from
// games/rune-vault/world.json — nothing about a level is hardcoded here.
//
// Input frames (one command per 1/60 s tick, anything else is ignored):
//   { move: "up" | "right" | "down" | "left" }   step / push / unlock
//   { reset: true }                               restart the current room
//   { next: true }                                skip the room-clear pause
// Phases: playing -> cleared -> (next room) ... -> won, or playing -> failed
// (moves ran out; only reset is accepted).
// Determinism: no randomness is needed; the seed only labels the session.

import { createEcs, createEcsState, validateEcsState } from "../../src/core/next/ecs.js";
import { defineGame } from "../../src/core/next/runtime.js";
import { createGrid, isBlocked, inBounds, DIR_BY_NAME } from "../../src/core/next/spatial.js";
import { createInventory, add, remove, count, canAdd, isValidInventory } from "../../src/core/next/inventory.js";
import { createQuestLog, updateQuests, isValidQuestLog } from "../../src/core/next/quest.js";
import { saveKey } from "../../src/core/next/save.js";
import { loadGameWorld, parseTileRows } from "../../src/core/next/manifest.js";

export const GAME_ID = "rune-vault";
export const SEED = "rune-vault-m4";
export const RULE_TYPE = "game.puzzle";
export const SAVE_KEY = saveKey(GAME_ID, "m4");
export const PHASES = ["playing", "cleared", "failed", "won"];
const STAT_KEYS = ["roomsCleared", "keysUsed", "leversPulled", "cratesPushed", "moves", "resets", "fails"];

const isCell = (d) => (Number.isInteger(d.c) && Number.isInteger(d.r) ? null : "c/r must be integers");
const components = {
  Cell: { defaults: { c: 0, r: 0 }, validate: isCell },
  Player: { defaults: { facing: "down" }, validate: (d) => (Object.prototype.hasOwnProperty.call(DIR_BY_NAME, d.facing) ? null : "facing") },
  Crate: {},
  Goal: {},
  Key: {},
  // lever: toggled by a lever (or set for good when a seal is broken).
  // locked: a seal that needs a key. open: derived every move.
  Door: {
    defaults: { key: "", mode: "any", lever: false, locked: false, open: false },
    validate: (d) => (typeof d.key === "string" && (d.mode === "any" || d.mode === "all") && [d.lever, d.locked, d.open].every((b) => typeof b === "boolean") ? null : "door fields"),
  },
  Plate: { defaults: { door: "", pressed: false }, validate: (d) => (typeof d.door === "string" && typeof d.pressed === "boolean" ? null : "plate fields") },
  Lever: { defaults: { door: "", on: false }, validate: (d) => (typeof d.door === "string" && typeof d.on === "boolean" ? null : "lever fields") },
};
const ecs = createEcs({ components });

// ------------------------------------------------------------- world
function fail(msg) { throw new Error(`rune-vault world: ${msg}`); }

function buildLevel(def, index, board) {
  if (!def || typeof def.id !== "string") fail(`level ${index} needs an id`);
  if (!Number.isInteger(def.moveLimit) || def.moveLimit < 1) fail(`${def.id}: moveLimit must be a positive integer`);
  const tiles = parseTileRows(def.rows);
  if (tiles.cols !== board.cols || tiles.rows !== board.rows) fail(`${def.id}: rows must be ${board.cols}x${board.rows}`);
  for (const ch of Object.keys(tiles.marks)) if (!"PGCK".includes(ch)) fail(`${def.id}: unknown tile "${ch}"`);
  const grid = createGrid({ cols: tiles.cols, rows: tiles.rows, blocked: tiles.blocked });
  const starts = tiles.marks.P || [];
  if (starts.length !== 1) fail(`${def.id}: needs exactly one P`);
  const goals = tiles.marks.G || [];
  if (goals.length < 1) fail(`${def.id}: needs a goal G`);
  const doors = [];
  const plates = [];
  const levers = [];
  const used = new Set([...starts, ...goals, ...(tiles.marks.C || []), ...(tiles.marks.K || [])].map((p) => `${p.c},${p.r}`));
  for (const o of def.objects || []) {
    if (!o || !inBounds(grid, o.c, o.r) || isBlocked(grid, o.c, o.r)) fail(`${def.id}: object ${o && o.kind} is off the floor`);
    const k = `${o.c},${o.r}`;
    if (used.has(k)) fail(`${def.id}: two things share cell ${k}`);
    used.add(k);
    if (o.kind === "door" || o.kind === "lock") {
      if (typeof o.id !== "string" || doors.some((d) => d.key === o.id)) fail(`${def.id}: door id missing or duplicated`);
      if (o.mode !== undefined && o.mode !== "any" && o.mode !== "all") fail(`${def.id}: door mode`);
      doors.push({ key: o.id, c: o.c, r: o.r, mode: o.mode || "any", locked: o.kind === "lock", lever: o.open === true });
    } else if (o.kind === "plate") plates.push({ c: o.c, r: o.r, door: o.door });
    else if (o.kind === "lever") levers.push({ c: o.c, r: o.r, door: o.door });
    else fail(`${def.id}: unknown object kind "${o.kind}"`);
  }
  for (const link of [...plates, ...levers]) {
    const door = doors.find((d) => d.key === link.door);
    if (!door) fail(`${def.id}: plate/lever points at unknown door "${link.door}"`);
    if (door.locked) fail(`${def.id}: a sealed door cannot have a plate or lever`);
  }
  return {
    id: def.id, name: def.name || def.id, moveLimit: def.moveLimit, grid,
    start: starts[0], goals, crates: tiles.marks.C || [], keys: tiles.marks.K || [], doors, plates, levers,
  };
}

// Manifest -> world. Throws on any bad level so a broken world never starts.
export function loadWorld(manifest) {
  const base = loadGameWorld(manifest, { ruleType: RULE_TYPE, projectId: GAME_ID });
  const cfg = base.config;
  const board = cfg.board;
  if (!board || !Number.isInteger(board.cols) || !Number.isInteger(board.rows)) fail("config.board { cols, rows } is required");
  if (!Array.isArray(cfg.levels) || cfg.levels.length === 0) fail("config.levels must be a non-empty array");
  if (!Number.isInteger(cfg.clearDelayTicks) || cfg.clearDelayTicks < 0) fail("clearDelayTicks must be a non-negative integer");
  if (!Number.isInteger(cfg.keyCapacity) || cfg.keyCapacity < 1) fail("keyCapacity must be a positive integer");
  const levels = cfg.levels.map((def, i) => buildLevel(def, i, board));
  if (new Set(levels.map((l) => l.id)).size !== levels.length) fail("duplicate level id");
  return { ...base, board: { cols: board.cols, rows: board.rows }, levels, clearDelayTicks: cfg.clearDelayTicks, keyCapacity: cfg.keyCapacity };
}

// ------------------------------------------------------------- rules
function at(name, c, r) {
  return ecs.find(["Cell", name], (id, cell) => cell.c === c && cell.r === r);
}
function playerId() {
  return ecs.query("Player", "Cell")[0] ?? null;
}

function loadLevel(state, world, index) {
  for (const id of ecs.ids()) ecs.despawn(id);
  const level = world.levels[index];
  state.level = index;
  state.movesLeft = level.moveLimit;
  state.clearAt = 0;
  state.phase = "playing";
  state.keys = createInventory({ capacity: world.keyCapacity });
  ecs.spawn({ Cell: { c: level.start.c, r: level.start.r }, Player: {} });
  for (const p of level.goals) ecs.spawn({ Cell: { c: p.c, r: p.r }, Goal: {} });
  for (const d of level.doors) ecs.spawn({ Cell: { c: d.c, r: d.r }, Door: { key: d.key, mode: d.mode, locked: d.locked, lever: d.lever } });
  for (const p of level.plates) ecs.spawn({ Cell: { c: p.c, r: p.r }, Plate: { door: p.door } });
  for (const l of level.levers) ecs.spawn({ Cell: { c: l.c, r: l.r }, Lever: { door: l.door } });
  for (const k of level.keys) ecs.spawn({ Cell: { c: k.c, r: k.r }, Key: {} });
  for (const c of level.crates) ecs.spawn({ Cell: { c: c.c, r: c.r }, Crate: {} });
  refreshDoors(false);
}

// Plates are pressed by a crate or the player. A door is open when its
// lever flag is set, its plates are pressed ("any" or "all"), or something
// is standing in it (a door never closes on an occupant). Seals stay shut.
function refreshDoors(emit) {
  const pid = playerId();
  const pc = pid === null ? null : ecs.get(pid, "Cell");
  const occupied = (c, r) => (pc && pc.c === c && pc.r === r) || at("Crate", c, r) !== null;
  const pressedBy = {};
  ecs.each(["Cell", "Plate"], (id, cell, plate) => {
    plate.pressed = occupied(cell.c, cell.r);
    (pressedBy[plate.door] || (pressedBy[plate.door] = [])).push(plate.pressed);
  });
  ecs.each(["Cell", "Door"], (id, cell, door) => {
    const plates = pressedBy[door.key] || [];
    const byPlates = plates.length > 0 && (door.mode === "all" ? plates.every(Boolean) : plates.some(Boolean));
    const open = !door.locked && (door.lever || byPlates || occupied(cell.c, cell.r));
    if (open !== door.open) {
      door.open = open;
      if (emit) ecs.emit("door", { key: door.key, open });
    }
  });
}

function tryMove(state, world, dirName, tick) {
  const dir = DIR_BY_NAME[dirName];
  const level = world.levels[state.level];
  const pid = playerId();
  const pos = ecs.get(pid, "Cell");
  ecs.get(pid, "Player").facing = dirName;
  const c = pos.c + dir.dc;
  const r = pos.r + dir.dr;
  const bump = () => ecs.emit("bump", { c, r });
  if (isBlocked(level.grid, c, r)) return bump();

  const doorId = at("Door", c, r);
  let unlock = false;
  if (doorId !== null) {
    const door = ecs.get(doorId, "Door");
    if (door.locked) {
      if (count(state.keys, "key") < 1) return bump();
      unlock = true;
    } else if (!door.open) return bump();
  }
  const crateId = at("Crate", c, r);
  if (crateId !== null) {
    const nc = c + dir.dc;
    const nr = r + dir.dr;
    if (isBlocked(level.grid, nc, nr) || at("Crate", nc, nr) !== null) return bump();
    const beyond = at("Door", nc, nr);
    if (beyond !== null && !ecs.get(beyond, "Door").open) return bump();
    const cell = ecs.get(crateId, "Cell");
    cell.c = nc;
    cell.r = nr;
    state.stats.cratesPushed += 1;
    ecs.emit("push", { c: nc, r: nr });
  }
  if (unlock) {
    const door = ecs.get(doorId, "Door");
    remove(state.keys, "key", 1);
    door.locked = false;
    door.lever = true; // a broken seal stays open
    state.stats.keysUsed += 1;
    ecs.emit("unlock", { key: door.key });
  }
  pos.c = c;
  pos.r = r;
  state.movesLeft -= 1;
  state.stats.moves += 1;
  ecs.emit("step", { c, r });

  const keyId = at("Key", c, r);
  if (keyId !== null && canAdd(state.keys, "key", 1)) {
    add(state.keys, "key", 1);
    ecs.despawn(keyId);
    ecs.emit("key", { c, r });
  }
  const leverId = at("Lever", c, r);
  if (leverId !== null) {
    const lever = ecs.get(leverId, "Lever");
    lever.on = !lever.on;
    ecs.each(["Door"], (id, door) => { if (door.key === lever.door) door.lever = !door.lever; });
    state.stats.leversPulled += 1;
    ecs.emit("lever", { door: lever.door, on: lever.on });
  }
  refreshDoors(true);

  if (at("Goal", c, r) !== null) {
    state.stats.roomsCleared += 1;
    if (state.level + 1 >= world.levels.length) {
      state.phase = "won";
      ecs.emit("won", {});
    } else {
      state.phase = "cleared";
      state.clearAt = tick + world.clearDelayTicks;
      ecs.emit("cleared", { level: state.level });
    }
  } else if (state.movesLeft <= 0) {
    state.phase = "failed";
    state.stats.fails += 1;
    ecs.emit("failed", { level: state.level });
  }
}

function createState(seed, world) {
  if (!world || !Array.isArray(world.levels)) throw new Error("rune-vault needs a world from loadWorld()");
  const state = {
    ecs: createEcsState(),
    phase: "playing",
    level: 0,
    movesLeft: 0,
    clearAt: 0,
    keys: createInventory({ capacity: world.keyCapacity }),
    runes: createInventory(),
    quests: createQuestLog(world.questDefs),
    stats: Object.fromEntries(STAT_KEYS.map((k) => [k, 0])),
  };
  ecs.bind(state.ecs);
  loadLevel(state, world, 0);
  return state;
}

function step(state, input, { world, tick }) {
  ecs.bind(state.ecs);
  ecs.beginTick();
  if (state.phase === "cleared") {
    if (input.next === true || tick >= state.clearAt) {
      loadLevel(state, world, state.level + 1);
      ecs.emit("room", { level: state.level });
    }
  } else if (input.reset === true && (state.phase === "playing" || state.phase === "failed")) {
    state.stats.resets += 1;
    loadLevel(state, world, state.level);
    ecs.emit("reset", { level: state.level });
  } else if (state.phase === "playing" && typeof input.move === "string" && Object.prototype.hasOwnProperty.call(DIR_BY_NAME, input.move)) {
    tryMove(state, world, input.move, tick);
  }
  updateQuests(state.quests, world.questDefs, state.stats, (reward, questId) => {
    for (const item of Object.keys(reward.items || {}).sort()) add(state.runes, item, reward.items[item]);
    ecs.emit("quest", { id: questId });
  });
  ecs.dispatch();
}

function validateState(state, world) {
  if (!PHASES.includes(state.phase)) return "phase";
  if (!Number.isInteger(state.level) || state.level < 0 || state.level >= world.levels.length) return "level";
  const level = world.levels[state.level];
  if (!Number.isInteger(state.movesLeft) || state.movesLeft < 0 || state.movesLeft > level.moveLimit) return "movesLeft";
  if (!Number.isInteger(state.clearAt) || state.clearAt < 0) return "clearAt";
  if (!isValidInventory(state.keys) || state.keys.capacity !== world.keyCapacity) return "keys";
  if (!isValidInventory(state.runes)) return "runes";
  if (!isValidQuestLog(state.quests, world.questDefs)) return "quests";
  if (!state.stats || typeof state.stats !== "object") return "stats";
  for (const k of STAT_KEYS) if (!Number.isInteger(state.stats[k]) || state.stats[k] < 0) return `stats.${k}`;
  const err = validateEcsState(state.ecs, ecs.specs());
  if (err) return `ecs: ${err}`;
  const cells = state.ecs.comps.Cell || {};
  for (const id of state.ecs.alive) {
    const cell = cells[id];
    if (!cell || !Number.isInteger(cell.c) || !Number.isInteger(cell.r) || isBlocked(level.grid, cell.c, cell.r)) return `entity ${id} is off the floor`;
  }
  if (Object.keys(state.ecs.comps.Player || {}).length !== 1) return "player count";
  for (const p of Object.values(state.ecs.comps.Player)) if (!Object.prototype.hasOwnProperty.call(DIR_BY_NAME, p.facing)) return "facing";
  return null;
}

// Render/inspect view: every object as { id, kind, c, r, ...flags }.
export function view(state) {
  ecs.bind(state.ecs);
  const out = [];
  const push = (kind, extra) => ecs.each(["Cell", kind], (id, cell, data) => out.push({ id, kind: kind.toLowerCase(), c: cell.c, r: cell.r, ...(extra ? extra(data) : {}) }));
  push("Goal");
  push("Plate", (d) => ({ pressed: d.pressed }));
  push("Lever", (d) => ({ on: d.on }));
  push("Door", (d) => ({ open: d.open, locked: d.locked, key: d.key }));
  push("Key");
  push("Crate");
  push("Player", (d) => ({ facing: d.facing }));
  return out;
}

function summarize(state, world) {
  const player = view(state).find((o) => o.kind === "player");
  return {
    phase: state.phase,
    level: state.level + 1,
    levels: world.levels.length,
    room: world.levels[state.level].name,
    movesLeft: state.movesLeft,
    keys: count(state.keys, "key"),
    runes: count(state.runes, "rune"),
    player: { c: player.c, r: player.r },
    questsDone: state.quests.filter((q) => q.done).length,
  };
}

export const game = defineGame({ id: GAME_ID, version: 1, createState, step, validateState, summarize });

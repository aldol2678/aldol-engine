// Star Foundry (M6 candidate) — logistics / production automation sim on the
// ENGINE-NEXT-01 shared core.
//
// Reuse proof: no code is copied from the M1–M3 sims. This file only holds
// the foundry rules and builds them from the shared modules:
//   ecs.js        buildings and items are entities (stable ids, ordered)
//   spatial.js    tile grid, DIRS4 / DIR_BY_NAME, cell keys
//   inventory.js  machine buffers (craft), coins (transfer: player <-> bank)
//   quest.js      orders = manifest quests, rewards paid exactly once
//   runtime.js    defineGame: fixed 1/60 s step, counted RNG, replay
//   save.js       save key convention
//   manifest.js   world.json adapter (grid, costs, recipes, orders)
// Every number (grid, costs, recipes, belt speed, orders, deadline) comes
// from games/star-foundry/world.json.
//
// Tick order (fixed — changing it changes every hash):
//   1. one input command: build or remove
//   2. sources, ascending entity id: emit one item when due and the output
//      cell accepts it (emission jitter is the only RNG use)
//   3. machines, ascending entity id: advance/finish the recipe, start a new
//      one, then eject at most one output item
//   4. belts, only when tick % beltTicks == 0: every item tries to advance
//      one cell. Items are visited in ascending id; before an item moves,
//      the item blocking its target cell is resolved first (head of a line
//      moves first, so a full line shifts as one). When two belts feed the
//      same free cell, the item with the smaller id (the older one) wins.
//      A closed loop with no gap does not move.
//   5. events are dispatched (a delivery pays coins), orders are updated,
//      then win / deadline are checked.
// Conservation (checked by tools/check-star-foundry.mjs):
//   items: produced + crafted == onBelts + inBuffers + consumed + delivered + scrapped
//   coins: player + bank is constant.
// Determinism: no wall clock, no global randomness — only ctx.rng.

import { createEcs, validateEcsState } from "../../src/core/next/ecs.js";
import { createGrid, inBounds, isBlocked, cellKey, DIR_BY_NAME } from "../../src/core/next/spatial.js";
import * as inv from "../../src/core/next/inventory.js";
import { createQuestLog, updateQuests, allQuestsDone, isValidQuestLog } from "../../src/core/next/quest.js";
import { defineGame } from "../../src/core/next/runtime.js";
import { saveKey } from "../../src/core/next/save.js";
import { loadGameWorld, parseTileRows } from "../../src/core/next/manifest.js";

export const GAME_ID = "star-foundry";
export const SEED = "star-foundry-m6";
export const RULE_TYPE = "game.foundry";
export const SAVE_KEY = saveKey(GAME_ID, "m6");
export const COIN = "coin";

const isInt = Number.isInteger;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPosInt = (n) => isInt(n) && n > 0;

function checkBag(bag, items, label) {
  if (!bag || typeof bag !== "object" || Object.keys(bag).length === 0) throw new Error(`star-foundry: ${label} must list at least one item`);
  for (const k of Object.keys(bag)) {
    if (!own(items, k)) throw new Error(`star-foundry: ${label} uses unknown item "${k}"`);
    if (!isPosInt(bag[k])) throw new Error(`star-foundry: ${label}.${k} must be a positive integer`);
  }
}

// Manifest -> world. Throws on any bad rule config so a broken world stops
// the game before it starts.
export function loadWorld(manifest) {
  const base = loadGameWorld(manifest, { ruleType: RULE_TYPE, projectId: GAME_ID });
  const cfg = base.config;
  const tiles = parseTileRows(cfg.grid?.rows);
  const grid = createGrid({ cols: tiles.cols, rows: tiles.rows, blocked: tiles.blocked });
  if (Object.keys(tiles.marks).length > 0) throw new Error("star-foundry: grid rows may only contain '.' and '#'");
  for (const key of ["beltTicks", "deadlineTicks"]) if (!isPosInt(cfg[key])) throw new Error(`star-foundry: ${key} must be a positive integer`);
  for (const key of ["startCoins", "bankCoins"]) if (!isInt(cfg[key]) || cfg[key] < 0) throw new Error(`star-foundry: ${key} must be a non-negative integer`);
  if (!isInt(cfg.refundPercent) || cfg.refundPercent < 0 || cfg.refundPercent > 100) throw new Error("star-foundry: refundPercent must be 0..100");
  const items = cfg.items || {};
  if (Object.keys(items).length === 0 || own(items, COIN)) throw new Error("star-foundry: items must be non-empty and must not define coin");

  const kinds = { source: { type: "source", name: "원천", cost: 0 }, depot: { type: "depot", name: "납품 창고", cost: 0 } };
  for (const kind of Object.keys(cfg.buildings || {})) {
    const b = cfg.buildings[kind];
    if (own(kinds, kind)) throw new Error(`star-foundry: building kind "${kind}" is reserved or duplicated`);
    if (b.type !== "belt" && b.type !== "machine") throw new Error(`star-foundry: building "${kind}" has unknown type "${b.type}"`);
    if (!isInt(b.cost) || b.cost < 0) throw new Error(`star-foundry: building "${kind}" cost must be a non-negative integer`);
    if (b.type === "machine") {
      if (!b.recipe) throw new Error(`star-foundry: machine "${kind}" needs a recipe`);
      checkBag(b.recipe.inputs, items, `${kind}.recipe.inputs`);
      checkBag(b.recipe.outputs, items, `${kind}.recipe.outputs`);
      if (!isPosInt(b.recipe.ticks) || !isPosInt(b.inputStacks) || !isPosInt(b.outputCap)) throw new Error(`star-foundry: machine "${kind}" needs positive recipe.ticks, inputStacks, outputCap`);
      for (const k of Object.keys(b.recipe.outputs)) if (own(b.recipe.inputs, k)) throw new Error(`star-foundry: machine "${kind}" outputs its own input "${k}"`);
    }
    kinds[kind] = b;
  }
  if (!Object.values(kinds).some((k) => k.type === "belt")) throw new Error("star-foundry: at least one belt building is required");
  const accepts = cfg.depot?.accepts || {};
  checkBag(accepts, items, "depot.accepts");

  // Fixed structures come from manifest entities (cell = [x, z]).
  const fixed = [];
  const taken = new Set();
  for (const e of base.entities) {
    const src = e.components["game.source"];
    const dep = e.components["game.depot"];
    if (!src && !dep) continue;
    if (!isInt(e.x) || !isInt(e.z) || isBlocked(grid, e.x, e.z)) throw new Error(`star-foundry: fixed entity ${e.id} is not on a free grid cell`);
    const key = cellKey(e.x, e.z);
    if (taken.has(key)) throw new Error(`star-foundry: two fixed entities share cell ${key}`);
    taken.add(key);
    if (src) {
      if (!own(items, src.item)) throw new Error(`star-foundry: source ${e.id} emits unknown item "${src.item}"`);
      if (!isPosInt(src.intervalTicks) || !isInt(src.jitterTicks) || src.jitterTicks < 0) throw new Error(`star-foundry: source ${e.id} needs intervalTicks > 0 and jitterTicks >= 0`);
      if (!own(DIR_BY_NAME, src.dir)) throw new Error(`star-foundry: source ${e.id} has bad dir "${src.dir}"`);
      fixed.push({ entityId: e.id, name: e.name, kind: "source", c: e.x, r: e.z, dir: src.dir, item: src.item, interval: src.intervalTicks, jitter: src.jitterTicks });
    } else {
      fixed.push({ entityId: e.id, name: e.name, kind: "depot", c: e.x, r: e.z, dir: "up" });
    }
  }
  if (!fixed.some((f) => f.kind === "source") || !fixed.some((f) => f.kind === "depot")) throw new Error("star-foundry: the world needs at least one source and one depot");
  if (base.questDefs.length === 0) throw new Error("star-foundry: the world needs at least one order (quest)");
  let rewardCoins = 0;
  for (const d of base.questDefs) rewardCoins += d.reward?.items?.[COIN] || 0;
  if (cfg.bankCoins < rewardCoins) throw new Error("star-foundry: bankCoins cannot cover the order rewards");

  return Object.freeze({ ...base, grid, kinds: Object.freeze(kinds), fixed: Object.freeze(fixed), buildable: Object.freeze(Object.keys(cfg.buildings)), wallKeys: Object.freeze(tiles.blocked.map(([c, r]) => cellKey(c, r))) });
}

const components = {
  Building: {
    defaults: { kind: "", c: 0, r: 0, dir: "right", fixed: false },
    validate: (d) => (typeof d.kind === "string" && d.kind && isInt(d.c) && isInt(d.r) && own(DIR_BY_NAME, d.dir) && typeof d.fixed === "boolean" ? null : "kind/c/r/dir/fixed"),
  },
  Item: { defaults: { kind: "", c: 0, r: 0 }, validate: (d) => (typeof d.kind === "string" && d.kind && isInt(d.c) && isInt(d.r) ? null : "kind/c/r") },
  Machine: { defaults: { progress: 0, active: false }, validate: (d) => (isInt(d.progress) && d.progress >= 0 && typeof d.active === "boolean" ? null : "progress/active") },
  Buffer: { defaults: { items: {}, capacity: null }, validate: (d) => (inv.isValidInventory(d) ? null : "inventory") },
  Source: { defaults: { item: "", interval: 1, jitter: 0, nextAt: 0 }, validate: (d) => (typeof d.item === "string" && isPosInt(d.interval) && isInt(d.jitter) && d.jitter >= 0 && isInt(d.nextAt) ? null : "item/interval/jitter/nextAt") },
};
const ecs = createEcs({ components });

function bump(map, kind, n = 1) { map[kind] = (map[kind] || 0) + n; }

function createState(seed, world, rng) {
  const state = {
    ecs: ecs.bind({ nextId: 1, alive: [], comps: {}, queue: [], events: [], eventSeq: 0 }).state,
    phase: "playing", // playing | won | lost
    player: inv.createInventory(world.config.startCoins > 0 ? { items: { [COIN]: world.config.startCoins } } : {}),
    bank: inv.createInventory(world.config.bankCoins > 0 ? { items: { [COIN]: world.config.bankCoins } } : {}),
    cells: {},  // "c,r" -> building entity id
    itemAt: {}, // "c,r" -> item entity id (belt cells only)
    ledger: { produced: {}, crafted: {}, consumed: {}, delivered: {}, scrapped: {} },
    built: {},
    removed: 0,
    refused: 0,
    quests: createQuestLog(world.questDefs),
  };
  for (const f of world.fixed) {
    const comps = { Building: { kind: f.kind, c: f.c, r: f.r, dir: f.dir, fixed: true } };
    // The first emission is jittered too, so seeds diverge from tick 1.
    if (f.kind === "source") comps.Source = { item: f.item, interval: f.interval, jitter: f.jitter, nextAt: f.interval + (f.jitter > 0 ? rng.int(0, f.jitter + 1) : 0) };
    state.cells[cellKey(f.c, f.r)] = ecs.spawn(comps);
  }
  return state;
}

export function coins(state) { return inv.count(state.player, COIN); }
export function coinTotal(state) { return inv.count(state.player, COIN) + inv.count(state.bank, COIN); }
export function refundFor(world, kind) { return Math.floor((world.kinds[kind].cost * world.config.refundPercent) / 100); }

// Pure placement test shared by the sim, the page (cursor colour) and tests.
// Returns { ok, reason }: phase | shape | kind | dir | bounds | wall | occupied | coins.
export function canBuild(state, world, cmd) {
  if (state.phase !== "playing") return { ok: false, reason: "phase" };
  if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) return { ok: false, reason: "shape" };
  if (typeof cmd.kind !== "string" || !world.buildable.includes(cmd.kind)) return { ok: false, reason: "kind" };
  if (typeof cmd.dir !== "string" || !own(DIR_BY_NAME, cmd.dir)) return { ok: false, reason: "dir" };
  if (!inBounds(world.grid, cmd.c, cmd.r)) return { ok: false, reason: "bounds" };
  if (isBlocked(world.grid, cmd.c, cmd.r)) return { ok: false, reason: "wall" };
  if (own(state.cells, cellKey(cmd.c, cmd.r))) return { ok: false, reason: "occupied" };
  if (coins(state) < world.kinds[cmd.kind].cost) return { ok: false, reason: "coins" };
  return { ok: true, reason: null };
}
// Returns { ok, reason }: phase | shape | bounds | empty | fixed.
export function canRemove(state, world, cmd) {
  if (state.phase !== "playing") return { ok: false, reason: "phase" };
  if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) return { ok: false, reason: "shape" };
  if (!inBounds(world.grid, cmd.c, cmd.r)) return { ok: false, reason: "bounds" };
  const key = cellKey(cmd.c, cmd.r);
  if (!own(state.cells, key)) return { ok: false, reason: "empty" };
  ecs.bind(state.ecs);
  if (ecs.get(state.cells[key], "Building").fixed) return { ok: false, reason: "fixed" };
  return { ok: true, reason: null };
}

function refuse(state, action, reason) {
  state.refused += 1;
  ecs.emit("refused", { action, reason });
}

function doBuild(state, world, cmd) {
  const verdict = canBuild(state, world, cmd);
  if (!verdict.ok) return refuse(state, "build", verdict.reason);
  const def = world.kinds[cmd.kind];
  if (def.cost > 0 && !inv.transfer(state.player, state.bank, COIN, def.cost)) return refuse(state, "build", "coins");
  const comps = { Building: { kind: cmd.kind, c: cmd.c, r: cmd.r, dir: cmd.dir, fixed: false } };
  if (def.type === "machine") {
    comps.Machine = { progress: 0, active: false };
    comps.Buffer = inv.createInventory();
  }
  const id = ecs.spawn(comps);
  state.cells[cellKey(cmd.c, cmd.r)] = id;
  bump(state.built, cmd.kind);
  ecs.emit("built", { id, kind: cmd.kind, c: cmd.c, r: cmd.r, dir: cmd.dir });
}

function doRemove(state, world, cmd) {
  const verdict = canRemove(state, world, cmd);
  if (!verdict.ok) return refuse(state, "remove", verdict.reason);
  const key = cellKey(cmd.c, cmd.r);
  const id = state.cells[key];
  const b = ecs.get(id, "Building");
  // Whatever the building holds is scrapped — and written to the ledger.
  if (own(state.itemAt, key)) {
    const itemId = state.itemAt[key];
    bump(state.ledger.scrapped, ecs.get(itemId, "Item").kind);
    ecs.despawn(itemId);
    delete state.itemAt[key];
  }
  const buf = ecs.get(id, "Buffer");
  if (buf) for (const k of Object.keys(buf.items).sort()) bump(state.ledger.scrapped, k, buf.items[k]);
  const refund = refundFor(world, b.kind);
  if (refund > 0) inv.transfer(state.bank, state.player, COIN, refund);
  const kind = b.kind;
  ecs.despawn(id);
  delete state.cells[key];
  state.removed += 1;
  ecs.emit("removed", { id, kind, c: cmd.c, r: cmd.r, refund });
}

// Offer one item of `kind` to cell (c, r). movingId is the belt item being
// moved, or null for a new item (source emission, machine output).
// Returns true when the cell took it.
function offer(state, world, kind, c, r, movingId) {
  const key = cellKey(c, r);
  if (!own(state.cells, key)) return false;
  const bid = state.cells[key];
  const def = world.kinds[ecs.get(bid, "Building").kind];
  if (def.type === "belt") {
    if (own(state.itemAt, key)) return false;
    if (movingId === null) {
      state.itemAt[key] = ecs.spawn({ Item: { kind, c, r } });
    } else {
      const it = ecs.get(movingId, "Item");
      delete state.itemAt[cellKey(it.c, it.r)];
      it.c = c;
      it.r = r;
      state.itemAt[key] = movingId;
    }
    return true;
  }
  if (def.type === "machine") {
    if (!own(def.recipe.inputs, kind)) return false;
    const buf = ecs.get(bid, "Buffer");
    if (inv.count(buf, kind) >= def.recipe.inputs[kind] * def.inputStacks) return false;
    if (!inv.add(buf, kind, 1)) return false;
  } else if (def.type === "depot") {
    if (!own(world.config.depot.accepts, kind)) return false;
    bump(state.ledger.delivered, kind);
    ecs.emit("delivered", { kind, price: world.config.depot.accepts[kind] });
  } else {
    return false;
  }
  if (movingId !== null) {
    const it = ecs.get(movingId, "Item");
    delete state.itemAt[cellKey(it.c, it.r)];
    ecs.despawn(movingId);
  }
  return true;
}

function stepSources(state, world, tick, rng) {
  ecs.each(["Building", "Source"], (id, b, src) => {
    if (tick < src.nextAt) return;
    const d = DIR_BY_NAME[b.dir];
    if (!offer(state, world, src.item, b.c + d.dc, b.r + d.dr, null)) return; // blocked: retry next tick
    bump(state.ledger.produced, src.item);
    src.nextAt = tick + src.interval + (src.jitter > 0 ? rng.int(0, src.jitter + 1) : 0);
    ecs.emit("emitted", { kind: src.item });
  });
}

function stepMachines(state, world) {
  ecs.each(["Building", "Machine", "Buffer"], (id, b, m, buf) => {
    const def = world.kinds[b.kind];
    const recipe = def.recipe;
    if (m.active) {
      m.progress += 1;
      if (m.progress >= recipe.ticks) {
        inv.craft(buf, recipe.inputs, recipe.outputs);
        for (const k of Object.keys(recipe.inputs)) bump(state.ledger.consumed, k, recipe.inputs[k]);
        for (const k of Object.keys(recipe.outputs)) bump(state.ledger.crafted, k, recipe.outputs[k]);
        m.active = false;
        m.progress = 0;
        ecs.emit("crafted", { id, kind: b.kind });
      }
    }
    if (!m.active && inv.hasAll(buf, recipe.inputs)
      && Object.keys(recipe.outputs).every((k) => inv.count(buf, k) + recipe.outputs[k] <= def.outputCap)) {
      m.active = true;
      m.progress = 0;
    }
    const d = DIR_BY_NAME[b.dir];
    for (const k of Object.keys(recipe.outputs).sort()) {
      if (inv.count(buf, k) > 0 && offer(state, world, k, b.c + d.dc, b.r + d.dr, null)) {
        inv.remove(buf, k, 1);
        break; // one item per tick
      }
    }
  });
}

function stepBelts(state, world) {
  const done = new Set();
  const chain = [];
  for (const startId of ecs.query("Item")) {
    // Walk forward along blockers, then resolve from the head backwards.
    let id = startId;
    chain.length = 0;
    while (id !== undefined && !done.has(id)) {
      done.add(id);
      chain.push(id);
      const it = ecs.get(id, "Item");
      const d = DIR_BY_NAME[ecs.get(state.cells[cellKey(it.c, it.r)], "Building").dir];
      const next = cellKey(it.c + d.dc, it.r + d.dr);
      id = own(state.itemAt, next) ? state.itemAt[next] : undefined;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const it = ecs.get(chain[i], "Item");
      const d = DIR_BY_NAME[ecs.get(state.cells[cellKey(it.c, it.r)], "Building").dir];
      offer(state, world, it.kind, it.c + d.dc, it.r + d.dr, chain[i]);
    }
  }
}

export function questStats(state) {
  const stats = { coins: coins(state), removed: state.removed };
  for (const group of ["delivered", "crafted", "produced"]) {
    for (const k of Object.keys(state.ledger[group])) stats[`${group}.${k}`] = state.ledger[group][k];
  }
  for (const k of Object.keys(state.built)) stats[`built.${k}`] = state.built[k];
  return stats;
}

function step(state, input, { rng, world, tick }) {
  ecs.bind(state.ecs);
  ecs.beginTick();
  if (state.phase !== "playing") return;

  if (own(input, "build")) doBuild(state, world, input.build);
  else if (own(input, "remove")) doRemove(state, world, input.remove);

  stepSources(state, world, tick, rng);
  stepMachines(state, world);
  if (tick % world.config.beltTicks === 0) stepBelts(state, world);

  ecs.dispatch({
    // The bank is finite: a payment it cannot cover is skipped, never minted.
    delivered: (data) => { if (data.price > 0) inv.transfer(state.bank, state.player, COIN, data.price); },
  });
  const completed = updateQuests(state.quests, world.questDefs, questStats(state), (reward) => {
    const n = reward.items?.[COIN];
    if (isPosInt(n)) inv.transfer(state.bank, state.player, COIN, n);
  });
  for (const id of completed) ecs.emit("order", { id });
  if (allQuestsDone(state.quests)) {
    state.phase = "won";
    ecs.emit("won", {});
  } else if (tick >= world.config.deadlineTicks) {
    state.phase = "lost";
    ecs.emit("lost", {});
  }
  ecs.dispatch();
}

// --- Read helpers (pure) ------------------------------------------------
export function listBuildings(state) {
  ecs.bind(state.ecs);
  return ecs.query("Building").map((id) => {
    const b = ecs.get(id, "Building");
    const m = ecs.get(id, "Machine");
    const buf = ecs.get(id, "Buffer");
    return { id, kind: b.kind, c: b.c, r: b.r, dir: b.dir, fixed: b.fixed, active: m ? m.active : false, progress: m ? m.progress : 0, buffer: buf ? { ...buf.items } : null };
  });
}
export function listItems(state) {
  ecs.bind(state.ecs);
  return ecs.query("Item").map((id) => ({ id, ...ecs.get(id, "Item") }));
}
export function buildingAt(state, c, r) {
  const key = cellKey(c, r);
  if (!own(state.cells, key)) return null;
  ecs.bind(state.ecs);
  return { id: state.cells[key], ...ecs.get(state.cells[key], "Building") };
}

// Per-item conservation ledger. balanced is true when nothing was lost or
// duplicated: produced + crafted == onBelts + inBuffers + consumed + delivered + scrapped.
export function itemLedger(state, world) {
  ecs.bind(state.ecs);
  const out = {};
  for (const k of Object.keys(world.config.items)) {
    out[k] = { produced: state.ledger.produced[k] || 0, crafted: state.ledger.crafted[k] || 0, consumed: state.ledger.consumed[k] || 0, delivered: state.ledger.delivered[k] || 0, scrapped: state.ledger.scrapped[k] || 0, onBelts: 0, inBuffers: 0 };
  }
  ecs.each(["Item"], (id, it) => { if (out[it.kind]) out[it.kind].onBelts += 1; });
  ecs.each(["Buffer"], (id, buf) => { for (const k of Object.keys(buf.items)) if (out[k]) out[k].inBuffers += buf.items[k]; });
  let balanced = true;
  for (const k of Object.keys(out)) {
    const e = out[k];
    e.balanced = e.produced + e.crafted === e.onBelts + e.inBuffers + e.consumed + e.delivered + e.scrapped;
    if (!e.balanced) balanced = false;
  }
  return { items: out, balanced };
}

function isCountMap(map) {
  return !!map && typeof map === "object" && !Array.isArray(map) && Object.keys(map).every((k) => isInt(map[k]) && map[k] >= 0);
}

function validateState(state, world) {
  if (!["playing", "won", "lost"].includes(state.phase)) return "phase";
  const ecsErr = validateEcsState(state.ecs, ecs.specs());
  if (ecsErr) return `ecs: ${ecsErr}`;
  if (!inv.isValidInventory(state.player) || !inv.isValidInventory(state.bank)) return "coins";
  if (coinTotal(state) !== world.config.startCoins + world.config.bankCoins) return "coin total";
  if (!isValidQuestLog(state.quests, world.questDefs)) return "quests";
  if (!state.ledger || !["produced", "crafted", "consumed", "delivered", "scrapped"].every((g) => isCountMap(state.ledger[g]))) return "ledger";
  if (!isCountMap(state.built) || !isInt(state.removed) || state.removed < 0 || !isInt(state.refused) || state.refused < 0) return "counters";
  if (!isCountMap(state.cells) || !isCountMap(state.itemAt)) return "cell index";
  const buildings = state.ecs.comps.Building || {};
  const items = state.ecs.comps.Item || {};
  for (const name of ["Building", "Item", "Machine", "Buffer", "Source"]) {
    const store = state.ecs.comps[name] || {};
    for (const id of Object.keys(store)) {
      const err = components[name].validate(store[id]);
      if (err) return `${name}[${id}]: ${err}`;
    }
  }
  if (Object.keys(buildings).length !== Object.keys(state.cells).length) return "cell index size";
  for (const id of Object.keys(buildings)) {
    const b = buildings[id];
    if (!own(world.kinds, b.kind) || isBlocked(world.grid, b.c, b.r) || state.cells[cellKey(b.c, b.r)] !== Number(id)) return `building ${id}`;
    const type = world.kinds[b.kind].type;
    if ((type === "machine") !== (own(state.ecs.comps.Machine || {}, id) && own(state.ecs.comps.Buffer || {}, id))) return `machine parts ${id}`;
    if ((type === "source") !== own(state.ecs.comps.Source || {}, id)) return `source parts ${id}`;
    if (b.fixed !== (type === "source" || type === "depot")) return `fixed flag ${id}`;
  }
  for (const f of world.fixed) {
    const id = state.cells[cellKey(f.c, f.r)];
    if (id === undefined || buildings[id].kind !== f.kind) return `fixed structure missing at ${f.c},${f.r}`;
  }
  if (Object.keys(items).length !== Object.keys(state.itemAt).length) return "item index size";
  for (const id of Object.keys(items)) {
    const it = items[id];
    const key = cellKey(it.c, it.r);
    if (!own(world.config.items, it.kind) || state.itemAt[key] !== Number(id)) return `item ${id}`;
    if (!own(state.cells, key) || world.kinds[buildings[state.cells[key]].kind].type !== "belt") return `item ${id} is not on a belt`;
  }
  if (!itemLedger(state, world).balanced) return "item ledger does not balance";
  return null;
}

export const game = defineGame({
  id: GAME_ID,
  version: 1,
  createState,
  step,
  validateState,
  summarize(state, world) {
    return {
      phase: state.phase,
      coins: coins(state),
      delivered: { ...state.ledger.delivered },
      buildings: Object.keys(state.cells).length,
      items: Object.keys(state.itemAt).length,
      ordersDone: state.quests.filter((q) => q.done).length,
      ticksLeft: Math.max(0, world.config.deadlineTicks - state.tick),
    };
  },
});

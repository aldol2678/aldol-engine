// ENGINE-NEXT-01 shared core checks (G3): normal / boundary / error cases
// for every module under src/core/next/. Run: node --experimental-vm-modules tools/check-next.mjs (or node tools/check-next-all.mjs)
import { createChecker, syntaxChecks, bannedApiChecks, browserModuleSyntaxChecks, readJson } from "./next/harness.mjs";
import { Rng } from "../src/core/rng.js";
import { stateHash } from "../src/core/state-hash.js";
import { buildNavmesh } from "../src/core/navmesh.js";
import { validateWorldManifest } from "../src/core/worldforge.js";
import { createEcs, createEcsState, createScheduler, validateEcsState } from "../src/core/next/ecs.js";
import { TICK, CountedRng, defineGame, inputAt, normalizeInput, createRecorder, replay } from "../src/core/next/runtime.js";
import * as sp from "../src/core/next/spatial.js";
import { defineFsm, createFsmState, updateFsm, ticksInState, isValidFsmState } from "../src/core/next/fsm.js";
import * as inv from "../src/core/next/inventory.js";
import * as cb from "../src/core/next/combat.js";
import { questDefsFromManifest, createQuestLog, updateQuests, allQuestsDone, isValidQuestLog } from "../src/core/next/quest.js";
import { serializeSave, parseSave, saveKey, SAVE_FORMAT, MAX_SAVE_CHARS } from "../src/core/next/save.js";
import { loadGameWorld, parseTileRows } from "../src/core/next/manifest.js";

const t = createChecker();
const { check, throws } = t;

const CORE = ["ecs", "runtime", "spatial", "fsm", "inventory", "combat", "quest", "save", "manifest", "index"].map((n) => `src/core/next/${n}.js`);
syntaxChecks(check, [...CORE, "tools/next/harness.mjs"]);
bannedApiChecks(check, CORE);
browserModuleSyntaxChecks(check, ["src/render/next/board.js", "src/render/next/shell.js"]);

// ---------------------------------------------------------------- ECS
{
  const components = {
    Pos: { defaults: { x: 0, z: 0 }, validate: (d) => (Number.isFinite(d.x) && Number.isFinite(d.z) ? null : "x/z must be numbers") },
    Tag: { defaults: { kind: "none" } },
    Hp: { validate: (d) => (Number.isInteger(d.hp) ? null : "hp") },
  };
  const ecs = createEcs({ components });
  const a = ecs.spawn({ Pos: { x: 1 }, Tag: { kind: "a" } });
  const b = ecs.spawn({ Pos: { x: 2, z: 5 } });
  const c = ecs.spawn({ Tag: { kind: "c" } });
  check("ecs ids are stable ascending integers", a === 1 && b === 2 && c === 3);
  check("ecs defaults merged", ecs.get(a, "Pos").z === 0 && ecs.get(b, "Pos").z === 5);
  check("ecs query is ascending and exact", JSON.stringify(ecs.query("Pos")) === "[1,2]" && JSON.stringify(ecs.query("Pos", "Tag")) === "[1]" && JSON.stringify(ecs.query("Tag")) === "[1,3]");
  check("ecs despawn removes entity and its components", ecs.despawn(a) && !ecs.isAlive(a) && ecs.get(a, "Pos") === null && ecs.count() === 2);
  check("ecs despawn of dead entity is a no-op", ecs.despawn(a) === false && ecs.despawn(999) === false);
  const d = ecs.spawn({ Pos: {} });
  check("ecs ids are never reused", d === 4 && JSON.stringify(ecs.ids()) === "[2,3,4]");
  throws("ecs unknown component rejected", () => ecs.spawn({ Nope: {} }), /unknown component/);
  throws("ecs component validation rejects bad data", () => ecs.spawn({ Pos: { x: "left" } }), /invalid "Pos"/);
  check("ecs failed spawn is atomic (no id consumed)", ecs.state.nextId === 5 && ecs.count() === 3);
  throws("ecs non-object component data rejected", () => ecs.set(b, "Pos", 7), /plain object/);
  throws("ecs set on dead entity rejected", () => ecs.set(a, "Pos", { x: 1 }), /not alive/);
  throws("ecs bad component name rejected", () => createEcs({ components: { "9bad": {} } }), /bad component name/);
  check("ecs remove component", ecs.remove(b, "Pos") === true && ecs.remove(b, "Pos") === false && ecs.has(b, "Pos") === false);

  // Component data is copied in: mutating the source must not leak.
  const src = { x: 1, z: 1 };
  const e = ecs.spawn({ Pos: src });
  src.x = 99;
  check("ecs copies component data on spawn", ecs.get(e, "Pos").x === 1);

  // Spawn / despawn while iterating.
  const w = createEcs({ components });
  for (let i = 0; i < 6; i++) w.spawn({ Pos: { x: i } });
  const seen = [];
  w.each(["Pos"], (id, pos) => {
    seen.push(id);
    if (id === 2) { w.despawn(3); w.spawn({ Pos: { x: 100 } }); }
  });
  check("ecs each: despawned entity skipped, spawned entity not visited this pass", JSON.stringify(seen) === "[1,2,4,5,6]", JSON.stringify(seen));
  check("ecs find returns first match", w.find(["Pos"], (id, pos) => pos.x >= 4) === 5 && w.find(["Pos"], () => false) === null);

  // Events: FIFO, handler-emitted events delivered in the same dispatch.
  const order = [];
  w.emit("a", { n: 1 });
  w.emit("b", { n: 2 });
  w.emit("a", { n: 3 });
  const delivered = w.dispatch({
    a: (data) => { order.push(`a${data.n}`); if (data.n === 1) w.emit("c", { n: 4 }); },
    b: [(data) => order.push(`b${data.n}`), (data) => order.push(`b${data.n}'`)],
    c: (data) => order.push(`c${data.n}`),
  });
  check("ecs events delivered FIFO incl. nested emits", order.join(",") === "a1,b2,b2',a3,c4" && delivered === 4, order.join(","));
  check("ecs event log keeps seq order", w.state.events.map((ev) => ev.seq).join(",") === "1,2,3,4" && w.state.queue.length === 0);
  w.beginTick();
  check("ecs beginTick clears the event log", w.state.events.length === 0 && w.state.eventSeq === 4);
  throws("ecs event storm is cut off", () => { w.emit("loop"); w.dispatch({ loop: () => w.emit("loop") }); }, /event storm/);
  throws("ecs empty event type rejected", () => w.emit(""), /non-empty/);

  // Same operations -> same hash; state survives JSON and can be swapped in.
  const build = () => {
    const x = createEcs({ components });
    for (let i = 0; i < 20; i++) x.spawn({ Pos: { x: i, z: -i }, Tag: { kind: i % 2 ? "odd" : "even" } });
    for (const id of [3, 7, 11]) x.despawn(id);
    x.emit("built", { n: 17 });
    return x;
  };
  const h1 = stateHash(build().state);
  check("ecs same operations give same hash", h1 === stateHash(build().state), h1);
  const restored = createEcs({ components });
  restored.state = JSON.parse(JSON.stringify(build().state));
  check("ecs state round-trips through JSON", stateHash(restored.state) === h1 && restored.spawn({ Pos: {} }) === 21);
  throws("ecs rejects state with component on dead entity", () => { const bad = JSON.parse(JSON.stringify(build().state)); bad.comps.Pos[3] = { x: 0, z: 0 }; createEcs({ components }).state = bad; }, /dead entity/);
  throws("ecs rejects state with duplicate/unsorted ids", () => { const bad = createEcsState(); bad.nextId = 5; bad.alive = [2, 2]; createEcs({ components }).state = bad; }, /alive id/);
  throws("ecs rejects state with unknown component store", () => { const bad = createEcsState(); bad.comps.Ghost = {}; createEcs({ components }).state = bad; }, /unknown component/);
  const rebound = createEcs({ components });
  check("ecs bind() retargets without copying", rebound.bind(restored.state).count() === restored.count() && rebound.state === restored.state && validateEcsState(restored.state, rebound.specs()) === null);
  check("validateEcsState accepts fresh state", validateEcsState(createEcsState()) === null && validateEcsState(null) !== null);

  // Scheduler order: (order, registration), duplicates rejected.
  const sched = createScheduler();
  const ran = [];
  sched.add("late", () => ran.push("late"), { order: 10 });
  sched.add("first", () => ran.push("first"), { order: -1 });
  sched.add("mid-a", () => ran.push("mid-a"));
  sched.add("mid-b", () => ran.push("mid-b"));
  sched.run({});
  check("scheduler runs in (order, registration) order", ran.join(",") === "first,mid-a,mid-b,late" && sched.list().join(",") === "first,mid-a,mid-b,late");
  throws("scheduler rejects duplicate system name", () => sched.add("late", () => {}), /duplicate system/);
  throws("scheduler rejects non-function", () => sched.add("x", null), /needs a function/);
  throws("scheduler rejects NaN order", () => sched.add("y", () => {}, { order: NaN }), /finite/);
}

// ------------------------------------------------------------ runtime
{
  check("TICK is 1/60", TICK === 1 / 60);
  // CountedRng yields the exact stream of the shared Rng.
  const plain = new Rng("next-seed");
  const counted = new CountedRng("next-seed");
  let sameStream = true;
  for (let i = 0; i < 200; i++) if (plain.next() !== counted.next()) sameStream = false;
  check("CountedRng matches shared Rng stream", sameStream && counted.draws === 200);
  const resumedRng = new CountedRng("next-seed", 200);
  check("CountedRng fast-forward resumes the stream", resumedRng.next() === plain.next() && resumedRng.draws === 201);
  const viaHelpers = new CountedRng("h");
  viaHelpers.int(0, 10); viaHelpers.pick([1, 2, 3]); viaHelpers.shuffle([1, 2, 3, 4]); viaHelpers.float();
  check("CountedRng counts int/pick/shuffle/float draws", viaHelpers.draws === 6, `draws=${viaHelpers.draws}`);
  check("CountedRng fork is independent of the parent count", new CountedRng("h").fork("x").next() === new Rng("h").fork("x").next());
  throws("CountedRng rejects negative draws", () => new CountedRng("h", -1), /non-negative/);

  check("normalizeInput drops non-objects", JSON.stringify([null, 5, "x", [1], undefined].map(normalizeInput)) === "[{},{},{},{},{}]");
  check("inputAt handles array / holes / pairs / Map / object",
    inputAt([{ a: 1 }, , { a: 3 }], 1).a === undefined && inputAt([{ a: 1 }], 0).a === 1 && inputAt([{ a: 1 }], 99).a === undefined
    && inputAt({ pairs: [[4, { b: 2 }]] }, 4).b === 2 && inputAt({ pairs: [[4, { b: 2 }]] }, 5).b === undefined
    && inputAt(new Map([[2, { c: 3 }]]), 2).c === 3 && inputAt({ 7: { d: 4 } }, 7).d === 4 && inputAt(null, 0).d === undefined);

  const counter = defineGame({
    id: "counter", version: 1,
    createState: () => ({ n: 0, rolls: [] }),
    step(state, input, { rng }) {
      if (Number.isInteger(input.add)) state.n += input.add;
      if (input.roll) state.rolls.push(rng.int(0, 1000));
    },
    validateState: (s) => (Number.isInteger(s.n) && Array.isArray(s.rolls) ? null : "counter shape"),
    summarize: (s) => ({ n: s.n }),
  });
  throws("defineGame rejects bad id", () => defineGame({ id: "Bad Id", version: 1, createState() {}, step() {} }), /kebab-case/);
  throws("defineGame rejects bad version", () => defineGame({ id: "x", version: 0, createState() {}, step() {} }), /version/);
  throws("defineGame requires step", () => defineGame({ id: "x", version: 1, createState() {} }), /required/);

  const inputs = [];
  for (let f = 0; f < 300; f++) inputs.push(f % 3 === 0 ? { add: 1, roll: f % 2 === 0 } : f % 50 === 7 ? "garbage" : {});
  const s1 = counter.simulate("seed-a", 300, inputs, null);
  const s2 = counter.simulate("seed-a", 300, inputs, null);
  const s3 = counter.simulate("seed-b", 300, inputs, null);
  check("runtime same (seed, frames, inputs) -> same hash", counter.hash(s1) === counter.hash(s2), counter.hash(s1));
  check("runtime different seed -> different hash", counter.hash(s1) !== counter.hash(s3));
  check("runtime owns tick/seed/rngDraws", s1.tick === 300 && s1.seed === "seed-a" && s1.rngDraws === s1.rolls.length && s1.n === 100);

  const session = counter.start("seed-a", null);
  const rec = createRecorder(counter, "seed-a", { checkpointEvery: 60 });
  for (let f = 0; f < 300; f++) { counter.step(session, inputs[f]); rec.capture(session, inputs[f]); }
  const record = rec.finish(session);
  check("recorder stores only non-empty inputs + checkpoints", record.inputs.length === 100 && record.checkpoints.length === 5 && record.finalHash === counter.hash(s1));
  const rp = replay(counter, JSON.parse(JSON.stringify(record)), null);
  check("replay reproduces the final hash", rp.ok && rp.hash === counter.hash(s1));
  const tampered = JSON.parse(JSON.stringify(record));
  tampered.inputs[10][1].add = 5;
  const bad = replay(counter, tampered, null);
  check("replay detects a changed input at the first diverging checkpoint", !bad.ok && bad.mismatch === 60, String(bad.mismatch));
  check("replay rejects other game / version / malformed record",
    replay(counter, { ...record, game: "other" }, null).mismatch === "game"
    && replay(counter, { ...record, version: 2 }, null).mismatch === "version"
    && replay(counter, { ...record, frames: -1 }, null).mismatch === "record"
    && replay(counter, null, null).ok === false);

  // Snapshot/restore mid-run continues the same RNG stream.
  const live = counter.start("seed-a", null);
  for (let f = 0; f < 137; f++) counter.step(live, inputs[f]);
  const snap = JSON.parse(JSON.stringify(counter.snapshot(live)));
  const resumed = counter.restore(snap, null);
  for (let f = 137; f < 300; f++) counter.step(resumed, inputs[f]);
  check("restore continues to the same final hash", counter.hash(resumed) === counter.hash(s1));
  counter.step(live, { add: 1000 });
  check("snapshot is isolated from the live session", snap.n !== live.state.n);
  throws("restore rejects invalid state", () => counter.restore({ tick: 1, seed: "s", rngDraws: 0, n: "x", rolls: [] }, null), /cannot restore/);
  throws("restore rejects missing tick", () => counter.restore({ seed: "s", rngDraws: 0, n: 1, rolls: [] }, null), /tick/);
  const ins = counter.inspect(session);
  check("inspect returns JSON status", ins.game === "counter" && ins.tick === 300 && ins.hash === counter.hash(s1) && ins.summary.n === 100 && JSON.stringify(ins).length > 0);
}

// ------------------------------------------------------------ spatial
{
  const parsed = parseTileRows([
    "#######",
    "#..#..#",
    "#..#..#",
    "#.....#",
    "#######",
  ]);
  const grid = sp.createGrid({ cols: parsed.cols, rows: parsed.rows, blocked: parsed.blocked });
  check("grid bounds and blocked cells", sp.inBounds(grid, 0, 0) && !sp.inBounds(grid, 7, 0) && !sp.inBounds(grid, -1, 2) && !sp.inBounds(grid, 1.5, 1)
    && sp.isBlocked(grid, 0, 0) && sp.isBlocked(grid, 3, 1) && !sp.isBlocked(grid, 1, 1) && sp.isBlocked(grid, 99, 99));
  throws("grid rejects out-of-bounds blocked cell", () => sp.createGrid({ cols: 2, rows: 2, blocked: [[2, 0]] }), /out of bounds/);
  throws("grid rejects zero size", () => sp.createGrid({ cols: 0, rows: 2 }), /positive integers/);
  const path = sp.findPath(grid, { c: 1, r: 1 }, { c: 5, r: 1 });
  check("findPath goes around the wall (shortest)", path && path.length === 8 && path[path.length - 1].c === 5 && path[path.length - 1].r === 1, JSON.stringify(path));
  check("findPath is deterministic", JSON.stringify(path) === JSON.stringify(sp.findPath(grid, { c: 1, r: 1 }, { c: 5, r: 1 })));
  // Tie-break: two equal-length routes -> DIRS4 order (up, right, down, left) decides.
  const open = sp.createGrid({ cols: 3, rows: 3 });
  check("findPath tie-break follows DIRS4 order", JSON.stringify(sp.findPath(open, { c: 0, r: 0 }, { c: 1, r: 1 })) === JSON.stringify([{ c: 1, r: 0 }, { c: 1, r: 1 }]));
  check("findPath same cell is empty path", sp.findPath(grid, { c: 1, r: 1 }, { c: 1, r: 1 }).length === 0);
  check("findPath to wall / out of bounds is null", sp.findPath(grid, { c: 1, r: 1 }, { c: 3, r: 1 }) === null && sp.findPath(grid, { c: 1, r: 1 }, { c: 50, r: 1 }) === null && sp.findPath(grid, { c: -1, r: 1 }, { c: 1, r: 1 }) === null);
  const occupied = (c, r) => c === 3 && r === 3;
  check("findPath respects dynamic occupancy", sp.findPath(grid, { c: 1, r: 1 }, { c: 5, r: 1 }, { isOccupied: occupied }) === null);
  check("findPath allowOccupiedGoal reaches an occupied goal", sp.findPath(grid, { c: 1, r: 3 }, { c: 3, r: 3 }, { isOccupied: occupied, allowOccupiedGoal: true }).length === 2
    && sp.findPath(grid, { c: 1, r: 3 }, { c: 3, r: 3 }, { isOccupied: occupied }) === null);
  check("findPath maxCost boundary", sp.findPath(grid, { c: 1, r: 1 }, { c: 5, r: 1 }, { maxCost: 8 }).length === 8 && sp.findPath(grid, { c: 1, r: 1 }, { c: 5, r: 1 }, { maxCost: 7 }) === null);
  const reach = sp.floodFill(grid, { c: 1, r: 1 }, { maxCost: 2 });
  check("floodFill respects maxCost and visit order", reach.length === 5 && reach[0].cost === 0 && reach.every((n) => n.cost <= 2) && `${reach[1].c},${reach[1].r}` === "2,1", JSON.stringify(reach.map((n) => [n.c, n.r, n.cost])));
  check("floodFill from outside is empty", sp.floodFill(grid, { c: -3, r: 0 }).length === 0);
  check("lineOfSight blocked by wall, clear along the corridor", sp.lineOfSight(grid, { c: 1, r: 1 }, { c: 5, r: 1 }) === false && sp.lineOfSight(grid, { c: 1, r: 3 }, { c: 5, r: 3 }) === true
    && sp.lineOfSight(grid, { c: 1, r: 3 }, { c: 5, r: 3 }, (c, r) => c === 3 && r === 3) === false && sp.lineOfSight(grid, { c: 1, r: 1 }, { c: 1, r: 1 }) === true);
  check("distance helpers", sp.manhattan({ c: 0, r: 0 }, { c: 3, r: -4 }) === 7 && sp.chebyshev({ c: 0, r: 0 }, { c: 3, r: -4 }) === 4);
  const g2 = sp.createGrid({ cols: 4, rows: 4, cellSize: 2, originX: -3, originZ: -3 });
  const wpos = sp.cellToWorld(g2, 2, 1);
  check("cell <-> world round-trip", wpos.x === 1 && wpos.z === -1 && sp.worldToCell(g2, 1.4, -0.7).c === 2 && sp.worldToCell(g2, 1.4, -0.7).r === 1);

  check("circle overlap (touching is not overlap)", sp.circlesOverlap({ x: 0, z: 0, r: 1 }, { x: 1.9, z: 0, r: 1 }) && !sp.circlesOverlap({ x: 0, z: 0, r: 1 }, { x: 2, z: 0, r: 1 }));
  const box = { minX: 0, minZ: 0, maxX: 2, maxZ: 2 };
  check("aabb overlap (touching is not overlap)", sp.aabbOverlap(box, { minX: 1, minZ: 1, maxX: 3, maxZ: 3 }) && !sp.aabbOverlap(box, { minX: 2, minZ: 0, maxX: 3, maxZ: 2 }));
  check("circle vs aabb", sp.circleAabbOverlap({ x: 2.4, z: 1, r: 0.5 }, box) && !sp.circleAabbOverlap({ x: 2.5, z: 1, r: 0.5 }, box) && sp.circleAabbOverlap({ x: 1, z: 1, r: 0.1 }, box) && sp.pointInAabb(2, 2, box) && !sp.pointInAabb(2.01, 2, box));
  const slid = sp.moveCircle({ x: -1, z: 1, r: 0.5 }, 1, 0.5, [box]);
  check("moveCircle slides along a wall", slid.hitX === true && slid.hitZ === false && slid.x === -1 && slid.z === 1.5, JSON.stringify(slid));
  const free = sp.moveCircle({ x: -3, z: 1, r: 0.5 }, 1, 0, [box]);
  check("moveCircle moves freely when clear", free.x === -2 && !free.hitX);

  const hash = sp.createSpatialHash(2);
  [[5, 0, 0], [2, 1, 0], [9, 10, 10], [1, -1, 0.5], [7, 3.9, 0]].forEach(([id, x, z]) => hash.insert(id, x, z, 0.5));
  check("spatial hash query is sorted by id", JSON.stringify(hash.queryCircle(0, 0, 1.6)) === "[1,2,5]", JSON.stringify(hash.queryCircle(0, 0, 1.6)));
  check("spatial hash query boundary and far items", hash.queryCircle(0, 0, 3.4).includes(7) === false && hash.queryCircle(0, 0, 3.5).includes(7) && hash.queryCircle(50, 50, 1).length === 0);
  throws("spatial hash rejects duplicate id", () => hash.insert(5, 1, 1), /duplicate id/);
  hash.insert(3, 0, 1, 0.5);
  check("spatial hash nearest: tie goes to the smaller id", hash.nearest(0.5, 0.5).id === 2 && hash.nearest(0.5, 1).id === 3 && hash.nearest(0, 0, 0.4).id === 5 && hash.nearest(40, 40, 3) === null && hash.nearest(0, 0, Infinity, (id) => id === 9).id === 9);
  hash.clear();
  check("spatial hash clear", hash.size === 0 && hash.queryCircle(0, 0, 5).length === 0);
  // Load: 1000 circles, hash query equals brute force.
  const rng = new Rng("spatial-load");
  const big = sp.createSpatialHash(3);
  const all = [];
  for (let i = 1; i <= 1000; i++) { const it = { id: i, x: rng.float() * 100, z: rng.float() * 100, r: 0.4 }; all.push(it); big.insert(it.id, it.x, it.z, it.r); }
  let agree = true;
  for (let q = 0; q < 50; q++) {
    const c = { x: rng.float() * 100, z: rng.float() * 100, r: 1 + rng.float() * 6 };
    const brute = all.filter((it) => sp.circlesOverlap(c, it)).map((it) => it.id);
    if (JSON.stringify(brute) !== JSON.stringify(big.queryCircle(c.x, c.z, c.r))) agree = false;
  }
  check("spatial hash matches brute force on 1000 circles x 50 queries", agree);

  // NavProvider: same interface over the tile grid and the existing navmesh.
  const gnav = sp.gridNav(grid);
  const gp = gnav.findPath({ x: 1, z: 1 }, { x: 5, z: 1 });
  check("gridNav implements NavProvider", gnav.isWalkable(1, 1) && !gnav.isWalkable(3, 1) && gp.length === 8 && gp[7].x === 5 && gp[7].z === 1);
  const mesh = buildNavmesh({ bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 }, obstacles: [{ x: 0, y: 0, radius: 1.5 }] });
  const mnav = sp.navmeshNav(mesh);
  const mp = mnav.findPath({ x: -4, z: 0 }, { x: 4, z: 0 });
  check("navmeshNav reuses src/core/navmesh.js behind the same interface", mnav.isWalkable(-4, 0) && !mnav.isWalkable(0, 0) && Array.isArray(mp) && mp.length >= 2 && mp.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z)), `points=${mp && mp.length}`);
}

// ---------------------------------------------------------------- FSM
{
  const guard = defineFsm({
    id: "guard", initial: "idle",
    states: {
      idle: { transitions: [{ to: "flee", when: (c) => c.hp < 3 }, { to: "chase", when: (c) => c.dist <= 5 }] },
      chase: { transitions: [{ to: "flee", when: (c) => c.hp < 3 }, { to: "attack", when: (c) => c.dist <= 1 }, { to: "idle", when: (c) => c.dist > 5 }] },
      attack: { transitions: [{ to: "chase", when: (c) => c.dist > 1 }] },
      flee: { transitions: [] },
    },
  });
  const fs = createFsmState(guard);
  check("fsm stays put when nothing matches", updateFsm(guard, fs, { hp: 10, dist: 9 }, 1).changed === false && fs.state === "idle");
  const r1 = updateFsm(guard, fs, { hp: 10, dist: 5 }, 2);
  check("fsm boundary transition (dist == 5)", r1.changed && r1.from === "idle" && r1.to === "chase" && fs.since === 2 && fs.prev === "idle");
  check("fsm one transition per update", updateFsm(guard, fs, { hp: 10, dist: 1 }, 3).to === "attack" && fs.state === "attack");
  check("fsm first matching transition wins (priority by order)", (() => { const f = createFsmState(guard); updateFsm(guard, f, { hp: 1, dist: 1 }, 1); return f.state === "flee"; })());
  check("fsm ticksInState", ticksInState(fs, 10) === 7);
  check("fsm terminal state never leaves", (() => { const f = { state: "flee", since: 0, prev: null }; return updateFsm(guard, f, { hp: 99, dist: 0 }, 5).changed === false; })());
  check("fsm state is plain JSON", stateHash(fs) === stateHash(JSON.parse(JSON.stringify(fs))) && isValidFsmState(guard, fs) && !isValidFsmState(guard, { state: "nope", since: 0, prev: null }));
  throws("fsm rejects unknown target state", () => defineFsm({ id: "x", initial: "a", states: { a: { transitions: [{ to: "zzz", when: () => true }] } } }), /unknown state/);
  throws("fsm rejects unknown initial state", () => defineFsm({ id: "x", initial: "q", states: { a: {} } }), /initial state/);
  throws("fsm rejects transition without when()", () => defineFsm({ id: "x", initial: "a", states: { a: { transitions: [{ to: "a" }] } } }), /when/);
  throws("fsm update on corrupted state throws", () => updateFsm(guard, { state: "ghost", since: 0, prev: null }, {}, 1), /unknown state/);
}

// ---------------------------------------------------------- inventory
{
  const a = inv.createInventory({ capacity: 10, items: { ore: 4, coin: 3 } });
  const b = inv.createInventory({ capacity: 5 });
  const totalOf = (item) => inv.count(a, item) + inv.count(b, item);
  check("inventory initial counts", inv.count(a, "ore") === 4 && inv.total(a) === 7 && inv.freeSpace(a) === 3 && inv.count(a, "nope") === 0);
  check("inventory add up to capacity boundary", inv.add(a, "ore", 3) && inv.total(a) === 10 && inv.add(a, "ore", 1) === false && inv.total(a) === 10);
  check("inventory remove is all-or-nothing", inv.remove(a, "coin", 4) === false && inv.count(a, "coin") === 3 && inv.remove(a, "coin", 3) && !("coin" in a.items));
  check("inventory transfer conserves items", inv.transfer(a, b, "ore", 5) && totalOf("ore") === 7 && inv.count(b, "ore") === 5);
  check("inventory transfer refused when target is full", inv.transfer(a, b, "ore", 1) === false && totalOf("ore") === 7);
  check("inventory transfer refused when source lacks items", inv.transfer(b, a, "ore", 6) === false && inv.transfer(a, a, "ore", 1) === false);
  throws("inventory rejects zero quantity", () => inv.add(a, "ore", 0), /positive integer/);
  throws("inventory rejects negative quantity", () => inv.remove(a, "ore", -1), /positive integer/);
  throws("inventory rejects fractional quantity", () => inv.transfer(a, b, "ore", 0.5), /positive integer/);
  throws("inventory rejects __proto__ item id", () => inv.add(a, "__proto__", 1), /bad item id/);
  throws("inventory rejects over-capacity initial items", () => inv.createInventory({ capacity: 1, items: { x: 2 } }), /exceed capacity/);

  const m = inv.createInventory({ capacity: 4, items: { ore: 4 } });
  check("craft consumes inputs and produces outputs atomically", inv.craft(m, { ore: 2 }, { ingot: 1 }) && inv.count(m, "ore") === 2 && inv.count(m, "ingot") === 1);
  check("craft refused without inputs (nothing changes)", inv.craft(m, { ore: 3 }, { ingot: 1 }) === false && inv.count(m, "ore") === 2 && inv.count(m, "ingot") === 1);
  check("craft refused when outputs do not fit", inv.craft(m, { ore: 1 }, { slag: 5 }) === false && inv.count(m, "ore") === 2);

  const shop = inv.createInventory({ items: { lamp: 2, coin: 0 + 1 } });
  const buyer = inv.createInventory({ capacity: 6, items: { coin: 5 } });
  const before = { coin: inv.count(shop, "coin") + inv.count(buyer, "coin"), lamp: inv.count(shop, "lamp") + inv.count(buyer, "lamp") };
  check("trade swaps both sides", inv.trade(buyer, shop, { coin: 3 }, { lamp: 1 }) && inv.count(buyer, "lamp") === 1 && inv.count(shop, "coin") === 4);
  check("trade refused when a side cannot pay", inv.trade(buyer, shop, { coin: 3 }, { lamp: 1 }) === false && inv.trade(buyer, shop, { coin: 1 }, { lamp: 5 }) === false);
  check("trade conserves every item", inv.count(shop, "coin") + inv.count(buyer, "coin") === before.coin && inv.count(shop, "lamp") + inv.count(buyer, "lamp") === before.lamp);
  const tiny = inv.createInventory({ capacity: 2, items: { coin: 2 } });
  check("trade refused when receiver has no room (nothing moves)", inv.trade(tiny, shop, { coin: 1 }, { lamp: 1, coin: 1 }) === false && inv.count(tiny, "coin") === 2);
  check("inventory validity check", inv.isValidInventory(a) && !inv.isValidInventory({ items: { x: -1 }, capacity: null }) && !inv.isValidInventory({ items: { x: 5 }, capacity: 2 }) && !inv.isValidInventory(null));
  check("empty stacks are deleted (canonical hash)", stateHash(inv.createInventory()) === stateHash((() => { const x = inv.createInventory(); inv.add(x, "k", 2); inv.remove(x, "k", 2); return x; })()));
}

// ------------------------------------------------------------- combat
{
  const hp = cb.createHealth(10);
  check("damage reduces hp", cb.applyDamage(hp, 4).dealt === 4 && hp.hp === 6);
  check("armor subtracts, minimum 1 damage", cb.applyDamage(hp, 3, { armor: 5 }).dealt === 1 && hp.hp === 5);
  const kill = cb.applyDamage(hp, 99);
  check("lethal damage clamps at 0 and reports overkill", kill.killed && kill.dealt === 5 && kill.overkill === 94 && hp.hp === 0 && cb.isDead(hp));
  check("dead target takes no more damage and cannot be healed", cb.applyDamage(hp, 5).dealt === 0 && cb.heal(hp, 5) === 0 && hp.hp === 0);
  const hp2 = cb.createHealth(10, 7);
  check("heal clamps at max", cb.heal(hp2, 99) === 3 && hp2.hp === 10 && cb.heal(hp2, 1) === 0);
  check("zero damage is a no-op", cb.applyDamage(hp2, 0).dealt === 0 && hp2.hp === 10);
  throws("negative damage rejected", () => cb.applyDamage(hp2, -1), /non-negative/);
  throws("NaN damage rejected", () => cb.applyDamage(hp2, NaN), /non-negative/);
  throws("bad max hp rejected", () => cb.createHealth(0), /positive integer/);
  const cd = cb.createCooldown();
  check("cooldown: ready, trigger, blocked until readyAt, boundary tick ready",
    cb.cooldownReady(cd, 0) && cb.triggerCooldown(cd, 10, 30) && !cb.cooldownReady(cd, 39) && cb.triggerCooldown(cd, 39, 30) === false
    && cb.cooldownRemaining(cd, 25) === 15 && cb.cooldownReady(cd, 40) && cb.triggerCooldown(cd, 40, 0) && cb.cooldownReady(cd, 40));
  throws("cooldown rejects fractional duration", () => cb.triggerCooldown(cd, 100, 1.5), /non-negative integer/);
  const r1 = new CountedRng("dmg");
  const r2 = new CountedRng("dmg");
  const rolls1 = []; const rolls2 = [];
  for (let i = 0; i < 50; i++) { rolls1.push(cb.rollDamage(r1, { base: 5, variance: 2, critChance: 0.2 })); rolls2.push(cb.rollDamage(r2, { base: 5, variance: 2, critChance: 0.2 })); }
  check("rollDamage is seeded and bounded", JSON.stringify(rolls1) === JSON.stringify(rolls2) && rolls1.every((r) => (r.crit ? r.amount >= 6 && r.amount <= 14 : r.amount >= 3 && r.amount <= 7)) && rolls1.some((r) => r.crit) && rolls1.some((r) => !r.crit));
  const r3 = new CountedRng("dmg");
  cb.rollDamage(r3, { base: 5 });
  check("rollDamage always consumes exactly two draws", r1.draws === 100 && r3.draws === 2);
}

// -------------------------------------------------------------- quest
{
  const manifestQuests = [
    { id: "q-collect", name: "모으기", type: "quest.collect", nodes: [{ id: "start", type: "quest.start" }, { id: "goal", type: "quest.condition", params: { stat: "ore", op: ">=", value: 3 } }, { id: "done", type: "quest.complete", params: { reward: { items: { coin: 5 } } } }], edges: [] },
    { id: "q-fast", name: "빠르게", type: "quest.limit", nodes: [{ id: "a", params: { stat: "cleared", value: 1 } }, { id: "b", params: { stat: "moves", op: "<=", value: 10 } }], edges: [] },
  ];
  const defs = questDefsFromManifest(manifestQuests);
  const log = createQuestLog(defs);
  const granted = [];
  const grant = (reward, id) => granted.push([id, reward.items.coin]);
  check("quest progress tracks the first condition, capped at target", updateQuests(log, defs, { ore: 2 }, grant).length === 0 && log[0].progress === 2 && log[0].target === 3 && !log[0].done);
  const done = updateQuests(log, defs, { ore: 7, cleared: 1, moves: 10 }, grant);
  check("quest completes at the boundary and multi-condition quests need all", done.join(",") === "q-collect,q-fast" && log[0].progress === 3 && log[1].done);
  updateQuests(log, defs, { ore: 99, cleared: 1, moves: 1 }, grant);
  updateQuests(log, defs, { ore: 0 }, grant);
  check("quest reward is granted exactly once", granted.length === 1 && granted[0][0] === "q-collect" && granted[0][1] === 5 && log[0].rewarded && log[0].done);
  check("completed quests stay done when stats drop", log[0].done && log[1].done && allQuestsDone(log));
  // A loaded log that is done but not yet rewarded pays once, then never again.
  const loaded = createQuestLog(defs); loaded[0].done = true;
  const paid = [];
  updateQuests(loaded, defs, {}, (r, id) => paid.push(id));
  updateQuests(loaded, defs, {}, (r, id) => paid.push(id));
  check("done-but-unrewarded log pays once after load", paid.join(",") === "q-collect");
  check("quest log validity", isValidQuestLog(log, defs) && !isValidQuestLog([{ ...log[0], done: false, rewarded: true }, log[1]], defs) && !isValidQuestLog(log.slice(1), defs));
  throws("duplicate quest id rejected", () => questDefsFromManifest([manifestQuests[0], manifestQuests[0]]), /duplicate quest id/);
  throws("quest without a condition rejected", () => questDefsFromManifest([{ id: "x", nodes: [{ id: "s" }] }]), /no condition/);
  throws("quest with unknown op rejected", () => questDefsFromManifest([{ id: "x", nodes: [{ id: "s", params: { stat: "a", op: "~=", value: 1 } }] }]), /unknown op/);
  throws("quest log / definition mismatch rejected", () => updateQuests([{ id: "other" }], defs, {}), /does not match/);
}

// --------------------------------------------------------------- save
{
  const state = { tick: 42, seed: "s", rngDraws: 3, items: { ore: 2 }, list: [1, 2, 3] };
  const text = serializeSave({ gameId: "game-a", version: 2, state });
  const opts = { gameId: "game-a", version: 2 };
  const ok = parseSave(text, opts);
  check("save round-trip", ok.ok && ok.tick === 42 && stateHash(ok.state) === stateHash(state) && JSON.parse(text).format === SAVE_FORMAT);
  check("save rejects empty / non-string", parseSave("", opts).code === "E_EMPTY" && parseSave(null, opts).code === "E_EMPTY" && parseSave(undefined, opts).code === "E_EMPTY");
  check("save rejects corrupted JSON", parseSave(text.slice(0, -5), opts).code === "E_PARSE" && parseSave("{not json", opts).code === "E_PARSE");
  check("save rejects non-envelope JSON", parseSave("[]", opts).code === "E_FORMAT" && parseSave("null", opts).code === "E_FORMAT" && parseSave('"str"', opts).code === "E_FORMAT" && parseSave("{}", opts).code === "E_FORMAT");
  const env = JSON.parse(text);
  check("save rejects unknown (newer and older) versions", parseSave(JSON.stringify({ ...env, version: 3 }), opts).code === "E_VERSION_UNKNOWN" && parseSave(JSON.stringify({ ...env, version: 1 }), opts).code === "E_VERSION_UNKNOWN" && parseSave(JSON.stringify({ ...env, version: "2" }), opts).code === "E_VERSION_UNKNOWN");
  check("save is isolated per game", parseSave(text, { gameId: "game-b", version: 2 }).code === "E_GAME");
  const flipped = JSON.parse(text); flipped.payload.items.ore = 999;
  check("save rejects payload edits (checksum)", parseSave(JSON.stringify(flipped), opts).code === "E_CHECKSUM" && parseSave(JSON.stringify({ ...env, checksum: 12345 }), opts).code === "E_CHECKSUM");
  check("save rejects missing / array payload", parseSave(JSON.stringify({ ...env, payload: [1] }), opts).code === "E_SHAPE" && parseSave(JSON.stringify({ ...env, payload: null }), opts).code === "E_SHAPE");
  const proto = '{"format":"aldol-next-save/1","gameId":"game-a","version":2,"tick":0,"checksum":"x","payload":{"__proto__":{"polluted":true},"tick":0}}';
  check("save rejects __proto__ keys and does not pollute", parseSave(proto, opts).code === "E_SHAPE" && ({}).polluted === undefined);
  check("save validator result is honoured", parseSave(text, { ...opts, validate: () => "nope" }).code === "E_SHAPE" && parseSave(text, { ...opts, validate: () => null }).ok && parseSave(text, { ...opts, validate: () => { throw new Error("boom"); } }).code === "E_SHAPE");
  check("save rejects oversized text", parseSave("x".repeat(MAX_SAVE_CHARS + 1), opts).code === "E_TOO_LARGE");
  check("save drops undefined fields before checksum", parseSave(serializeSave({ gameId: "game-a", version: 2, state: { tick: 1, gone: undefined } }), opts).ok);
  check("saveKey format matches the per-game key convention", saveKey("rune-vault", "m4") === "aldol-engine.rune-vault-m4.save.v1" && saveKey("x", "m5", 2) === "aldol-engine.x-m5.save.v2");
  throws("saveKey rejects path-like ids", () => saveKey("../evil", "m4"), /bad game id/);
  const keys = ["rune-vault", "star-tactics", "star-foundry"].map((g, i) => saveKey(g, `m${4 + i}`));
  const legacy = ["aldol-engine.supuli-m1.save.v4", "aldol-engine.star-fishing-m2.save.v1", "aldol-engine.star-defense-m3.save.v1"];
  check("new save keys are distinct from each other and from M1–M3 keys", new Set([...keys, ...legacy]).size === 6);
}

// ----------------------------------------------------------- manifest
{
  const base = () => ({
    schemaVersion: "worldforge/0.1", project: { id: "demo", name: "Demo" }, world: { id: "demo-world", name: "Demo World" },
    assets: [{ id: "crate", type: "model", uri: "builtin:crate" }],
    zones: [{ id: "room", name: "Room", type: "zone.room", geometry: { type: "polygon", space: "local", points: [[0, 0], [6, 0], [6, 4], [0, 4]] } }],
    places: [{ id: "spawn", name: "Start", type: "place.spawn", zoneId: "room", position: [1, 0, 2] }],
    paths: [],
    entities: [
      { id: "crate-1", type: "entity.crate", assetId: "crate", enabled: true, transform: { position: [3, 0, 2] }, components: { "game.push": { weight: 1 } } },
      { id: "crate-off", type: "entity.crate", assetId: "crate", enabled: false, transform: { position: [4, 0, 2] }, components: {} },
    ],
    npcs: [], events: [],
    quests: [{ id: "q1", name: "Q", type: "quest.goal", nodes: [{ id: "n", params: { stat: "goal", value: 1 } }], edges: [] }],
    rules: [{ id: "rule-demo", type: "game.demo", enabled: true, config: { moveLimit: 20 } }],
  });
  const world = loadGameWorld(base(), { ruleType: "game.demo", projectId: "demo" });
  check("loadGameWorld adapts places/entities/config/quests", world.places.spawn.x === 1 && world.places.spawn.z === 2 && world.entities.length === 1 && world.entityById["crate-1"].z === 2
    && world.config.moveLimit === 20 && world.questDefs[0].conditions[0].stat === "goal" && world.bounds.maxX === 6 && world.bounds.maxZ === 4);
  check("loaded world is deep-frozen (sims cannot mutate it)", Object.isFrozen(world) && Object.isFrozen(world.config) && Object.isFrozen(world.entities[0].components));
  throws("loadGameWorld rejects an invalid manifest", () => { const m = base(); m.schemaVersion = "worldforge/9.9"; loadGameWorld(m, { ruleType: "game.demo" }); }, /invalid world manifest/);
  throws("loadGameWorld rejects a missing rule", () => loadGameWorld(base(), { ruleType: "game.other" }), /no enabled/);
  throws("loadGameWorld rejects a disabled rule", () => { const m = base(); m.rules[0].enabled = false; loadGameWorld(m, { ruleType: "game.demo" }); }, /no enabled/);
  throws("loadGameWorld rejects another project's manifest", () => loadGameWorld(base(), { ruleType: "game.demo", projectId: "other" }), /expected "other"/);
  throws("loadGameWorld rejects duplicate entity ids", () => { const m = base(); m.entities.push({ ...m.entities[0] }); loadGameWorld(m, { ruleType: "game.demo" }); }, /E_DUPLICATE_ID/);
  throws("loadGameWorld rejects a broken asset reference", () => { const m = base(); m.entities[0].assetId = "ghost"; loadGameWorld(m, { ruleType: "game.demo" }); }, /E_ASSET_REF_NOT_FOUND/);
  throws("loadGameWorld rejects external asset URLs", () => { const m = base(); m.assets[0].uri = "https://example.com/x.glb"; loadGameWorld(m, { ruleType: "game.demo" }); }, /E_ASSET_URI/);
  throws("loadGameWorld rejects parent-traversal GLB paths", () => { const m = base(); m.assets[0].uri = "glb:../x.glb"; loadGameWorld(m, { ruleType: "game.demo" }); }, /E_ASSET_URI_UNSAFE/);

  const tiles = parseTileRows(["#P.", "#.G"]);
  check("parseTileRows walls and marks", tiles.cols === 3 && tiles.rows === 2 && tiles.blocked.length === 2 && tiles.marks.P[0].c === 1 && tiles.marks.G[0].r === 1);
  throws("parseTileRows rejects ragged rows", () => parseTileRows(["##", "#"]), /same non-zero length/);
  throws("parseTileRows rejects empty input", () => parseTileRows([]), /non-empty/);

  // Existing manifests are untouched by the new adapter and still validate.
  for (const g of ["supuli", "star-fishing", "star-defense"]) {
    check(`existing manifest still valid: ${g}`, validateWorldManifest(readJson(`games/${g}/world.json`)).valid === true);
  }
}

t.done();

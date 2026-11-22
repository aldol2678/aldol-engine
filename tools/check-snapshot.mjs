// Regression: serializable RNG checkpoints and deterministic JS simulation resume.
// Does not claim parity with the Rust/WASM backend or the three game UIs.
import assert from "node:assert/strict";
import { Rng } from "../src/core/rng.js";
import { createSim } from "../src/render/sim-loader.js";

let count = 0;
function check(name, fn) { fn(); count++; console.log("PASS " + name); }
const seed = "marginlife-save-restore";
check("RNG repeatability over 1,000 draws", () => {
  const a = new Rng(seed); const b = new Rng(seed);
  for (let i = 0; i < 1000; i++) assert.equal(a.next(), b.next());
});
check("Existing RNG output sequence unchanged", () => {
  const rng = new Rng("supuli-m1::bark");
  const golden = [0.3048535482957959, 0.7961983166169375,
    0.608515408122912, 0.31883666245266795, 0.29010562831535935];
  for (const value of golden) assert.equal(rng.next(), value);
});
check("JSON RNG snapshot preserves 200 future draws", () => {
  const a = new Rng(seed); for (let i = 0; i < 37; i++) a.next();
  const b = new Rng(seed); b.restore(JSON.parse(JSON.stringify(a.snapshot())));
  for (let i = 0; i < 200; i++) assert.equal(a.next(), b.next());
});
check("Forked stream restores independently", () => {
  const a = new Rng(seed).fork("hero"); for (let i = 0; i < 8; i++) a.next();
  const b = new Rng(seed).fork("hero"); b.restore(a.snapshot());
  for (let i = 0; i < 40; i++) assert.equal(a.next(), b.next());
});
check("Bad RNG snapshots never mutate the stream", () => {
  const rng = new Rng(seed); rng.next(); const before = rng.snapshot();
  const invalid = [null, { ...before, version: 2 }, { ...before, seed: "other" },
    { ...before, state: -1 }, { ...before, state: 0x100000000 },
    { ...before, state: 1.5 }];
  for (const item of invalid) { assert.throws(() => rng.restore(item)); assert.deepEqual(rng.snapshot(), before); }
});
const js = {
  createInitialState(seed) { return { tick: 0, seed, heroChoices: [] }; },
  step(state, input, rng) {
    const next = structuredClone(state);
    next.tick++;
    next.heroChoices.push([input.action, rng.int(0, 1_000_000)]);
    return next;
  },
};
const opts = { kind: "marginlife-probe", seed, rngSeed: seed + "::hero",
  world: {}, js, preferJs: true };
const create = () => createSim(opts);
const live = await create();
check("preferJs opts into JS snapshot-capable backend", () => assert.equal(live.backend, "js"));
for (let i = 0; i < 21; i++) {
  live.step({ action: "shop" });
  if (i % 5 === 0) live.rngNext();
}
const snapshot = JSON.parse(JSON.stringify(live.saveSnapshot()));
check("Snapshot is JSON-serializable, correctly keyed", () => {
  assert.equal(snapshot.format, "aldol.sim.snapshot.v1");
  assert.equal(snapshot.kind, opts.kind);
  assert.deepEqual(snapshot.state, live.state);
});
const resumed = await create();
resumed.loadSnapshot(snapshot);
check("Restored game state and hash match", () => {
  assert.deepEqual(live.state, resumed.state);
  assert.equal(live.hash(), resumed.hash());
});
check("21-step save + 14-step resume matches continuous run", () => {
  for (let i = 0; i < 14; i++) {
    live.step({ action: "travel-" + (i % 3) });
    resumed.step({ action: "travel-" + (i % 3) });
    if (i % 4 === 0) {
      assert.equal(live.rngNext(), resumed.rngNext());
      assert.equal(live.pick(["home", "quest", "rest"]), resumed.pick(["home", "quest", "rest"]));
    }
    assert.equal(live.hash(), resumed.hash());
  }
});
check("Invalid simulation snapshot rejects without mutating either stream", () => {
  const before = resumed.saveSnapshot();
  const cases = [{ ...before, kind: "wrong" }, { ...before, rngSeed: "wrong" },
    { ...before, rng: { ...before.rng, state: -1 } }];
  for (const bad of cases) {
    assert.throws(() => resumed.loadSnapshot(bad));
    assert.deepEqual(resumed.saveSnapshot(), before);
  }
});
check("Legacy loadState remains available", () => {
  resumed.loadState({ tick: 0, seed, heroChoices: [] });
  assert.equal(resumed.state.tick, 0);
});
console.log(`Snapshot checks ${count}/${count} PASS`);

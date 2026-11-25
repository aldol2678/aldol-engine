// ENGINE-NEXT-02: real runtime restore benchmark, independent sequence oracle.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Rng } from "../../src/core/rng.js";
import { defineGame, MAX_RNG_DRAWS } from "../../src/core/next/runtime.js";
import { serializeSave, parseSave } from "../../src/core/next/save.js";

const game = defineGame({
  id: "rng-restore-stress", version: 1,
  createState: () => ({ value: 0 }),
  step(state, input, {rng}) { state.value = rng.next(); },
});
const world = {};
const legacyCap = 50_000_000;
const rows = [];
// Warm up without suppressing cold samples for each size.
for (const seed of ["engine-next-02", "unicode-별"]) {
  for (const draws of [0, 1000, 1_000_000, 10_000_000, legacyCap, legacyCap + 1]) {
    const snapshot = {tick: draws, seed, rngDraws: draws, value: 0};
    const text = serializeSave({gameId: game.id, version: game.version, state: snapshot});
    const expected = new Rng(seed);
    for (let i = 0; i < draws; i++) expected.next();
    const expectedTail = Array.from({length: 16}, () => expected.next());
    const samples = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      const t0 = performance.now();
      const parsed = parseSave(text, {gameId: game.id, version: game.version, validate: s => game.validateState(s, world)});
      assert.equal(parsed.ok, true);
      const restored = game.restore(parsed.state, world);
      const elapsed = performance.now() - t0;
      samples.push(elapsed);
      const tail = [];
      for (let i = 0; i < 16; i++) { game.step(restored, {}); tail.push(restored.state.value); }
      assert.deepEqual(tail, expectedTail, "restored stream mismatch");
      assert.equal(restored.state.rngDraws, draws + 16);
    }
    rows.push({seed, draws, samplesMs:samples.map(x=>Number(x.toFixed(3))), maxMs:Number(Math.max(...samples).toFixed(3)), sequence:"PASS"});
  }
}
for (const draws of [-1, 0.5, MAX_RNG_DRAWS+1, Infinity, NaN]) {
  const s = {tick:0, seed:"engine-next-02", rngDraws:draws, value:0};
  assert.equal(game.validateState(s, world), "rngDraws");
  assert.throws(()=>game.restore(s, world), /rngDraws/);
}
console.log(JSON.stringify({node:process.version,platform:process.platform,method:"serialize/parse/restore, 2 seeds x 6 sizes x 3 repeats, 16 next values per sample",rows,threshold50ms:"diagnostic only; browser and mobile still need measurement",over50ms:rows.filter(x=>x.maxMs>50).length},null,2));
console.log("PASS RNG restore stream parity and rejection bounds; timing reported separately");

await import('./rng-compat-check.mjs');

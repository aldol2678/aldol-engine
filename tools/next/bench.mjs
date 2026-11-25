// tools/next/bench.mjs — G5 headless performance measurements.
//   node tools/next/bench.mjs [--root <repo root to measure>] [--only existing|next]
//        [--reps 3] [--out <json path>]
// Measures per-tick cost (p50 / p95 / mean, microseconds) and heap use:
//   existing : Supuli / Star Fishing / Star Defense sims (works on any tree,
//              so the same script measures the baseline checkout via --root)
//   next     : the three new games + Star Foundry at ~100 / 500 / 1000
//              entities and raw ECS query load at 100 / 500 / 1000 entities
// Timing uses process.hrtime in THIS tool only — never inside src/core.
// Numbers are measurements on the machine that ran them, not guarantees.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const ROOT = path.resolve(argOf("--root", new URL("../../", import.meta.url).pathname));
const ONLY = argOf("--only", "all");
const REPS = Number(argOf("--reps", 3));
const OUT = argOf("--out", null);
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

function stats(samplesNs) {
  const s = Float64Array.from(samplesNs).sort();
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))] / 1000;
  let sum = 0;
  for (const v of s) sum += v;
  return { ticks: s.length, p50_us: +q(0.5).toFixed(2), p95_us: +q(0.95).toFixed(2), p99_us: +q(0.99).toFixed(2), mean_us: +(sum / s.length / 1000).toFixed(2), max_us: +(s[s.length - 1] / 1000).toFixed(2) };
}
// stepOnce(frame) runs one tick. Warm-up ticks are not sampled.
function measure(name, setup, { warmup = 300, ticks = 3000 } = {}) {
  const runs = [];
  for (let rep = 0; rep < REPS; rep++) {
    const stepOnce = setup();
    for (let f = 0; f < warmup; f++) stepOnce(f);
    if (global.gc) global.gc();
    const heap0 = process.memoryUsage().heapUsed;
    const samples = new Array(ticks);
    for (let f = 0; f < ticks; f++) {
      const t0 = process.hrtime.bigint();
      stepOnce(warmup + f);
      samples[f] = Number(process.hrtime.bigint() - t0);
    }
    const heap1 = process.memoryUsage().heapUsed;
    runs.push({ rep: rep + 1, ...stats(samples), heapUsed_mb: +(heap1 / 1048576).toFixed(2), heapDelta_mb: +((heap1 - heap0) / 1048576).toFixed(2) });
  }
  const med = (key) => runs.map((r) => r[key]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  const row = { name, median_p50_us: med("p50_us"), median_p95_us: med("p95_us"), median_mean_us: med("mean_us"), runs };
  console.log(`${name.padEnd(44)} p50=${String(row.median_p50_us).padStart(9)}us  p95=${String(row.median_p95_us).padStart(9)}us  mean=${String(row.median_mean_us).padStart(9)}us  (median of ${REPS})`);
  return row;
}

const results = { tool: "tools/next/bench.mjs", root: ROOT, node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model || "unknown", cpus: os.cpus().length, reps: REPS, gcExposed: !!global.gc, rows: [] };

if (ONLY === "all" || ONLY === "existing") {
  const { Rng } = await load("src/core/rng.js");
  const { validateWorldManifest, worldToSim } = await load("src/core/worldforge.js");
  const adapt = (rel) => { const m = readJson(rel); if (!validateWorldManifest(m).valid) throw new Error("bad manifest " + rel); return worldToSim(m); };
  {
    const sim = await load("src/core/sim.js");
    const world = adapt("games/supuli/world.json");
    results.rows.push(measure("existing/supuli step {dx:1}", () => {
      const rng = new Rng("supuli-m1");
      let state = sim.createInitialState("supuli-m1", world);
      return (f) => { state = sim.step(state, { dx: f % 240 < 120 ? 1 : -1, dy: 0 }, rng, world); };
    }));
  }
  {
    const sim = await load("games/star-fishing/fishing.js");
    const world = adapt("games/star-fishing/world.json");
    results.rows.push(measure("existing/star-fishing step (walk + cast)", () => {
      const rng = new Rng(sim.SEED);
      let state = sim.createInitialState(sim.SEED, world);
      return (f) => { state = sim.step(state, f < 200 ? { dx: 0, dy: -1 } : f % 300 === 0 ? { dx: 0, dy: 0, cast: true } : { dx: 0, dy: 0 }, rng, world); };
    }));
  }
  {
    const sim = await load("games/star-defense/defense.js");
    const world = adapt("games/star-defense/world.json");
    results.rows.push(measure("existing/star-defense step (3 towers, waves)", () => {
      const rng = new Rng(sim.SEED);
      let state = sim.createInitialState(sim.SEED, world);
      const spots = ["spot-1", "spot-3", "spot-5"];
      return (f) => {
        const input = f < 3 ? { placeTower: { spotId: spots[f], type: "star" } } : state.phase === "build" ? { startWave: true } : {};
        state = sim.step(state, input, rng, world);
      };
    }));
  }
}

if (ONLY === "all" || ONLY === "next") {
  const { createEcs } = await load("src/core/next/ecs.js");
  const { stateHash } = await load("src/core/state-hash.js");
  {
    const vault = await load("games/rune-vault/vault.js");
    const { SOLUTIONS, DIR } = await load("tools/next/play/rune-vault-solutions.mjs");
    const world = vault.loadWorld(readJson("games/rune-vault/world.json"));
    const moves = SOLUTIONS[0].split("").map((ch) => ({ move: DIR[ch] }));
    results.rows.push(measure("next/rune-vault step (moves + resets)", () => {
      const session = vault.game.start(vault.SEED, world);
      return (f) => { const k = f % (moves.length + 4); vault.game.step(session, k < moves.length - 1 ? moves[k] : k === moves.length + 3 ? { reset: true } : {}); };
    }));
  }
  {
    const tactics = await load("games/star-tactics/tactics.js");
    const { planAction } = await load("tools/next/play/star-tactics-bot.mjs");
    const world = tactics.loadWorld(readJson("games/star-tactics/world.json"));
    results.rows.push(measure("next/star-tactics step (bot turns + enemy AI)", () => {
      let session = tactics.game.start(tactics.SEED, world);
      return () => {
        if (session.state.phase === "won" || session.state.phase === "lost") session = tactics.game.start(tactics.SEED, world);
        const plan = planAction(session.state, world);
        tactics.game.step(session, plan ? plan.cmd : {});
      };
    }));
  }
  {
    const foundry = await load("games/star-foundry/foundry.js");
    const { stressManifest, stressInputs } = await load("tools/next/play/star-foundry-stress.mjs");
    const manifest = readJson("games/star-foundry/world.json");
    const world = foundry.loadWorld(manifest);
    results.rows.push(measure("next/star-foundry step (real map, working line)", () => {
      const session = foundry.game.start(foundry.SEED, world);
      const B = (kind, c, r, dir = "right") => ({ build: { kind, c, r, dir } });
      const script = [B("belt", 1, 3), B("smelter", 2, 3), ...[3, 4, 5, 6, 7, 8].map((c) => B("belt", c, 3))];
      return (f) => { foundry.game.step(session, script[f] || {}); if (session.state.phase !== "playing") session.state.phase = "playing"; };
    }));
    for (const n of [100, 500, 1000]) {
      const big = foundry.loadWorld(stressManifest(manifest));
      const inputs = stressInputs({ entities: n });
      let entities = 0;
      const row = measure(`next/star-foundry load ~${n} entities`, () => {
        const session = foundry.game.start(foundry.SEED, big);
        // Build the lines and let them fill up before sampling.
        for (let f = 0; f < inputs.length + 2500; f++) foundry.game.step(session, inputs[f] || {});
        entities = session.state.ecs.alive.length;
        return () => { foundry.game.step(session, {}); };
      }, { warmup: 200, ticks: 2000 });
      row.entities = entities;
      results.rows.push(row);
    }
  }
  for (const n of [100, 500, 1000]) {
    results.rows.push(measure(`next/ecs ${n} entities: move system + query + events`, () => {
      const ecs = createEcs({ components: { Pos: { defaults: { x: 0, z: 0 } }, Vel: { defaults: { dx: 0, dz: 0 } }, Tag: { defaults: { kind: "" } } } });
      for (let i = 0; i < n; i++) ecs.spawn(i % 3 === 0 ? { Pos: { x: i, z: 0 }, Tag: { kind: "static" } } : { Pos: { x: i, z: 0 }, Vel: { dx: 1, dz: i % 2 } });
      return (f) => {
        ecs.beginTick();
        ecs.each(["Pos", "Vel"], (id, pos, vel) => { pos.x += vel.dx; pos.z += vel.dz; if (pos.x > 5000) pos.x = 0; });
        if (f % 60 === 0) { const victim = ecs.query("Vel")[0]; ecs.despawn(victim); ecs.spawn({ Pos: {}, Vel: { dx: 1, dz: 0 } }); ecs.emit("respawn", { victim }); }
        ecs.dispatch();
      };
    }));
    results.rows.push(measure(`next/ecs ${n} entities: stateHash (per call)`, () => {
      const ecs = createEcs({ components: { Pos: { defaults: { x: 0, z: 0 } } } });
      for (let i = 0; i < n; i++) ecs.spawn({ Pos: { x: i, z: -i } });
      return () => { stateHash(ecs.state); };
    }, { warmup: 20, ticks: 200 }));
  }
}

if (OUT) {
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(OUT), JSON.stringify(results, null, 2) + "\n");
  console.log(`wrote ${OUT}`);
}

// Manual scenario runner, does not change game saves or external services.
import { readFileSync } from "node:fs";
import { createSim } from "../src/render/sim-loader.js";
import { createInitialState, step, GAME_KIND, DEFAULT_SEED } from "../games/marginlife/sim.js";
const world = JSON.parse(readFileSync(new URL("../games/marginlife/world.json", import.meta.url), "utf8"));
const policy = process.argv[2] === "offer" ? "offer" : "deny";
const seed = process.argv[3] || DEFAULT_SEED;
const create = () => createSim({ kind: GAME_KIND, seed, rngSeed: `${seed}::heroes`,
  world, js: { createInitialState, step }, preferJs: true });
const sim = await create();
let checkpoint;
while (!sim.state.finished) {
  sim.step(sim.state.tick === 0 ? { creditPolicy: policy } : {});
  if (sim.state.tick === 10) checkpoint = JSON.parse(JSON.stringify(sim.saveSnapshot()));
}
const resumed = await create();
resumed.loadSnapshot(checkpoint);
while (!resumed.state.finished) resumed.step({});
const summary = {
  kind: GAME_KIND, seed, firstDayCredit: policy, days: 7,
  ending: sim.state.ending,
  arlenDay1: sim.state.events.filter(e=>e.day===1 && e.actor==="hero-arlen"),
  hash: sim.hash(), resumedHash: resumed.hash(), resumeMatches: resumed.hash()===sim.hash(),
  events: sim.state.events.length,
};
console.log(JSON.stringify(summary, null, 2));

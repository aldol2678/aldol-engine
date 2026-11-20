// Headless runner: node src/simulate-cli.mjs --seed <string> --frames <n> [--inputs <JSON>]
// Prints the final state hash. Same (seed, frames, inputs) -> same hash, always.

import { simulate } from "./core/sim.js";

function parseArgs(argv) {
  const out = { seed: "supuli-m1", frames: 600, inputs: {} };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed") out.seed = argv[++i];
    else if (argv[i] === "--frames") out.frames = Number(argv[++i]);
    else if (argv[i] === "--inputs") out.inputs = JSON.parse(argv[++i]);
  }
  return out;
}

const { seed, frames, inputs } = parseArgs(process.argv.slice(2));
const { state, hash } = simulate(seed, frames, inputs);
console.log(JSON.stringify({ seed, frames, hash, tick: state.tick, player: state.player, npc: state.npc }, null, 2));

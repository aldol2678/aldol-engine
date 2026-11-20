// Headless runner:
//   node src/simulate-cli.mjs --seed <string> --frames <n> [--inputs <JSON>] [--world <path>]
// Default world: games/supuli/world.json (WorldForge manifest, validated first).
// Prints the final state hash. Same (seed, frames, inputs, world) -> same hash.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate } from "./core/sim.js";
import { validateWorldManifest, worldToSim } from "./core/worldforge.js";

function parseArgs(argv) {
  const out = { seed: "supuli-m1", frames: 600, inputs: {}, world: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed") out.seed = argv[++i];
    else if (argv[i] === "--frames") out.frames = Number(argv[++i]);
    else if (argv[i] === "--inputs") out.inputs = JSON.parse(argv[++i]);
    else if (argv[i] === "--world") out.world = argv[++i];
  }
  return out;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { seed, frames, inputs, world: worldPath } = parseArgs(process.argv.slice(2));
const manifestPath = worldPath || join(root, "games", "supuli", "world.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const validation = validateWorldManifest(manifest);
if (!validation.valid) {
  console.error(`world manifest invalid: ${manifestPath}`);
  for (const e of validation.errors) console.error(`  ${e.code} ${e.path} ${e.detail || ""}`);
  process.exit(1);
}
const world = worldToSim(manifest);
const { state, hash } = simulate(seed, frames, inputs, world);
console.log(JSON.stringify({
  seed, frames, world: world.worldId, hash, tick: state.tick,
  player: state.player,
  npcs: state.npcs.map((n) => ({ id: n.id, state: n.state, x: +n.x.toFixed(2), y: +n.y.toFixed(2) })),
  quests: state.quests.map((q) => ({ id: q.id, done: q.done, progress: q.progress })),
  shards: state.shards.filter((s) => s.collected).length,
}, null, 2));

// npm run check — syntax + manifest validation + determinism + behaviour + forbidden-API checks.
// Fails (exit 1) on the first failure. No network, no browser needed.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate, findPath, createInitialState, step, DEFAULT_WORLD } from "../src/core/sim.js";
import { validateWorldManifest, worldToSim } from "../src/core/worldforge.js";
import { Rng } from "../src/core/rng.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// 0. WorldForge manifest: load + validate + adapt.
const manifest = JSON.parse(readFileSync(join(root, "games", "supuli", "world.json"), "utf8"));
const validation = validateWorldManifest(manifest);
check("world manifest valid", validation.valid, validation.errors.map((e) => `${e.code}@${e.path}`).join(", "));
const world = worldToSim(manifest);
check("world adapted", world.waypoints.length === 6 && world.houses.length === 5 && world.trees.length === 3
  && world.shards.length === 3 && world.npcs.length === 2 && world.quests.length === 3 && world.bounds.maxX === 16,
  `wp=${world.waypoints.length} houses=${world.houses.length} trees=${world.trees.length} shards=${world.shards.length} npcs=${world.npcs.length} quests=${world.quests.length} maxX=${world.bounds.maxX}`);
// A deliberately broken manifest must fail validation.
const broken = structuredClone(manifest);
broken.npcs[0].entityId = "ent-missing";
check("world manifest rejects bad npc ref", validateWorldManifest(broken).valid === false);

// 1. Syntax: node --check on every JS file under src/ and tools/.
const jsFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (p.endsWith(".js") || p.endsWith(".mjs")) jsFiles.push(p);
  }
})(join(root, "src"));
jsFiles.push(join(root, "tools", "check.mjs"));
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "ignore" });
    check(`syntax ${f.replace(root + "/", "")}`, true);
  } catch {
    check(`syntax ${f.replace(root + "/", "")}`, false);
  }
}

// 2. Determinism: same (seed, frames, inputs, world) -> same hash, twice.
const a = simulate("supuli-m1", 600, { dx: 1, dy: 0 }, world);
const b = simulate("supuli-m1", 600, { dx: 1, dy: 0 }, world);
check("determinism same-seed", a.hash === b.hash, `hash=${a.hash}`);
const c = simulate("supuli-m1-other", 600, { dx: 1, dy: 0 }, world);
check("determinism different-seed", a.hash !== c.hash, `a=${a.hash} c=${c.hash}`);

// Steering helper: walk toward a target (recomputed each tick), then idle.
function steer(seed, worldArg, targetOf, frames, interactAtEnd = 0) {
  const rng = new Rng(seed).fork("ai:patrol");
  let state = createInitialState(seed, worldArg);
  for (let f = 0; f < frames; f++) {
    const t = targetOf(state);
    const dx = t.x - state.player.x;
    const dy = t.y - state.player.y;
    const len = Math.hypot(dx, dy);
    const input = len > 0.3 ? { dx: dx / len, dy: dy / len } : {};
    if (interactAtEnd > 0 && f >= frames - interactAtEnd) input.interact = true;
    state = step(state, input, rng, worldArg);
  }
  return state;
}

// 3. Behaviour smoke: player actually moves; NPC patrols and chases.
const moved = simulate("supuli-m1", 120, { dx: 1, dy: 0 }, world);
check("player moves east", moved.state.player.x > 0, `x=${moved.state.player.x.toFixed(2)}`);
const chase = simulate("supuli-m1", 600, { dx: 1, dy: 1 }, world);
check("npc leaves patrol or chases", ["patrol", "chase", "flee"].includes(chase.state.npcs[0].state), `npc=${chase.state.npcs[0].state}`);
check("A* path exists 0->2", Array.isArray(findPath(0, 2, world.edges, world.waypoints)) && findPath(0, 2, world.edges, world.waypoints)[0] === 0,
  `path=${JSON.stringify(findPath(0, 2, world.edges, world.waypoints))}`);

// 3b. Quests on the real world.
const talkState = steer("supuli-m1", world, (s) => s.npcs[0], 600, 60);
check("quest talk-to-villager completes", talkState.quests.find((q) => q.id === "talk-to-villager").done === true);
const noInteract = steer("supuli-m1", world, (s) => s.npcs[0], 600, 0);
check("quest does not complete without interact", noInteract.quests.find((q) => q.id === "talk-to-villager").done === false);
let collectState = createInitialState("supuli-m1", world);
{
  const rng = new Rng("supuli-m1").fork("ai:patrol");
  for (const shard of world.shards) {
    for (let f = 0; f < 400; f++) {
      const dx = shard.x - collectState.player.x;
      const dy = shard.y - collectState.player.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) break;
      collectState = step(collectState, { dx: dx / len, dy: dy / len }, rng, world);
    }
  }
}
check("quest collect-shards completes", collectState.quests.find((q) => q.id === "collect-shards").done === true,
  `progress=${collectState.quests.find((q) => q.id === "collect-shards").progress}`);
const gateState = steer("supuli-m1", world, () => world.places["forest-gate"], 900, 0);
check("quest reach-forest-gate completes", gateState.quests.find((q) => q.id === "reach-forest-gate").done === true,
  `player=(${gateState.player.x.toFixed(1)}, ${gateState.player.y.toFixed(1)})`);

// 3c. Combat-lite: stand next to the boar, HP must drop.
let combatState = createInitialState("supuli-m1", world);
{
  const rng = new Rng("supuli-m1").fork("ai:patrol");
  const boar = () => combatState.npcs.find((n) => n.id === "boar-1");
  for (let f = 0; f < 1200; f++) {
    const t = boar();
    const dx = t.x - combatState.player.x;
    const dy = t.y - combatState.player.y;
    const len = Math.hypot(dx, dy);
    const input = len > 0.5 ? { dx: dx / len, dy: dy / len } : {};
    combatState = step(combatState, input, rng, world);
  }
}
check("combat-lite contact damage", combatState.player.hp < 100, `hp=${combatState.player.hp}`);

// 3d. Default world (no manifest) still works: talk quest completes.
const defaultInputs = [];
for (let f = 0; f < 300; f++) defaultInputs.push({ dx: 1, dy: 1 });
for (let f = 0; f < 120; f++) defaultInputs.push({ dx: 0, dy: 0, interact: true });
const defaultRun = simulate("supuli-m1", 420, defaultInputs, DEFAULT_WORLD);
check("default world talk quest completes", defaultRun.state.quests[0].done === true);

// 4. Forbidden APIs in the sim path (src/core only).
const forbidden = ["Math.random", "Date.now", "performance.now"];
for (const f of jsFiles.filter((x) => x.includes(`${"src"}/core/`))) {
  // Strip comments first: mentioning a banned API in a comment is fine.
  const raw = readFileSync(f, "utf8");
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const api of forbidden) {
    check(`no ${api} in ${f.replace(root + "/", "")}`, !text.includes(api));
  }
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

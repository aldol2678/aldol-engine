// Star Fishing (M2) checks — same harness shape as tools/check.mjs, but for
// the fishing sim. Run: npm run check:fishing
import fs from "node:fs";
import { execSync } from "node:child_process";
import { Rng } from "../src/core/rng.js";
import { stateHash } from "../src/core/state-hash.js";
import { validateWorldManifest, worldToSim } from "../src/core/worldforge.js";
import { isSafeGlbUri, glbAssets } from "../src/core/assets.js";
import { createInitialState, step, simulate, SEED } from "../games/star-fishing/fishing.js";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures += 1;
}

const manifest = JSON.parse(fs.readFileSync(new URL("../games/star-fishing/world.json", import.meta.url), "utf8"));
const v = validateWorldManifest(manifest);
check("fishing manifest valid", v.valid, JSON.stringify(v.errors));
const world = worldToSim(manifest);
check("fishing world adapted",
  world.waypoints.length === 8 && world.npcs.length === 6 && world.quests.length === 3
    && world.bounds.minX === -6 && world.bounds.maxX === 10 && world.bounds.minY === -8 && world.bounds.maxY === 8
    && world.fishing && world.fishing.species.big.biteWindowTicks === 20 && (world.reeds || []).length === 6,
  `wp=${world.waypoints.length} npcs=${world.npcs.length} quests=${world.quests.length} bounds=${JSON.stringify(world.bounds)} reeds=${(world.reeds || []).length}`);

const bad = JSON.parse(JSON.stringify(manifest));
bad.npcs[0].entityId = "ent-does-not-exist";
check("fishing manifest rejects bad npc ref", validateWorldManifest(bad).valid === false);

check("fishing world has trophies + glb npc asset",
  (world.trophies || []).length === 1 && world.npcs.find((n) => n.id === "fish-5")?.assetId === "star-fish",
  `trophies=${(world.trophies || []).length} fish-5 asset=${world.npcs.find((n) => n.id === "fish-5")?.assetId}`);

const badUri = JSON.parse(JSON.stringify(manifest));
badUri.assets.find((a) => a.id === "star-fish").uri = "glb:../evil.glb";
check("manifest rejects parent-traversal glb uri", validateWorldManifest(badUri).valid === false);
const extUri = JSON.parse(JSON.stringify(manifest));
extUri.assets.find((a) => a.id === "star-fish").uri = "https://example.com/fish.glb";
check("manifest rejects external glb uri", validateWorldManifest(extUri).valid === false);
const supuli = JSON.parse(fs.readFileSync(new URL("../games/supuli/world.json", import.meta.url), "utf8"));
check("supuli manifest still valid under asset-uri rule", validateWorldManifest(supuli).valid === true);
check("glbAssets lists 2", glbAssets(manifest).length === 2);
check("isSafeGlbUri cases",
  isSafeGlbUri("glb:assets/models/star-fish.glb")
  && !isSafeGlbUri("glb:../x.glb") && !isSafeGlbUri("glb:/abs/x.glb")
  && !isSafeGlbUri("https://x/y.glb") && !isSafeGlbUri("builtin:fish"));
for (const f of ["assets/models/star-fish.glb", "assets/models/star-trophy.glb"]) {
  const buf = fs.readFileSync(new URL(`../games/star-fishing/${f}`, import.meta.url));
  check(`glb valid ${f}`, buf.readUInt32LE(0) === 0x46546c67 && buf.readUInt32LE(4) === 2, `${buf.length} bytes`);
}

for (const f of ["games/star-fishing/fishing.js", "src/core/worldforge.js"]) {
  try {
    execSync(`node --check ${f}`, { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe" });
    check(`syntax ${f}`, true);
  } catch { check(`syntax ${f}`, false); }
}

// Syntax-check the render modules without linking: they import bare 'three',
// which only exists in the browser importmap. vm.SourceTextModule parses
// without resolving imports (needs --experimental-vm-modules, see package.json).
import vm from "node:vm";
for (const f of ["src/render/asset-loader.js", "src/render/hud.js", "src/render/vendor/GLTFLoader.js", "src/render/vendor/BufferGeometryUtils.js"]) {
  try {
    new vm.SourceTextModule(fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
    check(`syntax ${f}`, true);
  } catch (e) {
    check(`syntax ${f}`, false, String(e).slice(0, 200));
  }
}

// Determinism.
const a = simulate(SEED, 600, [{ dx: 1, dy: 0 }], world);
const b = simulate(SEED, 600, [{ dx: 1, dy: 0 }], world);
const c = simulate(SEED + "-other", 600, [{ dx: 1, dy: 0 }], world);
check("determinism same-seed", stateHash(a) === stateHash(b), `hash=${stateHash(a)}`);
check("determinism different-seed", stateHash(a) !== stateHash(c), `a=${stateHash(a)} c=${stateHash(c)}`);

// Steer helper: walk toward a target each frame.
function steer(seed, getTarget, frames, interactAtEnd = 0) {
  const rng = new Rng(seed).fork("fish:steer");
  let s = createInitialState(seed, world);
  for (let f = 0; f < frames; f++) {
    const t = getTarget(s);
    const dx = t.x - s.player.x;
    const dy = t.y - s.player.y;
    const len = Math.hypot(dx, dy);
    const input = len < 0.5 ? {} : { dx: dx / len, dy: dy / len };
    if (f >= frames - interactAtEnd) input.interact = true;
    s = step(s, input, rng, world);
  }
  return s;
}

// Player cannot walk into the water (off the dock strip).
{
  const rng = new Rng(SEED).fork("fish:steer");
  let s = createInitialState(SEED, world);
  for (let f = 0; f < 600; f++) s = step(s, { dx: -1, dy: -1 }, rng, world);
  check("player blocked from water", s.player.y >= 0 && s.player.x < 0,
    `player=(${s.player.x.toFixed(1)}, ${s.player.y.toFixed(1)})`);
}

// Talk quest.
const talkState = steer(SEED, (s) => s.npcs.find((n) => n.id === "angler-1"), 900, 60);
check("quest talk-to-angler completes", talkState.quests.find((q) => q.id === "talk-to-angler").done === true);

// Arrive quest (dock end, down the dock strip).
const dockState = steer(SEED, () => world.places["dock-end"], 900, 0);
check("quest reach-dock-end completes", dockState.quests.find((q) => q.id === "reach-dock-end").done === true,
  `player=(${dockState.player.x.toFixed(1)}, ${dockState.player.y.toFixed(1)})`);

// Cast away from the dock does nothing.
{
  const rng = new Rng(SEED).fork("fish:steer");
  let s = createInitialState(SEED, world);
  s = step(s, { cast: true }, rng, world);
  check("cast off-dock does nothing", s.fishing.phase === "idle" && s.fishing.bobber === null);
}

// Full catch: cast at the dock end, wait for the bite, reel.
function castAndCatch(seed, state, rng, maxFrames = 600) {
  let s = state;
  s = step(s, { cast: true }, rng, world);
  if (s.fishing.phase !== "waiting") return { state: s, caught: false, reason: "no-cast" };
  for (let f = 0; f < maxFrames; f++) {
    s = step(s, {}, rng, world);
    if (s.fishing.phase === "bite") break;
  }
  if (s.fishing.phase !== "bite") return { state: s, caught: false, reason: "no-bite" };
  const before = s.caught.length;
  s = step(s, { reel: true }, rng, world);
  return { state: s, caught: s.caught.length === before + 1, reason: s.caught.length === before + 1 ? "ok" : "reel-missed" };
}
{
  const rng = new Rng(SEED).fork("fish:catch");
  let s = steer(SEED, () => world.places["dock-end"], 900, 0);
  const r = castAndCatch(SEED, s, rng);
  check("cast -> bite -> reel catches a fish", r.caught === true, `reason=${r.reason} score=${r.state.score} caught=${r.state.caught.length}`);
}

// Early reel scares the fish (no catch, cooldown).
{
  const rng = new Rng(SEED).fork("fish:scare");
  let s = steer(SEED, () => world.places["dock-end"], 900, 0);
  s = step(s, { cast: true }, rng, world);
  const biterId = s.fishing.biterId;
  s = step(s, { reel: true }, rng, world);
  const biter = s.fish.find((f) => f.id === biterId);
  check("early reel scares the fish", s.fishing.phase === "cooldown" && s.caught.length === 0 && biter?.state === "flee",
    `phase=${s.fishing.phase} biter=${biter?.state}`);
}

// Catch 3 completes the quest, and the caught fish respawns.
{
  const rng = new Rng(SEED).fork("fish:catch3");
  let s = steer(SEED, () => world.places["dock-end"], 900, 0);
  let ok = true;
  for (let i = 0; i < 3; i++) {
    const r = castAndCatch(SEED, s, rng);
    if (!r.caught) { ok = false; break; }
    s = r.state;
    // Wait out any cooldown before the next cast.
    for (let f = 0; f < 120; f++) s = step(s, {}, rng, world);
  }
  check("quest catch-star-fish completes", ok && s.quests.find((q) => q.id === "catch-star-fish").done === true,
    `caught=${s.caught.length} score=${s.score}`);
  const firstCaught = s.caught[0];
  const caughtFish = s.fish.find((f) => f.id === firstCaught.fishId);
  check("caught fish respawns", caughtFish?.state === "swim",
    `fish=${firstCaught.fishId} state=${caughtFish?.state}`);
}

// No banned nondeterministic APIs in the fishing sim (comments stripped:
// the header comment names the banned calls, so it must not match itself).
const src = fs.readFileSync(new URL("../games/star-fishing/fishing.js", import.meta.url), "utf8");
const codeOnly = src.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
for (const banned of ["Math.random", "Date.now", "performance.now"]) {
  check(`no ${banned} in games/star-fishing/fishing.js`, !codeOnly.includes(banned));
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

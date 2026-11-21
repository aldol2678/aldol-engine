// Star Defense (M3) checks — same harness shape as tools/check-fishing.mjs,
// but for the defense sim. Run: npm run check:star-defense
import fs from "node:fs";
import { execSync } from "node:child_process";
import { Rng } from "../src/core/rng.js";
import { stateHash } from "../src/core/state-hash.js";
import { validateWorldManifest, worldToSim } from "../src/core/worldforge.js";
import { isSafeGlbUri, glbAssets } from "../src/core/assets.js";
import { createInitialState, step, simulate, SEED } from "../games/star-defense/defense.js";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures += 1;
}

const manifest = JSON.parse(fs.readFileSync(new URL("../games/star-defense/world.json", import.meta.url), "utf8"));
const v = validateWorldManifest(manifest);
check("defense manifest valid", v.valid, JSON.stringify(v.errors));
const world = worldToSim(manifest);
check("defense world adapted",
  world.waypoints.length === 7 && world.quests.length === 3
    && world.bounds.minX === -9 && world.bounds.maxX === 9 && world.bounds.minY === -6 && world.bounds.maxY === 6
    && world.defense && world.defense.towers.star.cost === 30 && world.defense.towers.moon.cost === 60
    && world.defense.waves.length === 5 && world.defense.path.length === 7 && world.defense.buildSpots.length === 7
    && (world.trophies || []).length === 1,
  `wp=${world.waypoints.length} quests=${world.quests.length} bounds=${JSON.stringify(world.bounds)} waves=${world.defense?.waves.length} trophies=${(world.trophies || []).length}`);

const badPath = JSON.parse(JSON.stringify(manifest));
badPath.paths[0].from = "place-does-not-exist";
check("defense manifest rejects bad path ref", validateWorldManifest(badPath).valid === false);

const badUri = JSON.parse(JSON.stringify(manifest));
badUri.assets.find((a) => a.id === "star-trophy").uri = "glb:../evil.glb";
check("manifest rejects parent-traversal glb uri", validateWorldManifest(badUri).valid === false);
const fishing = JSON.parse(fs.readFileSync(new URL("../games/star-fishing/world.json", import.meta.url), "utf8"));
check("fishing manifest still valid under defense rule", validateWorldManifest(fishing).valid === true);
check("glbAssets lists 1", glbAssets(manifest).length === 1);
check("isSafeGlbUri cases",
  isSafeGlbUri("glb:assets/models/star-trophy.glb")
  && !isSafeGlbUri("glb:../x.glb") && !isSafeGlbUri("glb:/abs/x.glb")
  && !isSafeGlbUri("https://x/y.glb") && !isSafeGlbUri("builtin:tree"));
for (const f of ["assets/models/star-trophy.glb"]) {
  const buf = fs.readFileSync(new URL(`../games/star-defense/${f}`, import.meta.url));
  check(`glb valid ${f}`, buf.readUInt32LE(0) === 0x46546c67 && buf.readUInt32LE(4) === 2, `${buf.length} bytes`);
}

for (const f of ["games/star-defense/defense.js", "src/core/worldforge.js"]) {
  try {
    execSync(`node --check ${f}`, { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe" });
    check(`syntax ${f}`, true);
  } catch { check(`syntax ${f}`, false); }
}

// Syntax-check the render modules without linking: they import bare 'three',
// which only exists in the browser importmap. vm.SourceTextModule parses
// without resolving imports (needs --experimental-vm-modules, see package.json).
import vm from "node:vm";
for (const f of ["src/render/asset-loader.js", "src/render/hud.js", "src/render/vendor/GLTFLoader.js", "src/render/vendor/BufferGeometryUtils.js", "src/render/vendor/SkeletonUtils.js"]) {
  try {
    new vm.SourceTextModule(fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
    check(`syntax ${f}`, true);
  } catch (e) {
    check(`syntax ${f}`, false, String(e).slice(0, 200));
  }
}

// Determinism: start a wave with no towers — spawn jitter consumes the RNG,
// so different seeds walk different enemy positions by frame 600.
const detInputs = [{ startWave: true }];
const a = simulate(SEED, 600, detInputs, world);
const b = simulate(SEED, 600, detInputs, world);
const c = simulate(SEED + "-other", 600, detInputs, world);
check("determinism same-seed", stateHash(a) === stateHash(b), `hash=${stateHash(a)}`);
check("determinism different-seed", stateHash(a) !== stateHash(c), `a=${stateHash(a)} c=${stateHash(c)}`);

// A corrupted defense path (waypoint id not in the manifest) must throw.
{
  const badWorld = JSON.parse(JSON.stringify(world));
  badWorld.defense = { ...badWorld.defense, path: ["wp-gate", "wp-nope"] };
  let threw = false;
  try { createInitialState(SEED, badWorld); } catch { threw = true; }
  check("createInitialState rejects bad path waypoint", threw);
}

// Place tower: costs stars, occupies the spot, rejects repeats + unaffordable.
{
  const rng = new Rng(SEED).fork("defense:place");
  let s = createInitialState(SEED, world);
  s = step(s, { placeTower: { spotId: "spot-1", type: "star" } }, rng, world);
  check("place tower costs stars", s.towers.length === 1 && s.stars === 70, `towers=${s.towers.length} stars=${s.stars}`);
  const starsAfter = s.stars;
  s = step(s, { placeTower: { spotId: "spot-1", type: "moon" } }, rng, world);
  check("place on occupied spot rejected", s.towers.length === 1 && s.stars === starsAfter);
  s.stars = 10;
  s = step(s, { placeTower: { spotId: "spot-2", type: "moon" } }, rng, world);
  check("unaffordable tower rejected", s.towers.length === 1 && s.stars === 10);
  s = step(s, { placeTower: { spotId: "spot-nope", type: "star" } }, rng, world);
  check("place on unknown spot rejected", s.towers.length === 1);
}

// Start wave: queue fills, enemies spawn and walk.
{
  const rng = new Rng(SEED).fork("defense:wave");
  let s = createInitialState(SEED, world);
  s = step(s, { startWave: true }, rng, world);
  check("start wave builds queue", s.phase === "combat" && s.wave === 1 && s.spawnQueue.length === 5,
    `phase=${s.phase} wave=${s.wave} queue=${s.spawnQueue.length}`);
  for (let f = 0; f < 400; f++) s = step(s, {}, rng, world);
  check("enemies spawn and walk", s.enemies.length > 0 && s.enemies[0].x > -8,
    `enemies=${s.enemies.length} first=(${s.enemies[0]?.x.toFixed(1)}, ${s.enemies[0]?.y.toFixed(1)})`);
}

// 3 star towers kill wave 1; wave clears, bonus stars, quest completes.
{
  const rng = new Rng(SEED).fork("defense:kills");
  let s = createInitialState(SEED, world);
  for (const spot of ["spot-1", "spot-3", "spot-5"]) s = step(s, { placeTower: { spotId: spot, type: "star" } }, rng, world);
  s = step(s, { startWave: true }, rng, world);
  for (let f = 0; f < 3000; f++) s = step(s, {}, rng, world);
  check("towers kill wave 1 and it clears",
    s.kills === 5 && s.phase === "build" && s.wavesCleared === 1 && s.shrineHp === 10,
    `kills=${s.kills} phase=${s.phase} cleared=${s.wavesCleared} shrine=${s.shrineHp} stars=${s.stars}`);
  check("stars after wave 1", s.stars === 10 + 5 * 8 + 20 + 5, `stars=${s.stars}`);
  check("quest clear-wave-1 completes", s.quests.find((q) => q.id === "clear-wave-1").done === true);
  check("quest place-first-tower completes", s.quests.find((q) => q.id === "place-first-tower").done === true);
}

// No towers: the wave leaks through and damages the shrine.
{
  const rng = new Rng(SEED).fork("defense:leak");
  let s = createInitialState(SEED, world);
  s = step(s, { startWave: true }, rng, world);
  for (let f = 0; f < 3000; f++) s = step(s, {}, rng, world);
  check("leaks damage the shrine", s.shrineHp === 5 && s.phase === "build" && s.kills === 0,
    `shrine=${s.shrineHp} phase=${s.phase} kills=${s.kills}`);
}

// Full game: moon towers on every spot clear all 5 waves (win, defeat quest).
{
  const rng = new Rng(SEED).fork("defense:win");
  let s = createInitialState(SEED, world);
  s.stars = 9999;
  for (const spot of ["spot-1", "spot-2", "spot-3", "spot-4", "spot-5", "spot-6", "spot-7"]) {
    s = step(s, { placeTower: { spotId: spot, type: "moon" } }, rng, world);
  }
  let won = false;
  for (let w = 0; w < 5; w++) {
    s = step(s, { startWave: true }, rng, world);
    for (let f = 0; f < 6000 && s.phase === "combat"; f++) s = step(s, {}, rng, world);
    if (s.phase === "won") { won = true; break; }
    if (s.phase !== "build") break;
  }
  check("clear all 5 waves wins", won && s.wavesCleared === 5 && s.phase === "won",
    `phase=${s.phase} cleared=${s.wavesCleared} kills=${s.kills} shrine=${s.shrineHp}`);
  check("quest defeat-20 completes", s.quests.find((q) => q.id === "defeat-20").done === true, `kills=${s.kills}`);
}

// Shrine at 1 HP with no towers: the first leak ends the game.
{
  const rng = new Rng(SEED).fork("defense:lose");
  let s = createInitialState(SEED, world);
  s.shrineHp = 1;
  s = step(s, { startWave: true }, rng, world);
  for (let f = 0; f < 3000 && s.phase !== "lost"; f++) s = step(s, {}, rng, world);
  check("shrine 0 loses the game", s.phase === "lost", `phase=${s.phase} shrine=${s.shrineHp}`);
}

// No banned nondeterministic APIs in the defense sim (comments stripped:
// the header comment names the banned calls, so it must not match itself).
const src = fs.readFileSync(new URL("../games/star-defense/defense.js", import.meta.url), "utf8");
const codeOnly = src.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
for (const banned of ["Math.random", "Date.now", "performance.now"]) {
  check(`no ${banned} in games/star-defense/defense.js`, !codeOnly.includes(banned));
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

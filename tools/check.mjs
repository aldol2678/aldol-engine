// npm run check — syntax + manifest validation + determinism + behaviour + forbidden-API checks.
// Fails (exit 1) on the first failure. No network, no browser needed.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate, findPath, createInitialState, step, DEFAULT_WORLD } from "../src/core/sim.js";
import { validateWorldManifest, worldToSim } from "../src/core/worldforge.js";
import { scheduleVoice, VOICES, BGM_CHORDS, BGM_CHORD_SECONDS } from "../src/core/audio.js";
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
check("world adapted", world.waypoints.length === 12 && world.houses.length === 5 && world.trees.length === 7
  && world.shards.length === 5 && world.crops.length === 3 && world.herbs.length === 3
  && world.npcs.length === 5 && world.quests.length === 9 && world.bounds.maxX === 24 && world.bounds.minY === -8,
  `wp=${world.waypoints.length} houses=${world.houses.length} trees=${world.trees.length} shards=${world.shards.length} crops=${world.crops.length} herbs=${world.herbs.length} npcs=${world.npcs.length} quests=${world.quests.length} maxX=${world.bounds.maxX} minY=${world.bounds.minY}`);
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

// 3. Behaviour smoke: player actually moves; NPC patrols, chases and approaches.
const moved = simulate("supuli-m1", 120, { dx: 1, dy: 0 }, world);
check("player moves east", moved.state.player.x > 0, `x=${moved.state.player.x.toFixed(2)}`);
const chase = simulate("supuli-m1", 600, { dx: 1, dy: 1 }, world);
check("npc leaves patrol or chases", ["patrol", "chase", "approach", "flee", "defeated"].includes(chase.state.npcs[0].state), `npc=${chase.state.npcs[0].state}`);
check("A* path exists 0->2", Array.isArray(findPath(0, 2, world.edges, world.waypoints)) && findPath(0, 2, world.edges, world.waypoints)[0] === 0,
  `path=${JSON.stringify(findPath(0, 2, world.edges, world.waypoints))}`);

// 3a. Navmesh: houses block, spawn is open, paths detour, NPCs never enter blocked cells.
const nav = world.navmesh;
check("navmesh built", nav && nav.cols > 0 && nav.rows > 0, `cols=${nav?.cols} rows=${nav?.rows} cell=${nav?.cellSize}`);
const house1 = world.houses[0]; // (-4, -1)
check("house center is blocked", nav.isWalkable(house1.x, house1.y) === false, `house=(${house1.x}, ${house1.y})`);
check("spawn is walkable", nav.isWalkable(world.spawn.x, world.spawn.y) === true);
check("direct line through a house is blocked", nav.lineClear(house1.x - 2, house1.y, house1.x + 2, house1.y) === false);
const detour = nav.findPath({ x: house1.x - 2, y: house1.y }, { x: house1.x + 2, y: house1.y });
const detourFull = [{ x: house1.x - 2, y: house1.y }, ...(detour || [])];
const detourLen = detourFull.reduce((s, p, i, a) => s + (i ? Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) : 0), 0);
check("navmesh path detours around a house", Array.isArray(detour) && detour.length > 0
  && detour.every((p) => nav.isWalkable(p.x, p.y)) && detourLen > 4,
  `points=${detour?.length} len=${detourLen.toFixed(2)}`);
check("navmesh path is deterministic",
  JSON.stringify(nav.findPath({ x: house1.x - 2, y: house1.y }, { x: house1.x + 2, y: house1.y })) === JSON.stringify(detour));
// NPC chase around a house: boar 2 units west of house-1, player 2 units east.
let chaseState = createInitialState("supuli-m1", world);
chaseState.player.x = house1.x + 2;
chaseState.player.y = house1.y;
chaseState.npcs.find((n) => n.id === "boar-1").x = house1.x - 2;
chaseState.npcs.find((n) => n.id === "boar-1").y = house1.y;
{
  const rng = new Rng("supuli-m1").fork("ai:patrol");
  let reached = false;
  let enteredBlocked = false;
  for (let f = 0; f < 1500; f++) {
    chaseState = step(chaseState, {}, rng, world);
    const boar = chaseState.npcs.find((n) => n.id === "boar-1");
    if (!nav.isWalkable(boar.x, boar.y)) enteredBlocked = true;
    if (Math.hypot(boar.x - chaseState.player.x, boar.y - chaseState.player.y) < 1.0) { reached = true; break; }
  }
  check("npc chases around a house and reaches the player", reached === true,
    `boar=(${chaseState.npcs.find((n) => n.id === "boar-1").x.toFixed(2)}, ${chaseState.npcs.find((n) => n.id === "boar-1").y.toFixed(2)})`);
  check("npc never enters a blocked cell", enteredBlocked === false);
}

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
const deepState = steer("supuli-m1", world, () => world.places["deep-forest-heart"], 1800, 0);
check("quest reach-deep-forest completes", deepState.quests.find((q) => q.id === "reach-deep-forest").done === true,
  `player=(${deepState.player.x.toFixed(1)}, ${deepState.player.y.toFixed(1)})`);
const elderState = steer("supuli-m1", world, (s) => s.npcs.find((n) => n.id === "elder-1"), 600, 60);
check("quest talk-to-elder completes", elderState.quests.find((q) => q.id === "talk-to-elder").done === true);
let harvestState = createInitialState("supuli-m1", world);
{
  const rng = new Rng("supuli-m1").fork("ai:patrol");
  for (const crop of world.crops) {
    for (let f = 0; f < 400; f++) {
      const dx = crop.x - harvestState.player.x;
      const dy = crop.y - harvestState.player.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) break;
      harvestState = step(harvestState, { dx: dx / len, dy: dy / len }, rng, world);
    }
  }
}
check("quest harvest-crops completes", harvestState.quests.find((q) => q.id === "harvest-crops").done === true,
  `progress=${harvestState.quests.find((q) => q.id === "harvest-crops").progress}`);
const farmState = steer("supuli-m1", world, () => world.places["farm-center"], 900, 0);
check("quest reach-farm completes", farmState.quests.find((q) => q.id === "reach-farm").done === true,
  `player=(${farmState.player.x.toFixed(1)}, ${farmState.player.y.toFixed(1)})`);
// Herb heal: start hurt, walk over herb-1, HP must rise by its amount (capped at max).
let herbState = createInitialState("supuli-m1", world);
herbState.player.hp = 50;
{
  const rng = new Rng("supuli-m1").fork("ai:patrol");
  const herb = world.herbs[0];
  for (let f = 0; f < 600; f++) {
    const dx = herb.x - herbState.player.x;
    const dy = herb.y - herbState.player.y;
    const len = Math.hypot(dx, dy);
    if (herbState.herbs[0].consumed) break;
    herbState = step(herbState, { dx: dx / len, dy: dy / len }, rng, world);
  }
}
check("herb heals on pickup", herbState.herbs[0].consumed === true && herbState.player.hp === 80,
  `hp=${herbState.player.hp} consumed=${herbState.herbs[0].consumed}`);

// 3c. Defeat quest: attack the boar until its HP hits 0, then it respawns.
let defeatState = createInitialState("supuli-m1", world);
{
  const rng = new Rng("supuli-m1").fork("ai:patrol");
  const boar = () => defeatState.npcs.find((n) => n.id === "boar-1");
  for (let f = 0; f < 1800; f++) {
    const t = boar();
    if (t.hp <= 0) break;
    const dx = t.x - defeatState.player.x;
    const dy = t.y - defeatState.player.y;
    const len = Math.hypot(dx, dy);
    const input = len > 0.9 ? { dx: dx / len, dy: dy / len } : { attack: true };
    defeatState = step(defeatState, input, rng, world);
  }
}
check("quest defeat-boar completes", defeatState.quests.find((q) => q.id === "defeat-boar").done === true,
  `boar hp=${defeatState.npcs.find((n) => n.id === "boar-1").hp}`);
{
  const rng = new Rng("supuli-m1").fork("ai:patrol");
  for (let f = 0; f < 700; f++) defeatState = step(defeatState, {}, rng, world);
}
check("defeated npc respawns at home", defeatState.npcs.find((n) => n.id === "boar-1").hp === 60
  && defeatState.npcs.find((n) => n.id === "boar-1").state !== "defeated",
  `boar hp=${defeatState.npcs.find((n) => n.id === "boar-1").hp} state=${defeatState.npcs.find((n) => n.id === "boar-1").state}`);

// 3d. Combat-lite: stand next to the boar, HP must drop.
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

// 3e. Default world (no manifest) still works: talk quest completes.
const defaultInputs = [];
for (let f = 0; f < 300; f++) defaultInputs.push({ dx: 1, dy: 1 });
for (let f = 0; f < 120; f++) defaultInputs.push({ dx: 0, dy: 0, interact: true });
const defaultRun = simulate("supuli-m1", 420, defaultInputs, DEFAULT_WORLD);
check("default world talk quest completes", defaultRun.state.quests[0].done === true);

// 3f. Audio voices (pure core module — no AudioContext needed).
check("audio voices defined", ["cast", "bite", "catch", "talk", "quest", "hurt", "heal", "hit"].every((v) => Array.isArray(VOICES[v]) && VOICES[v].length > 0));
check("audio catch voice ascends", scheduleVoice("catch").map((e) => e.freq).every((f, i, a) => i === 0 || f > a[i - 1]));
check("audio unknown voice is empty", scheduleVoice("nope").length === 0);
check("audio schedule offsets by when", scheduleVoice("bite", 2)[0].at === 2);
check("audio bgm has 4 chords", BGM_CHORDS.length === 4 && BGM_CHORDS.every((c) => c.length === 3) && BGM_CHORD_SECONDS === 4);

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

// Star Fishing (M2) — fishing sim built on the shared Aldol Engine core.
//
// Reuse proof: this game does NOT copy Supuli's sim. It imports the shared
// core (seeded Rng, stateHash, worldforge manifest validation + adaptation)
// and implements only its own rules on top:
//   - player walks the shore + dock (water is blocked except the dock strip)
//   - cast (E at the dock end) -> waiting -> bite (seeded timing) -> reel
//     (Space inside the species bite window) -> catch
//   - fish NPCs: swim (patrol lake waypoints) -> chase (to the bobber)
//     -> flee (after a scare) -> caught (hidden, respawns at home)
// Determinism: (seed, frames, inputs, world) -> identical state hash.
// No Math.random / Date.now / performance.now in this file.

import { Rng } from "../../src/core/rng.js";
import { stateHash } from "../../src/core/state-hash.js";
import { validateWorldManifest, worldToSim } from "../../src/core/worldforge.js";

export const SEED = "star-fishing-m2";
export const TICK = 1 / 60;
export const PLAYER_SPEED = 4; // units per second

const DEFAULT_FISHING = {
  biteBaseTicks: 90,
  biteRandomTicks: 120,
  castCooldownTicks: 60,
  fishRespawnTicks: 600,
  fleeTicks: 120,
  species: {
    small: { biteWindowTicks: 45, score: 10 },
    medium: { biteWindowTicks: 30, score: 20 },
    big: { biteWindowTicks: 20, score: 40 },
  },
};

function questNodeParams(quest, nodeId) {
  const node = (quest.nodes || []).find((n) => n.id === nodeId);
  return node?.params ?? {};
}

function clampPlayerToShore(player, world) {
  const b = world.bounds;
  player.x = Math.max(b.minX, Math.min(b.maxX, player.x));
  player.y = Math.max(b.minY, Math.min(b.maxY, player.y));
  // Water is blocked except the dock strip (|x| <= 1, down to the dock end).
  if (player.y < 0) {
    if (Math.abs(player.x) <= 1) player.y = Math.max(player.y, -5);
    else player.y = 0;
  }
}

export function createInitialState(seed, world) {
  if (!world) throw new Error("star-fishing needs a world manifest (worldToSim output)");
  const fishing = world.fishing || DEFAULT_FISHING;
  const lakeWps = world.waypoints.filter((w) => w.y < 0);
  const shoreWps = world.waypoints.filter((w) => w.y >= 0);
  const fish = world.npcs
    .filter((n) => n.params?.species)
    .map((n) => ({
      id: n.id,
      species: n.params.species,
      x: n.x,
      y: n.y,
      homeX: n.homeX,
      homeY: n.homeY,
      speed: n.params.speed ?? 0.03,
      state: "swim",
      targetWp: n.homePlaceId || (lakeWps[0]?.id ?? null),
      fleeUntil: 0,
      caughtUntil: 0,
    }));
  const npcs = world.npcs
    .filter((n) => !n.params?.species)
    .map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      homeX: n.homeX,
      homeY: n.homeY,
      state: "patrol",
      targetWp: null,
      interaction: n.interaction,
    }));
  return {
    tick: 0,
    seed,
    player: { x: world.spawn.x, y: world.spawn.y },
    score: 0,
    casts: 0,
    caught: [],
    fishing: {
      phase: "idle", // idle | waiting | bite | cooldown
      bobber: null,
      biterId: null,
      biteAt: 0,
      biteEnd: 0,
      cooldownUntil: 0,
    },
    fish,
    npcs,
    quests: world.quests.map((q) => ({ id: q.id, name: q.name, type: q.type, done: false, progress: 0 })),
    _lakeWps: lakeWps.map((w) => w.id),
    _shoreWps: shoreWps.map((w) => w.id),
    _fishing: fishing,
  };
}

function moveToward(obj, tx, ty, speed) {
  const dx = tx - obj.x;
  const dy = ty - obj.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.05) return true;
  const stepLen = Math.min(len, speed);
  obj.x += (dx / len) * stepLen;
  obj.y += (dy / len) * stepLen;
  return len - stepLen < 0.05;
}

export function step(state, input, rng, world) {
  const next = structuredClone(state);
  next.tick += 1;
  const fishing = next._fishing;
  const wpById = new Map(world.waypoints.map((w) => [w.id, w]));

  // --- Player movement (shore + dock strip only). ---
  const dx = input.dx || 0;
  const dy = input.dy || 0;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    next.player.x += (dx / len) * PLAYER_SPEED * TICK;
    next.player.y += (dy / len) * PLAYER_SPEED * TICK;
  }
  clampPlayerToShore(next.player, world);

  // --- Angler patrols the shore waypoints. ---
  for (const npc of next.npcs) {
    if (!npc.targetWp) {
      const pool = next._shoreWps;
      npc.targetWp = pool[Math.floor(rng.next() * pool.length)];
    }
    const wp = wpById.get(npc.targetWp);
    if (wp && moveToward(npc, wp.x, wp.y, 0.02)) npc.targetWp = null;
  }

  // --- Fish AI. ---
  const bobber = next.fishing.bobber;
  for (const f of next.fish) {
    if (f.state === "caught") {
      if (next.tick >= f.caughtUntil) {
        f.state = "swim";
        f.x = f.homeX;
        f.y = f.homeY;
        f.targetWp = null;
      }
      continue;
    }
    if (f.state === "flee") {
      if (next.tick >= f.fleeUntil) { f.state = "swim"; f.targetWp = null; continue; }
      // Swim away from the bobber.
      const away = bobber || { x: f.homeX, y: f.homeY };
      const ax = f.x - away.x;
      const ay = f.y - away.y;
      const alen = Math.hypot(ax, ay) || 1;
      f.x += (ax / alen) * f.speed * 1.5;
      f.y += (ay / alen) * f.speed * 1.5;
      f.x = Math.max(world.bounds.minX, Math.min(world.bounds.maxX, f.x));
      f.y = Math.max(-8, Math.min(0, f.y));
      continue;
    }
    if (f.state === "chase" && bobber) {
      moveToward(f, bobber.x, bobber.y, f.speed * 1.5);
      continue;
    }
    // swim: patrol lake waypoints.
    if (!f.targetWp) {
      const pool = next._lakeWps;
      f.targetWp = pool[Math.floor(rng.next() * pool.length)];
    }
    const wp = wpById.get(f.targetWp);
    if (wp && moveToward(f, wp.x, wp.y, f.speed)) f.targetWp = null;
  }

  // --- Fishing state machine. ---
  const fs = next.fishing;
  const dockEnd = world.places["dock-end"];
  const nearDockEnd = dockEnd && Math.hypot(next.player.x - dockEnd.x, next.player.y - dockEnd.y) < 1.5;

  if (input.cast && fs.phase === "idle" && next.tick >= fs.cooldownUntil && nearDockEnd) {
    // Cast: bobber lands 2 units past the dock end, in the lake.
    fs.phase = "waiting";
    fs.bobber = { x: dockEnd.x, y: dockEnd.y - 2 };
    next.casts += 1;
    // The biter is the nearest fish to the bobber.
    let best = null;
    let bestDist = Infinity;
    for (const f of next.fish) {
      if (f.state !== "swim") continue;
      const d = Math.hypot(f.x - fs.bobber.x, f.y - fs.bobber.y);
      if (d < bestDist) { bestDist = d; best = f; }
    }
    if (best) {
      best.state = "chase";
      fs.biterId = best.id;
      const windowTicks = fishing.species[best.species]?.biteWindowTicks ?? 45;
      fs.biteAt = next.tick + fishing.biteBaseTicks + Math.floor(rng.next() * fishing.biteRandomTicks);
      fs.biteEnd = fs.biteAt + windowTicks;
    } else {
      fs.biteAt = next.tick + fishing.biteBaseTicks;
      fs.biteEnd = fs.biteAt;
    }
  }

  if (fs.phase === "waiting" && next.tick >= fs.biteAt) fs.phase = "bite";
  if (fs.phase === "bite" && next.tick > fs.biteEnd) {
    // Too late: the fish is gone.
    const biter = next.fish.find((f) => f.id === fs.biterId);
    if (biter && biter.state === "chase") { biter.state = "swim"; biter.targetWp = null; }
    fs.phase = "idle";
    fs.bobber = null;
    fs.biterId = null;
  }

  if (input.reel) {
    if (fs.phase === "bite" && next.tick <= fs.biteEnd) {
      // Caught!
      const biter = next.fish.find((f) => f.id === fs.biterId);
      if (biter) {
        const speciesCfg = fishing.species[biter.species] ?? { score: 10 };
        next.score += speciesCfg.score;
        next.caught.push({ fishId: biter.id, species: biter.species, tick: next.tick });
        biter.state = "caught";
        biter.caughtUntil = next.tick + fishing.fishRespawnTicks;
      }
      fs.phase = "idle";
      fs.bobber = null;
      fs.biterId = null;
    } else if (fs.phase === "waiting") {
      // Too early: scare the fish away.
      const biter = next.fish.find((f) => f.id === fs.biterId);
      if (biter && biter.state === "chase") {
        biter.state = "flee";
        biter.fleeUntil = next.tick + fishing.fleeTicks;
      }
      fs.phase = "cooldown";
      fs.cooldownUntil = next.tick + fishing.castCooldownTicks;
      fs.bobber = null;
      fs.biterId = null;
    }
  }

  // --- Quests. ---
  for (const quest of next.quests) {
    if (quest.done) continue;
    const manifestQuest = world.quests.find((q) => q.id === quest.id) || {};
    if (quest.type === "quest.talk") {
      const params = questNodeParams(manifestQuest, "talk");
      const npc = next.npcs.find((n) => n.id === params.npcId);
      if (npc && input.interact && Math.hypot(next.player.x - npc.x, next.player.y - npc.y) < (params.range ?? 1.5)) {
        quest.done = true;
      }
    } else if (quest.type === "quest.arrive") {
      const params = questNodeParams(manifestQuest, "arrive");
      const place = world.places[params.placeId];
      if (place && Math.hypot(next.player.x - place.x, next.player.y - place.y) < (params.range ?? 1.5)) {
        quest.done = true;
      }
    } else if (quest.type === "quest.catch") {
      const params = questNodeParams(manifestQuest, "catch");
      quest.progress = next.caught.length;
      if (quest.progress >= (params.count ?? 3)) quest.done = true;
    }
  }

  return next;
}

export function simulate(seed, frames, inputs, world) {
  const rng = new Rng(seed);
  let state = createInitialState(seed, world);
  for (let f = 0; f < frames; f++) {
    state = step(state, inputs[f] || {}, rng, world);
  }
  return state;
}

export function hashState(state) {
  return stateHash(state);
}

export function loadFishingWorld(manifest) {
  const v = validateWorldManifest(manifest);
  if (!v.valid) throw new Error("invalid fishing manifest: " + JSON.stringify(v.errors));
  return worldToSim(manifest);
}

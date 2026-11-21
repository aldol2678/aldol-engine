// Star Defense (M3) — tower-defense sim built on the shared Aldol Engine core.
//
// Reuse proof: this game does NOT copy Supuli's or Star Fishing's sim. It
// imports the shared core (seeded Rng, stateHash, worldforge manifest
// validation + adaptation) and implements only its own rules on top:
//   - build phase: place star/moon towers on build spots (stars = currency)
//   - combat phase: waves of shadow wisps walk the manifest path to the
//     star shrine; towers auto-fire homing projectiles
//   - leak: an enemy that reaches the shrine damages it; shrine 0 = lost
//   - win: clear all waves; a star bonus is paid on every wave clear
// Determinism: (seed, frames, inputs, world) -> identical state hash.
// No Math.random / Date.now / performance.now in this file.

import { Rng } from "../../src/core/rng.js";
import { stateHash } from "../../src/core/state-hash.js";
import { validateWorldManifest, worldToSim } from "../../src/core/worldforge.js";

export const SEED = "star-defense-m3";
export const TICK = 1 / 60;

const DEFAULT_DEFENSE = {
  startStars: 100,
  shrineHp: 10,
  spawnIntervalTicks: 45,
  spawnJitterTicks: 10,
  waveClearBonus: 20,
  path: ["wp-gate", "wp-a", "wp-b", "wp-c", "wp-d", "wp-e", "wp-shrine"],
  buildSpots: ["spot-1", "spot-2", "spot-3", "spot-4", "spot-5", "spot-6", "spot-7"],
  towers: {
    star: { cost: 30, range: 3, damage: 10, cooldownTicks: 30, projectileSpeed: 0.15 },
    moon: { cost: 60, range: 4, damage: 30, cooldownTicks: 60, projectileSpeed: 0.15 },
  },
  enemies: {
    wisp: { hp: 20, speed: 0.03, reward: 8, leak: 1 },
    swift: { hp: 12, speed: 0.05, reward: 10, leak: 1 },
    brute: { hp: 60, speed: 0.02, reward: 20, leak: 2 },
  },
  waves: [
    { wisp: 5 },
    { wisp: 7, swift: 2 },
    { wisp: 8, swift: 3, brute: 1 },
    { wisp: 10, swift: 4, brute: 2 },
    { wisp: 12, swift: 5, brute: 3 },
  ],
};

function questNodeParams(quest, nodeId) {
  const node = (quest.nodes || []).find((n) => n.id === nodeId);
  return node?.params ?? {};
}

// Round-robin interleave: one of each kind in rotation until counts run out.
// Deterministic (no RNG) so the same wave always spawns the same order.
function buildSpawnQueue(waveDef) {
  const kinds = ["wisp", "swift", "brute"];
  const remaining = {};
  for (const k of kinds) remaining[k] = waveDef[k] ?? 0;
  const queue = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const k of kinds) {
      if (remaining[k] > 0) {
        queue.push(k);
        remaining[k] -= 1;
        progress = true;
      }
    }
  }
  return queue;
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

export function createInitialState(seed, world) {
  if (!world) throw new Error("star-defense needs a world manifest (worldToSim output)");
  const defense = world.defense || DEFAULT_DEFENSE;
  const path = (defense.path || []).map((id) => {
    const p = world.places[id];
    if (!p) throw new Error(`star-defense path waypoint missing: ${id}`);
    return { id, x: p.x, y: p.y };
  });
  if (path.length < 2) throw new Error("star-defense needs a path of at least 2 waypoints");
  const spots = {};
  for (const id of defense.buildSpots || []) {
    const p = world.places[id];
    if (!p) throw new Error(`star-defense build spot missing: ${id}`);
    spots[id] = { id, x: p.x, y: p.y };
  }
  return {
    tick: 0,
    seed,
    phase: "build", // build | combat | won | lost
    wave: 0,
    wavesCleared: 0,
    stars: defense.startStars ?? 100,
    shrineHp: defense.shrineHp ?? 10,
    shrineMaxHp: defense.shrineHp ?? 10,
    kills: 0,
    towers: [],
    enemies: [],
    projectiles: [],
    spawnQueue: [],
    nextSpawnAt: 0,
    spawnSeq: 0,
    towerSeq: 0,
    projectileSeq: 0,
    quests: world.quests.map((q) => ({ id: q.id, name: q.name, type: q.type, done: false, progress: 0 })),
    _defense: defense,
    _path: path,
    _spots: spots,
  };
}

export function step(state, input, rng, world) {
  const next = structuredClone(state);
  next.tick += 1;
  const defense = next._defense;
  const totalWaves = (defense.waves || []).length;

  // --- Place tower (build or mid-combat). ---
  if (input.placeTower && (next.phase === "build" || next.phase === "combat")) {
    const { spotId, type } = input.placeTower;
    const towerCfg = defense.towers?.[type];
    const spot = next._spots[spotId];
    if (
      towerCfg && spot
      && !next.towers.some((t) => t.spotId === spotId)
      && next.stars >= towerCfg.cost
    ) {
      next.stars -= towerCfg.cost;
      next.towerSeq += 1;
      next.towers.push({ id: `tower-${next.towerSeq}`, spotId, type, x: spot.x, y: spot.y, cooldownUntil: 0 });
    }
  }

  // --- Start wave. ---
  if (input.startWave && next.phase === "build" && next.wave < totalWaves) {
    next.wave += 1;
    next.phase = "combat";
    next.spawnQueue = buildSpawnQueue(defense.waves[next.wave - 1] || {});
    next.nextSpawnAt = next.tick + 30;
  }

  if (next.phase === "combat") {
    // --- Spawn. ---
    if (next.spawnQueue.length > 0 && next.tick >= next.nextSpawnAt) {
      const kind = next.spawnQueue.shift();
      const cfg = defense.enemies?.[kind];
      if (cfg) {
        next.spawnSeq += 1;
        const start = next._path[0];
        next.enemies.push({
          id: `enemy-${next.spawnSeq}`, kind,
          x: start.x, y: start.y,
          hp: cfg.hp, maxHp: cfg.hp, speed: cfg.speed, reward: cfg.reward, leak: cfg.leak,
          wpIndex: 1,
        });
      }
      next.nextSpawnAt = next.tick
        + (defense.spawnIntervalTicks ?? 45)
        + Math.floor(rng.next() * (defense.spawnJitterTicks ?? 10));
    }

    // --- Enemies walk the path; reaching the shrine leaks. ---
    for (const e of next.enemies) {
      const target = next._path[e.wpIndex];
      if (!target) continue;
      if (moveToward(e, target.x, target.y, e.speed)) {
        e.wpIndex += 1;
        if (e.wpIndex >= next._path.length) {
          next.shrineHp -= e.leak;
          e.leaked = true;
        }
      }
    }
    next.enemies = next.enemies.filter((e) => !e.leaked);
    if (next.shrineHp <= 0) next.phase = "lost";
  }

  if (next.phase === "combat") {
    // --- Towers auto-fire at the nearest enemy in range. ---
    for (const t of next.towers) {
      if (next.tick < t.cooldownUntil) continue;
      const cfg = defense.towers[t.type];
      let best = null;
      let bestDist = Infinity;
      for (const e of next.enemies) {
        const d = Math.hypot(e.x - t.x, e.y - t.y);
        if (d <= cfg.range && d < bestDist) {
          bestDist = d;
          best = e;
        }
      }
      if (best) {
        next.projectileSeq += 1;
        next.projectiles.push({
          id: `proj-${next.projectileSeq}`,
          x: t.x, y: t.y,
          targetId: best.id, damage: cfg.damage, speed: cfg.projectileSpeed, type: t.type,
        });
        t.cooldownUntil = next.tick + cfg.cooldownTicks;
      }
    }

    // --- Projectiles home to their target; a dead/missing target fizzles. ---
    const remaining = [];
    for (const p of next.projectiles) {
      const target = next.enemies.find((e) => e.id === p.targetId);
      if (!target) continue;
      if (moveToward(p, target.x, target.y, p.speed)) {
        target.hp -= p.damage;
        if (target.hp <= 0) {
          next.kills += 1;
          next.stars += target.reward;
        }
      } else {
        remaining.push(p);
      }
    }
    next.projectiles = remaining;
    next.enemies = next.enemies.filter((e) => e.hp > 0);

    // --- Wave clear: queue drained and no enemies left. ---
    if (next.spawnQueue.length === 0 && next.enemies.length === 0) {
      next.wavesCleared += 1;
      next.stars += (defense.waveClearBonus ?? 20) + next.wave * 5;
      next.phase = next.wave >= totalWaves ? "won" : "build";
    }
  }

  // --- Quests. ---
  for (const quest of next.quests) {
    if (quest.done) continue;
    const manifestQuest = world.quests.find((q) => q.id === quest.id) || {};
    if (quest.type === "quest.build") {
      const params = questNodeParams(manifestQuest, "build");
      quest.progress = next.towers.length;
      if (quest.progress >= (params.count ?? 1)) quest.done = true;
    } else if (quest.type === "quest.wave") {
      const params = questNodeParams(manifestQuest, "wave");
      if (next.wavesCleared >= (params.wave ?? 1)) quest.done = true;
    } else if (quest.type === "quest.defeat") {
      const params = questNodeParams(manifestQuest, "defeat");
      quest.progress = next.kills;
      if (quest.progress >= (params.count ?? 20)) quest.done = true;
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

export function loadDefenseWorld(manifest) {
  const v = validateWorldManifest(manifest);
  if (!v.valid) throw new Error("invalid defense manifest: " + JSON.stringify(v.errors));
  return worldToSim(manifest);
}

// Fixed-step simulation core (pure: no rendering, no wall clock, no Math.random).
// M1 slice (expanded): Supuli village + forest entrance, driven by a WorldForge
// manifest (games/supuli/world.json, worldforge/0.1) via worldToSim().
// The sim never reads the manifest file itself: it takes the adapted world
// object, so headless runs stay deterministic and testable.
//
// NPC FSM transitions (per npc):
//   patrol -> chase    : hostile only, distance(player) < sight
//   patrol -> approach : talk NPCs, distance(player) < sight (stop at 1.2)
//   chase/approach -> patrol: distance(player) > sight + 3
//   chase  -> patrol: distance(player) > sight + 3
//   any    -> flee  : 0 < npc.hp <= fleeHp (combat rule)
//   any    -> defeated: npc.hp <= 0 (player attack)
//   defeated -> patrol: after npcRespawnTicks, respawn at home with full HP
//   flee   -> patrol: npc.hp > fleeHp and distance(player) > sight + 3
// Steering: seek + arrive, plus the navmesh for NPCs. An NPC steers straight
// when the line to its target is clear; when a house or tree blocks the way
// it follows a navmesh path (replanned only when the target moved far).
// AI ticks every step here (10-20Hz tick is a
// renderer-side optimisation; the sim itself is deterministic either way).
//
// Quests (from the manifest):
//   quest.talk    — input.interact within range of the named NPC.
//   quest.collect — walk within 1.0 of an uncollected item (assetId picks the
//                   pool: "star-shard" -> shards, "crop" -> crops).
//   quest.arrive  — walk within range of the named place.
//   quest.defeat  — the named NPC's HP reaches 0 (player attack).
// Healing herbs (component game.heal): walking within 1.0 consumes one and
// restores its amount of HP, capped at the combat rule's playerHp.
// Combat-lite (rule game.combat): a hostile NPC in chase state touching the
// player (dist < 0.8) deals contactDamage, once per contactCooldownTicks.
// Player attack (input.attack): nearest hostile NPC within attackRange takes
// playerAttackDamage, once per attackCooldownTicks.
// Player HP 0 -> respawn at spawn with full HP (quest progress is kept).

import { Rng } from "./rng.js";
import { stateHash } from "./state-hash.js";

export const STEP = 1 / 60;
export const PLAYER_SPEED = 3;
export const NPC_SPEED = 2.2;

// Built-in fallback world: identical to the original M1 village slice, used
// only when no WorldForge world is passed (e.g. `npm run simulate` default).
export const DEFAULT_WORLD = {
  bounds: { minX: -6, maxX: 10, minY: -2, maxY: 8 },
  waypoints: [
    { id: "wp-0", x: 0, y: 0 },
    { id: "wp-1", x: 8, y: 0 },
    { id: "wp-2", x: 8, y: 6 },
    { id: "wp-3", x: 0, y: 6 },
    { id: "wp-4", x: 4, y: 3 },
    { id: "wp-5", x: -4, y: 3 },
  ],
  edges: { 0: [1, 3, 4], 1: [0, 2, 4], 2: [1, 3, 4], 3: [0, 2, 5], 4: [0, 1, 2, 5], 5: [3, 4] },
  houses: [],
  trees: [],
  shards: [],
  crops: [],
  herbs: [],
  npcs: [{ id: "villager-1", name: "마을 주민", x: 8, y: 6, homeX: 4, homeY: 3, hp: 100, homePlaceId: null, interaction: "talk", sight: 6, damage: 0 }],
  spawn: { x: 0, y: 0 },
  quests: [{ id: "talk-to-villager", name: "이웃 주민과 대화하기", type: "quest.talk", nodes: [{ id: "talk", type: "quest.talk", params: { npcId: "villager-1", range: 1.5 } }], edges: [], params: new Map() }],
  combat: { contactDamage: 10, contactCooldownTicks: 60, playerHp: 100, fleeHp: 25, playerAttackDamage: 20, attackRange: 1.2, attackCooldownTicks: 30, npcRespawnTicks: 600 },
  places: {},
};

// A* over the waypoint graph. Returns an array of waypoint indices, or null.
export function findPath(fromIdx, toIdx, edges, waypoints) {
  const open = [{ id: fromIdx, g: 0, f: 0, path: [fromIdx] }];
  const best = new Map([[fromIdx, 0]]);
  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    if (cur.id === toIdx) return cur.path;
    for (const next of edges[cur.id] || []) {
      const a = waypoints[cur.id];
      const b = waypoints[next];
      const g = cur.g + Math.hypot(b.x - a.x, b.y - a.y);
      if (g < (best.get(next) ?? Infinity)) {
        best.set(next, g);
        const h = Math.hypot(waypoints[toIdx].x - b.x, waypoints[toIdx].y - b.y);
        open.push({ id: next, g, f: g + h, path: [...cur.path, next] });
      }
    }
  }
  return null;
}

function seek(pos, target, speed, dt) {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.01) return { x: pos.x, y: pos.y, arrived: true };
  // Arrive: slow down inside 0.5 units.
  const s = dist < 0.5 ? speed * (dist / 0.5) : speed;
  const stepLen = Math.min(s * dt, dist);
  return {
    x: pos.x + (dx / dist) * stepLen,
    y: pos.y + (dy / dist) * stepLen,
    arrived: stepLen >= dist - 1e-9,
  };
}

function questNodeParams(quest, nodeId) {
  const node = (quest.nodes || []).find((n) => n.id === nodeId);
  return node?.params || {};
}

export function createInitialState(seed, world = DEFAULT_WORLD) {
  const rng = new Rng(seed);
  const startWp = world.waypoints.findIndex((w) => w.id === "wp-2");
  return {
    tick: 0,
    seed: String(seed),
    worldId: world.worldId || "supuli-village",
    player: { x: world.spawn.x, y: world.spawn.y, hp: world.combat.playerHp },
    npcs: world.npcs.map((n, i) => ({
      id: n.id,
      name: n.name,
      x: n.x,
      y: n.y,
      homeX: n.homeX ?? n.x,
      homeY: n.homeY ?? n.y,
      state: "patrol",
      hp: n.hp,
      maxHp: n.hp,
      defeatedTimer: 0,
      interaction: n.interaction,
      sight: n.sight,
      damage: n.damage,
      waypoint: i === 0 ? (startWp >= 0 ? startWp : 0) : 0,
      path: [0],
      navPath: [],
      navIndex: 0,
    })),
    shards: world.shards.map((s) => ({ id: s.id, x: s.x, y: s.y, collected: false })),
    crops: (world.crops || []).map((c) => ({ id: c.id, x: c.x, y: c.y, collected: false })),
    herbs: (world.herbs || []).map((h) => ({ id: h.id, x: h.x, y: h.y, amount: h.amount, consumed: false })),
    quests: world.quests.map((q) => ({ id: q.id, name: q.name, type: q.type, done: false, progress: 0 })),
    combatCooldown: 0,
    attackCooldown: 0,
    lastHit: null,
    rngNote: `patrol target picked by fork('ai:patrol') from seed ${rng.seedString}`,
  };
}

function moveNpc(npc, tx, ty, speed, world) {
  const nav = world.navmesh;
  if (nav && !nav.lineClear(npc.x, npc.y, tx, ty)) {
    const end = npc.navPath.length > 0 ? npc.navPath[npc.navPath.length - 1] : null;
    const stale = !end || Math.hypot(end.x - tx, end.y - ty) > 1.5;
    if (npc.navPath.length === 0 || npc.navIndex >= npc.navPath.length || stale) {
      npc.navPath = nav.findPath({ x: npc.x, y: npc.y }, { x: tx, y: ty }) || [];
      npc.navIndex = 0;
    }
    if (npc.navIndex < npc.navPath.length) {
      const wp = npc.navPath[npc.navIndex];
      if (Math.hypot(wp.x - npc.x, wp.y - npc.y) < 0.3) npc.navIndex++;
      if (npc.navIndex < npc.navPath.length) {
        const t = npc.navPath[npc.navIndex];
        const moved = seek(npc, t, speed, STEP);
        npc.x = moved.x;
        npc.y = moved.y;
        return;
      }
    }
  }
  const moved = seek(npc, { x: tx, y: ty }, speed, STEP);
  npc.x = moved.x;
  npc.y = moved.y;
}

// One fixed step. `input` is {dx, dy, interact?, attack?} with dx/dy in [-1, 1].
// Pure function of (state, input, rng, world).
export function step(state, input, rng, world = DEFAULT_WORLD) {
  const next = structuredClone(state);
  next.tick += 1;
  const { bounds, waypoints, edges } = world;
  const fleeHp = world.combat.fleeHp;

  // Player movement (clamped to the world bounds).
  const len = Math.hypot(input.dx || 0, input.dy || 0) || 1;
  const moving = Boolean(input.dx || input.dy);
  const nx = next.player.x + ((input.dx || 0) / len) * PLAYER_SPEED * STEP * (moving ? 1 : 0);
  const ny = next.player.y + ((input.dy || 0) / len) * PLAYER_SPEED * STEP * (moving ? 1 : 0);
  next.player.x = Math.max(bounds.minX, Math.min(bounds.maxX, nx));
  next.player.y = Math.max(bounds.minY, Math.min(bounds.maxY, ny));

  // Player attack: nearest hostile NPC within range takes damage.
  if (next.attackCooldown > 0) next.attackCooldown -= 1;
  if (input.attack && next.attackCooldown === 0) {
    const range = world.combat.attackRange ?? 1.2;
    let best = null;
    let bestDist = Infinity;
    for (const npc of next.npcs) {
      if (npc.interaction !== "hostile" || npc.state === "defeated") continue;
      const d = Math.hypot(next.player.x - npc.x, next.player.y - npc.y);
      if (d < range && d < bestDist) { best = npc; bestDist = d; }
    }
    if (best) {
      best.hp -= world.combat.playerAttackDamage ?? 20;
      next.attackCooldown = world.combat.attackCooldownTicks ?? 30;
      next.lastHit = { npcId: best.id, tick: next.tick };
    }
  }

  // NPC FSM + steering.
  for (const npc of next.npcs) {
    if (npc.hp <= 0) {
      if (npc.state !== "defeated") { npc.state = "defeated"; npc.defeatedTimer = 0; }
      npc.defeatedTimer += 1;
      if (npc.defeatedTimer >= (world.combat.npcRespawnTicks ?? 600)) {
        npc.hp = npc.maxHp;
        npc.state = "patrol";
        npc.x = npc.homeX;
        npc.y = npc.homeY;
        npc.defeatedTimer = 0;
      }
      continue;
    }
    const dist = Math.hypot(next.player.x - npc.x, next.player.y - npc.y);
    if (npc.hp <= fleeHp) {
      npc.state = "flee";
    } else if (npc.state === "flee" && dist > npc.sight + 3) {
      npc.state = "patrol";
    } else if (npc.state === "patrol" && dist < npc.sight) {
      // Hostiles chase to contact; talk NPCs only walk up to talk range.
      // (2026-11-22 real-device QA: with plain chase for everyone the HUD
      // showed all five NPCs as "추격" at once and the player got mobbed.
      // Talk NPCs must still come to the player — the talk-quest test
      // relies on the villager closing in — so they approach and stop.)
      npc.state = npc.interaction === "hostile" ? "chase" : "approach";
    } else if ((npc.state === "chase" || npc.state === "approach") && dist > npc.sight + 3) {
      npc.state = "patrol";
    }

    if (npc.state === "patrol") {
      const target = waypoints[npc.waypoint];
      moveNpc(npc, target.x, target.y, NPC_SPEED, world);
      if (Math.hypot(target.x - npc.x, target.y - npc.y) < 0.15) {
        const options = (edges[npc.waypoint] || []).filter((id) => id !== npc.waypoint);
        const nextWp = options.length > 0 ? rng.pick(options) : npc.waypoint;
        npc.path = findPath(npc.waypoint, nextWp, edges, waypoints) || [nextWp];
        npc.waypoint = nextWp;
      }
    } else if (npc.state === "chase") {
      moveNpc(npc, next.player.x, next.player.y, NPC_SPEED * 1.15, world);
    } else if (npc.state === "approach") {
      // Talk NPCs walk up to the player but stop at talk range (1.2 is
      // inside the 1.5 interact range, so the talk quest still completes).
      if (dist > 1.2) moveNpc(npc, next.player.x, next.player.y, NPC_SPEED * 1.15, world);
    } else {
      // flee: seek away from the player.
      const away = { x: npc.x + (npc.x - next.player.x), y: npc.y + (npc.y - next.player.y) };
      const moved = seek(npc, away, NPC_SPEED * 1.3, STEP);
      npc.x = Math.max(bounds.minX, Math.min(bounds.maxX, moved.x));
      npc.y = Math.max(bounds.minY, Math.min(bounds.maxY, moved.y));
    }
  }

  // Combat-lite: hostile NPC contact damage with cooldown.
  if (next.combatCooldown > 0) next.combatCooldown -= 1;
  for (const npc of next.npcs) {
    if (npc.interaction !== "hostile" || npc.state !== "chase") continue;
    const dist = Math.hypot(next.player.x - npc.x, next.player.y - npc.y);
    if (dist < 0.8 && next.combatCooldown === 0) {
      next.player.hp -= npc.damage;
      next.combatCooldown = world.combat.contactCooldownTicks;
      if (next.player.hp <= 0) {
        next.player.hp = world.combat.playerHp;
        next.player.x = world.spawn.x;
        next.player.y = world.spawn.y;
      }
    }
  }

  // Healing herbs: walk over one to consume it and restore HP (capped at max).
  for (const herb of next.herbs) {
    if (herb.consumed) continue;
    if (Math.hypot(next.player.x - herb.x, next.player.y - herb.y) < 1.0) {
      herb.consumed = true;
      next.player.hp = Math.min(world.combat.playerHp, next.player.hp + herb.amount);
    }
  }

  // Quests.
  for (const quest of next.quests) {
    if (quest.done) continue;
    if (quest.type === "quest.talk") {
      const params = questNodeParams(world.quests.find((q) => q.id === quest.id) || {}, "talk");
      const npc = next.npcs.find((n) => n.id === params.npcId);
      if (npc && input.interact) {
        const dist = Math.hypot(next.player.x - npc.x, next.player.y - npc.y);
        if (dist < (params.range ?? 1.5)) quest.done = true;
      }
    } else if (quest.type === "quest.collect") {
      const params = questNodeParams(world.quests.find((q) => q.id === quest.id) || {}, "collect");
      const pool = params.assetId === "crop" ? next.crops : next.shards;
      for (const item of pool) {
        if (item.collected) continue;
        if (Math.hypot(next.player.x - item.x, next.player.y - item.y) < 1.0) {
          item.collected = true;
          quest.progress += 1;
        }
      }
      if (quest.progress >= (params.count ?? 3)) quest.done = true;
    } else if (quest.type === "quest.arrive") {
      const params = questNodeParams(world.quests.find((q) => q.id === quest.id) || {}, "arrive");
      const place = world.places?.[params.placeId];
      if (place) {
        const dist = Math.hypot(next.player.x - place.x, next.player.y - place.y);
        if (dist < (params.range ?? 1.5)) quest.done = true;
      }
    } else if (quest.type === "quest.defeat") {
      const params = questNodeParams(world.quests.find((q) => q.id === quest.id) || {}, "defeat");
      const npc = next.npcs.find((n) => n.id === params.npcId);
      if (npc && npc.hp <= 0) quest.done = true;
    }
  }
  return next;
}

// Headless run: simulate(seed, frames, inputs, world) -> { state, hash }.
// inputs: {dx, dy} held for all frames, or an array of per-frame {dx, dy}.
export function simulate(seed, frames, inputs = {}, world = DEFAULT_WORLD) {
  const rng = new Rng(seed).fork("ai:patrol");
  let state = createInitialState(seed, world);
  const perFrame = Array.isArray(inputs);
  for (let f = 0; f < frames; f++) {
    const input = perFrame ? inputs[f] || {} : inputs;
    state = step(state, input, rng, world);
  }
  return { state, hash: stateHash(state) };
}

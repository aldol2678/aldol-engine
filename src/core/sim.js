// Fixed-step simulation core (pure: no rendering, no wall clock, no Math.random).
// M1 slice: Supuli village — 1 map, player movement, 1 NPC with a 3-state FSM.
//
// FSM transitions (npc.state):
//   patrol -> chase : distance(player) < SIGHT (6)
//   chase  -> patrol: distance(player) > SIGHT + 3
//   any    -> flee  : npc.hp <= 25
//   flee   -> patrol: npc.hp > 25 and distance(player) > SIGHT + 3
// Steering: seek + arrive. AI ticks every step here (10-20Hz tick is a
// renderer-side optimisation; the sim itself is deterministic either way).

import { Rng } from "./rng.js";
import { stateHash } from "./state-hash.js";

export const STEP = 1 / 60;
export const PLAYER_SPEED = 3;
export const NPC_SPEED = 2.2;
export const SIGHT = 6;

// Village waypoint graph (x, y). Edges are bidirectional.
export const WAYPOINTS = [
  { id: 0, x: 0, y: 0 },
  { id: 1, x: 8, y: 0 },
  { id: 2, x: 8, y: 6 },
  { id: 3, x: 0, y: 6 },
  { id: 4, x: 4, y: 3 },
  { id: 5, x: -4, y: 3 },
];
const EDGES = {
  0: [1, 3, 4],
  1: [0, 2, 4],
  2: [1, 3, 4],
  3: [0, 2, 5],
  4: [0, 1, 2, 5],
  5: [3, 4],
};

// A* over the waypoint graph. Returns an array of waypoint ids, or null.
export function findPath(fromId, toId) {
  const open = [{ id: fromId, g: 0, f: 0, path: [fromId] }];
  const best = new Map([[fromId, 0]]);
  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    if (cur.id === toId) return cur.path;
    for (const next of EDGES[cur.id] || []) {
      const a = WAYPOINTS[cur.id];
      const b = WAYPOINTS[next];
      const g = cur.g + Math.hypot(b.x - a.x, b.y - a.y);
      if (g < (best.get(next) ?? Infinity)) {
        best.set(next, g);
        const h = Math.hypot(WAYPOINTS[toId].x - b.x, WAYPOINTS[toId].y - b.y);
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

export function createInitialState(seed) {
  const rng = new Rng(seed);
  return {
    tick: 0,
    seed: String(seed),
    player: { x: 0, y: 0 },
    npc: {
      id: "villager-1",
      x: 8,
      y: 6,
      state: "patrol",
      hp: 100,
      waypoint: 2,
      path: [2],
    },
    rngNote: `patrol target picked by fork('ai:patrol') from seed ${rng.seedString}`,
  };
}

// One fixed step. `input` is {dx, dy} in [-1, 1]. Pure function.
export function step(state, input, rng) {
  const next = structuredClone(state);
  next.tick += 1;

  // Player movement (clamped to the village bounds).
  const len = Math.hypot(input.dx || 0, input.dy || 0) || 1;
  const nx = next.player.x + ((input.dx || 0) / len) * PLAYER_SPEED * STEP * (input.dx || input.dy ? 1 : 0);
  const ny = next.player.y + ((input.dy || 0) / len) * PLAYER_SPEED * STEP * (input.dx || input.dy ? 1 : 0);
  next.player.x = Math.max(-6, Math.min(10, nx));
  next.player.y = Math.max(-2, Math.min(8, ny));

  // NPC FSM.
  const npc = next.npc;
  const dist = Math.hypot(next.player.x - npc.x, next.player.y - npc.y);
  if (npc.hp <= 25) {
    npc.state = "flee";
  } else if (npc.state === "flee" && dist > SIGHT + 3) {
    npc.state = "patrol";
  } else if (npc.state === "patrol" && dist < SIGHT) {
    npc.state = "chase";
  } else if (npc.state === "chase" && dist > SIGHT + 3) {
    npc.state = "patrol";
  }

  if (npc.state === "patrol") {
    const target = WAYPOINTS[npc.waypoint];
    const moved = seek(npc, target, NPC_SPEED, STEP);
    npc.x = moved.x;
    npc.y = moved.y;
    if (moved.arrived) {
      const options = EDGES[npc.waypoint].filter((id) => id !== npc.waypoint);
      const nextWp = rng.pick(options);
      npc.path = findPath(npc.waypoint, nextWp) || [nextWp];
      npc.waypoint = nextWp;
    }
  } else if (npc.state === "chase") {
    const moved = seek(npc, next.player, NPC_SPEED * 1.15, STEP);
    npc.x = moved.x;
    npc.y = moved.y;
  } else {
    // flee: seek away from the player.
    const away = { x: npc.x + (npc.x - next.player.x), y: npc.y + (npc.y - next.player.y) };
    const moved = seek(npc, away, NPC_SPEED * 1.3, STEP);
    npc.x = Math.max(-6, Math.min(10, moved.x));
    npc.y = Math.max(-2, Math.min(8, moved.y));
  }
  return next;
}

// Headless run: simulate(seed, frames, inputs) -> { state, hash }.
// inputs: {dx, dy} held for all frames, or an array of per-frame {dx, dy}.
export function simulate(seed, frames, inputs = {}) {
  const rng = new Rng(seed).fork("ai:patrol");
  let state = createInitialState(seed);
  const perFrame = Array.isArray(inputs);
  for (let f = 0; f < frames; f++) {
    const input = perFrame ? inputs[f] || {} : inputs;
    state = step(state, input, rng);
  }
  return { state, hash: stateHash(state) };
}

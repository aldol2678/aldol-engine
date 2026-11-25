// src/core/next/runtime.js — fixed-step game runtime: explicit input frames,
// counted seeded RNG, state hash, inspect/simulate, snapshot/restore and
// replay (ENGINE-NEXT-01 candidate).
//
// A game is a plain definition:
//   defineGame({
//     id: "rune-vault", version: 1,
//     createState(seed, world, rng) -> plain JSON state (owns no functions),
//     step(state, input, ctx)       -> mutates state in place for one tick,
//   })
// ctx = { rng, world, tick }. The runtime owns state.tick, state.seed and
// state.rngDraws; everything else belongs to the game.
//
// RNG: the shared Rng (src/core/rng.js) is reused unchanged. Its stream
// position lives in a closure, so this module wraps it in a counter
// (CountedRng) and stores the draw count in state.rngDraws. Restoring a
// snapshot re-creates Rng(seed) and fast-forwards that many draws — the
// same numbers come out after a save/load as in an uninterrupted run.
// Pure module: no rendering, no wall clock, no network.

import { Rng } from "../rng.js";
import { stateHash } from "../state-hash.js";

export const TICK = 1 / 60;
export const TICKS_PER_SECOND = 60;

export class CountedRng extends Rng {
  constructor(seedString, draws = 0) {
    super(seedString);
    if (!Number.isInteger(draws) || draws < 0) throw new Error("CountedRng: draws must be a non-negative integer");
    const base = this.next;
    this.draws = 0;
    this.next = () => {
      this.draws += 1;
      return base();
    };
    for (let i = 0; i < draws; i++) base();
    this.draws = draws;
  }
}

// inputs may be: an array indexed by frame (holes allowed), a list of
// [frame, input] pairs wrapped as { pairs: [...] }, or a Map/object keyed by
// frame. Anything that is not a plain object becomes {} — a malformed input
// frame must never crash or desync the sim.
export function normalizeInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return {};
  return input;
}

export function inputAt(inputs, frame) {
  if (!inputs) return {};
  if (Array.isArray(inputs)) return normalizeInput(inputs[frame]);
  if (inputs instanceof Map) return normalizeInput(inputs.get(frame));
  if (Array.isArray(inputs.pairs)) {
    if (!inputs._index) {
      const index = new Map();
      for (const pair of inputs.pairs) {
        if (Array.isArray(pair) && Number.isInteger(pair[0])) index.set(pair[0], pair[1]);
      }
      Object.defineProperty(inputs, "_index", { value: index, enumerable: false });
    }
    return normalizeInput(inputs._index.get(frame));
  }
  return normalizeInput(inputs[frame]);
}

export function defineGame(def) {
  if (!def || typeof def.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(def.id)) throw new Error("defineGame: id must be kebab-case");
  if (!Number.isInteger(def.version) || def.version < 1) throw new Error("defineGame: version must be a positive integer");
  if (typeof def.createState !== "function" || typeof def.step !== "function") throw new Error("defineGame: createState and step are required");

  const game = {
    id: def.id,
    version: def.version,

    // A session is { state, rng, world }: the only mutable runtime object.
    start(seed, world) {
      const seedString = String(seed);
      const rng = new CountedRng(seedString);
      const state = def.createState(seedString, world, rng);
      if (!state || typeof state !== "object") throw new Error(`${def.id}: createState must return an object`);
      state.tick = 0;
      state.seed = seedString;
      state.rngDraws = rng.draws;
      return { state, rng, world };
    },

    step(session, input) {
      const state = session.state;
      state.tick += 1;
      def.step(state, normalizeInput(input), { rng: session.rng, world: session.world, tick: state.tick });
      state.rngDraws = session.rng.draws;
      return state;
    },

    // Headless run: (seed, frames, inputs, world) -> final state.
    simulate(seed, frames, inputs, world) {
      const session = game.start(seed, world);
      for (let f = 0; f < frames; f++) game.step(session, inputAt(inputs, f));
      return session.state;
    },

    hash(sessionOrState) {
      return stateHash(sessionOrState && sessionOrState.rng ? sessionOrState.state : sessionOrState);
    },

    // JSON status for handoffs and probes.
    inspect(session) {
      return {
        game: def.id,
        version: def.version,
        seed: session.state.seed,
        tick: session.state.tick,
        rngDraws: session.state.rngDraws,
        hash: stateHash(session.state),
        summary: def.summarize ? def.summarize(session.state, session.world) : null,
      };
    },

    // Deep copy of everything needed to resume: the state carries seed,
    // tick and rngDraws, so the snapshot is just the state.
    snapshot(session) {
      return structuredClone(session.state);
    },

    restore(snapshot, world) {
      const err = game.validateState(snapshot, world);
      if (err) throw new Error(`${def.id}: cannot restore: ${err}`);
      const state = structuredClone(snapshot);
      return { state, rng: new CountedRng(state.seed, state.rngDraws), world };
    },

    // Shape check shared by restore() and save.js. Game-specific checks
    // come from def.validateState(state, world) -> string | null.
    validateState(state, world) {
      if (!state || typeof state !== "object" || Array.isArray(state)) return "state is not an object";
      if (!Number.isInteger(state.tick) || state.tick < 0) return "tick";
      if (typeof state.seed !== "string") return "seed";
      if (!Number.isInteger(state.rngDraws) || state.rngDraws < 0 || state.rngDraws > 50000000) return "rngDraws";
      return def.validateState ? def.validateState(state, world) : null;
    },
  };
  return game;
}

// --- Replay -----------------------------------------------------------
// A record is plain JSON: { game, version, seed, frames, inputs: [[frame,
// input], ...], checkpoints: [[frame, hash], ...], finalHash }.
// Only non-empty input frames are stored.

export function createRecorder(game, seed, { checkpointEvery = 0 } = {}) {
  const record = { game: game.id, version: game.version, seed: String(seed), frames: 0, inputs: [], checkpoints: [], finalHash: null };
  return {
    record,
    // Call once per tick, after game.step(session, input).
    capture(session, input) {
      const frame = session.state.tick - 1;
      const clean = normalizeInput(input);
      if (Object.keys(clean).length > 0) record.inputs.push([frame, structuredClone(clean)]);
      record.frames = session.state.tick;
      if (checkpointEvery > 0 && session.state.tick % checkpointEvery === 0) {
        record.checkpoints.push([session.state.tick, stateHash(session.state)]);
      }
      record.finalHash = null;
    },
    finish(session) {
      record.frames = session.state.tick;
      record.finalHash = stateHash(session.state);
      return structuredClone(record);
    },
  };
}

// Re-run a record and compare every checkpoint and the final hash.
// Returns { ok, hash, state, mismatch } — mismatch names the first frame
// whose hash differs (or "final").
export function replay(game, record, world) {
  if (!record || record.game !== game.id) return { ok: false, mismatch: "game", hash: null, state: null };
  if (record.version !== game.version) return { ok: false, mismatch: "version", hash: null, state: null };
  if (!Number.isInteger(record.frames) || record.frames < 0 || !Array.isArray(record.inputs)) {
    return { ok: false, mismatch: "record", hash: null, state: null };
  }
  const inputs = { pairs: record.inputs };
  const checkpoints = new Map(Array.isArray(record.checkpoints) ? record.checkpoints : []);
  const session = game.start(record.seed, world);
  let mismatch = null;
  for (let f = 0; f < record.frames; f++) {
    game.step(session, inputAt(inputs, f));
    const expected = checkpoints.get(session.state.tick);
    if (mismatch === null && expected !== undefined && expected !== stateHash(session.state)) mismatch = session.state.tick;
  }
  const hash = stateHash(session.state);
  if (mismatch === null && record.finalHash != null && record.finalHash !== hash) mismatch = "final";
  return { ok: mismatch === null, hash, state: session.state, mismatch };
}

// src/render/sim-loader.js — WASM sim with JS fallback.
//
// The three games play through this loader instead of calling their sim
// module directly. The loader tries the Rust/WASM sim first (wasm-bindgen
// `--target web` glue + .wasm, built from ~/workspace/aldol-engine-step0/wasm)
// and falls back to the plain JS sim on ANY failure (network, MIME, missing
// WebAssembly, bad world JSON, ...). The game code only sees one interface:
//
//   const sim = await createSim({ kind, seed, rngSeed, world, js });
//   sim.backend          // "wasm" | "js" (also exposed on the QA hook)
//   sim.step(input)      // advance one fixed tick, returns the new state object
//   sim.state            // current state object (same shape as the JS sim's)
//   sim.hash()           // canonical state hash (8 hex)
//   sim.loadState(obj)   // restore a full state object (save merge)
//   sim.rngNext()        // one float from the sim rng (bark picks)
//   sim.pick(arr)        // arr[Math.floor(rngNext() * arr.length)]
//
// `kind` is "supuli" | "fishing" | "defense". `seed` is the game's SEED
// (the state's seed field). `rngSeed` is the sim rng's effective seed string:
//   - supuli live game: SEED + "::bark" (JS: new Rng(SEED).fork("bark") — the
//     same stream feeds both the sim steps and the bark picks, so bark lines
//     come from sim.pick() and the stream stays identical to the JS path).
//   - fishing / defense live game: SEED (JS: new Rng(SEED), unforked).
// `js` is the game's JS sim module for the fallback path:
//   { createInitialState, step } — the page already imports these.
// The world is passed as the JS worldToSim() adapted world; it is stringified
// for WASM (the Rust side rebuilds the navmesh from it, like the POC).
// The sim rng stream, the input mapping and the save format are unchanged —
// only the loading path differs, so WASM and JS play identically.

import { Rng } from "../core/rng.js";
import { stateHash } from "../core/state-hash.js";

const WASM_GLU_URL = new URL("../wasm/aldol_sim.js", import.meta.url).href;
const WASM_TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("wasm load timeout")), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

async function tryLoadWasm() {
  try {
    const mod = await withTimeout(import(WASM_GLU_URL), WASM_TIMEOUT_MS);
    await withTimeout(mod.default(), WASM_TIMEOUT_MS);
    if (typeof mod.Sim !== "function") return null;
    return mod;
  } catch {
    return null;
  }
}

function createJsSim(kind, seed, rngSeed, world, js) {
  let state = js.createInitialState(seed, world);
  const rng = new Rng(rngSeed);
  return {
    backend: "js",
    step(input) {
      state = js.step(state, input, rng, world);
      return state;
    },
    get state() {
      return state;
    },
    hash() {
      return stateHash(state);
    },
    loadState(next) {
      state = structuredClone(next);
    },
    rngNext() {
      return rng.next();
    },
    pick(arr) {
      return arr[Math.floor(rng.next() * arr.length)];
    },
  };
}

function createWasmSim(mod, kind, seed, rngSeed, world) {
  const worldJson = JSON.stringify(world);
  let wasmSim = new mod.Sim(kind, seed, rngSeed, worldJson);
  let state = JSON.parse(wasmSim.state());
  return {
    backend: "wasm",
    step(input) {
      state = JSON.parse(wasmSim.step(JSON.stringify(input)));
      return state;
    },
    get state() {
      return state;
    },
    hash() {
      return wasmSim.hash();
    },
    loadState(next) {
      try {
        wasmSim.set_state(JSON.stringify(next));
        state = JSON.parse(wasmSim.state());
      } catch (e) {
        // A state the Rust side cannot parse must never blank the game:
        // reset to a fresh sim (the save is dropped) and say so loudly.
        console.warn("sim-loader: set_state failed, resetting to fresh state", e);
        wasmSim = new mod.Sim(kind, seed, rngSeed, worldJson);
        state = JSON.parse(wasmSim.state());
      }
    },
    rngNext() {
      return wasmSim.rng_next();
    },
    pick(arr) {
      return arr[Math.floor(wasmSim.rng_next() * arr.length)];
    },
  };
}

export async function createSim({ kind, seed, rngSeed, world, js }) {
  const mod = await tryLoadWasm();
  if (mod) {
    try {
      return createWasmSim(mod, kind, seed, rngSeed, world);
    } catch {
      // WASM construction failed (bad world JSON, etc.) — fall through to JS.
    }
  }
  return createJsSim(kind, seed, rngSeed, world, js);
}

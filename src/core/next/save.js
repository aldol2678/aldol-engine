// src/core/next/save.js — versioned save envelope with checksum and strict
// validation (ENGINE-NEXT-01 candidate). New games only: the save keys and
// formats of Supuli / Star Fishing / Star Defense are not touched and there
// is no migration from them.
//
// Envelope (JSON text):
//   { format: "aldol-next-save/1", gameId, version, tick, checksum, payload }
// checksum = stateHash(payload). parseSave() refuses, with a reason code,
// anything that is not exactly a save of this game at this version:
//   E_EMPTY E_TOO_LARGE E_PARSE E_FORMAT E_GAME E_VERSION_UNKNOWN
//   E_CHECKSUM E_SHAPE
// A refused save is never partially applied — the caller starts a new game.
// This module does not read storage; src/render/next/shell.js owns
// localStorage. Pure module: no wall clock (no savedAt timestamp).

import { stateHash } from "../state-hash.js";

export const SAVE_FORMAT = "aldol-next-save/1";
export const MAX_SAVE_CHARS = 2000000;

export function saveKey(gameId, milestone, version = 1) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(gameId) || !/^m[0-9]+$/.test(milestone) || !Number.isInteger(version) || version < 1) {
    throw new Error("saveKey: bad game id, milestone or version");
  }
  return `aldol-engine.${gameId}-${milestone}.save.v${version}`;
}

export function serializeSave({ gameId, version, state }) {
  if (typeof gameId !== "string" || !Number.isInteger(version)) throw new Error("serializeSave: gameId and integer version are required");
  if (!state || typeof state !== "object") throw new Error("serializeSave: state must be an object");
  // Round-trip through JSON first so the checksum covers exactly what is
  // stored (undefined fields and -0 do not survive JSON).
  const payload = JSON.parse(JSON.stringify(state));
  return JSON.stringify({
    format: SAVE_FORMAT,
    gameId,
    version,
    tick: Number.isInteger(payload.tick) ? payload.tick : 0,
    checksum: stateHash(payload),
    payload,
  });
}

function hasForbiddenKey(value, depth = 0) {
  if (value === null || typeof value !== "object") return false;
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some((v) => hasForbiddenKey(v, depth + 1));
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return true;
    if (hasForbiddenKey(value[key], depth + 1)) return true;
  }
  return false;
}

// validate(payload) -> string | null is the game's own shape check
// (game.validateState from runtime.js fits). Returns
//   { ok: true, state, tick } or { ok: false, code, detail }.
export function parseSave(text, { gameId, version, validate = null }) {
  const fail = (code, detail = "") => ({ ok: false, code, detail });
  if (typeof text !== "string" || text.length === 0) return fail("E_EMPTY");
  if (text.length > MAX_SAVE_CHARS) return fail("E_TOO_LARGE", String(text.length));
  let env;
  try { env = JSON.parse(text); } catch (e) { return fail("E_PARSE", String(e && e.message).slice(0, 120)); }
  if (!env || typeof env !== "object" || Array.isArray(env) || env.format !== SAVE_FORMAT) return fail("E_FORMAT", String(env && env.format));
  if (env.gameId !== gameId) return fail("E_GAME", String(env.gameId));
  if (env.version !== version) return fail("E_VERSION_UNKNOWN", String(env.version));
  const payload = env.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("E_SHAPE", "payload");
  if (hasForbiddenKey(payload)) return fail("E_SHAPE", "forbidden key");
  if (typeof env.checksum !== "string" || env.checksum !== stateHash(payload)) return fail("E_CHECKSUM");
  if (validate) {
    let err;
    try { err = validate(payload); } catch (e) { err = "validator threw: " + String(e && e.message).slice(0, 120); }
    if (err) return fail("E_SHAPE", err);
  }
  return { ok: true, state: payload, tick: env.tick };
}

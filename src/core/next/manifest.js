// src/core/next/manifest.js — additive adapter from a WorldForge 0.1
// manifest to the data the next-gen games need (ENGINE-NEXT-01 candidate).
//
// src/core/worldforge.js is reused as-is for validation and is NOT changed:
// worldToSim() there is shaped for the M1–M3 sims (navmesh, shards, crops…),
// so the new games read their own rule config through this adapter instead
// of adding per-game fields to it. The manifest stays the only source of
// map/rule data; sims never hardcode a level.
// Coordinates: manifest [x, y, z] (Y-up) -> 2D { x, z }.
// Pure module.

import { validateWorldManifest } from "../worldforge.js";
import { questDefsFromManifest } from "./quest.js";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// Returns a deep-frozen world: { worldId, projectId, name, ruleType, config,
// places, entities, entityById, quests, questDefs, bounds }.
// Throws when the manifest is invalid or the game's rule is missing — a bad
// world stops the game before it starts.
export function loadGameWorld(manifest, { ruleType, projectId = null, questConditions = true } = {}) {
  const v = validateWorldManifest(manifest);
  if (!v.valid) throw new Error("invalid world manifest: " + JSON.stringify(v.errors));
  if (projectId && manifest.project?.id !== projectId) throw new Error(`world manifest is for project "${manifest.project?.id}", expected "${projectId}"`);
  const rule = manifest.rules.find((r) => r.type === ruleType && r.enabled !== false);
  if (!rule || !rule.config || typeof rule.config !== "object") throw new Error(`world manifest has no enabled "${ruleType}" rule`);

  const places = {};
  for (const p of manifest.places) {
    places[p.id] = { id: p.id, name: p.name || p.id, type: p.type || "place", zoneId: p.zoneId || null, x: p.position[0], z: p.position[2] };
  }
  const entities = manifest.entities
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      id: e.id, name: e.name || e.id, type: e.type || "entity", assetId: e.assetId || null,
      tags: Array.isArray(e.tags) ? e.tags.slice() : [],
      components: structuredClone(e.components || {}),
      x: e.transform.position[0], z: e.transform.position[2],
    }));
  const entityById = {};
  for (const e of entities) entityById[e.id] = e;

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const zone of manifest.zones) {
    for (const pt of zone.geometry?.points || []) {
      minX = Math.min(minX, pt[0]); maxX = Math.max(maxX, pt[0]);
      minZ = Math.min(minZ, pt[1]); maxZ = Math.max(maxZ, pt[1]);
    }
  }
  const bounds = Number.isFinite(minX) ? { minX, maxX, minZ, maxZ } : null;

  return deepFreeze({
    worldId: manifest.world.id,
    projectId: manifest.project?.id || null,
    name: manifest.world.name || manifest.world.id,
    ruleType,
    config: structuredClone(rule.config),
    places,
    entities,
    entityById,
    quests: structuredClone(manifest.quests),
    questDefs: questConditions ? questDefsFromManifest(manifest.quests) : [],
    bounds,
  });
}

// Tile rows ("#..#" strings) -> grid data. `wall` characters block; every
// other non-floor character is collected under marks[char] as [{ c, r }]
// in row-major order. All rows must have the same length.
export function parseTileRows(rows, { wall = "#", floor = "." } = {}) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((r) => typeof r !== "string")) throw new Error("parseTileRows: rows must be a non-empty array of strings");
  const cols = rows[0].length;
  if (cols === 0 || rows.some((r) => r.length !== cols)) throw new Error("parseTileRows: all rows must have the same non-zero length");
  const blocked = [];
  const marks = {};
  rows.forEach((row, r) => {
    for (let c = 0; c < cols; c++) {
      const ch = row[c];
      if (ch === wall) blocked.push([c, r]);
      else if (ch !== floor) (marks[ch] || (marks[ch] = [])).push({ c, r });
    }
  });
  return { cols, rows: rows.length, blocked, marks };
}

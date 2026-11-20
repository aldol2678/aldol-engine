// WorldForge manifest (worldforge/0.1) — minimal JS mirror of the official
// validator (packages/worldforge-schema/src/validate.ts, P4-2 2026-11-16).
// The full WorldForge runtime (Zod + PlayCanvas app) is NOT vendored here;
// this module validates the manifest subset Aldol Engine uses and adapts it
// to the sim. Source of truth for the schema:
//   vendor-upstream/packages/worldforge-schema/schema/world-manifest.schema.json
//   ($id: aldol2678/aldol-worldforge, world-manifest.schema.json)

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const TOP = ["schemaVersion", "project", "world", "assets", "zones", "places", "paths", "entities", "npcs", "quests", "events", "rules"];

function dupErrors(collection, values) {
  const seen = new Set();
  const errors = [];
  values.forEach((v, i) => {
    if (!v || typeof v.id !== "string" || !ID_RE.test(v.id)) {
      errors.push({ code: "E_ID", path: `${collection}[${i}].id`, detail: String(v?.id) });
      return;
    }
    if (seen.has(v.id)) errors.push({ code: "E_DUPLICATE_ID", path: `${collection}[${i}].id`, detail: v.id });
    seen.add(v.id);
  });
  return errors;
}

export function validateWorldManifest(input) {
  const errors = [];
  if (!input || typeof input !== "object") return { valid: false, errors: [{ code: "E_NOT_OBJECT", path: "$" }], warnings: [] };
  if (input.schemaVersion !== "worldforge/0.1") {
    errors.push({ code: "E_SCHEMA_VERSION", path: "schemaVersion", detail: String(input.schemaVersion) });
  }
  for (const key of TOP) {
    if (!(key in input)) errors.push({ code: "E_MISSING", path: key });
  }
  if (errors.length > 0) return { valid: false, errors, warnings: [] };
  const lists = ["assets", "zones", "places", "paths", "entities", "npcs", "quests", "events", "rules"];
  for (const name of lists) {
    if (!Array.isArray(input[name])) errors.push({ code: "E_NOT_ARRAY", path: name });
  }
  if (errors.length > 0) return { valid: false, errors, warnings: [] };
  for (const name of lists) errors.push(...dupErrors(name, input[name]));

  const assetIds = new Set(input.assets.map((a) => a.id));
  const zoneIds = new Set(input.zones.map((z) => z.id));
  const placeIds = new Set(input.places.map((p) => p.id));
  const entityIds = new Set(input.entities.map((e) => e.id));

  input.places.forEach((p, i) => {
    if (p.zoneId && !zoneIds.has(p.zoneId)) errors.push({ code: "E_ZONE_REF_NOT_FOUND", path: `places[${i}].zoneId`, detail: p.zoneId });
    if (!Array.isArray(p.position) || p.position.length !== 3) errors.push({ code: "E_PLACE_POSITION", path: `places[${i}].position` });
  });
  input.paths.forEach((p, i) => {
    if (p.from && !placeIds.has(p.from)) errors.push({ code: "E_PLACE_REF_NOT_FOUND", path: `paths[${i}].from`, detail: p.from });
    if (p.to && !placeIds.has(p.to)) errors.push({ code: "E_PLACE_REF_NOT_FOUND", path: `paths[${i}].to`, detail: p.to });
  });
  input.entities.forEach((e, i) => {
    if (e.parentId && !entityIds.has(e.parentId)) errors.push({ code: "E_ENTITY_PARENT_NOT_FOUND", path: `entities[${i}].parentId`, detail: e.parentId });
    if (e.assetId && !assetIds.has(e.assetId)) errors.push({ code: "E_ASSET_REF_NOT_FOUND", path: `entities[${i}].assetId`, detail: e.assetId });
    if (!e.transform || !Array.isArray(e.transform.position) || e.transform.position.length !== 3) {
      errors.push({ code: "E_ENTITY_TRANSFORM", path: `entities[${i}].transform` });
    }
  });
  input.npcs.forEach((n, i) => {
    if (n.entityId && !entityIds.has(n.entityId)) errors.push({ code: "E_NPC_ENTITY_REF_NOT_FOUND", path: `npcs[${i}].entityId`, detail: n.entityId });
    if (n.homePlaceId && !placeIds.has(n.homePlaceId)) errors.push({ code: "E_NPC_HOME_REF_NOT_FOUND", path: `npcs[${i}].homePlaceId`, detail: n.homePlaceId });
    if (!n.profile || typeof n.profile.role !== "string") errors.push({ code: "E_NPC_PROFILE", path: `npcs[${i}].profile` });
    if (!Array.isArray(n.schedule) || n.schedule.length === 0) errors.push({ code: "E_NPC_SCHEDULE", path: `npcs[${i}].schedule` });
  });
  input.quests.forEach((q, qi) => {
    errors.push(...dupErrors(`quests[${qi}].nodes`, q.nodes || []));
    const nodeIds = new Set((q.nodes || []).map((n) => n.id));
    (q.edges || []).forEach((e, ei) => {
      if (!nodeIds.has(e.from)) errors.push({ code: "E_QUEST_NODE_REF_NOT_FOUND", path: `quests[${qi}].edges[${ei}].from`, detail: e.from });
      if (!nodeIds.has(e.to)) errors.push({ code: "E_QUEST_NODE_REF_NOT_FOUND", path: `quests[${qi}].edges[${ei}].to`, detail: e.to });
    });
  });
  return { valid: errors.length === 0, errors, warnings: [] };
}

// Manifest [x, y, z] (Y-up) -> sim 2D (x, z).
const toSim = (pos) => ({ x: pos[0], y: pos[2] });

export function worldToSim(world) {
  const places = new Map(world.places.map((p) => [p.id, p]));
  const entities = new Map(world.entities.map((e) => [e.id, e]));

  // Bounds from zone polygons.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const z of world.zones) {
    for (const [x, y] of z.geometry.points) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }

  // Waypoints: nav.waypoint places; edges from paths between waypoints.
  const waypoints = world.places
    .filter((p) => p.type === "nav.waypoint")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({ id: p.id, ...toSim(p.position) }));
  const wpIndex = new Map(waypoints.map((w, i) => [w.id, i]));
  const edges = {};
  waypoints.forEach((w, i) => { edges[i] = []; });
  for (const p of world.paths) {
    if (!p.enabled) continue;
    const a = wpIndex.get(p.from);
    const b = wpIndex.get(p.to);
    if (a === undefined || b === undefined) continue;
    if (!edges[a].includes(b)) edges[a].push(b);
    if (!p.oneWay && !edges[b].includes(a)) edges[b].push(a);
  }

  const houses = world.entities
    .filter((e) => e.type === "entity.house" && e.enabled !== false)
    .map((e) => ({ id: e.id, ...toSim(e.transform.position) }));
  const trees = world.entities
    .filter((e) => e.type === "entity.tree" && e.enabled !== false)
    .map((e) => ({ id: e.id, ...toSim(e.transform.position) }));
  const shards = world.entities
    .filter((e) => e.components && e.components["game.collectible"] && e.enabled !== false)
    .map((e) => ({ id: e.id, questId: e.components["game.collectible"].questId, ...toSim(e.transform.position) }));

  const npcs = world.npcs.map((n) => {
    const ent = entities.get(n.entityId);
    const pos = ent ? toSim(ent.transform.position) : { x: 0, y: 0 };
    return {
      id: n.id,
      name: n.name || n.id,
      x: pos.x,
      y: pos.y,
      hp: n.profile?.attributes?.hp ?? 100,
      homePlaceId: n.homePlaceId || null,
      interaction: n.behavior?.interaction || "talk",
      sight: n.behavior?.params?.sight ?? 6,
      damage: n.behavior?.params?.damage ?? 0,
    };
  });

  const spawn = places.get("spawn") ? toSim(places.get("spawn").position) : { x: 0, y: 0 };
  const quests = world.quests.map((q) => {
    const nodes = new Map(q.nodes.map((n) => [n.id, n]));
    return { id: q.id, name: q.name, type: q.type, nodes: q.nodes, edges: q.edges, params: nodes };
  });
  const combatRule = world.rules.find((r) => r.type === "game.combat" && r.enabled);
  const combat = combatRule ? combatRule.config : { contactDamage: 10, contactCooldownTicks: 60, playerHp: 100, fleeHp: 25 };

  const placeMap = {};
  for (const p of world.places) placeMap[p.id] = toSim(p.position);

  return { worldId: world.world.id, bounds: { minX, maxX, minY, maxY }, waypoints, edges, houses, trees, shards, npcs, spawn, quests, combat, places: placeMap };
}

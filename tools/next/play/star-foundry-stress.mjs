// Pure helpers (no browser) for Star Foundry load tests and benchmarks:
// derive a big workshop from the real manifest and a build script that
// fills it with belts, so the sim holds ~`entities` entities.
// Used by tools/check-star-foundry.mjs; reusable by a perf benchmark.

// A cols x rows open grid with one ore source at the left end of every row
// and one depot in the top-right corner. Coins are raised so the script can
// afford every belt; rules/recipes are the real ones.
export function stressManifest(manifest, { cols = 40, rows = 26 } = {}) {
  const m = JSON.parse(JSON.stringify(manifest));
  const rule = m.rules.find((r) => r.type === "game.foundry");
  rule.config.grid.rows = Array.from({ length: rows }, () => ".".repeat(cols));
  rule.config.startCoins = 1000000;
  rule.config.deadlineTicks = 100000000;
  const template = m.entities.find((e) => e.components["game.source"]);
  const depot = m.entities.find((e) => e.components["game.depot"]);
  m.entities = [];
  for (let r = 0; r < rows; r++) {
    const e = JSON.parse(JSON.stringify(template));
    e.id = `ent-stress-source-${r}`;
    e.transform.position = [0, 0, r];
    e.components["game.source"] = { item: "ore", intervalTicks: 6, jitterTicks: 3, dir: "right" };
    m.entities.push(e);
  }
  depot.transform.position = [cols - 1, 0, 0];
  m.entities.push(depot);
  m.zones[0].geometry.points = [[-0.5, -0.5], [cols - 0.5, -0.5], [cols - 0.5, rows - 0.5], [-0.5, rows - 0.5]];
  m.places.forEach((p) => { p.position = [1, 0, 1]; });
  return m;
}

// One build command per frame: belts running right along every row until
// the entity budget (buildings + the items that will pile up on them) is
// reached. Lines dead-end, so every belt fills up through back-pressure.
// Returns an inputs array (index = frame).
export function stressInputs({ cols = 40, rows = 26, entities = 1000 } = {}) {
  const inputs = [];
  const belts = Math.max(1, Math.floor((entities - rows - 1) / 2));
  for (let c = 1; c < cols - 1 && inputs.length < belts; c++) {
    for (let r = 0; r < rows && inputs.length < belts; r++) {
      inputs.push({ build: { kind: "belt", c, r, dir: "right" } });
    }
  }
  return inputs;
}

// Browser scenario — Star Defense (M3, existing game, unchanged). Regression
// only: place towers on build spots, start wave 1, wait for the clear, reload.
export const meta = {
  id: "star-defense", path: "games/star-defense/index.html", saveKey: "aldol-engine.star-defense-m3.save.v1",
  ready: () => !!window.__STAR_DEFENSE__, hudStrict: false,
};
const snap = (page) => page.evaluate(() => { const s = window.__STAR_DEFENSE__.state; return { phase: s.phase, stars: s.stars, towers: s.towers.length, wavesCleared: s.wavesCleared, kills: s.kills, shrineHp: s.shrineHp, backend: window.__STAR_DEFENSE__.backend, assets: window.__STAR_DEFENSE__.assets }; });

export async function play(page, ctx) {
  const start = await snap(page);
  ctx.step(`sim backend: ${start.backend}; GLB loaded=${start.assets.loaded.length} failed=${start.assets.failed.length}`);
  ctx.expect(start.phase === "build" && start.stars === 100 && start.towers === 0, "fresh game starts in the build phase with 100 stars");
  // A build spot can sit under a HUD element on small screens. That is how
  // the existing page lays out (unchanged here), so covered spots are
  // recorded as a baseline observation and the next free spot is used.
  const spots = await page.evaluate(() => {
    const w = window.__STAR_DEFENSE__;
    return w.world.defense.buildSpots.map((id) => {
      const p = w.project(w.world.places[id].x, w.world.places[id].y);
      const el = document.elementFromPoint(p.x, p.y);
      return { id, x: p.x, y: p.y, free: !!el && el.tagName === "CANVAS" };
    });
  });
  const covered = spots.filter((s) => !s.free).map((s) => s.id);
  ctx.step(`baseline observation: build spots covered by HUD at this viewport: ${covered.join(", ") || "none"} (existing game — recorded, not gated)`);
  // Tap free spots in a fixed order until three towers stand. A spot whose
  // tap places nothing is recorded as a baseline observation (on the 844x390
  // landscape viewport the unchanged page does not register a tap on
  // spot-3 — reproduced on the origin/main checkout as well).
  const order = ["spot-1", "spot-3", "spot-5", "spot-2", "spot-4", "spot-6", "spot-7"].map((id) => spots.find((s) => s.id === id)).filter((s) => s && s.free);
  const placed = [];
  const silent = [];
  for (const p of order) {
    if (placed.length === 3) break;
    await ctx.tapXY(p.x, p.y);
    await page.waitForTimeout(200);
    if ((await snap(page)).towers > placed.length) placed.push(p.id); else silent.push(p.id);
  }
  if (silent.length > 0) ctx.step(`baseline observation: tap on ${silent.join(", ")} placed no tower at this viewport (existing game — recorded, not gated)`);
  const built = await snap(page);
  ctx.expect(built.towers === 3 && built.stars === 10, `placed 3 star towers by tapping build spots ${placed.join(", ")} (towers=${built.towers}, stars=${built.stars})`);
  if (ctx.mobile) await ctx.tap("#wave-btn"); else await ctx.key("Space");
  await page.waitForFunction(() => window.__STAR_DEFENSE__.state.phase === "combat", null, { timeout: 5000 });
  await ctx.shot("play");
  await page.waitForFunction(() => window.__STAR_DEFENSE__.state.wavesCleared >= 1, null, { timeout: 60000 });
  const cleared = await snap(page);
  ctx.expect(cleared.kills + (10 - cleared.shrineHp) === 5 && cleared.phase === "build", `wave 1 cleared (kills=${cleared.kills}, shrine=${cleared.shrineHp})`);
  await ctx.reload();
  const after = await snap(page);
  ctx.expect(after.towers === 3 && after.wavesCleared === 1 && after.stars === cleared.stars, `towers, stars and cleared wave restored after reload (stars=${after.stars})`);
}

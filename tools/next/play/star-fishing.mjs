// Browser scenario — Star Fishing (M2, existing game, unchanged). Regression
// only: walk to the dock end, cast, wait for the bite, reel, reload.
export const meta = {
  id: "star-fishing", path: "games/star-fishing/index.html", saveKey: "aldol-engine.star-fishing-m2.save.v1",
  ready: () => !!window.__STAR_FISHING__, hudStrict: false,
};
const snap = (page) => page.evaluate(() => { const s = window.__STAR_FISHING__.state; return { x: s.player.x, y: s.player.y, phase: s.fishing.phase, casts: s.casts, caught: s.caught.length, score: s.score, backend: window.__STAR_FISHING__.backend, assets: window.__STAR_FISHING__.assets }; });

export async function play(page, ctx) {
  const start = await snap(page);
  ctx.step(`sim backend: ${start.backend}; GLB loaded=${start.assets.loaded.length} failed=${start.assets.failed.length}`);
  ctx.expect(start.assets.loaded.length === 2 && start.assets.failed.length === 0, "both GLB models loaded (no fallback needed)");
  const cx = ctx.viewport.width / 2;
  const cy = ctx.viewport.height / 2;
  for (let i = 0; i < 12 && (await snap(page)).y > -3.9; i++) {
    if (ctx.mobile) await ctx.drag(cx, cy, cx, cy - 90, 700);
    else await ctx.holdKey("w", 700);
  }
  const atDock = await snap(page);
  ctx.expect(atDock.y <= -3.6, `walked up the dock (y ${start.y.toFixed(2)} -> ${atDock.y.toFixed(2)})`);
  let caught = 0;
  let casts = 0;
  // The bite window is 20–45 ticks (0.33–0.75 s), so the reel input must
  // follow the bite quickly: resolve the button position up front and send
  // the tap/key the moment the page reports the bite.
  const reelBox = ctx.mobile ? await page.locator("#reel-btn").boundingBox() : null;
  for (let attempt = 0; attempt < 6 && caught === 0; attempt++) {
    await page.waitForFunction(() => window.__STAR_FISHING__.state.fishing.phase === "idle", null, { timeout: 15000 });
    if (ctx.mobile) await ctx.tap("#cast-btn"); else await ctx.key("e");
    await page.waitForFunction(() => window.__STAR_FISHING__.state.fishing.phase !== "idle", null, { timeout: 5000 });
    casts += 1;
    await page.waitForFunction(() => window.__STAR_FISHING__.state.fishing.phase === "bite", null, { timeout: 15000, polling: "raf" }).catch(() => {});
    if (ctx.mobile) await ctx.tapXY(reelBox.x + reelBox.width / 2, reelBox.y + reelBox.height / 2); else await ctx.key("Space");
    await page.waitForTimeout(300);
    caught = (await snap(page)).caught;
  }
  const end = await snap(page);
  ctx.expect(end.casts >= 1, `cast the line (${end.casts} casts)`);
  ctx.expect(end.caught >= 1 && end.score > 0, `caught a fish on the bite (${end.caught} caught, score ${end.score}, ${casts} attempts)`);
  await ctx.shot("play");
  await ctx.reload();
  const after = await snap(page);
  ctx.expect(after.score === end.score && after.caught === end.caught, `score and catch restored after reload (score ${after.score})`);
}

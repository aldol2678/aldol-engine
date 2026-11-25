// Browser scenario — Supuli (M1, existing game, unchanged). Regression only:
// move with real keyboard/drag input, attack, and check the save survives a
// reload. HUD layout facts are recorded as baseline observations.
export const meta = {
  id: "supuli", path: "games/supuli/index.html", saveKey: "aldol-engine.supuli-m1.save.v4",
  ready: () => !!window.__SUPULI_M1__, hudStrict: false,
};
const player = (page) => page.evaluate(() => ({ ...window.__SUPULI_M1__.state.player, tick: window.__SUPULI_M1__.state.tick, backend: window.__SUPULI_M1__.backend }));

export async function play(page, ctx) {
  const start = await player(page);
  ctx.step(`sim backend: ${start.backend}`);
  const cx = ctx.viewport.width / 2;
  const cy = ctx.viewport.height / 2;
  if (ctx.mobile) await ctx.drag(cx, cy, cx + 80, cy, 900);
  else await ctx.holdKey("d", 900);
  const moved = await player(page);
  ctx.expect(moved.x > start.x + 0.5, `player moved right (${start.x.toFixed(2)} -> ${moved.x.toFixed(2)})`);
  if (ctx.mobile) await ctx.drag(cx, cy, cx, cy + 80, 700);
  else await ctx.holdKey("s", 700);
  const moved2 = await player(page);
  ctx.expect(moved2.y > moved.y + 0.3, `player moved down-screen (${moved.y.toFixed(2)} -> ${moved2.y.toFixed(2)})`);
  if (ctx.mobile) await ctx.tap("#attack-btn"); else await ctx.key("Space");
  await page.waitForTimeout(200);
  ctx.expect((await player(page)).tick > moved2.tick, "sim keeps ticking after attack input");
  await ctx.shot("play");
  await ctx.reload();
  const after = await player(page);
  ctx.expect(Math.abs(after.x - moved2.x) < 1.5 && Math.abs(after.y - moved2.y) < 1.5, `position restored from save after reload (${after.x.toFixed(2)}, ${after.y.toFixed(2)})`);
  const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), meta.saveKey);
  ctx.expect(saved && saved.player && Array.isArray(saved.quests) && saved.quests.length === 9, "save keeps the v4 shape (player + 9 quests)");
}

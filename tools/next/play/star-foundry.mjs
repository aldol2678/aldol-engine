// Browser scenario — Star Foundry (M6 candidate). Builds a working factory
// through real input, checks an illegal placement, a mid-production reload,
// the speed toggle, the win and a new-game restart.
export const meta = {
  id: "star-foundry", path: "games/star-foundry/index.html", saveKey: "aldol-engine.star-foundry-m6.save.v1",
  ready: () => !!window.__ALDOL_NEXT__,
};
const probe = (page) => page.evaluate(() => {
  const p = window.__ALDOL_NEXT__;
  const s = p.state();
  return {
    tick: s.tick, phase: s.phase, coins: p.coins(), refused: s.refused, delivered: s.ledger.delivered, ui: p.ui(),
    buildings: p.buildings().map((b) => `${b.kind}@${b.c},${b.r}:${b.dir}`).sort(), balanced: p.ledger().balanced,
    quests: s.quests.map((q) => q.done), load: p.loadResult(),
  };
});

export async function play(page, ctx) {
  const tool = async (name, key) => { if (ctx.mobile) await ctx.tap(`#tool-${name}`); else await ctx.key(key); };
  const place = async (c, r) => { await ctx.tapCell(c, r); await ctx.waitTicks(3); };
  const setSpeed4 = async () => {
    if ((await probe(page)).ui.speed === 4) return;
    if (ctx.mobile) await ctx.tap("#speed-btn"); else await ctx.key("f");
  };

  const start = await probe(page);
  ctx.expect(start.phase === "playing" && start.coins === 120 && start.buildings.length === 3 && start.load.code === "E_NONE", `fresh game: 120 coins, 3 fixed structures (${start.buildings.join(" ")})`);

  // Phase 1: mine -> belt -> smelter -> belts -> depot.
  await tool("belt", "1");
  if (ctx.mobile) await place(1, 3);
  else { await ctx.key("Enter"); await ctx.waitTicks(3); } // cursor starts on (1, 3)
  await tool("smelter", "2");
  await place(2, 3);
  await tool("belt", "1");
  for (const c of [3, 4, 5, 6, 7, 8]) await place(c, 3);
  const built = await probe(page);
  ctx.expect(built.buildings.length === 11 && built.coins === 120 - 7 * 5 - 30, `built 7 belts + smelter by ${ctx.mobile ? "taps" : "Enter at the cursor, keys 1/2 and clicks"} (coins=${built.coins})`);

  // Illegal placements are refused by the sim and change nothing.
  await place(3, 1); // pillar
  await place(2, 3); // occupied
  const refused = await probe(page);
  ctx.expect(refused.refused === built.refused + 2 && refused.coins >= built.coins && refused.buildings.length === 11, `building on a pillar / occupied cell is refused (refused ${built.refused} -> ${refused.refused}, coins ${built.coins} -> ${refused.coins}, buildings=${refused.buildings.length})`);

  await setSpeed4();
  ctx.expect((await probe(page)).ui.speed === 4, "speed toggle switches to x4");
  await ctx.waitFor(() => (window.__ALDOL_NEXT__.state().ledger.delivered.ingot || 0) >= 1, null, 40000);
  await ctx.shot("play");

  // Reload mid-production: the factory comes back from the save.
  const before = await probe(page);
  await ctx.reload();
  const after = await probe(page);
  ctx.expect(after.load.ok === true, `save accepted after reload (${after.load.code || "ok"})`);
  ctx.expect(JSON.stringify(after.buildings) === JSON.stringify(before.buildings) && after.tick > 0 && after.tick <= before.tick + 600 && after.balanced,
    `factory restored mid-production: ${after.buildings.length} buildings, ledger balanced, tick ${after.tick}`);
  ctx.expect((after.delivered.ingot || 0) >= 1 && after.coins >= before.coins - 0 - 10, `deliveries and coins restored (ingots=${after.delivered.ingot}, coins=${after.coins})`);

  await setSpeed4();
  await ctx.waitFor(() => window.__ALDOL_NEXT__.state().quests[1].done, null, 60000);
  const order1 = await probe(page);
  ctx.expect(order1.quests[1] && order1.delivered.ingot >= 3, `order 1 done: ${order1.delivered.ingot} ingots delivered, reward paid (coins=${order1.coins})`);

  // Phase 2: swap one belt for the assembler and feed it crystals.
  await tool("erase", "4");
  await place(5, 3);
  await tool("assembler", "3");
  await place(5, 3);
  await tool("belt", "1");
  for (let i = 0; i < 4 && (await probe(page)).ui.dir !== "up"; i++) {
    if (ctx.mobile) await ctx.tap("#rotate-btn"); else await ctx.key("r");
  }
  ctx.expect((await probe(page)).ui.dir === "up", "rotate control turns the belt direction to up");
  await place(5, 5);
  await place(5, 4);
  const phase2 = await probe(page);
  ctx.expect(phase2.buildings.includes("assembler@5,3:right") && phase2.buildings.includes("belt@5,5:up") && phase2.buildings.includes("belt@5,4:up"), "assembler and crystal line built");
  await ctx.shot("play2");

  await ctx.waitFor(() => window.__ALDOL_NEXT__.state().phase !== "playing", null, 90000);
  const end = await probe(page);
  ctx.expect(end.phase === "won" && end.delivered.lamp === 5 && end.quests.every(Boolean) && end.balanced, `won: 5 lamps delivered, all orders done, ledger balanced (phase=${end.phase})`);
  await ctx.reload();
  ctx.expect((await probe(page)).phase === "won", "won state survives a reload");

  // New game.
  if (ctx.mobile) await ctx.tap("#new-btn"); else await ctx.key("n");
  await ctx.waitTicks(2);
  const fresh = await probe(page);
  ctx.expect(fresh.phase === "playing" && fresh.coins === 120 && fresh.buildings.length === 3 && fresh.tick < 120 && !fresh.quests.some(Boolean), `new game starts fresh (tick=${fresh.tick}, coins=${fresh.coins})`);
}

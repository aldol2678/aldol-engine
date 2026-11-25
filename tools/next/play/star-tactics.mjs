// Browser play scenario for Star Tactics (M5). Decisions come from the
// shared bot reading live probe state; every action is performed with real
// input: taps on cells/buttons (touch on mobile configs, mouse on desktop)
// and, on desktop, keyboard for unit cycling / skill / end turn / new game.
import fs from "node:fs";
import { loadWorld, listUnits } from "../../../games/star-tactics/tactics.js";
import { planAction } from "./star-tactics-bot.mjs";

export const meta = {
  id: "star-tactics",
  path: "games/star-tactics/index.html",
  saveKey: "aldol-engine.star-tactics-m5.save.v1",
  ready: () => !!window.__ALDOL_NEXT__,
};

const world = loadWorld(JSON.parse(fs.readFileSync(new URL("../../../games/star-tactics/world.json", import.meta.url), "utf8")));
const brief = (state) => JSON.stringify(listUnits(state).map((u) => [u.id, u.c, u.r, u.hp, u.ap]));

export async function play(page, ctx) {
  const ui = () => page.evaluate(() => window.__ALDOL_NEXT__.ui());
  const settle = async () => {
    await ctx.waitTicks(2);
    await page.waitForFunction(() => window.__ALDOL_NEXT__.pending() === 0, null, { timeout: 10000 });
  };
  async function selectUnit(state, id) {
    if ((await ui()).selected === id) return;
    const u = listUnits(state).find((x) => x.id === id);
    if (!ctx.mobile) {
      // Desktop: Tab cycles through the squad.
      for (let i = 0; i < 4 && (await ui()).selected !== id; i++) await ctx.key("Tab");
    }
    if ((await ui()).selected !== id) await ctx.tapCell(u.c, u.r);
  }
  // Perform one bot action through the UI; returns false when it had no effect.
  async function perform(state, plan) {
    const before = brief(state);
    if (plan.type === "endTurn") {
      if (ctx.mobile) await ctx.tap("#end-btn"); else await ctx.key("e");
      await page.waitForFunction((turn) => { const s = window.__ALDOL_NEXT__.state(); return s.phase !== "enemy" && (s.turn > turn || s.phase !== "player"); }, state.turn, { timeout: 30000 });
      return true;
    }
    await selectUnit(state, plan.unit);
    const units = listUnits(state);
    if (plan.type === "move") await ctx.tapCell(plan.c, plan.r);
    else {
      const t = units.find((u) => u.id === plan.target);
      if (plan.type === "skill") { if (ctx.mobile) await ctx.tap("#skill-btn"); else await ctx.key("f"); }
      await ctx.tapCell(t.c, t.r);
    }
    await settle();
    const after = await ctx.state();
    return brief(after) !== before || after.mission !== state.mission || after.phase !== state.phase;
  }

  const start = await ctx.state();
  ctx.expect(start.phase === "player" && start.turn === 1 && start.mission === 0 && listUnits(start).length === world.missions[0].units.length, "fresh game: mission 1, turn 1, all units on the board");
  ctx.expect((await page.evaluate(() => window.__ALDOL_NEXT__.loadResult())).code === "E_NONE", "no save at first start");

  // Desktop: keyboard cursor move (arrow keys + Enter) moves the selected unit.
  if (!ctx.mobile) {
    const first = listUnits(start).find((u) => u.team === "player");
    await selectUnit(start, first.id);
    await ctx.key("ArrowDown");
    await ctx.key("Enter");
    await settle();
    const moved = listUnits(await ctx.state()).find((u) => u.id === first.id);
    ctx.expect(moved.c === first.c && moved.r === first.r + 1 && moved.ap === first.ap - 1, `keyboard cursor move: unit ${first.id} stepped down one cell (ap ${first.ap} -> ${moved.ap})`);
  }

  let actions = 0;
  let failed = 0;
  let reloaded = false;
  let shotTaken = false;
  for (let guard = 0; guard < 400; guard++) {
    const state = await ctx.state();
    if (state.phase === "won" || state.phase === "lost") break;
    if (state.phase !== "player") { await ctx.waitTicks(2); continue; }

    // Save/reload mid-battle: once the fight is on (turn >= 3), reload and
    // compare the restored battle with what was on screen.
    if (!reloaded && state.turn >= 3 && actions > 4) {
      reloaded = true;
      await ctx.shot("mid");
      await ctx.reload();
      const restored = await ctx.state();
      const lr = await page.evaluate(() => window.__ALDOL_NEXT__.loadResult());
      ctx.expect(lr.ok === true, "reload: save accepted (loadResult.ok)");
      ctx.expect(restored.turn === state.turn && restored.mission === state.mission && brief(restored) === brief(state),
        `reload: same turn ${restored.turn}, positions/HP/AP restored`);
      continue;
    }
    const plan = planAction(state, world);
    const ok = await perform(state, plan);
    actions += 1;
    if (!ok) { failed += 1; ctx.step(`no effect: ${JSON.stringify(plan.cmd)}`); if (failed > 5) break; }
    if (!shotTaken && state.mission === 1) { shotTaken = true; await ctx.shot("mission2"); }
  }
  ctx.expect(failed === 0, `every UI action changed the game state (${actions} actions, ${failed} without effect)`);
  ctx.expect(reloaded, "save/reload was exercised mid-battle");
  const end = await ctx.state();
  ctx.expect(end.phase === "won", `reached phase won (phase=${end.phase}, mission=${end.mission + 1}, turn=${end.turn})`);
  ctx.expect(end.stats.missionsCleared === world.missions.length && end.quests.filter((q) => q.id.startsWith("clear-")).every((q) => q.done), "both mission quests done");
  ctx.step(`final: ${JSON.stringify((await ctx.inspect()).summary)}`);
  await ctx.shot("won");

  // A finished game stays finished across a reload.
  await ctx.reload();
  ctx.expect((await ctx.state()).phase === "won", "reload after victory keeps the won state");

  // New game: N key on desktop, button on touch.
  if (ctx.mobile) await ctx.tap("#new-btn"); else await ctx.key("n");
  await ctx.waitTicks(2);
  const fresh = await ctx.state();
  ctx.expect(fresh.phase === "player" && fresh.turn === 1 && fresh.mission === 0 && fresh.stats.defeated === 0 && fresh.tick < 120 && listUnits(fresh).length === world.missions[0].units.length,
    `new game: fresh state (tick ${fresh.tick})`);
  await ctx.waitTicks(170); // let the last bark fade before the HUD is measured
}

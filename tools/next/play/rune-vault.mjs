// Browser play scenario for Rune Vault (M4 candidate), run by
// tools/next/browser-check.mjs. Desktop drives the game with real key
// presses; touch configs use real taps on the D-pad, buttons and board
// cells only. Covers: move/push, wall bump, reset, save surviving a reload
// mid-room, the move-limit failure, all three rooms to "won", new game.
import { SOLUTIONS } from "./rune-vault-solutions.mjs";

export const meta = {
  id: "rune-vault",
  path: "games/rune-vault/index.html",
  saveKey: "aldol-engine.rune-vault-m4.save.v1",
  ready: () => !!window.__ALDOL_NEXT__,
};

const KEY = { U: "ArrowUp", R: "ArrowRight", D: "ArrowDown", L: "ArrowLeft" };
const WASD = { U: "w", R: "d", D: "s", L: "a" };
const PAD = { U: "#dpad-up", R: "#dpad-right", D: "#dpad-down", L: "#dpad-left" };

export async function play(page, ctx) {
  const probe = () => page.evaluate(() => {
    const p = window.__ALDOL_NEXT__;
    const s = p.state();
    const me = p.view().find((o) => o.kind === "player");
    return { phase: s.phase, level: s.level, movesLeft: s.movesLeft, moves: s.stats.moves, resets: s.stats.resets, fails: s.stats.fails, cleared: s.stats.roomsCleared, c: me.c, r: me.r, tick: s.tick, quests: s.quests.filter((q) => q.done).length };
  });
  // One input, then wait until the sim has consumed it (queue empty + a tick).
  const settle = async () => { await ctx.waitTicks(2); };
  let useWasd = false;
  const move = async (d) => {
    if (ctx.mobile) await ctx.tap(PAD[d]);
    else await ctx.key((useWasd ? WASD : KEY)[d]);
    await settle();
  };
  const walk = async (path) => { for (const d of path) await move(d); };
  const resetRoom = async () => { if (ctx.mobile) await ctx.tap("#reset-btn"); else await ctx.key("r"); await settle(); };
  const waitPhase = (phase, level) => ctx.waitFor(([ph, lv]) => { const s = window.__ALDOL_NEXT__.state(); return s.phase === ph && s.level === lv; }, [phase, level], 15000);

  let s = await probe();
  ctx.expect(s.phase === "playing" && s.level === 0 && s.c === 1 && s.r === 1 && s.movesLeft === 20, `fresh start in room 1 (phase=${s.phase} level=${s.level} moves=${s.movesLeft})`);
  ctx.expect((await page.evaluate(() => window.__ALDOL_NEXT__.loadResult().code)) === "E_NONE", "no save at first start");
  ctx.expect((await page.evaluate(() => window.__ALDOL_NEXT__.renderInfo().webgl2)) === true, "renderer is WebGL2");

  // Wall bump costs nothing; a real step costs one move.
  await move("U");
  s = await probe();
  ctx.expect(s.c === 1 && s.r === 1 && s.movesLeft === 20, "bump into the wall: no move spent");
  await move("D");
  s = await probe();
  ctx.expect(s.c === 1 && s.r === 2 && s.movesLeft === 19, `${ctx.mobile ? "D-pad tap" : "ArrowDown"} moves one cell and spends one move`);

  // A second input method: WASD on desktop, tapping a board cell on touch.
  if (ctx.mobile) {
    await ctx.tapCell(2, 2);
    await settle();
  } else {
    useWasd = true;
    await move("R");
    useWasd = false;
  }
  s = await probe();
  ctx.expect(s.c === 2 && s.r === 2 && s.movesLeft === 18, `${ctx.mobile ? "tapping the next cell" : "WASD"} also moves (at ${s.c},${s.r})`);

  // Reset path.
  await resetRoom();
  s = await probe();
  ctx.expect(s.c === 1 && s.r === 1 && s.movesLeft === 20 && s.resets === 1, "reset returns the room to its start");

  // Push the crate onto the plate, then reload: the save must bring it back.
  await walk(SOLUTIONS[0].slice(0, 4));
  s = await probe();
  const doorOpen = await page.evaluate(() => window.__ALDOL_NEXT__.view().find((o) => o.kind === "door").open);
  ctx.expect(doorOpen === true && s.movesLeft === 16, "crate pushed onto the plate opens the door");
  await ctx.shot("mid");
  const before = await page.evaluate(() => ({ view: JSON.stringify(window.__ALDOL_NEXT__.view().map((o) => [o.kind, o.c, o.r, o.open])), movesLeft: window.__ALDOL_NEXT__.state().movesLeft }));
  await ctx.reload();
  const after = await page.evaluate(() => ({ view: JSON.stringify(window.__ALDOL_NEXT__.view().map((o) => [o.kind, o.c, o.r, o.open])), movesLeft: window.__ALDOL_NEXT__.state().movesLeft, load: window.__ALDOL_NEXT__.loadResult() }));
  ctx.expect(after.load.ok === true, "save restored after reload (loadResult ok)");
  ctx.expect(after.view === before.view && after.movesLeft === before.movesLeft, "reloaded room matches the room before reload (crate, door, moves)");
  const saveLine = await page.locator("#save-state").textContent();
  ctx.expect(/불러옴/.test(saveLine), `HUD shows the save was loaded ("${saveLine}")`);

  // Finish room 1 from the restored state; the next room starts on its own.
  await walk(SOLUTIONS[0].slice(4));
  await waitPhase("playing", 1);
  s = await probe();
  ctx.expect(s.level === 1 && s.cleared === 1 && s.quests >= 1, "room 1 cleared, room 2 started after the timed pause, first quest done");

  // Failure path: burn all 36 moves of room 2 pacing, then reset.
  for (let i = 0; i < 18; i++) await walk("DU");
  s = await probe();
  ctx.expect(s.phase === "failed" && s.fails === 1 && s.movesLeft === 0, `running out of moves fails the room (phase=${s.phase})`);
  const phaseText = await page.locator("#phase").textContent();
  ctx.expect(/소진/.test(phaseText), `phase panel reports the failure ("${phaseText.trim()}")`);
  await ctx.shot("failed");
  await move("R");
  ctx.expect((await probe()).phase === "failed", "moves are ignored while failed");
  await resetRoom();
  s = await probe();
  ctx.expect(s.phase === "playing" && s.movesLeft === 36 && s.c === 1 && s.r === 1, "reset after failure restarts room 2");

  // Rooms 2 and 3 to the end.
  await walk(SOLUTIONS[1]);
  await waitPhase("playing", 2);
  ctx.step("room 2 cleared (lever, key, seal)");
  await walk(SOLUTIONS[2]);
  s = await probe();
  ctx.expect(s.phase === "won" && s.cleared === 3, `all three rooms cleared -> won (phase=${s.phase} cleared=${s.cleared})`);
  ctx.expect(s.quests === 3, `quests: 3 done, flawless stays open after the failure (${s.quests})`);
  const wonText = await page.locator("#phase").textContent();
  ctx.expect(/승리/.test(wonText), "phase panel shows the win");

  // The win is saved: reload stays won.
  await ctx.reload();
  s = await probe();
  ctx.expect(s.phase === "won", "won state survives a reload");

  // New game returns to room 1 and replaces the save.
  if (ctx.mobile) await ctx.tap("#new-btn"); else await ctx.key("n");
  await settle();
  s = await probe();
  ctx.expect(s.phase === "playing" && s.level === 0 && s.movesLeft === 20 && s.cleared === 0 && s.c === 1 && s.r === 1, "new game restarts at room 1 with fresh progress");
  await move("D");
  await ctx.reload();
  s = await probe();
  ctx.expect(s.level === 0 && s.cleared === 0 && s.r === 2, "after new game the stored save is the new run");

  // A corrupted save is refused and the game starts fresh with a note.
  await page.evaluate((key) => localStorage.setItem(key, "{broken"), meta.saveKey);
  await ctx.reload();
  const bad = await page.evaluate(() => ({ load: window.__ALDOL_NEXT__.loadResult(), level: window.__ALDOL_NEXT__.state().level, tick: window.__ALDOL_NEXT__.state().tick }));
  const note = await page.locator("#save-state").textContent();
  ctx.expect(bad.load.ok === false && bad.load.code === "E_PARSE" && bad.level === 0 && /손상/.test(note), `corrupted save refused, fresh start with a note ("${note}")`);
}

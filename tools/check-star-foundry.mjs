// Star Foundry (M6 candidate) checks. Run: node --experimental-vm-modules tools/check-star-foundry.mjs (or node tools/check-next-all.mjs)
// (node --experimental-vm-modules tools/check-star-foundry.mjs)
import { createChecker, readJson, readText, syntaxChecks, pageScriptSyntaxChecks, bannedApiChecks, determinismSuite, saveRejectionSuite } from "./next/harness.mjs";
import { validateWorldManifest } from "../src/core/worldforge.js";
import { stateHash } from "../src/core/state-hash.js";
import { serializeSave, parseSave } from "../src/core/next/save.js";
import * as inv from "../src/core/next/inventory.js";
import { stressManifest, stressInputs } from "./next/play/star-foundry-stress.mjs";
import {
  GAME_ID, SEED, RULE_TYPE, SAVE_KEY, COIN, game, loadWorld, canBuild, canRemove, coins, coinTotal,
  refundFor, listBuildings, listItems, buildingAt, itemLedger, questStats,
} from "../games/star-foundry/foundry.js";

const t = createChecker();
const { check, throws } = t;

const manifest = readJson("games/star-foundry/world.json");
const clone = (x) => JSON.parse(JSON.stringify(x));
const rule = (m) => m.rules.find((r) => r.type === RULE_TYPE);
const withConfig = (fn) => { const m = clone(manifest); fn(rule(m).config, m); return m; };

// ---------------------------------------------------------------- manifest
check("manifest valid (worldforge/0.1)", validateWorldManifest(manifest).valid, JSON.stringify(validateWorldManifest(manifest).errors));
const world = loadWorld(manifest);
const cfg = world.config;
check("world adapted", world.projectId === GAME_ID && world.grid.cols === 10 && world.grid.rows === 7 && world.fixed.length === 3
  && world.fixed.filter((f) => f.kind === "source").length === 2 && world.buildable.join(",") === "belt,smelter,assembler"
  && world.questDefs.length === 3 && world.wallKeys.length === 2 && cfg.beltTicks === 12,
  `grid=${world.grid.cols}x${world.grid.rows} fixed=${world.fixed.length} buildable=${world.buildable} quests=${world.questDefs.length}`);
check("only builtin assets (no GLB, no external URL)", manifest.assets.every((a) => /^builtin:[a-z-]+$/.test(a.uri)));
check("save key", SAVE_KEY === "aldol-engine.star-foundry-m6.save.v1" && game.id === GAME_ID && game.version === 1);
throws("rejects wrong schema version", () => { const m = clone(manifest); m.schemaVersion = "worldforge/9"; loadWorld(m); }, /invalid world manifest/);
throws("rejects another project's manifest", () => loadWorld(readJson("games/star-defense/world.json")), /expected "star-foundry"|no enabled/);
throws("rejects disabled rule", () => { const m = clone(manifest); rule(m).enabled = false; loadWorld(m); }, /no enabled/);
throws("rejects ragged grid", () => loadWorld(withConfig((c) => { c.grid.rows[2] = "..."; })), /same non-zero length/);
throws("rejects unknown grid symbol", () => loadWorld(withConfig((c) => { c.grid.rows[0] = "X........."; })), /only contain/);
throws("rejects zero beltTicks", () => loadWorld(withConfig((c) => { c.beltTicks = 0; })), /beltTicks/);
throws("rejects negative cost", () => loadWorld(withConfig((c) => { c.buildings.belt.cost = -1; })), /cost/);
throws("rejects recipe with unknown item", () => loadWorld(withConfig((c) => { c.buildings.smelter.recipe.inputs = { mud: 1 }; })), /unknown item/);
throws("rejects reserved building kind", () => loadWorld(withConfig((c) => { c.buildings.depot = c.buildings.belt; })), /reserved/);
throws("rejects source on a wall", () => loadWorld(withConfig((c, m) => { m.entities[0].transform.position = [3, 0, 1]; })), /not on a free grid cell/);
throws("rejects source outside the grid", () => loadWorld(withConfig((c, m) => { m.entities[0].transform.position = [40, 0, 1]; })), /not on a free grid cell/);
throws("rejects two fixed entities on one cell", () => loadWorld(withConfig((c, m) => { m.entities[1].transform.position = [0, 0, 3]; })), /share cell/);
throws("rejects bad source direction", () => loadWorld(withConfig((c, m) => { m.entities[0].components["game.source"].dir = "north"; })), /bad dir/);
throws("rejects world without a depot", () => loadWorld(withConfig((c, m) => { m.entities = m.entities.filter((e) => !e.components["game.depot"]); })), /source and one depot/);
throws("rejects world without orders", () => loadWorld(withConfig((c, m) => { m.quests = []; })), /at least one order/);
throws("rejects bank that cannot pay rewards", () => loadWorld(withConfig((c) => { c.bankCoins = 10; })), /bankCoins/);
throws("rejects duplicate entity id", () => loadWorld(withConfig((c, m) => { m.entities.push(clone(m.entities[0])); })), /E_DUPLICATE_ID/);

// ------------------------------------------------------------------ helpers
const B = (kind, c, r, dir = "right") => ({ build: { kind, c, r, dir } });
const R = (c, r) => ({ remove: { c, r } });
function run(session, n, input) {
  if (input) { game.step(session, input); n -= 1; }
  for (let i = 0; i < n; i++) game.step(session, {});
  return session.state;
}
const fresh = (w = world, seed = SEED) => game.start(seed, w);
const itemsAt = (state) => listItems(state).map((i) => `${i.kind}@${i.c},${i.r}`).sort().join(" ");
// World variants with fixed (jitter-free) timing for exact boundary tests.
const steady = loadWorld(withConfig((c, m) => { m.entities.forEach((e) => { if (e.components["game.source"]) e.components["game.source"].jitterTicks = 0; }); }));
const PHASE1 = [B("belt", 1, 3), B("smelter", 2, 3), ...[3, 4, 5, 6, 7, 8].map((c) => B("belt", c, 3))];
const PHASE2 = [R(5, 3), B("assembler", 5, 3), B("belt", 5, 5, "up"), B("belt", 5, 4, "up")];

// -------------------------------------------------------------- build rules
{
  const s = fresh();
  const st = s.state;
  check("initial state", st.phase === "playing" && coins(st) === cfg.startCoins && listBuildings(st).length === 3 && listItems(st).length === 0 && st.quests.length === 3
    && coinTotal(st) === cfg.startCoins + cfg.bankCoins && game.validateState(st, world) === null);
  run(s, 1, B("belt", 1, 3));
  check("build costs coins and occupies the cell", coins(st) === cfg.startCoins - 5 && buildingAt(st, 1, 3).kind === "belt" && buildingAt(st, 1, 3).dir === "right" && st.built.belt === 1);
  check("build event is in the tick log", st.ecs.events.some((e) => e.type === "built") && st.quests[0].done === true);
  const before = stateHash({ ...st, tick: 0, ecs: { ...st.ecs, events: [], eventSeq: 0 }, refused: 0, rngDraws: 0 });
  const refusedReason = (input) => { run(s, 1, input); const ev = st.ecs.events.find((e) => e.type === "refused"); return ev ? ev.data.reason : null; };
  check("build on occupied cell refused", refusedReason(B("smelter", 1, 3)) === "occupied");
  check("build on wall refused", refusedReason(B("belt", 3, 1)) === "wall");
  check("build on source cell refused", refusedReason(B("belt", 0, 3)) === "occupied");
  check("build on depot cell refused", refusedReason(B("belt", 9, 3)) === "occupied");
  check("build out of bounds refused", refusedReason(B("belt", 10, 3)) === "bounds" && refusedReason(B("belt", -1, 0)) === "bounds" && refusedReason(B("belt", 1.5, 2)) === "bounds");
  check("build unknown kind refused", refusedReason(B("reactor", 4, 4)) === "kind" && refusedReason(B("source", 4, 4)) === "kind" && refusedReason(B("depot", 4, 4)) === "kind");
  check("build bad direction refused", refusedReason(B("belt", 4, 4, "north")) === "dir" && refusedReason({ build: { kind: "belt", c: 4, r: 4 } }) === "dir");
  check("garbage build/remove payloads refused", refusedReason({ build: null }) === "shape" && refusedReason({ build: "belt" }) === "shape" && refusedReason({ build: [1, 2] }) === "shape" && refusedReason({ remove: 7 }) === "shape");
  check("remove empty / fixed / out of bounds refused", refusedReason(R(4, 4)) === "empty" && refusedReason(R(0, 3)) === "fixed" && refusedReason(R(9, 3)) === "fixed" && refusedReason(R(99, 0)) === "bounds");
  run(s, 3, { nonsense: true });
  const after = stateHash({ ...st, tick: 0, ecs: { ...st.ecs, events: [], eventSeq: 0 }, refused: 0, rngDraws: 0 });
  check("refused commands change nothing but the refusal counter", before === after && st.refused === 20, `refused=${st.refused}`);
  check("canBuild / canRemove agree with the sim", canBuild(st, world, B("belt", 4, 4).build).ok && canBuild(st, world, B("belt", 3, 1).build).reason === "wall" && canRemove(st, world, { c: 1, r: 3 }).ok && canRemove(st, world, { c: 0, r: 3 }).reason === "fixed");

  // Unaffordable: coins boundary (exactly enough is allowed, one short is not).
  const poor = fresh();
  inv.transfer(poor.state.player, poor.state.bank, COIN, cfg.startCoins - 34);
  check("coins boundary: 34 coins cannot buy a 30+5", (run(poor, 1, B("smelter", 4, 4)), coins(poor.state) === 4 && buildingAt(poor.state, 4, 4).kind === "smelter"));
  run(poor, 1, B("belt", 5, 4));
  check("unaffordable build refused, nothing charged", coins(poor.state) === 4 && buildingAt(poor.state, 5, 4) === null && poor.state.ecs.events.find((e) => e.type === "refused").data.reason === "coins");
  inv.transfer(poor.state.bank, poor.state.player, COIN, 1);
  run(poor, 1, B("belt", 5, 4));
  check("exactly enough coins is accepted", coins(poor.state) === 0 && buildingAt(poor.state, 5, 4).kind === "belt");

  // Remove: refund, scrap ledger.
  run(s, 1, R(1, 3));
  check("remove refunds part of the cost", coins(st) === cfg.startCoins - 5 + refundFor(world, "belt") && refundFor(world, "belt") === 2 && refundFor(world, "smelter") === 15 && buildingAt(st, 1, 3) === null && st.removed === 1);
  check("coins are conserved through build/remove", coinTotal(st) === cfg.startCoins + cfg.bankCoins);
}

// -------------------------------------------------------------- belts
{
  // Source emission boundary: interval 40, no jitter -> first item at tick 40.
  const s = fresh(steady);
  run(s, 39, B("belt", 1, 3));
  check("source does not emit before its interval", listItems(s.state).length === 0);
  run(s, 1);
  check("source emits exactly at the interval tick", itemsAt(s.state) === "ore@1,3" && s.state.ledger.produced.ore === 1);
  // Dead-end belt: the item stays, the source is blocked (back-pressure).
  run(s, 200);
  check("back-pressure: a full dead-end belt holds exactly one item", itemsAt(s.state) === "ore@1,3" && s.state.ledger.produced.ore === 1);
  // Extend the line by two cells: the item advances one cell per belt tick.
  run(s, 1, B("belt", 2, 3));
  run(s, 1, B("belt", 3, 3));
  const tickNow = s.state.tick;
  const toNext = cfg.beltTicks - (tickNow % cfg.beltTicks);
  run(s, toNext - 1);
  check("belt item waits until the belt tick", listItems(s.state).some((i) => i.c === 1));
  run(s, 1);
  check("belt item advances one cell on the belt tick", listItems(s.state).some((i) => i.c === 2) && s.state.tick % cfg.beltTicks === 0);
  run(s, 400);
  check("line fills to capacity and stops (3 cells, 3 items)", itemsAt(s.state) === "ore@1,3 ore@2,3 ore@3,3" && s.state.ledger.produced.ore === 3);
  // Opening the head lets the whole line shift in ONE belt tick (head first).
  run(s, 1, B("belt", 4, 3));
  run(s, cfg.beltTicks - (s.state.tick % cfg.beltTicks));
  check("head-first: the whole line shifts in one belt tick", ["2,3", "3,3", "4,3"].every((k) => listItems(s.state).some((i) => `${i.c},${i.r}` === k)), itemsAt(s.state));
  const cellsUsed = listItems(s.state).map((i) => `${i.c},${i.r}`);
  check("no two items share a cell", new Set(cellsUsed).size === cellsUsed.length);

  // Removing a belt with an item scraps it into the ledger.
  run(s, 1, R(4, 3));
  check("removing a loaded belt scraps the item (ledger)", s.state.ledger.scrapped.ore === 1 && itemLedger(s.state, steady).balanced);

  // Tie-break: two lines merge into one cell; the older item (smaller id) wins.
  const m = loadWorld(withConfig((c, mm) => {
    mm.entities[0].transform.position = [0, 0, 2]; mm.entities[0].components["game.source"] = { item: "ore", intervalTicks: 24, jitterTicks: 0, dir: "right" };
    mm.entities[1].transform.position = [0, 0, 4]; mm.entities[1].components["game.source"] = { item: "crystal", intervalTicks: 24, jitterTicks: 0, dir: "right" };
  }));
  const tie = fresh(m);
  // ore: (1,2) -> down into (1,3); crystal: (1,4) -> up into (1,3); (1,3) -> right, dead end at (2,3).
  for (const cmd of [B("belt", 1, 2, "down"), B("belt", 1, 4, "up"), B("belt", 1, 3, "right"), B("belt", 2, 3, "right")]) run(tie, 1, cmd);
  run(tie, 23 - tie.state.tick);
  check("merge setup: nothing emitted before tick 24", listItems(tie.state).length === 0);
  // Tick 24: both sources emit (ore first: smaller source id) and it is a
  // belt tick, so both items want (1,3) at once.
  run(tie, 1);
  const both = listItems(tie.state);
  check("merge: ore and crystal emitted on the same tick, ore is older", both.length === 2 && both[0].kind === "ore" && both[0].id < both[1].id, JSON.stringify(both));
  check("merge tie-break: the older item (smaller id) takes the cell", itemsAt(tie.state) === "crystal@1,4 ore@1,3", itemsAt(tie.state));
  run(tie, 12);
  check("merge: the loser follows on the next belt tick", itemsAt(tie.state).includes("crystal@1,3") && itemsAt(tie.state).includes("ore@2,3"), itemsAt(tie.state));

  // A closed loop with no gap never moves and never loses items.
  const loop = fresh(steady);
  for (const cmd of [B("belt", 1, 3, "up"), B("belt", 1, 2, "right"), B("belt", 2, 2, "down"), B("belt", 2, 3, "left")]) run(loop, 1, cmd);
  run(loop, 1200);
  check("closed belt loop fills up and stalls without losing items", listItems(loop.state).length === 4 && loop.state.ledger.produced.ore === 4 && itemLedger(loop.state, steady).balanced);
}

// -------------------------------------------------------------- machines
{
  const def = cfg.buildings.smelter;
  // Smelter fed directly by the mine (source -> machine), dead-end output.
  const s = fresh(steady);
  run(s, 1, B("smelter", 1, 3));
  const smelter = () => listBuildings(s.state).find((b) => b.kind === "smelter");
  run(s, 79 - s.state.tick);
  check("machine idle with 1 of 2 inputs", smelter().buffer.ore === 1 && smelter().active === false);
  run(s, 1); // tick 80: second ore arrives, recipe starts in the same tick
  check("recipe starts when the last input arrives", smelter().buffer.ore === 2 && smelter().active === true && smelter().progress === 0);
  run(s, def.recipe.ticks - 1);
  check("recipe not finished one tick early", smelter().active === true && smelter().progress === def.recipe.ticks - 1 && !smelter().buffer.ingot && !s.state.ledger.crafted.ingot);
  run(s, 1);
  check("recipe finishes exactly on time (inventory.craft)", smelter().buffer.ingot === 1 && s.state.ledger.crafted.ingot === 1 && s.state.ledger.consumed.ore === 2);
  // Output blocked (no belt): outputCap 2 ingots, then input buffer fills to 2 * inputStacks and the mine stalls.
  run(s, 3000);
  const full = smelter();
  check("buffer capacity boundary: output stops at outputCap, input at need*inputStacks", full.buffer.ingot === def.outputCap && full.buffer.ore === def.recipe.inputs.ore * def.inputStacks && full.active === false,
    JSON.stringify(full.buffer));
  check("blocked machine stalls the source (nothing lost)", s.state.ledger.produced.ore === def.outputCap * 2 + 4 && itemLedger(s.state, steady).balanced, `produced=${s.state.ledger.produced.ore}`);
  // Give it an output belt: one item per tick leaves, production resumes.
  run(s, 1, B("belt", 2, 3));
  check("machine ejects onto a free belt", itemsAt(s.state) === "ingot@2,3" && smelter().buffer.ingot === def.outputCap - 1);
  // A machine refuses items that are not recipe inputs.
  const wrong = fresh(steady);
  for (const cmd of [B("belt", 5, 5, "up"), B("smelter", 5, 4, "up")]) run(wrong, 1, cmd);
  run(wrong, 400);
  check("machine refuses a non-recipe item (crystal waits on the belt)", itemsAt(wrong.state) === "crystal@5,5" && !listBuildings(wrong.state).find((b) => b.kind === "smelter").buffer.crystal);
  // Removing a loaded machine scraps its buffer into the ledger and refunds.
  const c0 = coins(s.state);
  run(s, 1, R(1, 3));
  const led = itemLedger(s.state, steady);
  check("removing a loaded machine: buffer scrapped, ledger balanced, refund paid", led.balanced && led.items.ore.scrapped + led.items.ingot.scrapped > 0 && coins(s.state) === c0 + refundFor(steady, "smelter"));
  // Depot refuses items it does not buy.
  const raw = fresh(steady);
  for (const cmd of [1, 2, 3, 4, 5, 6, 7, 8].map((c) => B("belt", c, 3))) run(raw, 1, cmd);
  run(raw, 1500);
  check("depot refuses raw ore (line backs up, nothing delivered)", !raw.state.ledger.delivered.ore && listItems(raw.state).length === 8 && coins(raw.state) === cfg.startCoins - 40);
}

// ---------------------------------------------- full factory: win, ledger
function playFactory(seed, w = world, audit = null) {
  const s = fresh(w, seed);
  const queue = [...PHASE1];
  let phase2 = false;
  let frames = 0;
  while (s.state.phase === "playing" && frames < w.config.deadlineTicks + 10) {
    if (!phase2 && s.state.quests.find((q) => q.id === "order-ingots").done) { phase2 = true; queue.push(...PHASE2); }
    game.step(s, queue.shift() || {});
    frames += 1;
    if (audit && frames % 7 === 0) audit(s.state);
  }
  return s;
}
{
  let audits = 0, itemBreaks = 0, coinBreaks = 0, dupCells = 0, invalid = 0, rewards = 0;
  const s = playFactory(SEED, world, (st) => {
    audits += 1;
    if (!itemLedger(st, world).balanced) itemBreaks += 1;
    if (coinTotal(st) !== cfg.startCoins + cfg.bankCoins) coinBreaks += 1;
    const cells = listItems(st).map((i) => `${i.c},${i.r}`);
    if (new Set(cells).size !== cells.length) dupCells += 1;
    if (audits % 20 === 0 && game.validateState(st, world) !== null) invalid += 1;
    rewards += st.ecs.events.filter((e) => e.type === "order").length;
  });
  const st = s.state;
  const led = itemLedger(st, world);
  check("scripted factory completes every order and wins", st.phase === "won" && st.quests.every((q) => q.done && q.rewarded) && st.ledger.delivered.ingot >= 3 && st.ledger.delivered.lamp === 5,
    `phase=${st.phase} tick=${st.tick} delivered=${JSON.stringify(st.ledger.delivered)} coins=${coins(st)}`);
  check("item conservation held at every audit", itemBreaks === 0 && dupCells === 0 && audits > 100, `audits=${audits}`);
  check("coin conservation held at every audit", coinBreaks === 0);
  check("state stayed valid during the run", invalid === 0 && game.validateState(st, world) === null);
  check("final ledger balances per item", led.balanced && led.items.lamp.crafted === led.items.lamp.delivered + led.items.lamp.inBuffers + led.items.lamp.onBelts + led.items.lamp.scrapped, JSON.stringify(led.items.lamp));
  // Coins: start - builds + refund + sales + rewards.
  const spent = 7 * 5 + 30 + 40 + 2 * 5 - refundFor(world, "belt");
  const earned = st.ledger.delivered.ingot * cfg.depot.accepts.ingot + st.ledger.delivered.lamp * cfg.depot.accepts.lamp + 30 + 50;
  check("coins = start - builds + refund + sales + rewards (each reward once)", coins(st) === cfg.startCoins - spent + earned, `coins=${coins(st)} expected=${cfg.startCoins - spent + earned}`);
  check("quest stats expose deliveries", questStats(st)["delivered.lamp"] === 5 && questStats(st)["built.belt"] === 9);
  // After winning the sim is frozen: commands and time do nothing.
  const snap = () => stateHash({ ...st, tick: 0, ecs: { ...st.ecs, events: [] } });
  const frozen = snap();
  run(s, 300, B("belt", 4, 5));
  check("won game is frozen (inputs ignored, no production, no second reward)", snap() === frozen && st.phase === "won" && buildingAt(st, 4, 5) === null);
  check("summary for handoff/probe", game.inspect(s).summary.phase === "won" && game.inspect(s).summary.ordersDone === 3);
}

// ---------------------------------------------------------- deadline: lose
{
  const s = fresh();
  run(s, cfg.deadlineTicks - 1);
  check("still playing one tick before the deadline", s.state.phase === "playing");
  run(s, 1);
  check("idle play loses exactly at the deadline", s.state.phase === "lost" && s.state.tick === cfg.deadlineTicks && s.state.ecs.events.some((e) => e.type === "lost"));
  run(s, 50, B("belt", 1, 3));
  check("lost game is frozen", s.state.phase === "lost" && buildingAt(s.state, 1, 3) === null && coins(s.state) === cfg.startCoins);
  // Restart = a fresh session with the same seed gives the same fresh state.
  check("restart gives the identical fresh state", game.hash(fresh()) === game.hash(fresh()) && fresh().state.phase === "playing");
  // Winning on the deadline tick itself counts as a win (win is checked first).
  const tight = loadWorld(withConfig((c) => { c.deadlineTicks = playFactory(SEED).state.tick; }));
  check("orders finished on the deadline tick still win", playFactory(SEED, tight).state.phase === "won");
  const tooTight = loadWorld(withConfig((c) => { c.deadlineTicks = playFactory(SEED).state.tick - 1; }));
  check("one tick short of that loses", playFactory(SEED, tooTight).state.phase === "lost");
}

// ----------------------------------------------- reward once, finite bank
{
  const s = playFactory(SEED);
  // Re-running the quest update on a finished log must not pay again.
  const st = JSON.parse(JSON.stringify(s.state));
  const again = game.restore(st, world);
  const c0 = coins(again.state);
  run(again, 60);
  check("rewards are not paid again after save/restore of a finished game", coins(again.state) === c0 && again.state.quests.every((q) => q.rewarded));
  // A bank that runs dry skips payments instead of minting coins.
  const dry = loadWorld(withConfig((c) => { c.bankCoins = 80; }));
  const d = playFactory(SEED, dry);
  check("finite bank: payments are skipped, coins never minted", coinTotal(d.state) === dry.config.startCoins + 80 && inv.count(d.state.bank, COIN) >= 0 && d.state.phase === "won");
}

// ---------------------------------------------------- determinism (G2)
const SEEDS = [SEED, "foundry-a", "foundry-b", "foundry-c", "foundry-d", "foundry-e", "foundry-f", "foundry-g", "foundry-h", "foundry-i", "foundry-j", "별-공방"];
function scriptedInputs(seed, i) {
  const inputs = [];
  PHASE1.forEach((cmd, k) => { inputs[k * 3] = cmd; });
  // Per-seed variety: garbage, illegal builds, a side belt that is later removed.
  inputs[40 + i] = "garbage";
  inputs[50 + i] = B("belt", 3, 1);
  inputs[60 + i * 2] = B("belt", 4, 5, "left");
  inputs[300 + i * 5] = R(4, 5);
  PHASE2.forEach((cmd, k) => { inputs[900 + i * 3 + k * 2] = cmd; });
  return inputs;
}
const FRAMES = 2400;
const hashes = determinismSuite(check, { game, world, seeds: SEEDS, frames: FRAMES, makeInputs: scriptedInputs });
check("different seeds diverge (emission jitter uses the seeded RNG)", new Set(Object.values(hashes)).size === SEEDS.length, JSON.stringify(hashes));
const ref = game.simulate(SEED, FRAMES, scriptedInputs(SEED, 0), world);
console.log(`reference: seed=${SEED} frames=${FRAMES} hash=${game.hash(ref)} phase=${ref.phase} rngDraws=${ref.rngDraws}`);
check("pinned reference hash", game.hash(ref) === "02462c74", `hash=${game.hash(ref)}`);
check("reference run wins inside the script", ref.phase === "won" && ref.rngDraws > 10);
// Command order matters: build-then-remove differs from remove-then-build.
check("the same commands in another order give a different hash",
  game.hash(game.simulate(SEED, 30, [B("belt", 4, 4), R(4, 4)], world)) !== game.hash(game.simulate(SEED, 30, [R(4, 4), B("belt", 4, 4)], world)));

// ------------------------------------------------ save / restore (G3)
{
  const inputs = scriptedInputs(SEED, 0);
  const s = fresh();
  for (let f = 0; f < 1000; f++) game.step(s, inputs[f] || {});
  check("mid-production snapshot holds live belts, items and buffers", listItems(s.state).length > 0 && listBuildings(s.state).some((b) => b.buffer && Object.keys(b.buffer).length > 0) && s.state.phase === "playing");
  const text = saveRejectionSuite(check, { game, world, session: s });
  const parsed = parseSave(text, { gameId: game.id, version: game.version, validate: (st) => game.validateState(st, world) });
  const resumed = game.restore(parsed.state, world);
  check("restored session shows the same factory", JSON.stringify(listBuildings(resumed.state)) === JSON.stringify(listBuildings(s.state)) && itemsAt(resumed.state) === itemsAt(s.state) && coins(resumed.state) === coins(s.state));
  for (let f = 1000; f < FRAMES; f++) { game.step(s, inputs[f] || {}); game.step(resumed, inputs[f] || {}); }
  check("save/restore mid-production continues identically", game.hash(resumed) === game.hash(s) && game.hash(s) === game.hash(ref));
  // Re-signed but inconsistent saves are refused by validateState.
  const resign = (mutate) => { const env = JSON.parse(text); mutate(env.payload); env.checksum = stateHash(env.payload); return parseSave(JSON.stringify(env), { gameId: game.id, version: game.version, validate: (st) => game.validateState(st, world) }); };
  check("save with minted coins refused", resign((p) => { p.player.items.coin += 500; }).code === "E_SHAPE");
  check("save with a forged delivery refused (ledger must balance)", resign((p) => { p.ledger.delivered.ingot = (p.ledger.delivered.ingot || 0) + 1; }).code === "E_SHAPE");
  check("save with a conjured belt item refused", resign((p) => { const id = Object.keys(p.ecs.comps.Item)[0]; const it = p.ecs.comps.Item[id]; it.kind = it.kind === "lamp" ? "ore" : "lamp"; }).code === "E_SHAPE");
  check("save with a building on a wall refused", resign((p) => { const id = Object.keys(p.ecs.comps.Building).pop(); const b = p.ecs.comps.Building[id]; delete p.cells[`${b.c},${b.r}`]; b.c = 3; b.r = 1; p.cells["3,1"] = Number(id); }).code === "E_SHAPE");
  check("save with a broken cell index refused", resign((p) => { delete p.cells[Object.keys(p.cells)[0]]; }).code === "E_SHAPE");
  check("save with an unknown phase refused", resign((p) => { p.phase = "cheated"; }).code === "E_SHAPE");
  check("save with a missing fixed structure refused", resign((p) => { const id = p.cells["9,3"]; delete p.cells["9,3"]; delete p.ecs.comps.Building[id]; p.ecs.alive = p.ecs.alive.filter((x) => x !== id); }).code === "E_SHAPE");
  check("another game's save text is refused", parseSave(serializeSave({ gameId: "rune-vault", version: 1, state: game.snapshot(s) }), { gameId: game.id, version: game.version }).code === "E_GAME");
}

// ------------------------------------------------------- load (1000 entities)
{
  const big = loadWorld(stressManifest(manifest, { cols: 40, rows: 26 }));
  const inputs = stressInputs({ cols: 40, rows: 26, entities: 1000 });
  const s = game.start(SEED, big);
  let peak = 0;
  for (let f = 0; f < inputs.length + 4000; f++) { game.step(s, inputs[f] || {}); if (f % 500 === 0) peak = Math.max(peak, s.state.ecs.alive.length); }
  const n = s.state.ecs.alive.length;
  const cells = listItems(s.state).map((i) => `${i.c},${i.r}`);
  check("load: ~1000 entities, ledger balanced, one item per belt cell", n >= 950 && itemLedger(s.state, big).balanced && new Set(cells).size === cells.length && game.validateState(s.state, big) === null, `entities=${n} items=${cells.length}`);
  check("load run is deterministic", game.hash(game.simulate(SEED, inputs.length + 300, inputs, big)) === game.hash(game.simulate(SEED, inputs.length + 300, inputs, big)));
}

// ------------------------------------------------- reuse / hygiene checks
{
  const src = readText("games/star-foundry/foundry.js");
  const imported = [...src.matchAll(/from "\.\.\/\.\.\/src\/core\/next\/([a-z-]+)\.js"/g)].map((m) => m[1]);
  check("sim imports >= 3 shared core/next modules", new Set(imported).size >= 3 && ["ecs", "spatial", "inventory", "quest", "runtime", "save", "manifest"].every((m) => imported.includes(m)), imported.join(","));
  check("sim does not import M1–M3 sims or render code", !/src\/core\/sim\.js|games\/(supuli|star-fishing|star-defense)|src\/render/.test(src));
  const page = pageScriptSyntaxChecks(check, "games/star-foundry/index.html");
  check("page uses the shared HUD kit, board and shell", ["src/render/hud.js", "src/render/next/board.js", "src/render/next/shell.js", "src/render/audio.js"].every((p) => page.includes(p)));
  check("page pins three 0.187.0 and uses the game's own save key", page.includes("three@0.187.0") && !page.includes("latest") && page.includes("SAVE_KEY") && !/aldol-engine\.(supuli|star-fishing|star-defense)/.test(page));
  syntaxChecks(check, ["games/star-foundry/foundry.js", "tools/check-star-foundry.mjs", "tools/next/play/star-foundry.mjs", "tools/next/play/star-foundry-stress.mjs"]);
  bannedApiChecks(check, ["games/star-foundry/foundry.js"]);
}

t.done();

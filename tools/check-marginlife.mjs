// P1 MARGINLIFE: headless autonomous hero + merchant causality and snapshot replay.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSim } from "../src/render/sim-loader.js";
import { createInitialState, step, simulate, GAME_KIND, PHASES } from "../games/marginlife/sim.js";
const world = JSON.parse(readFileSync(new URL("../games/marginlife/world.json", import.meta.url), "utf8"));
const SEED = "marginlife-demo-01";
const OPT = seed => ({ kind: GAME_KIND, seed, rngSeed: `${seed}::heroes`, world,
  js: { createInitialState, step }, preferJs: true });
const make = seed => createSim(OPT(seed));
let passed = 0;
function check(name, fn) { const res = fn(); if (res && typeof res.then === "function") throw Error("use checkAsync"); passed++; console.log(`PASS ${name}`); }
async function checkAsync(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
function drive(sim, policy = "deny", until = 21) {
  const states = [];
  while (sim.state.tick < until) {
    sim.step(sim.state.tick === 0 ? { creditPolicy: policy } : {});
    assertInvariants(sim.state);
    states.push(sim.hash());
  }
  return states;
}
function assertInvariants(s) {
  const ids = s.events.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, "event ids unique");
  assert.equal(s.nextEventId, ids.length + 1, "event sequence");
  assert.ok(s.tick >= 0 && s.tick <= 21);
  assert.ok(s.merchant.cash >= 0 && s.merchant.stock >= 0 && s.merchant.receivables >= 0);
  assert.ok(s.heroes.every(h => h.cash >= 0 && h.debt >= 0 && h.potions >= 0 && h.hp > 0 && h.hp <= 100));
  assert.equal(s.merchant.receivables, s.heroes.reduce((sum, hero) => sum + hero.debt, 0), "credit ledger balances");
  const cash = s.merchant.cash + s.heroes.reduce((sum, hero) => sum + hero.cash, 0);
  assert.equal(cash, s.ledger.initialCash + s.ledger.outsideIncome - s.ledger.outsideCosts, "money conservation");
  for (const e of s.events) {
    assert.ok(e.day >= 1 && e.day <= 7);
    assert.equal(e.phase, PHASES[(e.tick - 1) % 3]);
    assert.equal(e.day, Math.floor((e.tick - 1) / 3) + 1);
  }
  if (s.finished) { assert.equal(s.tick, 21); assert.ok(s.ending); }
  else { assert.equal(s.ending, null); }
}
check("world declares 1 merchant and 3 heroes", () => {
  assert.equal(world.schemaVersion, "worldforge/0.1");
  assert.equal(world.npcs.filter(x => x.profile.role === "merchant").length, 1);
  assert.equal(world.npcs.filter(x => x.profile.role === "hero").length, 3);
  assert.equal(world.rules.find(x => x.type === "game.marginlife").config.days, 7);
  assert.equal(new Set(world.npcs.map(x => x.id)).size, 4);
});
check("baseline core is a pure deterministic 21-step simulation", () => {
  const a = simulate(SEED, world, i => i === 0 ? { creditPolicy: "offer" } : {});
  const b = simulate(SEED, world, i => i === 0 ? { creditPolicy: "offer" } : {});
  assert.equal(a.hash, b.hash); assert.deepEqual(a.state, b.state);
  assertInvariants(a.state);
});
await checkAsync("JS backend selected explicitly; run 7-day simulation", async () => {
  const sim = await make(SEED);
  assert.equal(sim.backend, "js");
  drive(sim, "offer");
  assert.equal(sim.state.finished, true);
  assert.equal(sim.state.tick, 21);
  assert.equal(sim.state.events.filter(e => e.type === "store_open").length, 7);
  assert.equal(sim.state.events.filter(e => e.type === "hero_plan").length, 3*7);
});
await checkAsync("NPC credit choice changes Arlen's actions and adventure opportunities", async () => {
  const allow = await make(SEED), deny = await make(SEED);
  drive(allow, "offer"); drive(deny, "deny");
  const first = (sim, type, actor) => sim.state.events.find(e => e.day === 1 && e.type === type && e.actor === actor);
  assert.ok(first(allow, "potion_credit", "hero-arlen"));
  assert.ok(first(deny, "potion_denied", "hero-arlen"));
  assert.equal(first(allow, "hero_plan", "hero-arlen").detail.plan, "ruins");
  assert.equal(first(deny, "hero_plan", "hero-arlen").detail.plan, "forage");
  assert.notEqual(allow.hash(), deny.hash());
});
await checkAsync("Other autonomous heroes progress without player directing them", async () => {
  const sim = await make(SEED); drive(sim, "deny");
  for(const hero of sim.state.heroes) {
    assert.equal(sim.state.events.filter(e => e.type === "hero_plan" && e.actor === hero.id).length, 7);
  }
  assert.ok(sim.state.events.some(e => e.actor === "hero-serin" && e.type.startsWith("hero_quest")));
  assert.ok(sim.state.events.some(e => e.actor === "hero-belen" && e.type.startsWith("hero_quest")));
});
await checkAsync("Snapshot JSON resume matches continuous run for every future tick", async () => {
  const live = await make(SEED);
  drive(live, "offer", 10); // midday progression; not just whole days
  const serialized = JSON.stringify(live.saveSnapshot());
  const beforeHash = live.hash();
  const resumed = await make(SEED);
  resumed.loadSnapshot(JSON.parse(serialized));
  assert.equal(resumed.hash(), beforeHash);
  while (!live.state.finished) {
    live.step({}); resumed.step({});
    assertInvariants(live.state); assertInvariants(resumed.state);
    assert.equal(live.hash(), resumed.hash());
  }
  assert.deepEqual(live.state.ending, resumed.state.ending);
});
await checkAsync("Snapshot restores same next RNG draw, without mutable aliasing", async () => {
  const live = await make(SEED); drive(live, "offer", 4);
  const snap = JSON.parse(JSON.stringify(live.saveSnapshot()));
  const resumed = await make(SEED); resumed.loadSnapshot(snap);
  assert.equal(live.rngNext(), resumed.rngNext());
  assert.equal(live.pick(["quest", "shop", "rest"]), resumed.pick(["quest", "shop", "rest"]));
  snap.state.heroes[0].cash = 999999;
  assert.notEqual(resumed.state.heroes[0].cash, 999999);
});
await checkAsync("Bad snapshots reject atomically and preserve state and RNG", async () => {
  const sim = await make(SEED); drive(sim, "offer", 5);
  const before = sim.saveSnapshot();
  const corrupt = [
    { ...before, kind: "other" }, { ...before, seed: "another-seed" },
    { ...before, rngSeed: "another-rng" }, { ...before, format: "unknown" },
    { ...before, rng: { ...before.rng, state: -1 } },
  ];
  for(const item of corrupt) {
    assert.throws(() => sim.loadSnapshot(item));
    assert.deepEqual(sim.saveSnapshot(), before);
  }
});
await checkAsync("Saving finished game cannot create duplicate events", async () => {
  const game = await make(SEED); drive(game, "offer");
  const final = game.saveSnapshot(); const again = await make(SEED);
  again.loadSnapshot(final);
  assert.deepEqual(again.state, game.state);
  assert.throws(() => again.step({}), /already finished/);
  assert.deepEqual(again.saveSnapshot(), final);
});
check("Different merchant policies do not break economy under 16 seeds", () => {
  for(let i = 0; i < 16; i++) {
    for(const policy of ["offer", "deny"]) {
      const r = simulate(`marginlife-regression-${i}`, world, tick => tick === 0 ? { creditPolicy: policy } : {});
      assertInvariants(r.state);
      assert.ok(r.state.heroes.every(h => h.questsAttempted >= 1));
    }
  }
});
check("Merchant and heroes have separate outcomes", () => {
  const s = simulate(SEED, world, i => i === 0 ? { creditPolicy: "offer" } : {}).state;
  assert.equal(typeof s.ending.merchant.shopSurvived, "boolean");
  assert.equal(s.ending.heroes.length, 3);
  assert.ok(s.ending.heroes.some(h=>h.questsAttempted > 0));
});
console.log(`MARGINLIFE P1: ${passed}/${passed} PASS`);

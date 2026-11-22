// MARGINLIFE P1: merchant-facing, autonomous-hero simulation.
// Headless prototype: one tick per phase, 3 phases per day for 7 days.
// All world rules come from games/marginlife/world.json. No wall clock or UI APIs.
import { Rng } from "../../src/core/rng.js";
import { stateHash } from "../../src/core/state-hash.js";

export const GAME_KIND = "marginlife";
export const DEFAULT_SEED = "marginlife-demo-01";
export const PHASES = ["morning", "afternoon", "evening"];

function settings(world) {
  const rule = world?.rules?.find(r => r.type === "game.marginlife" && r.enabled !== false);
  if (!rule?.config || !Array.isArray(world.npcs) || world.npcs.length !== 4) {
    throw new Error("invalid MARGINLIFE world manifest");
  }
  return rule.config;
}
function event(state, type, actor, detail = {}) {
  state.events.push({ id: `ev-${String(state.nextEventId++).padStart(4, "0")}`, tick: state.tick + 1,
    day: Math.floor(state.tick / PHASES.length) + 1, phase: PHASES[state.tick % PHASES.length],
    type, actor, detail });
}
function merchantOf(world) {
  const ms = world.npcs.filter(n => n.profile.role === "merchant");
  if (ms.length !== 1) throw new Error("expected exactly one merchant");
  return ms[0];
}
export function createInitialState(seed, world) {
  const cfg = settings(world), srcMerchant = merchantOf(world);
  const heroes = world.npcs.filter(n => n.profile.role === "hero").map(n => ({
    id: n.id, name: n.name, goal: n.profile.goal, riskTolerance: n.profile.riskTolerance,
    skill: n.profile.attributes.skill, hp: n.profile.attributes.hp, maxHp: 100,
    cash: n.profile.attributes.cash, potions: 0, debt: 0, trust: 0,
    questsAttempted: 0, questsWon: 0, todayPlan: null, lastAction: "arrived",
  }));
  if (heroes.length !== 3 || new Set(heroes.map(h => h.id)).size !== 3) throw new Error("expected three distinct autonomous heroes");
  const m = srcMerchant.profile.attributes;
  const cash = m.cash + heroes.reduce((s,h) => s + h.cash, 0);
  return {
    version: 1, seed: String(seed), worldId: world.world.id,
    tick: 0, finished: false, merchant: {
      id: srcMerchant.id, name: srcMerchant.name, cash: m.cash, stock: m.stock,
      price: m.unitPrice, creditLimit: m.creditLimit, receivables: 0, reputation: 0,
      sales: 0, creditSales: 0, repayments: 0,
    }, heroes, events: [], nextEventId: 1,
    ledger: { initialCash: cash, outsideIncome: 0, outsideCosts: 0, potionsConsumed: 0 },
    ending: null, expectedDays: cfg.days,
  };
}
function settleDebt(state, hero) {
  const amount = Math.min(hero.debt, Math.max(0, hero.cash - 8));
  if (amount === 0) return;
  hero.cash -= amount;
  hero.debt -= amount;
  state.merchant.cash += amount;
  state.merchant.receivables -= amount;
  state.merchant.repayments += amount;
  event(state, "credit_repaid", hero.id, { amount });
}
function trade(state, hero, creditAllowed) {
  const m = state.merchant;
  if (hero.potions > 0) return;
  if (m.stock === 0) {
    event(state, "out_of_stock", hero.id); return;
  }
  if (hero.cash >= m.price) {
    hero.cash -= m.price; m.cash += m.price;
    hero.potions++; m.stock--; m.sales++;
    event(state, "potion_bought", hero.id, { paid: m.price, onCredit: false });
    return;
  }
  if (creditAllowed && hero.debt + m.price <= m.creditLimit) {
    hero.debt += m.price; m.receivables += m.price;
    hero.potions++; m.stock--; m.creditSales++; hero.trust++;
    m.reputation++;
    event(state, "potion_credit", hero.id, { amount: m.price });
    return;
  }
  event(state, "potion_denied", hero.id, { reason: "insufficient_funds", cash: hero.cash });
}
function morning(state, input, cfg) {
  const m = state.merchant;
  const paid = Math.min(cfg.upkeepPerDay, m.cash);
  m.cash -= paid; state.ledger.outsideCosts += paid;
  event(state, "store_open", m.id, { upkeep: paid, creditAllowed: input.creditPolicy === "offer" });
  for (const hero of state.heroes) {
    settleDebt(state, hero);
    trade(state, hero, input.creditPolicy === "offer");
  }
}
function afternoon(state) {
  for (const hero of state.heroes) {
    let plan;
    if (hero.hp < 35) plan = "rest";
    else if (hero.potions === 0) plan = "forage";
    else plan = hero.goal === "protect" ? "forest" : "ruins";
    hero.todayPlan = plan;
    hero.lastAction = `planned:${plan}`;
    event(state, "hero_plan", hero.id, { plan, goal: hero.goal, hp: hero.hp,
      potions: hero.potions, cash: hero.cash, debt: hero.debt });
  }
}
function evening(state, rng, cfg) {
  for (const hero of state.heroes) {
    const plan = hero.todayPlan;
    if (plan === "rest") {
      hero.hp = Math.min(hero.maxHp, hero.hp + 20); hero.lastAction = "rested";
      event(state, "hero_rest", hero.id, { hp: hero.hp });
    } else if (plan === "forage") {
      hero.cash += cfg.forageIncome;
      state.ledger.outsideIncome += cfg.forageIncome;
      hero.hp = Math.min(hero.maxHp, hero.hp + 5); hero.lastAction = "foraged";
      event(state, "hero_forage", hero.id, { earned: cfg.forageIncome, hp: hero.hp });
    } else if (plan === "forest" || plan === "ruins") {
      hero.questsAttempted++;
      const difficulty = plan === "ruins" ? 0.1 : 0;
      const chance = Math.min(0.92, Math.max(0.2, 0.6 + hero.skill / 350 - difficulty));
      const success = rng.float() < chance;
      const damage = rng.int(10, plan === "ruins" ? 40 : 27);
      let healed = 0;
      if (hero.potions > 0) {
        hero.potions--; state.ledger.potionsConsumed++;
        healed = cfg.potionHeal;
      }
      hero.hp = Math.max(1, Math.min(hero.maxHp, hero.hp + healed - damage));
      if (success) {
        const reward = plan === "ruins" ? cfg.ruinsReward : cfg.forestReward;
        hero.cash += reward; state.ledger.outsideIncome += reward;
        hero.questsWon++; hero.lastAction = `won:${plan}`;
        event(state, "hero_quest_won", hero.id, { location: plan, reward, damage, healed });
      } else {
        hero.lastAction = `failed:${plan}`;
        event(state, "hero_quest_failed", hero.id, { location: plan, damage, healed });
      }
    } else throw new Error(`missing hero plan: ${hero.id}`);
    hero.todayPlan = null;
  }
}
function makeEnding(state) {
  return {
    merchant: {
      shopSurvived: state.merchant.cash > 0,
      cash: state.merchant.cash,
      receivables: state.merchant.receivables,
      reputation: state.merchant.reputation,
    },
    heroes: state.heroes.map(h => ({ id: h.id, name: h.name, questsWon: h.questsWon,
      questsAttempted: h.questsAttempted, cash: h.cash, debt: h.debt, hp: h.hp })),
  };
}
export function step(state, input = {}, rng, world) {
  const cfg = settings(world);
  if (state.finished || state.tick >= cfg.days * PHASES.length) throw new Error("simulation already finished");
  if (state.worldId !== world.world.id || state.expectedDays !== cfg.days) throw new Error("world mismatch");
  if (input.creditPolicy != null && !["offer", "deny"].includes(input.creditPolicy)) throw new Error("invalid merchant credit policy");
  const next = structuredClone(state);
  const phase = PHASES[next.tick % PHASES.length];
  if (phase === "morning") morning(next, input, cfg);
  else if (phase === "afternoon") afternoon(next);
  else evening(next, rng, cfg);
  next.tick++;
  if (next.tick === cfg.days * PHASES.length) {
    next.finished = true;
    next.ending = makeEnding(next);
  }
  return next;
}
export function simulate(seed, world, chooseInput = () => ({})) {
  const rng = new Rng(`${seed}::heroes`);
  let state = createInitialState(seed, world);
  for (let i = 0; i < state.expectedDays * PHASES.length; i++) {
    state = step(state, chooseInput(i, state), rng, world);
  }
  return { state, hash: stateHash(state) };
}

// MARGINLIFE P3: deterministic NPC life loop on the WorldForge place graph.
// Pure state mutation on a CLONED game state only; no browser, clock or RNG APIs.
// P1 merchant trades/expeditions remain phase-level abstractions until a later gate.
const HUNGER_PER_PHASE = 13;
const FATIGUE_PER_PHASE = 10;
const FOOD_RECOVERY = 55;
const REST_RECOVERY = 42;
const HERO_WAGE = 6;
const WORK_CASH_THRESHOLD = 14;
const WORK_PLACE = 'shop';

function worldGraph(world) {
  const placeIds = new Set(world.places?.map(p => p.id) || []);
  const graph = new Map([...placeIds].map(id => [id, new Set()]));
  for (const p of world.paths || []) {
    if (p.enabled === false || !p.modes?.includes('npc')) continue;
    if (!graph.has(p.from) || !graph.has(p.to)) throw new Error('invalid NPC path: ' + p.id);
    graph.get(p.from).add(p.to);
    if (!p.oneWay) graph.get(p.to).add(p.from);
  }
  return graph;
}

export function nextHop(world, from, to) {
  const graph = worldGraph(world);
  if (!graph.has(from) || !graph.has(to)) throw new Error('unknown NPC place');
  if (from === to) return from;
  const queue = [from], prev = new Map([[from, null]]);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const next of [...graph.get(current)].sort()) {
      if (prev.has(next)) continue;
      prev.set(next, current);
      if (next === to) {
        let hop = next;
        while (prev.get(hop) !== from) hop = prev.get(hop);
        return hop;
      }
      queue.push(next);
    }
  }
  return null;
}

export function createLifeState(world) {
  const graph = worldGraph(world);
  if (!graph.has(WORK_PLACE)) throw new Error('missing work place');
  const actors = {};
  for (const npc of world.npcs || []) {
    if (actors[npc.id] || !graph.has(npc.homePlaceId)) throw new Error('invalid life NPC home or duplicate ID');
    actors[npc.id] = {
      locationId: npc.homePlaceId, hunger: 30, fatigue: 15,
      food: 6, meals: 0, restTicks: 0, workTicks: 0,
      wagesEarned: 0, moves: 0, lastAction: 'idle',
    };
  }
  return { version: 1, actors };
}

export function advanceLife(state, world, phase, emit) {
  if (!['morning', 'afternoon', 'evening'].includes(phase)) throw new Error('invalid life phase');
  const npcDefs = new Map((world.npcs || []).map(n => [n.id, n]));
  const living = [state.merchant, ...state.heroes];
  if (Object.keys(state.life?.actors || {}).length !== living.length) throw new Error('life state does not match NPC count');

  for (const actor of living) {
    const info = state.life.actors[actor.id], def = npcDefs.get(actor.id);
    if (!info || !def) throw new Error('missing NPC life state: ' + actor.id);
    const home = def.homePlaceId;
    info.hunger = Math.min(100, info.hunger + HUNGER_PER_PHASE);
    info.fatigue = Math.min(100, info.fatigue + FATIGUE_PER_PHASE);
    const report = (action, detail = {}) => {
      info.lastAction = action;
      emit('life_' + action, actor.id, { locationId: info.locationId, ...detail });
    };
    const moveToward = target => {
      const hop = nextHop(world, info.locationId, target);
      if (!hop) { report('blocked', { target, reason: 'no_path' }); return; }
      if (hop === info.locationId) return;
      const previous = info.locationId;
      info.locationId = hop;
      info.moves++;
      report('move', { from: previous, to: hop, destination: target });
    };
    if (info.hunger >= 62 && info.food > 0) {
      info.food--; info.meals++;
      info.hunger = Math.max(0, info.hunger - FOOD_RECOVERY);
      report('eat', { foodRemaining: info.food, hunger: info.hunger });
      continue;
    }
    if (info.hunger >= 90 && info.food === 0) {
      report('blocked', { reason: 'no_food' });
      continue;
    }
    if (info.fatigue >= 65 || phase === 'evening') {
      if (info.locationId !== home) moveToward(home);
      else {
        info.restTicks++;
        info.fatigue = Math.max(0, info.fatigue - REST_RECOVERY);
        report('rest', { fatigue: info.fatigue });
      }
      continue;
    }
    // A labor turn must happen AT the workplace. External wages are tracked
    // to keep the preexisting currency-conservation test exact.
    if (actor.id === state.merchant.id || actor.cash < WORK_CASH_THRESHOLD) {
      if (info.locationId !== WORK_PLACE) moveToward(WORK_PLACE);
      else {
        const wage = actor.id === state.merchant.id ? 0 : HERO_WAGE;
        actor.cash += wage;
        state.ledger.outsideIncome += wage;
        info.workTicks++;
        info.wagesEarned += wage;
        info.fatigue = Math.min(100, info.fatigue + 8);
        info.hunger = Math.min(100, info.hunger + 4);
        report('work', { earned: wage, cash: actor.cash });
      }
      continue;
    }
    const target = phase === 'afternoon' && ['forest', 'ruins'].includes(actor.todayPlan)
      ? actor.todayPlan : home;
    if (info.locationId !== target) moveToward(target);
    else {
      info.restTicks++;
      info.fatigue = Math.max(0, info.fatigue - REST_RECOVERY);
      report('rest', { fatigue: info.fatigue });
    }
  }
}

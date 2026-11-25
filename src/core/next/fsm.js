// src/core/next/fsm.js — pure, data-driven finite state machine for NPC AI
// (ENGINE-NEXT-01 candidate).
//
// The machine definition holds the functions; the per-entity FSM state is
// plain JSON ({ state, since, prev }) so it lives inside hashed/saved game
// state. Transitions are tested in declaration order and the first match
// wins — the same context always picks the same transition.
// Pure module: no rendering, no wall clock, no randomness of its own.

// def: { id, initial, states: { [name]: { transitions: [{ to, when(ctx, fs) }] } } }
export function defineFsm(def) {
  if (!def || typeof def.id !== "string") throw new Error("defineFsm: id is required");
  const names = Object.keys(def.states || {});
  if (names.length === 0) throw new Error(`fsm ${def.id}: no states`);
  if (!names.includes(def.initial)) throw new Error(`fsm ${def.id}: initial state "${def.initial}" is not defined`);
  for (const name of names) {
    const transitions = def.states[name].transitions || [];
    transitions.forEach((t, i) => {
      if (!names.includes(t.to)) throw new Error(`fsm ${def.id}: ${name}[${i}] goes to unknown state "${t.to}"`);
      if (typeof t.when !== "function") throw new Error(`fsm ${def.id}: ${name}[${i}] needs a when() function`);
    });
  }
  return { id: def.id, initial: def.initial, states: def.states, stateNames: names };
}

export function createFsmState(def, tick = 0) {
  return { state: def.initial, since: tick, prev: null };
}

// Evaluate one update. Mutates fs; returns { changed, from, to }.
// At most one transition per update, so a state is always observable for
// at least one tick.
export function updateFsm(def, fs, ctx, tick) {
  const node = def.states[fs.state];
  if (!node) throw new Error(`fsm ${def.id}: entity is in unknown state "${fs.state}"`);
  for (const t of node.transitions || []) {
    if (t.when(ctx, fs)) {
      const from = fs.state;
      fs.prev = from;
      fs.state = t.to;
      fs.since = tick;
      return { changed: true, from, to: t.to };
    }
  }
  return { changed: false, from: fs.state, to: fs.state };
}

export function ticksInState(fs, tick) {
  return tick - fs.since;
}

export function isValidFsmState(def, fs) {
  return !!fs && typeof fs === "object" && def.stateNames.includes(fs.state)
    && Number.isInteger(fs.since) && (fs.prev === null || def.stateNames.includes(fs.prev));
}

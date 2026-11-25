// src/core/next/ecs.js — lightweight deterministic entity/component store,
// system scheduler and event queue (ENGINE-NEXT-01 candidate).
//
// Design rules:
//   - All ECS state is one plain JSON object ({ nextId, alive, comps, queue,
//     events, eventSeq }) so it can be hashed (state-hash.js), saved and
//     restored without custom serializers.
//   - Entity ids are integers handed out in ascending order and never
//     reused. `alive` stays sorted, so iteration order is the creation order
//     and is identical on every run.
//   - Components are declared up front. Unknown component names and data
//     that fails the component's validate() throw — a typo must not silently
//     create a second component store.
//   - Systems run in (order, registration) order. Events are FIFO.
// Pure module: no rendering, no wall clock, no randomness.

export function createEcsState() {
  return { nextId: 1, alive: [], comps: {}, queue: [], events: [], eventSeq: 0 };
}

const MAX_EVENTS_PER_DISPATCH = 100000;

function lowerBound(arr, value) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function clonePlain(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clonePlain);
  const out = {};
  for (const k of Object.keys(value)) out[k] = clonePlain(value[k]);
  return out;
}

// components: { [name]: { defaults?: object, validate?: (data) => string | null } }
export function createEcs({ components = {}, state = null } = {}) {
  const specs = new Map();
  for (const name of Object.keys(components)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(name)) throw new Error(`ecs: bad component name "${name}"`);
    specs.set(name, components[name] || {});
  }
  let s = state || createEcsState();

  function spec(name) {
    const sp = specs.get(name);
    if (!sp) throw new Error(`ecs: unknown component "${name}"`);
    return sp;
  }
  function build(name, data) {
    const sp = spec(name);
    if (data !== undefined && (data === null || typeof data !== "object" || Array.isArray(data))) {
      throw new Error(`ecs: component "${name}" data must be a plain object`);
    }
    const value = { ...clonePlain(sp.defaults || {}), ...clonePlain(data || {}) };
    if (sp.validate) {
      const err = sp.validate(value);
      if (err) throw new Error(`ecs: invalid "${name}": ${err}`);
    }
    return value;
  }
  function store(name) {
    spec(name);
    return s.comps[name] || (s.comps[name] = {});
  }

  const ecs = {
    get state() { return s; },
    // Swap in a restored state (save/load, snapshot rollback).
    set state(next) {
      const err = validateEcsState(next, specs);
      if (err) throw new Error(`ecs: invalid state: ${err}`);
      s = next;
    },
    // Point this ECS at another state object WITHOUT re-validating it. For
    // the hot path: a game keeps one module-level ecs and calls
    // ecs.bind(state.ecs) at the top of every step/view. Untrusted state
    // (a loaded save) must go through validateEcsState / the setter first.
    bind(next) { s = next; return ecs; },
    componentNames() { return [...specs.keys()]; },
    specs() { return specs; },

    spawn(initial = {}) {
      // Validate everything before touching state so a bad spawn is atomic.
      const built = [];
      for (const name of Object.keys(initial)) built.push([name, build(name, initial[name])]);
      const id = s.nextId;
      s.nextId += 1;
      s.alive.push(id);
      for (const [name, value] of built) store(name)[id] = value;
      return id;
    },
    despawn(id) {
      const i = lowerBound(s.alive, id);
      if (s.alive[i] !== id) return false;
      s.alive.splice(i, 1);
      for (const name of Object.keys(s.comps)) delete s.comps[name][id];
      return true;
    },
    isAlive(id) {
      return s.alive[lowerBound(s.alive, id)] === id;
    },
    count() { return s.alive.length; },
    ids() { return s.alive.slice(); },

    has(id, name) {
      spec(name);
      const st = s.comps[name];
      return !!st && Object.prototype.hasOwnProperty.call(st, id);
    },
    get(id, name) {
      spec(name);
      const st = s.comps[name];
      return st && Object.prototype.hasOwnProperty.call(st, id) ? st[id] : null;
    },
    set(id, name, data) {
      if (!ecs.isAlive(id)) throw new Error(`ecs: entity ${id} is not alive`);
      const value = build(name, data);
      store(name)[id] = value;
      return value;
    },
    remove(id, name) {
      spec(name);
      const st = s.comps[name];
      if (!st || !Object.prototype.hasOwnProperty.call(st, id)) return false;
      delete st[id];
      return true;
    },

    // Ids (ascending) that have every named component. Returns a fresh
    // array, so spawning/despawning while iterating the result is safe.
    query(...names) {
      const stores = names.map((n) => { spec(n); return s.comps[n]; });
      if (stores.some((st) => !st)) return [];
      const out = [];
      for (const id of s.alive) {
        let ok = true;
        for (const st of stores) {
          if (!Object.prototype.hasOwnProperty.call(st, id)) { ok = false; break; }
        }
        if (ok) out.push(id);
      }
      return out;
    },
    each(names, fn) {
      for (const id of ecs.query(...names)) {
        if (!ecs.isAlive(id)) continue; // despawned earlier in this pass
        fn(id, ...names.map((n) => s.comps[n][id]));
      }
    },
    // First id (ascending) matching the predicate, or null.
    find(names, pred) {
      for (const id of ecs.query(...names)) {
        if (pred(id, ...names.map((n) => s.comps[n][id]))) return id;
      }
      return null;
    },

    // --- Event queue (FIFO, deterministic). ---
    emit(type, data = {}) {
      if (typeof type !== "string" || type.length === 0) throw new Error("ecs: event type must be a non-empty string");
      s.eventSeq += 1;
      s.queue.push({ seq: s.eventSeq, type, data: clonePlain(data) });
    },
    // Deliver queued events in emit order. Handlers may emit more events;
    // those are delivered in the same dispatch, after the ones already
    // queued. Delivered events land in state.events (the per-tick log the
    // renderer reads); beginTick() clears that log.
    dispatch(handlers = {}) {
      let delivered = 0;
      while (s.queue.length > 0) {
        const ev = s.queue.shift();
        s.events.push(ev);
        delivered += 1;
        if (delivered > MAX_EVENTS_PER_DISPATCH) throw new Error("ecs: event storm (handlers keep emitting)");
        const list = handlers[ev.type];
        if (!list) continue;
        for (const fn of Array.isArray(list) ? list : [list]) fn(ev.data, ev);
      }
      return delivered;
    },
    beginTick() { s.events = []; },
  };
  return ecs;
}

// Structural check used by the state setter and by save validation.
export function validateEcsState(state, specs = null) {
  if (!state || typeof state !== "object") return "not an object";
  if (!Number.isInteger(state.nextId) || state.nextId < 1) return "nextId";
  if (!Array.isArray(state.alive)) return "alive";
  let prev = 0;
  for (const id of state.alive) {
    if (!Number.isInteger(id) || id <= prev || id >= state.nextId) return `alive id ${id}`;
    prev = id;
  }
  if (!state.comps || typeof state.comps !== "object" || Array.isArray(state.comps)) return "comps";
  const aliveSet = new Set(state.alive);
  for (const name of Object.keys(state.comps)) {
    if (specs && !specs.has(name)) return `unknown component ${name}`;
    const st = state.comps[name];
    if (!st || typeof st !== "object" || Array.isArray(st)) return `component store ${name}`;
    for (const key of Object.keys(st)) {
      if (!aliveSet.has(Number(key))) return `component ${name} on dead entity ${key}`;
      if (!st[key] || typeof st[key] !== "object") return `component ${name}[${key}]`;
    }
  }
  if (!Array.isArray(state.queue) || !Array.isArray(state.events)) return "event queues";
  if (!Number.isInteger(state.eventSeq) || state.eventSeq < 0) return "eventSeq";
  return null;
}

// Ordered system list. run(ctx) calls every system in (order, registration)
// order; the order is fixed at registration and never depends on names.
export function createScheduler() {
  const systems = [];
  let sorted = null;
  return {
    add(name, fn, { order = 0 } = {}) {
      if (typeof name !== "string" || !name) throw new Error("scheduler: system needs a name");
      if (typeof fn !== "function") throw new Error(`scheduler: system "${name}" needs a function`);
      if (systems.some((x) => x.name === name)) throw new Error(`scheduler: duplicate system "${name}"`);
      if (!Number.isFinite(order)) throw new Error(`scheduler: system "${name}" order must be finite`);
      systems.push({ name, fn, order, index: systems.length });
      sorted = null;
      return this;
    },
    list() {
      if (!sorted) sorted = systems.slice().sort((a, b) => a.order - b.order || a.index - b.index);
      return sorted.map((x) => x.name);
    },
    run(ctx) {
      if (!sorted) sorted = systems.slice().sort((a, b) => a.order - b.order || a.index - b.index);
      for (const sys of sorted) sys.fn(ctx);
    },
  };
}

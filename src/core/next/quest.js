// src/core/next/quest.js — data-driven quests: conditions over named stats
// and one-time rewards (ENGINE-NEXT-01 candidate).
//
// Quest definitions come from the WorldForge manifest `quests` list. A node
// with params { stat, op, value } is a condition; a node with params
// { reward: { items } } carries the reward. The quest log is plain JSON:
//   [{ id, name, type, done, rewarded, progress, target }]
// Invariant: a quest's reward is granted exactly once — `rewarded` flips
// together with the grant callback and is checked before it, so replaying
// update on a completed log (or loading a save) never pays twice.
// Pure module.

const OPS = {
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a === b,
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
};

export function questDefsFromManifest(manifestQuests) {
  if (!Array.isArray(manifestQuests)) throw new Error("quests: manifest quests must be an array");
  const seen = new Set();
  return manifestQuests.map((q) => {
    if (seen.has(q.id)) throw new Error(`quests: duplicate quest id ${q.id}`);
    seen.add(q.id);
    const conditions = [];
    let reward = null;
    for (const node of q.nodes || []) {
      const p = node.params;
      if (!p) continue;
      if (typeof p.stat === "string") {
        const op = p.op || ">=";
        if (!OPS[op]) throw new Error(`quests: ${q.id} uses unknown op "${op}"`);
        if (!Number.isFinite(p.value)) throw new Error(`quests: ${q.id} condition on ${p.stat} needs a numeric value`);
        conditions.push({ stat: p.stat, op, value: p.value });
      }
      if (p.reward) {
        if (reward) throw new Error(`quests: ${q.id} has more than one reward node`);
        reward = structuredClone(p.reward);
      }
    }
    if (conditions.length === 0) throw new Error(`quests: ${q.id} has no condition node (params.stat)`);
    return { id: q.id, name: q.name || q.id, type: q.type || "quest", conditions, reward };
  });
}

export function createQuestLog(defs) {
  return defs.map((d) => ({
    id: d.id, name: d.name, type: d.type,
    done: false, rewarded: false,
    progress: 0, target: d.conditions[0].value,
  }));
}

// stats: { [name]: number }. grant(reward, questId) is called once per quest
// that has a reward, at the moment it completes. Returns the ids completed
// by this call, in definition order.
export function updateQuests(log, defs, stats, grant = null) {
  const completed = [];
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const entry = log[i];
    if (!entry || entry.id !== def.id) throw new Error(`quests: log does not match definitions at ${def.id}`);
    if (!entry.done) {
      const first = def.conditions[0];
      const value = Number.isFinite(stats[first.stat]) ? stats[first.stat] : 0;
      entry.progress = first.op === ">=" || first.op === ">" ? Math.min(value, first.value) : value;
      const ok = def.conditions.every((c) => OPS[c.op](Number.isFinite(stats[c.stat]) ? stats[c.stat] : 0, c.value));
      if (ok) {
        entry.done = true;
        completed.push(def.id);
      }
    }
    if (entry.done && !entry.rewarded) {
      entry.rewarded = true;
      if (def.reward && grant) grant(def.reward, def.id);
    }
  }
  return completed;
}

export function allQuestsDone(log) {
  return log.length > 0 && log.every((q) => q.done);
}

export function isValidQuestLog(log, defs) {
  return Array.isArray(log) && log.length === defs.length && log.every((e, i) =>
    e && e.id === defs[i].id && typeof e.done === "boolean" && typeof e.rewarded === "boolean"
    && Number.isFinite(e.progress) && !(e.rewarded && !e.done));
}

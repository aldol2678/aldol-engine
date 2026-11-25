// src/core/next/combat.js — health, damage and tick-based cooldowns
// (ENGINE-NEXT-01 candidate).
//
// Everything is plain JSON and tick-based (never seconds from a clock):
//   health   = { hp, max }
//   cooldown = { readyAt }   (tick at which the action is usable again)
// Damage is integer; armor subtracts a flat amount, and a hit that connects
// always deals at least `minDamage` (default 1) so fights terminate.
// Pure module: the only randomness is the Rng the caller passes in.

export function createHealth(max, hp = max) {
  if (!Number.isInteger(max) || max <= 0) throw new RangeError("combat: max hp must be a positive integer");
  if (!Number.isInteger(hp) || hp < 0 || hp > max) throw new RangeError("combat: hp must be an integer in [0, max]");
  return { hp, max };
}
export function isDead(health) { return health.hp <= 0; }

// Returns { dealt, killed, overkill }. Dead targets take no damage.
export function applyDamage(health, amount, { armor = 0, minDamage = 1 } = {}) {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError("combat: damage must be a non-negative number");
  if (health.hp <= 0 || amount === 0) return { dealt: 0, killed: false, overkill: 0 };
  const raw = Math.max(minDamage, Math.floor(amount) - Math.max(0, armor));
  const dealt = Math.min(health.hp, raw);
  health.hp -= dealt;
  return { dealt, killed: health.hp === 0, overkill: raw - dealt };
}
// Returns the amount actually healed. Dead targets are not revived.
export function heal(health, amount) {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError("combat: heal must be a non-negative number");
  if (health.hp <= 0) return 0;
  const healed = Math.min(health.max - health.hp, Math.floor(amount));
  health.hp += healed;
  return healed;
}

export function createCooldown() { return { readyAt: 0 }; }
export function cooldownReady(cd, tick) { return tick >= cd.readyAt; }
export function cooldownRemaining(cd, tick) { return Math.max(0, cd.readyAt - tick); }
// Starts the cooldown only when it is ready. Returns true when it started.
export function triggerCooldown(cd, tick, durationTicks) {
  if (!Number.isInteger(durationTicks) || durationTicks < 0) throw new RangeError("combat: cooldown duration must be a non-negative integer");
  if (tick < cd.readyAt) return false;
  cd.readyAt = tick + durationTicks;
  return true;
}

// Seeded damage roll: base ± variance (integers, inclusive), optional crit.
// Always consumes exactly two RNG draws so the stream position does not
// depend on the outcome.
export function rollDamage(rng, { base, variance = 0, critChance = 0, critMultiplier = 2 }) {
  const spread = variance > 0 ? rng.int(-variance, variance + 1) : (rng.next(), 0);
  const crit = rng.next() < critChance;
  const amount = Math.max(0, base + spread);
  return { amount: crit ? Math.floor(amount * critMultiplier) : amount, crit };
}

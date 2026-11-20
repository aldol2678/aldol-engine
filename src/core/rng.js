// Seeded RNG — the only source of randomness in the simulation path.
// No Math.random() here or anywhere under src/core/.

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seedString) {
    this.seedString = String(seedString);
    this.next = mulberry32(fnv1a(this.seedString));
  }
  // Float in [0, 1).
  float() {
    return this.next();
  }
  // Integer in [min, max).
  int(min, max) {
    return min + Math.floor(this.next() * (max - min));
  }
  pick(arr) {
    return arr[this.int(0, arr.length)];
  }
  shuffle(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  // Named sub-stream, e.g. fork('ai:patrol'). Deterministic per (seed, name).
  fork(name) {
    return new Rng(`${this.seedString}::${name}`);
  }
}

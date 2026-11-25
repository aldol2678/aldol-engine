// Rune Vault (M4 candidate) checks. Run: node --experimental-vm-modules tools/check-rune-vault.mjs (or node tools/check-next-all.mjs)
// (node --experimental-vm-modules tools/check-rune-vault.mjs)
import { createChecker, readJson, readText, syntaxChecks, pageScriptSyntaxChecks, bannedApiChecks, determinismSuite, saveRejectionSuite } from "./next/harness.mjs";
import { validateWorldManifest } from "../src/core/worldforge.js";
import { stateHash } from "../src/core/state-hash.js";
import { count } from "../src/core/next/inventory.js";
import { serializeSave, parseSave } from "../src/core/next/save.js";
import { game, loadWorld, view, GAME_ID, SEED, RULE_TYPE, SAVE_KEY, PHASES } from "../games/rune-vault/vault.js";
import { SOLUTIONS, DIR } from "./next/play/rune-vault-solutions.mjs";

const t = createChecker();
const { check, throws } = t;
const SIM = "games/rune-vault/vault.js";

// ------------------------------------------------ manifest and world
const manifest = readJson("games/rune-vault/world.json");
const v = validateWorldManifest(manifest);
check("rune-vault manifest valid", v.valid, JSON.stringify(v.errors));
const world = loadWorld(manifest);
check("rune-vault world adapted",
  world.levels.length === 3 && world.board.cols === 11 && world.board.rows === 7 && world.questDefs.length === 4
  && world.levels[0].moveLimit === 20 && world.levels[2].doors.length === 3 && world.levels[2].plates.length === 2 && world.clearDelayTicks === 45,
  `levels=${world.levels.length} quests=${world.questDefs.length}`);
check("manifest uses builtin assets only", manifest.assets.every((a) => a.uri.startsWith("builtin:")));
check("ids and save key", GAME_ID === "rune-vault" && RULE_TYPE === "game.puzzle" && SAVE_KEY === "aldol-engine.rune-vault-m4.save.v1" && game.id === GAME_ID && game.version === 1);

const mutated = (fn) => { const m = JSON.parse(JSON.stringify(manifest)); fn(m, m.rules[0].config); return m; };
throws("rejects bad quest edge ref", () => loadWorld(mutated((m) => { m.quests[0].edges[0].to = "nope"; })), /E_QUEST_NODE_REF_NOT_FOUND/);
throws("rejects missing puzzle rule", () => loadWorld(mutated((m) => { m.rules[0].type = "game.other"; })), /no enabled/);
throws("rejects another project's manifest", () => loadWorld(mutated((m) => { m.project.id = "star-defense"; })), /expected "rune-vault"/);
throws("rejects external asset uri", () => loadWorld(mutated((m) => { m.assets[0].uri = "https://example.com/a.glb"; })), /E_ASSET_URI/);
throws("rejects ragged level rows", () => loadWorld(mutated((m, c) => { c.levels[0].rows[2] = "#..#"; })), /same non-zero length/);
throws("rejects level of another board size", () => loadWorld(mutated((m, c) => { c.levels[0].rows.pop(); })), /rows must be 11x7/);
throws("rejects level without player", () => loadWorld(mutated((m, c) => { c.levels[0].rows[1] = c.levels[0].rows[1].replace("P", "."); })), /exactly one P/);
throws("rejects level with two players", () => loadWorld(mutated((m, c) => { c.levels[0].rows[2] = "#P...#....#"; })), /exactly one P/);
throws("rejects level without goal", () => loadWorld(mutated((m, c) => { c.levels[0].rows[5] = "#....#....#"; })), /needs a goal/);
throws("rejects unknown tile character", () => loadWorld(mutated((m, c) => { c.levels[0].rows[2] = "#..X.#....#"; })), /unknown tile/);
throws("rejects plate linked to unknown door", () => loadWorld(mutated((m, c) => { c.levels[0].objects[1].door = "ghost"; })), /unknown door/);
throws("rejects object inside a wall", () => loadWorld(mutated((m, c) => { c.levels[0].objects[0].c = 0; })), /off the floor/);
throws("rejects object out of bounds", () => loadWorld(mutated((m, c) => { c.levels[0].objects[0].c = 99; })), /off the floor/);
throws("rejects two objects on one cell", () => loadWorld(mutated((m, c) => { c.levels[0].objects[1].c = 3; })), /share cell/);
throws("rejects duplicate door id", () => loadWorld(mutated((m, c) => { c.levels[2].objects[3].id = "twin"; })), /door id/);
throws("rejects lever on a sealed door", () => loadWorld(mutated((m, c) => { c.levels[1].objects[1].door = "seal"; })), /sealed door/);
throws("rejects zero move limit", () => loadWorld(mutated((m, c) => { c.levels[1].moveLimit = 0; })), /moveLimit/);
throws("rejects fractional move limit", () => loadWorld(mutated((m, c) => { c.levels[1].moveLimit = 3.5; })), /moveLimit/);
throws("rejects unknown object kind", () => loadWorld(mutated((m, c) => { c.levels[0].objects[0].kind = "trap"; })), /unknown object kind/);
throws("rejects duplicate level id", () => loadWorld(mutated((m, c) => { c.levels[1].id = "room-1"; })), /duplicate level id/);
throws("rejects empty level list", () => loadWorld(mutated((m, c) => { c.levels = []; })), /non-empty/);
throws("createState rejects a missing world", () => game.start(SEED, null), /needs a world/);

// ------------------------------------------------------------ helpers
const start = () => game.start(SEED, world);
const mv = (s, moves) => { for (const d of moves) game.step(s, { move: DIR[d] }); return s; };
const who = (s, kind) => view(s.state).filter((o) => o.kind === kind);
const player = (s) => who(s, "player")[0];
const pos = (s) => `${player(s).c},${player(s).r}`;
const skipTo = (level) => { const s = start(); for (let i = 0; i < level; i++) { mv(s, SOLUTIONS[i]); game.step(s, { next: true }); } return s; };

// --------------------------------------------------------- room 1 rules
{
  const s = start();
  check("start: room 1, playing, full moves", s.state.phase === "playing" && s.state.level === 0 && s.state.movesLeft === 20 && pos(s) === "1,1" && PHASES.includes(s.state.phase));
  mv(s, "U");
  check("walking into a wall is a bump and costs no move", pos(s) === "1,1" && s.state.movesLeft === 20 && s.state.ecs.events.some((e) => e.type === "bump"));
  mv(s, "L");
  check("walking into the border wall costs no move", pos(s) === "1,1" && s.state.movesLeft === 20);
  check("facing follows the last attempted direction", player(s).facing === "left");
  mv(s, "R");
  check("a free step costs exactly one move", pos(s) === "2,1" && s.state.movesLeft === 19 && s.state.stats.moves === 1);
  check("door starts closed", who(s, "door")[0].open === false && who(s, "plate")[0].pressed === false);
  mv(s, "R");
  check("pushing a crate onto the plate opens the door", pos(s) === "3,1" && who(s, "crate")[0].c === 4 && who(s, "plate")[0].pressed && who(s, "door")[0].open && s.state.stats.cratesPushed === 1);
  check("push emits events in order (push, step, door)", s.state.ecs.events.map((e) => e.type).join(",") === "push,step,door", s.state.ecs.events.map((e) => e.type).join(","));
  mv(s, "R");
  check("crate against a wall cannot be pushed (no move spent)", pos(s) === "3,1" && who(s, "crate")[0].c === 4 && s.state.movesLeft === 18);
}
{
  // The player alone holds a plate only while standing on it.
  const s = start();
  mv(s, "DRRU"); // (1,2) (2,2) (3,2) -> up into the crate at (3,1): pushes it to (3,0)? wall -> bump
  check("crate cannot be pushed into the top wall", who(s, "crate")[0].r === 1 && pos(s) === "3,2");
  mv(s, "RU"); // (4,2) -> (4,1) the plate
  check("player standing on the plate opens the door", pos(s) === "4,1" && who(s, "plate")[0].pressed && who(s, "door")[0].open);
  mv(s, "D");
  check("stepping off the plate closes the door again", !who(s, "plate")[0].pressed && !who(s, "door")[0].open && s.state.ecs.events.some((e) => e.type === "door" && e.data.open === false));
  mv(s, "DR"); // (4,3) then into the closed door at (5,3)
  check("a closed door blocks and costs no move", pos(s) === "4,3" && s.state.movesLeft === 20 - 7, `pos=${pos(s)} left=${s.state.movesLeft}`);
}
{
  // Crate chains and crates vs closed doors.
  const m2 = mutated((m, c) => { c.levels[0].rows[1] = "#PCC.#....#"; c.levels[0].rows[3] = "#...C.....#"; });
  const w2 = loadWorld(m2);
  const s = game.start(SEED, w2);
  game.step(s, { move: "right" });
  check("two crates in a row cannot be pushed", view(s.state).find((o) => o.kind === "player").c === 1 && s.state.movesLeft === 20);
  for (const d of ["down", "down", "right", "right"]) game.step(s, { move: d });
  const p = view(s.state).find((o) => o.kind === "player");
  const crate = view(s.state).filter((o) => o.kind === "crate").find((o) => o.r === 3);
  check("a crate cannot be pushed into a closed door", p.c === 3 && p.r === 3 && crate.c === 4, `player=${p.c},${p.r} crate=${crate.c}`);
}
{
  // Door never closes on an occupant: crate parked in an open doorway.
  const m3 = mutated((m, c) => { c.levels[0].rows[1] = "#P...#....#"; c.levels[0].rows[3] = "#..C......#"; });
  const s = game.start(SEED, loadWorld(m3));
  for (const d of ["right", "right", "right", "down"]) game.step(s, { move: d }); // stand next to plate (4,1)? plate is at (4,1); player at (3,1)->down (3,2)
  for (const d of ["up", "right"]) game.step(s, { move: d }); // onto the plate at (4,1): door opens
  const door0 = view(s.state).find((o) => o.kind === "door");
  check("setup: door open while player is on the plate", door0.open === true);
  // Leave the plate: door closes (nothing in it).
  game.step(s, { move: "left" });
  check("door closes when nothing holds it", view(s.state).find((o) => o.kind === "door").open === false);
}

// Move limit boundary: the last move may still reach the goal; otherwise fail.
{
  const tight = loadWorld(mutated((m, c) => { c.levels[0].moveLimit = SOLUTIONS[0].length; }));
  const s = game.start(SEED, tight);
  for (const d of SOLUTIONS[0]) game.step(s, { move: DIR[d] });
  check("reaching the goal on the very last move clears the room", s.state.phase === "cleared" && s.state.movesLeft === 0 && s.state.stats.fails === 0);
  const s2 = game.start(SEED, tight);
  for (const d of "DUDUDUDUDUD") game.step(s2, { move: DIR[d] });
  check("one move left: still playing", s2.state.phase === "playing" && s2.state.movesLeft === 1);
  game.step(s2, { move: "up" });
  check("running out of moves fails the room", s2.state.phase === "failed" && s2.state.movesLeft === 0 && s2.state.stats.fails === 1 && s2.state.ecs.events.some((e) => e.type === "failed"));
  const frozen = game.hash(s2).length && view(s2.state).find((o) => o.kind === "player");
  game.step(s2, { move: "down" });
  game.step(s2, { next: true });
  const after = view(s2.state).find((o) => o.kind === "player");
  check("failed room ignores moves and next", s2.state.phase === "failed" && after.c === frozen.c && after.r === frozen.r);
  game.step(s2, { reset: true });
  check("reset after failure restarts the room with full moves", s2.state.phase === "playing" && s2.state.movesLeft === tight.levels[0].moveLimit && s2.state.stats.resets === 1 && s2.state.stats.fails === 1);
  for (const d of SOLUTIONS[0]) game.step(s2, { move: DIR[d] });
  check("a failed-then-reset room can still be cleared", s2.state.phase === "cleared");
}

// Reset any time; garbage input never throws or changes the room.
{
  const s = start();
  mv(s, "RR");
  game.step(s, { reset: true });
  check("reset mid-room restores crate, player, doors and moves", pos(s) === "1,1" && who(s, "crate")[0].c === 3 && !who(s, "door")[0].open && s.state.movesLeft === 20 && s.state.stats.resets === 1);
  check("entity ids keep growing across resets (never reused)", s.state.ecs.alive[0] > 5);
  const before = stateHash({ v: view(s.state), m: s.state.movesLeft, p: s.state.phase });
  const garbage = [null, 7, "up", [], { move: "north" }, { move: 3 }, { move: null }, { move: "constructor" }, { move: "__proto__" }, { move: ["up"] }, { reset: "yes" }, { reset: 1 }, { next: true }, { unknown: true }, { move: "UP" }, undefined];
  let threw = false;
  try { for (const g of garbage) game.step(s, g); } catch { threw = true; }
  check("garbage inputs are ignored without throwing", !threw && before === stateHash({ v: view(s.state), m: s.state.movesLeft, p: s.state.phase }) && s.state.tick === 3 + garbage.length);
  game.step(s, { move: "right", reset: true });
  check("reset wins over move in the same frame", pos(s) === "1,1" && s.state.stats.resets === 2);
}

// Room clear pause -> next room (by timer on the fixed tick, or { next }).
{
  const s = mv(start(), SOLUTIONS[0]);
  check("room 1 solution clears it", s.state.phase === "cleared" && s.state.stats.roomsCleared === 1 && s.state.clearAt === s.state.tick + 45);
  check("quest escape-first-room completes with a rune reward", s.state.quests[0].done && s.state.quests[0].rewarded && count(s.state.runes, "rune") === 1);
  game.step(s, { move: "left" });
  game.step(s, { reset: true });
  check("cleared room ignores move and reset", s.state.phase === "cleared" && s.state.level === 0 && s.state.stats.resets === 0);
  for (let i = 0; i < 42; i++) game.step(s, {});
  check("still paused one tick before the delay ends", s.state.phase === "cleared" && s.state.tick === s.state.clearAt - 1);
  game.step(s, {});
  check("next room starts exactly at clearAt", s.state.phase === "playing" && s.state.level === 1 && s.state.movesLeft === 36 && pos(s) === "1,1" && s.state.ecs.events.some((e) => e.type === "room"));
  const s2 = mv(start(), SOLUTIONS[0]);
  game.step(s2, { next: true });
  check("{ next } skips the pause", s2.state.phase === "playing" && s2.state.level === 1);
}

// --------------------------------------------------------- room 2 rules
{
  const s = skipTo(1);
  mv(s, "DDDDRRU"); // down the left corridor, along the bottom, up into the lever door at (3,4)
  check("lever door starts closed and blocks", pos(s) === "3,5" && who(s, "door").find((d) => d.key === "cell").open === false);
  const s2 = skipTo(1);
  mv(s2, "RRRR");
  check("stepping on the lever opens its door", who(s2, "lever")[0].on && who(s2, "door").find((d) => d.key === "cell").open && s2.state.stats.leversPulled === 1);
  mv(s2, "LR");
  check("stepping on the lever again closes it (toggle)", !who(s2, "lever")[0].on && !who(s2, "door").find((d) => d.key === "cell").open && s2.state.stats.leversPulled === 2);
  mv(s2, "LR");
  mv(s2, "DDRRU"); // (5,3) (7,3) then up into the seal at (7,2) without a key
  check("sealed door blocks without a key (no move spent)", pos(s2) === "7,3" && who(s2, "door").find((d) => d.key === "seal").locked && s2.state.movesLeft === 36 - 8 - 4);
  mv(s2, "DDLLLLUU");
  check("walking onto the key picks it up", pos(s2) === "3,3" && count(s2.state.keys, "key") === 1 && who(s2, "key").length === 0 && s2.state.ecs.events.some((e) => e.type === "key"));
  mv(s2, "DDRRRRUUU");
  const seal = who(s2, "door").find((d) => d.key === "seal");
  check("the key is consumed and the seal opens for good", pos(s2) === "7,2" && count(s2.state.keys, "key") === 0 && !seal.locked && seal.open && s2.state.stats.keysUsed === 1);
  check("quest use-a-key completes", s2.state.quests[1].done && count(s2.state.runes, "rune") === 2);
  mv(s2, "D");
  check("a broken seal stays open after leaving it", who(s2, "door").find((d) => d.key === "seal").open === true);
  game.step(s2, { reset: true });
  check("reset returns the key to the floor and re-seals the door", who(s2, "key").length === 1 && count(s2.state.keys, "key") === 0 && who(s2, "door").find((d) => d.key === "seal").locked);
  check("quest progress and runes survive a room reset", s2.state.quests[1].done && count(s2.state.runes, "rune") === 2 && s2.state.stats.keysUsed === 1);
}

// --------------------------------------------------------- room 3 rules
{
  const s = skipTo(2);
  const twin = () => who(s, "door").find((d) => d.key === "twin");
  mv(s, "RR"); // stand on the plate at (3,1)
  check("an 'all' door stays closed with one of two plates pressed", pos(s) === "3,1" && who(s, "plate").filter((p) => p.pressed).length === 1 && twin().open === false);
  const full = skipTo(2);
  mv(full, SOLUTIONS[2].slice(0, 18));
  check("both plates pressed open the 'all' door", who(full, "plate").every((p) => p.pressed) && who(full, "door").find((d) => d.key === "twin").open);
}

// ------------------------------------------- full game, quests, replay
{
  const s = start();
  SOLUTIONS.forEach((sol, i) => {
    mv(s, sol);
    if (i < SOLUTIONS.length - 1) game.step(s, { next: true });
  });
  check("solutions clear all three rooms and win", s.state.phase === "won" && s.state.stats.roomsCleared === 3 && s.state.level === 2 && s.state.ecs.events.some((e) => e.type === "won"));
  check("all quests done, each reward paid once (5 runes)", s.state.quests.every((q) => q.done && q.rewarded) && count(s.state.runes, "rune") === 5);
  const h = game.hash(s);
  for (const g of [{ move: "left" }, { reset: true }, { next: true }, {}]) game.step(s, g);
  check("a won game ignores every input", s.state.phase === "won" && s.state.stats.resets === 0 && count(s.state.runes, "rune") === 5 && who(s, "player")[0].c === 9 && h !== game.hash(s));
  const ins = game.inspect(s);
  check("inspect() reports the game summary", ins.game === GAME_ID && ins.summary.phase === "won" && ins.summary.level === 3 && ins.summary.levels === 3 && ins.summary.runes === 5 && ins.summary.questsDone === 4);

  const failed = start();
  for (let i = 0; i < 20; i++) game.step(failed, { move: i % 2 ? "up" : "down" });
  check("a failure keeps the flawless quest open even after winning", (() => {
    game.step(failed, { reset: true });
    SOLUTIONS.forEach((sol, i) => { mv(failed, sol); if (i < 2) game.step(failed, { next: true }); });
    return failed.state.phase === "won" && failed.state.quests[2].done && !failed.state.quests[3].done && count(failed.state.runes, "rune") === 4;
  })());
}

// BFS solver (drives the real sim): every room is solvable within its move
// limit and the stored solution is a shortest one.
{
  const keyOf = (st) => JSON.stringify([view(st).map((o) => [o.kind, o.c, o.r, o.open, o.on, o.locked]), st.keys.items]);
  const base = start();
  world.levels.forEach((level, i) => {
    const first = structuredClone(base.state);
    const seen = new Set([keyOf(first)]);
    let frontier = [first];
    let depth = 0;
    let found = -1;
    while (frontier.length > 0 && found < 0 && depth < level.moveLimit) {
      depth += 1;
      const next = [];
      for (const st of frontier) {
        for (const d of ["up", "right", "down", "left"]) {
          const probe = { state: structuredClone(st), rng: base.rng, world };
          game.step(probe, { move: d });
          if (probe.state.phase === "cleared" || probe.state.phase === "won") { found = depth; break; }
          if (probe.state.phase !== "playing") continue;
          const k = keyOf(probe.state);
          if (seen.has(k)) continue;
          seen.add(k);
          next.push(probe.state);
        }
        if (found >= 0) break;
      }
      frontier = next;
    }
    check(`solver: ${level.id} is solvable within its ${level.moveLimit} moves`, found > 0 && found <= level.moveLimit, `shortest=${found} states=${seen.size}`);
    check(`solver: stored solution for ${level.id} is a shortest one`, found === SOLUTIONS[i].length, `stored=${SOLUTIONS[i].length}`);
    mv(base, SOLUTIONS[i]);
    game.step(base, { next: true });
  });
}

// ------------------------------------------------------- determinism
const script = [];
SOLUTIONS.forEach((sol, i) => {
  for (const d of sol) script.push({ move: DIR[d] }, {});
  if (i < SOLUTIONS.length - 1) for (let k = 0; k < 50; k++) script.push({});
});
const FRAMES = script.length + 20;
const ref = game.simulate(SEED, FRAMES, script, world);
const REFERENCE_HASH = "7772d3f5";
check("reference run wins through the timed room change", ref.phase === "won" && ref.tick === FRAMES);
check(`reference hash (seed ${SEED}, ${FRAMES} frames, solution script)`, game.hash(ref) === REFERENCE_HASH, `hash=${game.hash(ref)}`);
check("different seed gives a different hash", game.hash(game.simulate(SEED + "-other", FRAMES, script, world)) !== game.hash(ref));

const SEEDS = ["rune-vault-m4", "vault-a", "vault-b", "vault-c", "vault-d", "vault-e", "vault-f", "vault-g", "vault-h", "vault-i", "vault-j", "vault-k"];
// Per-seed input script: the solution with seeded detours, bumps, resets and
// garbage mixed in, so every seed walks a different (valid) input sequence.
import { Rng } from "../src/core/rng.js";
const makeInputs = (seed) => {
  const rng = new Rng(`inputs:${seed}`);
  const inputs = [];
  const dirs = ["up", "right", "down", "left"];
  const noise = rng.int(5, 40);
  for (let i = 0; i < noise; i++) inputs.push(rng.float() < 0.15 ? "garbage" : { move: rng.pick(dirs) });
  inputs.push({ reset: true });
  SOLUTIONS.forEach((sol, i) => {
    if (rng.float() < 0.5) { for (let k = rng.int(1, 6); k > 0; k--) inputs.push({ move: rng.pick(dirs) }); inputs.push({ reset: true }); }
    for (const d of sol) { inputs.push({ move: DIR[d] }); if (rng.float() < 0.3) inputs.push({}); }
    if (i < SOLUTIONS.length - 1) { if (rng.float() < 0.5) inputs.push({ next: true }); else for (let k = 0; k < 46; k++) inputs.push({}); }
  });
  return inputs;
};
const hashes = determinismSuite(check, { game, world, seeds: SEEDS, frames: 420, makeInputs });
check("every seed's scripted run wins", SEEDS.every((seed) => game.simulate(seed, 420, makeInputs(seed), world).phase === "won"));
check("12 seeds give 12 distinct hashes", new Set(Object.values(hashes)).size === SEEDS.length);

// Order matters: the same commands in another order give another state.
{
  const a = game.simulate(SEED, 4, [{ move: "right" }, { move: "down" }], world);
  const b = game.simulate(SEED, 4, [{ move: "down" }, { move: "right" }], world);
  check("input order changes the result", game.hash(a) !== game.hash(b));
  const c = game.simulate(SEED, 4, [{ move: "right" }, {}, { move: "down" }], world);
  const d = game.simulate(SEED, 4, [{ move: "right" }, { move: "down" }, {}], world);
  check("idle frames do not change the puzzle outcome", JSON.stringify(view(c)) === JSON.stringify(view(d)) && c.movesLeft === d.movesLeft);
}

// --------------------------------------------------------------- save
{
  const s = skipTo(1);
  mv(s, "RRRRDD");
  const text = saveRejectionSuite(check, { game, world, session: s, otherGameId: "star-tactics" });
  const parsed = parseSave(text, { gameId: game.id, version: game.version, validate: (st) => game.validateState(st, world) });
  const resumed = game.restore(parsed.state, world);
  mv(resumed, SOLUTIONS[1].slice(6));
  mv(s, SOLUTIONS[1].slice(6));
  check("a restored save plays on to the same state", resumed.state.phase === "cleared" && game.hash(resumed) === game.hash(s));

  const resign = (fn) => { const env = JSON.parse(text); fn(env.payload); env.checksum = stateHash(env.payload); return parseSave(JSON.stringify(env), { gameId: game.id, version: game.version, validate: (st) => game.validateState(st, world) }); };
  check("save with unknown phase rejected", resign((p) => { p.phase = "cheating"; }).code === "E_SHAPE");
  check("save with level out of range rejected", resign((p) => { p.level = 9; }).code === "E_SHAPE");
  check("save with more moves than the limit rejected", resign((p) => { p.movesLeft = 9999; }).code === "E_SHAPE");
  check("save with player inside a wall rejected", resign((p) => { const id = Object.keys(p.ecs.comps.Player)[0]; p.ecs.comps.Cell[id] = { c: 0, r: 0 }; }).code === "E_SHAPE");
  check("save with two players rejected", resign((p) => { const id = Object.keys(p.ecs.comps.Crate || p.ecs.comps.Goal)[0]; p.ecs.comps.Player[id] = { facing: "up" }; }).code === "E_SHAPE");
  check("save with over-capacity keys rejected", resign((p) => { p.keys.items.key = 99; }).code === "E_SHAPE");
  check("save with negative stats rejected", resign((p) => { p.stats.resets = -1; }).code === "E_SHAPE");
  check("save with rewarded-but-not-done quest rejected", resign((p) => { p.quests[3].done = false; p.quests[3].rewarded = true; }).code === "E_SHAPE");
  check("save with unknown component store rejected", resign((p) => { p.ecs.comps.Ghost = {}; }).code === "E_SHAPE");
  check("save with a missing ecs rejected", resign((p) => { delete p.ecs; }).code === "E_SHAPE");
  const defenseKey = "aldol-engine.star-defense-m3.save.v1";
  check("save key differs from the existing games' keys", ![defenseKey, "aldol-engine.supuli-m1.save.v4", "aldol-engine.star-fishing-m2.save.v1"].includes(SAVE_KEY));
  check("serialized save is small", serializeSave({ gameId: game.id, version: 1, state: game.snapshot(s) }).length < 20000);
}

// ---------------------------------------- reuse evidence, static checks
{
  const src = readText(SIM);
  const imported = [...src.matchAll(/from "\.\.\/\.\.\/src\/core\/next\/([a-z-]+)\.js"/g)].map((m) => m[1]);
  check("sim imports >= 3 shared next-core modules", new Set(imported).size >= 3, imported.join(", "));
  check("sim reuses ecs, spatial, inventory, quest, runtime, save, manifest", ["ecs", "spatial", "inventory", "quest", "runtime", "save", "manifest"].every((m) => imported.includes(m)));
  check("sim does not import another game's sim or the M1 sim", !/games\/(supuli|star-fishing|star-defense|star-tactics|star-foundry)|core\/sim\.js/.test(src));
  check("sim holds no level data (no tile rows)", !/"#[#.PGCK]+#"/.test(src));
  const page = pageScriptSyntaxChecks(check, "games/rune-vault/index.html");
  check("page uses the shared HUD kit, board and shell", ["src/render/hud.js", "src/render/next/board.js", "src/render/next/shell.js", "./vault.js"].every((p) => page.includes(p)));
  check("page pins three 0.187.0 and never uses 'latest'", page.includes("three@0.187.0") && !/three@latest/.test(page));
  check("page stores nothing but through the save slot / mute key", (page.match(/localStorage/g) || []).length <= 2);
}
syntaxChecks(check, [SIM, "tools/next/play/rune-vault.mjs", "tools/next/play/rune-vault-solutions.mjs"]);
bannedApiChecks(check, [SIM]);

t.done();

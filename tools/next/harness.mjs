// tools/next/harness.mjs — shared test helpers for the ENGINE-NEXT-01 checks
// (tools/check-next.mjs and the three new game checks). Same PASS/FAIL line
// format as tools/check.mjs so logs read the same.
import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { stateHash } from "../../src/core/state-hash.js";
import { createRecorder, replay, inputAt } from "../../src/core/next/runtime.js";
import { serializeSave, parseSave } from "../../src/core/next/save.js";

export const ROOT = new URL("../../", import.meta.url);

export function createChecker() {
  let failures = 0;
  let total = 0;
  function check(name, ok, detail = "") {
    total += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }
  function throws(name, fn, pattern = null) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    check(name, !!err && (!pattern || pattern.test(String(err.message))), err ? String(err.message).slice(0, 100) : "did not throw");
  }
  function done() {
    console.log(failures === 0 ? `ALL CHECKS PASSED (${total})` : `${failures} CHECK(S) FAILED of ${total}`);
    process.exit(failures === 0 ? 0 : 1);
  }
  return { check, throws, done, get failures() { return failures; } };
}

export function readJson(relPath) {
  return JSON.parse(fs.readFileSync(new URL(relPath, ROOT), "utf8"));
}
export function readText(relPath) {
  return fs.readFileSync(new URL(relPath, ROOT), "utf8");
}

// node --check for pure modules.
export function syntaxChecks(check, files) {
  for (const f of files) {
    try {
      execFileSync(process.execPath, ["--check", f], { cwd: ROOT.pathname, stdio: "pipe" });
      check(`syntax ${f}`, true);
    } catch (e) { check(`syntax ${f}`, false, String(e.stderr || e).slice(0, 200)); }
  }
}
// Parse-only check for browser modules that import bare "three" (needs
// --experimental-vm-modules, same as check-fishing / check-star-defense).
export function browserModuleSyntaxChecks(check, files) {
  for (const f of files) {
    try {
      new vm.SourceTextModule(readText(f));
      check(`syntax ${f}`, true);
    } catch (e) { check(`syntax ${f}`, false, String(e).slice(0, 200)); }
  }
}
// Inline <script type="module"> blocks of a game page must parse.
export function pageScriptSyntaxChecks(check, htmlPath) {
  const html = readText(htmlPath);
  const blocks = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  check(`page has module script ${htmlPath}`, blocks.length > 0);
  blocks.forEach((code, i) => {
    try { new vm.SourceTextModule(code); check(`syntax ${htmlPath} script[${i}]`, true); }
    catch (e) { check(`syntax ${htmlPath} script[${i}]`, false, String(e).slice(0, 200)); }
  });
  return html;
}

// Banned nondeterministic APIs (comment lines stripped — headers name them).
export function bannedApiChecks(check, files) {
  for (const f of files) {
    const code = readText(f).split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    for (const banned of ["Math.random", "Date.now", "performance.now", "new Date", "setTimeout", "setInterval", "fetch(", "localStorage"]) {
      check(`no ${banned} in ${f}`, !code.includes(banned));
    }
  }
}

// G2 determinism suite for one game:
//   - same (seed, frames, inputs) twice -> same hash
//   - recorded run replays to the same hash (with checkpoints)
//   - snapshot at mid-run -> save text -> parse -> restore -> continue
//     reaches the same final hash as the uninterrupted run
// makeInputs(seed, index) returns an inputs array (index = frame).
// Returns the per-seed hashes so the caller can pin reference vectors.
export function determinismSuite(check, { game, world, seeds, frames, makeInputs }) {
  const hashes = {};
  let same = 0, replayed = 0, resumed = 0;
  const details = [];
  seeds.forEach((seed, i) => {
    const inputs = makeInputs(seed, i);
    const a = game.hash(game.simulate(seed, frames, inputs, world));
    const b = game.hash(game.simulate(seed, frames, inputs, world));
    if (a === b) same += 1; else details.push(`${seed}: rerun ${a} != ${b}`);
    hashes[seed] = a;

    const session = game.start(seed, world);
    const rec = createRecorder(game, seed, { checkpointEvery: Math.max(1, Math.floor(frames / 5)) });
    for (let f = 0; f < frames; f++) {
      const input = inputAt(inputs, f);
      game.step(session, input);
      rec.capture(session, input);
    }
    const record = JSON.parse(JSON.stringify(rec.finish(session)));
    const rp = replay(game, record, world);
    if (rp.ok && rp.hash === a) replayed += 1; else details.push(`${seed}: replay mismatch at ${rp.mismatch}`);

    const mid = Math.floor(frames / 2) + (i % 7);
    const s1 = game.start(seed, world);
    for (let f = 0; f < mid; f++) game.step(s1, inputAt(inputs, f));
    const text = serializeSave({ gameId: game.id, version: game.version, state: game.snapshot(s1) });
    const parsed = parseSave(text, { gameId: game.id, version: game.version, validate: (st) => game.validateState(st, world) });
    if (!parsed.ok) { details.push(`${seed}: save rejected ${parsed.code} ${parsed.detail}`); return; }
    const s2 = game.restore(parsed.state, world);
    for (let f = mid; f < frames; f++) game.step(s2, inputAt(inputs, f));
    if (game.hash(s2) === a) resumed += 1; else details.push(`${seed}: resume ${game.hash(s2)} != ${a}`);
  });
  const n = seeds.length;
  check(`determinism ${game.id}: ${n} seeds rerun identical`, same === n, details.join("; "));
  check(`determinism ${game.id}: ${n} seeds replay identical`, replayed === n, details.join("; "));
  check(`determinism ${game.id}: ${n} seeds save/restore mid-run identical`, resumed === n, details.join("; "));
  return hashes;
}

// G3 save rejection suite for one game session.
export function saveRejectionSuite(check, { game, world, session, otherGameId = "some-other-game" }) {
  const validate = (st) => game.validateState(st, world);
  const opts = { gameId: game.id, version: game.version, validate };
  const text = serializeSave({ gameId: game.id, version: game.version, state: game.snapshot(session) });
  const good = parseSave(text, opts);
  check(`save ${game.id}: round-trip accepted`, good.ok && stateHash(good.state) === game.hash(session), good.code || "");
  check(`save ${game.id}: empty rejected`, parseSave("", opts).code === "E_EMPTY");
  check(`save ${game.id}: truncated rejected`, parseSave(text.slice(0, Math.floor(text.length / 2)), opts).code === "E_PARSE");
  const env = JSON.parse(text);
  const tampered = JSON.parse(text);
  tampered.payload.tick += 1;
  check(`save ${game.id}: tampered payload rejected`, parseSave(JSON.stringify(tampered), opts).code === "E_CHECKSUM");
  check(`save ${game.id}: unknown version rejected`, parseSave(JSON.stringify({ ...env, version: game.version + 1 }), opts).code === "E_VERSION_UNKNOWN");
  check(`save ${game.id}: older version rejected`, parseSave(JSON.stringify({ ...env, version: 0 }), opts).code === "E_VERSION_UNKNOWN");
  check(`save ${game.id}: other game's save rejected`, parseSave(JSON.stringify({ ...env, gameId: otherGameId }), opts).code === "E_GAME");
  check(`save ${game.id}: wrong format rejected`, parseSave(JSON.stringify({ ...env, format: "nope" }), opts).code === "E_FORMAT");
  check(`save ${game.id}: legacy M3 save shape rejected`, parseSave(JSON.stringify({ stars: 100, shrineHp: 10, towers: [] }), opts).code === "E_FORMAT");
  const bad = JSON.parse(text);
  bad.payload.rngDraws = -5;
  bad.checksum = stateHash(bad.payload);
  check(`save ${game.id}: re-signed but invalid state rejected`, parseSave(JSON.stringify(bad), opts).code === "E_SHAPE");
  return text;
}

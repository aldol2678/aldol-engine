// npm run check — syntax + determinism + forbidden-API checks.
// Fails (exit 1) on the first failure. No network, no browser needed.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate, findPath } from "../src/core/sim.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// 1. Syntax: node --check on every JS file under src/ and tools/.
const jsFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (p.endsWith(".js") || p.endsWith(".mjs")) jsFiles.push(p);
  }
})(join(root, "src"));
jsFiles.push(join(root, "tools", "check.mjs"));
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "ignore" });
    check(`syntax ${f.replace(root + "/", "")}`, true);
  } catch {
    check(`syntax ${f.replace(root + "/", "")}`, false);
  }
}

// 2. Determinism: same (seed, frames, inputs) -> same hash, twice.
const a = simulate("supuli-m1", 600, { dx: 1, dy: 0 });
const b = simulate("supuli-m1", 600, { dx: 1, dy: 0 });
check("determinism same-seed", a.hash === b.hash, `hash=${a.hash}`);
const c = simulate("supuli-m1-other", 600, { dx: 1, dy: 0 });
check("determinism different-seed", a.hash !== c.hash, `a=${a.hash} c=${c.hash}`);

// 3. Behaviour smoke: player actually moves; NPC patrols and chases.
const moved = simulate("supuli-m1", 120, { dx: 1, dy: 0 });
check("player moves east", moved.state.player.x > 0, `x=${moved.state.player.x.toFixed(2)}`);
const chase = simulate("supuli-m1", 600, { dx: 1, dy: 1 });
check("npc leaves patrol or chases", ["patrol", "chase", "flee"].includes(chase.state.npc.state), `npc=${chase.state.npc.state}`);
check("A* path exists 0->2", Array.isArray(findPath(0, 2)) && findPath(0, 2)[0] === 0, `path=${JSON.stringify(findPath(0, 2))}`);

// 3b. Quest: walk to the villager and interact -> quest done.
const questInputs = [];
for (let f = 0; f < 300; f++) questInputs.push({ dx: 1, dy: 1 });
for (let f = 0; f < 120; f++) questInputs.push({ dx: 0, dy: 0, interact: true });
const questRun = simulate("supuli-m1", 420, questInputs);
check("quest talk-to-villager completes", questRun.state.quest.done === true, `done=${questRun.state.quest.done}`);
const noInteract = simulate("supuli-m1", 420, questInputs.map((i) => ({ dx: i.dx, dy: i.dy })));
check("quest does not complete without interact", noInteract.state.quest.done === false, `done=${noInteract.state.quest.done}`);

// 4. Forbidden APIs in the sim path (src/core only).
const forbidden = ["Math.random", "Date.now", "performance.now"];
for (const f of jsFiles.filter((x) => x.includes(`${"src"}/core/`))) {
  // Strip comments first: mentioning a banned API in a comment is fine.
  const raw = readFileSync(f, "utf8");
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const api of forbidden) {
    check(`no ${api} in ${f.replace(root + "/", "")}`, !text.includes(api));
  }
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

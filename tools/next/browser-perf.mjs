// tools/next/browser-perf.mjs — G5 browser frame-time / memory samples.
//   node tools/next/browser-perf.mjs [--root <repo root>] [--games a,b] [--reps 3] [--out <json>]
// Opens each game page in headless Chromium (1280x800), waits until it is
// ready and idle-plays for `--frames` animation frames, recording the
// requestAnimationFrame interval (p50 / p95 ms) and JS heap. --root lets the
// same script measure the baseline checkout. Headless Chromium renders with
// software GL here, so these are relative numbers for baseline-vs-candidate
// comparison on one machine — not an FPS claim for real devices.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const ROOT = path.resolve(argOf("--root", new URL("../../", import.meta.url).pathname));
const REPS = Number(argOf("--reps", 3));
const FRAMES = Number(argOf("--frames", 240));
const OUT = argOf("--out", null);
const READY = {
  supuli: "__SUPULI_M1__", "star-fishing": "__STAR_FISHING__", "star-defense": "__STAR_DEFENSE__",
  "rune-vault": "__ALDOL_NEXT__", "star-tactics": "__ALDOL_NEXT__", "star-foundry": "__ALDOL_NEXT__",
};
const games = argOf("--games", Object.keys(READY).join(",")).split(",").filter((g) => fs.existsSync(path.join(ROOT, "games", g, "index.html")));
const threeDir = process.env.THREE_BUILD_DIR || path.join(os.tmpdir(), "aldol-three-0.187.0", "package", "build");
if (!fs.existsSync(path.join(threeDir, "three.module.js"))) throw new Error("three 0.187.0 build not found — run tools/next/browser-check.mjs once (it fetches it) or set THREE_BUILD_DIR");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".glb": "model/gltf-binary", ".png": "image/png", ".wasm": "application/wasm" };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = require("playwright");
const browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
const out = { tool: "tools/next/browser-perf.mjs", root: ROOT, browser: `chromium ${browser.version()} (headless, software GL)`, viewport: "1280x800", framesPerRun: FRAMES, reps: REPS, cpu: os.cpus()[0]?.model || "unknown", rows: [] };
for (const g of games) {
  const runs = [];
  for (let rep = 0; rep < REPS; rep++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route("https://unpkg.com/three@0.187.0/build/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(path.join(threeDir, path.basename(new URL(route.request().url()).pathname))) }));
    const page = await context.newPage();
    await page.goto(`${base}/games/${g}/index.html`);
    await page.waitForFunction((name) => !!window[name], READY[g], { timeout: 30000 });
    await page.evaluate(() => localStorage.setItem("aldol-engine.audio.muted", "1"));
    const sample = await page.evaluate((frames) => new Promise((resolve) => {
      const deltas = [];
      let last = performance.now();
      let warm = 30;
      function tick(now) {
        if (warm > 0) warm -= 1; else deltas.push(now - last);
        last = now;
        if (deltas.length < frames) requestAnimationFrame(tick);
        else {
          deltas.sort((a, b) => a - b);
          const q = (p) => +deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))].toFixed(2);
          resolve({ frame_p50_ms: q(0.5), frame_p95_ms: q(0.95), frame_max_ms: q(1), heap_mb: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(2) : null });
        }
      }
      requestAnimationFrame(tick);
    }), FRAMES);
    runs.push({ rep: rep + 1, ...sample });
    await context.close();
  }
  const med = (key) => runs.map((r) => r[key]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  const row = { game: g, median_frame_p50_ms: med("frame_p50_ms"), median_frame_p95_ms: med("frame_p95_ms"), median_heap_mb: med("heap_mb"), runs };
  console.log(`${g.padEnd(14)} frame p50=${row.median_frame_p50_ms}ms p95=${row.median_frame_p95_ms}ms heap=${row.median_heap_mb}MB (median of ${REPS})`);
  out.rows.push(row);
}
await browser.close();
server.close();
if (OUT) { fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(path.resolve(OUT), JSON.stringify(out, null, 2) + "\n"); console.log(`wrote ${OUT}`); }

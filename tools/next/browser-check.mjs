// tools/next/browser-check.mjs — G4 real-browser check for all six games.
// Serves the repo locally, opens every game page in headless Chromium at
// several viewports, plays it through real keyboard / mouse / touch input
// (scenarios in tools/next/play/*.mjs), and records console errors, HUD
// overlap, page scroll, save-reload behaviour and screenshots.
//
// Usage:
//   node tools/next/browser-check.mjs [--games a,b] [--configs desktop,phone-portrait]
//        [--out docs/engine-next-01] [--no-shots] [--merge]
// --merge keeps the runs already in <out>/logs/browser-check.json and only
// replaces the (engine, game, config) runs executed this time; replaced runs
// are kept under `superseded` so a re-run never hides an earlier failure.
// Requires Playwright (global install is fine). Three.js 0.187.0 comes from
// the unpkg importmap; when the network blocks unpkg the script serves the
// same build from `npm pack three@0.187.0` (or THREE_BUILD_DIR) instead.
// This is NOT part of npm run check:all (needs a browser).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL("../../", import.meta.url).pathname);
const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const OUT = path.resolve(ROOT, argOf("--out", "docs/engine-next-01"));
const SHOTS = !args.includes("--no-shots");

const CONFIGS = {
  desktop: { label: "PC 1280x800 (keyboard/mouse)", viewport: { width: 1280, height: 800 }, mobile: false },
  "phone-portrait": { label: "phone 390x844 portrait (touch emulation)", viewport: { width: 390, height: 844 }, mobile: true },
  "phone-landscape": { label: "phone 844x390 landscape (touch emulation)", viewport: { width: 844, height: 390 }, mobile: true },
  "narrow-portrait": { label: "narrow 320x568 portrait (touch emulation)", viewport: { width: 320, height: 568 }, mobile: true },
};
const ALL_GAMES = ["supuli", "star-fishing", "star-defense", "rune-vault", "star-tactics", "star-foundry"];
const games = argOf("--games", ALL_GAMES.join(",")).split(",");
const configNames = argOf("--configs", Object.keys(CONFIGS).join(",")).split(",");

// --- three.js build (CDN blocked -> local copy of the same version) ---
function threeBuildDir() {
  if (process.env.THREE_BUILD_DIR) return process.env.THREE_BUILD_DIR;
  const cache = path.join(os.tmpdir(), "aldol-three-0.187.0");
  const build = path.join(cache, "package", "build");
  if (!fs.existsSync(path.join(build, "three.module.js"))) {
    fs.mkdirSync(cache, { recursive: true });
    execFileSync("npm", ["pack", "three@0.187.0", "--silent"], { cwd: cache, stdio: "pipe" });
    execFileSync("tar", ["-xzf", "three-0.187.0.tgz"], { cwd: cache });
  }
  return build;
}

// --- static server ---
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".glb": "model/gltf-binary", ".png": "image/png", ".wasm": "application/wasm", ".css": "text/css" };
function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w - 1 && a.x + a.w - 1 > b.x && a.y < b.y + b.h - 1 && a.y + a.h - 1 > b.y;
}

// HUD layout facts measured in the page: visible panels/buttons/floats,
// pairwise overlaps, anything off-screen, and whether the document scrolls.
async function measureHud(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0; };
    const box = (el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.className, x: r.x, y: r.y, w: r.width, h: r.height }; };
    const items = [...document.querySelectorAll(".hud-panel, .hud-btn, #help, #prompt, #bark, .next-bar")].filter(vis).map(box);
    const de = document.documentElement;
    return {
      items,
      viewport: { w: innerWidth, h: innerHeight },
      scrollable: de.scrollWidth > innerWidth + 1 || de.scrollHeight > innerHeight + 1,
      canvas: (() => { const c = document.querySelector("#app canvas"); if (!c) return null; const r = c.getBoundingClientRect(); return { w: r.width, h: r.height }; })(),
    };
  });
}
function hudIssues(hud) {
  const issues = [];
  const { items, viewport } = hud;
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.x < -1 || a.y < -1 || a.x + a.w > viewport.w + 1 || a.y + a.h > viewport.h + 1) issues.push(`offscreen:${a.id}`);
    for (let j = i + 1; j < items.length; j++) {
      if (rectsOverlap(a, items[j])) issues.push(`overlap:${a.id}~${items[j].id}`);
    }
  }
  if (hud.scrollable) issues.push("page-scrolls");
  if (!hud.canvas || Math.abs(hud.canvas.w - viewport.w) > 2 || Math.abs(hud.canvas.h - viewport.h) > 2) issues.push("canvas-not-fullscreen");
  return issues;
}

async function main() {
  const { chromium, firefox, webkit } = require("playwright");
  const threeDir = threeBuildDir();
  const { server, base } = await startServer();
  fs.mkdirSync(path.join(OUT, "captures"), { recursive: true });
  const results = [];
  const engines = [];
  for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
    let available = false;
    try { available = fs.existsSync(type.executablePath()); } catch { available = false; }
    engines.push({ name, available, type });
  }
  console.log("engines: " + engines.map((e) => `${e.name}=${e.available ? "available" : "NOT RUN (not installed)"}`).join(" "));

  for (const engine of engines.filter((e) => e.available)) {
    let browser;
    try {
      browser = await engine.type.launch();
      engine.status = "RUN";
    } catch (error) {
      engine.status = "FAIL (browser launch)";
      engine.error = String(error && error.message || error);
      console.error(`FAIL ${engine.name} launch: ${engine.error}`);
      continue;
    }
    console.log(`browser: ${engine.name} ${browser.version()}`);
    for (const gameId of games) {
      const scenario = await import(`./play/${gameId}.mjs`);
      for (const configName of configNames) {
        const cfg = CONFIGS[configName];
        const context = await browser.newContext({ viewport: cfg.viewport, hasTouch: cfg.mobile, isMobile: cfg.mobile && engine.name !== "firefox", deviceScaleFactor: cfg.mobile ? 2 : 1 });
        await context.route("https://unpkg.com/three@0.187.0/build/**", (route) => {
          const file = path.join(threeDir, path.basename(new URL(route.request().url()).pathname));
          if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
          return route.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(file) });
        });
        const page = await context.newPage();
        const consoleErrors = [];
        const failedRequests = [];
        page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
        page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e.message).slice(0, 300)));
        page.on("requestfailed", (r) => failedRequests.push(r.url()));
        page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });

        const result = { engine: engine.name, game: gameId, config: configName, label: cfg.label, result: "FAIL", steps: [], issues: [], consoleErrors, failedRequests };
        const url = `${base}/${scenario.meta.path}`;
        const shot = async (tag) => {
          if (!SHOTS) return;
          const file = path.join(OUT, "captures", `${gameId}.${configName}.${tag}.png`);
          await page.screenshot({ path: file });
          result.steps.push(`screenshot captures/${path.basename(file)}`);
        };
        const ctx = {
          mobile: cfg.mobile, config: configName, viewport: cfg.viewport, url,
          step: (text) => { result.steps.push(text); },
          expect: (ok, text) => { result.steps.push(`${ok ? "ok" : "FAILED"}: ${text}`); if (!ok) result.issues.push(text); return ok; },
          shot,
          // Tap/click at CSS px the way the device would.
          tapXY: async (x, y) => { if (cfg.mobile) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); },
          tap: async (selector) => {
            const b = await page.locator(selector).boundingBox();
            if (!b) throw new Error(`cannot tap ${selector}: not visible`);
            await ctx.tapXY(b.x + b.width / 2, b.y + b.height / 2);
          },
          key: (k) => page.keyboard.press(k),
          // Press-drag-hold-release on the canvas: real touch events on
          // mobile configs (CDP), mouse on desktop.
          drag: async (x0, y0, x1, y1, holdMs = 600) => {
            if (cfg.mobile) {
              const cdp = await context.newCDPSession(page);
              await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
              for (let i = 1; i <= 5; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / 5, y: y0 + ((y1 - y0) * i) / 5 }] });
              await page.waitForTimeout(holdMs);
              await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
              await cdp.detach();
            } else {
              await page.mouse.move(x0, y0);
              await page.mouse.down();
              await page.mouse.move(x1, y1, { steps: 5 });
              await page.waitForTimeout(holdMs);
              await page.mouse.up();
            }
          },
          holdKey: async (k, ms) => { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); },
          // Next-gen probe helpers (window.__ALDOL_NEXT__).
          inspect: () => page.evaluate(() => window.__ALDOL_NEXT__.inspect()),
          state: () => page.evaluate(() => window.__ALDOL_NEXT__.state()),
          tapCell: async (c, r) => { const p = await page.evaluate(([cc, rr]) => window.__ALDOL_NEXT__.cellToScreen(cc, rr), [c, r]); await ctx.tapXY(p.x, p.y); },
          // Let the sim advance n ticks (bounded by wall time).
          waitTicks: async (n) => {
            const start = (await page.evaluate(() => window.__ALDOL_NEXT__.inspect().tick));
            await page.waitForFunction((target) => window.__ALDOL_NEXT__.inspect().tick >= target, start + n, { timeout: 20000 });
          },
          waitFor: (fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout }),
          hud: async () => { const h = await measureHud(page); return { ...h, issues: hudIssues(h) }; },
          reload: async () => { await page.reload(); await page.waitForFunction(scenario.meta.ready, null, { timeout: 30000 }); },
        };
        try {
          await page.goto(url);
          await page.waitForFunction(scenario.meta.ready, null, { timeout: 30000 });
          await page.evaluate((key) => { localStorage.removeItem(key); localStorage.setItem("aldol-engine.audio.muted", "1"); }, scenario.meta.saveKey);
          await ctx.reload();
          const hud0 = await ctx.hud();
          result.hudStart = hud0.issues;
          const strict = scenario.meta.hudStrict !== false;
          const hudExpect = (when, issues) => {
            if (strict) ctx.expect(issues.length === 0, `HUD at ${when}: no overlap/offscreen/scroll (${issues.join(", ") || "clean"})`);
            else ctx.step(`baseline observation, HUD at ${when}: ${issues.join(", ") || "clean"} (existing game — recorded, not gated)`);
          };
          hudExpect("start", hud0.issues);
          await shot("start");
          await scenario.play(page, ctx);
          const hud1 = await ctx.hud();
          result.hudEnd = hud1.issues;
          hudExpect("end", hud1.issues);
          await shot("end");
          const realErrors = consoleErrors.filter((e) => !/favicon/.test(e));
          ctx.expect(realErrors.length === 0, `no console errors (${realErrors.length})`);
          const realFailed = failedRequests.filter((u) => !/favicon/.test(u));
          ctx.expect(realFailed.length === 0, `no failed requests (${realFailed.join(" ") || 0})`);
          result.result = result.issues.length === 0 ? "PASS" : "FAIL";
        } catch (e) {
          result.issues.push("exception: " + String(e && e.message).slice(0, 400));
          try { await shot("error"); } catch { /* page may be gone */ }
        }
        console.log(`${result.result} ${engine.name} ${gameId} ${configName}${result.issues.length ? " — " + result.issues.join(" | ") : ""}`);
        results.push(result);
        await context.close();
      }
    }
    await browser.close();
  }
  server.close();
  const jsonPath = path.join(OUT, "logs", "browser-check.json");
  let superseded = [];
  if (args.includes("--merge") && fs.existsSync(jsonPath)) {
    const prev = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const key = (r) => `${r.engine}|${r.game}|${r.config}`;
    const fresh = new Set(results.map(key));
    superseded = [...(prev.superseded || []), ...prev.results.filter((r) => fresh.has(key(r)))];
    const merged = prev.results.map((r) => (fresh.has(key(r)) ? results.find((x) => key(x) === key(r)) : r));
    for (const r of results) if (!prev.results.some((x) => key(x) === key(r))) merged.push(r);
    results.length = 0;
    results.push(...merged);
  }
  const summary = {
    tool: "tools/next/browser-check.mjs",
    three: "0.187.0 (local copy of the npm package served for the unpkg importmap URL)",
    engines: engines.map((e) => ({ name: e.name, status: e.status || "NOT RUN (browser not installed in this environment)", ...(e.error ? { error: e.error } : {}) })),
    realDevices: "NOT RUN (touch results are browser touch emulation, not real devices)",
    results,
    superseded,
  };
  fs.mkdirSync(path.join(OUT, "logs"), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + "\n");
  const failed = results.filter((r) => r.result !== "PASS").length;
  console.log(failed === 0 ? `BROWSER CHECK PASSED (${results.length} runs)` : `${failed} BROWSER RUN(S) FAILED of ${results.length}`);
  const complete = engines.every(e => e.status === "RUN") && results.length === engines.length * games.length * configNames.length;
  if (!complete) console.error("Browser coverage incomplete; see engine status and result counts");
  process.exit(failed === 0 && complete ? 0 : 1);
}
main();

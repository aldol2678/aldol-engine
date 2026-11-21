// src/render/hud.js — Shared HUD kit for Aldol Engine games.
//
// Render-side only: builds the info panel, bark/prompt/help floats, round
// action buttons and the mute button, and renders the quest list. Never
// touches sim state. Both games (Supuli, Star Fishing) build their HUD from
// this kit so the same markup, CSS and wiring are not copied per game.
//
// Usage (one game page):
//   import { installHudCss, createHudPanel, createBark, createPrompt,
//            createHelp, createRoundButton, bindMute, renderQuests,
//            setSaveText, setPosText } from "../../src/render/hud.js";
//   installHudCss("forest");                    // "forest" (Supuli) or "lake" (Star Fishing)
//   const panel = createHudPanel({ title: "...", rows: ["zone", "quests", ...] });
//   const bark = createBark();
//   const prompt = createPrompt("E: 대화하기");
//   createHelp("WASD/방향키 이동 · ...", "right");
//   const muteBtn = createRoundButton({ id: "mute-btn", label: "🔊", size: 44, right: 16, bottom: 140 });
//   bindMute(audio, muteBtn);
//
// Theme presets keep each game's look while the structure stays shared.
// Element ids are kept identical to the pre-kit markup (#bark, #prompt,
// #help, #mute-btn, #zone, #quests, #save-state, ...) so existing probes
// and save code keep working unchanged.

// Theme presets: colours/sizes only, structure is shared.
const THEMES = {
  forest: {
    pageBg: "#101a12",
    panelBg: "rgba(16, 26, 18, 0.82)",
    panelFg: "#e8f3e8",
    panelPadding: "10px 12px",
    titleSize: "15px",
    bodySize: "13px",
    done: "#9be49b",
    todo: "#e8f3e8",
    barkBg: "#fffbe8",
    barkFg: "#222",
    barkBottom: "92px",
    promptBottom: "48px",
    floatSize: "14px",
    helpBg: "rgba(16, 26, 18, 0.7)",
    helpFg: "#cfe3cf",
  },
  lake: {
    pageBg: "#0b1620",
    panelBg: "rgba(10, 20, 30, 0.72)",
    panelFg: "#eaf6ff",
    panelPadding: "12px 14px",
    titleSize: "17px",
    bodySize: "14px",
    done: "#7dff9b",
    todo: "#cfe8ff",
    barkBg: "#fff",
    barkFg: "#222",
    barkBottom: "150px",
    promptBottom: "96px",
    floatSize: "15px",
    helpBg: "rgba(10, 20, 30, 0.6)",
    helpFg: "#cfe8ff",
  },
};

const CSS = `
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--hud-page-bg, #101a12); font-family: system-ui, sans-serif; }
#app { position: fixed; inset: 0; }
#app canvas { display: block; }
.hud-panel { position: absolute; left: 12px; top: 12px; max-width: 320px; background: var(--hud-panel-bg, rgba(16, 26, 18, 0.82)); color: var(--hud-panel-fg, #e8f3e8); border-radius: 10px; padding: var(--hud-panel-padding, 10px 12px); line-height: 1.5; pointer-events: none; }
.hud-panel.top-right { left: auto; right: 12px; }
.hud-panel h1 { font-size: var(--hud-title-size, 15px); margin: 0 0 4px; }
.hud-panel p, .hud-panel div { font-size: var(--hud-body-size, 13px); margin: 2px 0; }
.hud-panel .done { color: var(--hud-done, #9be49b); }
.hud-panel .todo { color: var(--hud-todo, #e8f3e8); }
.hpbar { height: 8px; background: #333; border-radius: 4px; overflow: hidden; margin: 4px 0; }
.hpbar > div { height: 100%; background: #e05252; width: 100%; }
#bark { position: absolute; left: 50%; bottom: var(--hud-bark-bottom, 92px); transform: translateX(-50%); background: var(--hud-bark-bg, #fffbe8); color: var(--hud-bark-fg, #222); border-radius: 12px; padding: 8px 14px; font-size: var(--hud-float-size, 14px); display: none; max-width: 80vw; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
#prompt { position: absolute; left: 50%; bottom: var(--hud-prompt-bottom, 48px); transform: translateX(-50%); background: rgba(0,0,0,.65); color: #fff; border-radius: 8px; padding: 6px 12px; font-size: var(--hud-float-size, 14px); display: none; }
#help { position: absolute; bottom: 12px; background: var(--hud-help-bg, rgba(16, 26, 18, 0.7)); color: var(--hud-help-fg, #cfe3cf); padding: 6px 10px; border-radius: 8px; font-size: 12px; }
#help.right { right: 12px; }
#help.center { left: 50%; transform: translateX(-50%); max-width: calc(100vw - 24px); text-align: center; }
.hud-btn { position: absolute; border: none; border-radius: 50%; color: #fff; display: flex; align-items: center; justify-content: center; font-family: inherit; font-size: 15px; font-weight: bold; padding: 0; user-select: none; touch-action: none; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
`;

let cssInstalled = false;

// Inject the shared HUD stylesheet once and apply the theme's CSS variables.
export function installHudCss(themeName) {
  if (cssInstalled) return;
  cssInstalled = true;
  const theme = THEMES[themeName] || THEMES.forest;
  const style = document.createElement("style");
  style.id = "hud-kit-css";
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.documentElement.style;
  root.setProperty("--hud-page-bg", theme.pageBg);
  root.setProperty("--hud-panel-bg", theme.panelBg);
  root.setProperty("--hud-panel-fg", theme.panelFg);
  root.setProperty("--hud-panel-padding", theme.panelPadding);
  root.setProperty("--hud-title-size", theme.titleSize);
  root.setProperty("--hud-body-size", theme.bodySize);
  root.setProperty("--hud-done", theme.done);
  root.setProperty("--hud-todo", theme.todo);
  root.setProperty("--hud-bark-bg", theme.barkBg);
  root.setProperty("--hud-bark-fg", theme.barkFg);
  root.setProperty("--hud-bark-bottom", theme.barkBottom);
  root.setProperty("--hud-prompt-bottom", theme.promptBottom);
  root.setProperty("--hud-float-size", theme.floatSize);
  root.setProperty("--hud-help-bg", theme.helpBg);
  root.setProperty("--hud-help-fg", theme.helpFg);
}

// Info panel (top-left by default, top-right with position: "right").
// rows: string ids ("zone") or { id, tag = "p", className, html, text }.
// The hp bar is a row too: { tag: "div", className: "hpbar", html: '<div id="hpfill"></div>' }.
// Returns { el, slots } where slots maps row ids to their elements.
export function createHudPanel({ id, title, rows = [], position = "left", style = {} }) {
  const el = document.createElement("div");
  el.className = "hud-panel" + (position === "right" ? " top-right" : "");
  if (id) el.id = id;
  Object.assign(el.style, style);
  if (title) {
    const h = document.createElement("h1");
    h.textContent = title;
    el.appendChild(h);
  }
  const slots = {};
  for (const row of rows) {
    const spec = typeof row === "string" ? { id: row } : row;
    const node = document.createElement(spec.tag || "p");
    if (spec.id) node.id = spec.id;
    if (spec.className) node.className = spec.className;
    if (spec.html) node.innerHTML = spec.html;
    if (spec.text) node.textContent = spec.text;
    el.appendChild(node);
    if (spec.id) slots[spec.id] = node;
  }
  document.body.appendChild(el);
  return { el, slots };
}

// Bark toast (bottom-center bubble, auto-hides after 2.5s of frame time).
// show(text) displays it; tick(dt) is called from the game's frame loop.
export function createBark() {
  const el = document.createElement("div");
  el.id = "bark";
  document.body.appendChild(el);
  let timer = 0;
  return {
    el,
    show(text) {
      el.textContent = text;
      el.style.display = "block";
      timer = 2.5;
    },
    tick(dt) {
      if (timer > 0) {
        timer -= dt;
        if (timer <= 0) el.style.display = "none";
      }
    },
  };
}

// Action prompt ("E: 대화하기") — shown/hidden by the game.
export function createPrompt(text = "") {
  const el = document.createElement("div");
  el.id = "prompt";
  el.textContent = text;
  document.body.appendChild(el);
  return {
    el,
    setVisible(visible) {
      el.style.display = visible ? "block" : "none";
    },
  };
}

// Controls hint. position: "right" (bottom-right corner) or "center" (bottom-center).
export function createHelp(text, position = "right") {
  const el = document.createElement("div");
  el.id = "help";
  el.className = position === "center" ? "center" : "right";
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

// Round touch button (attack / cast / reel / mute). onPress runs on pointerdown.
export function createRoundButton({ id, label, size = 72, fontSize, right, bottom, background, onPress }) {
  const btn = document.createElement("button");
  btn.className = "hud-btn";
  if (id) btn.id = id;
  btn.textContent = label;
  btn.style.width = `${size}px`;
  btn.style.height = `${size}px`;
  if (fontSize != null) btn.style.fontSize = `${fontSize}px`;
  if (right != null) btn.style.right = `${right}px`;
  if (bottom != null) btn.style.bottom = `${bottom}px`;
  if (background) btn.style.background = background;
  if (onPress) btn.addEventListener("pointerdown", (e) => { onPress(); e.preventDefault(); });
  document.body.appendChild(btn);
  return btn;
}

// Mute button wiring: label sync (🔊/🔇), pointerdown toggle, M key toggle,
// persisted to localStorage ("aldol-engine.audio.muted"). Returns toggleMute.
// The audio manager must already exist; the game sets its initial muted
// state from localStorage before calling this.
export function bindMute(audio, buttonEl) {
  const sync = () => {
    buttonEl.textContent = audio.muted ? "🔇" : "🔊";
  };
  function toggleMute() {
    audio.setMuted(!audio.muted);
    localStorage.setItem("aldol-engine.audio.muted", audio.muted ? "1" : "0");
    sync();
  }
  sync();
  buttonEl.addEventListener("pointerdown", () => toggleMute());
  addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "m") toggleMute();
  });
  return toggleMute;
}

// Quest list: done → ✓ + .done, todo → · + .todo. progressText(q) returns
// "" or e.g. " (2)" / " (1/3)" — each game formats its own progress.
export function renderQuests(el, quests, progressText) {
  el.innerHTML = quests.map((q) =>
    `<div class="${q.done ? "done" : "todo"}">${q.done ? "✓" : "·"} ${q.name}${progressText ? progressText(q) : ""}</div>`
  ).join("");
}

// Save-state line ("저장: ..."). fallback is the text when no note is given.
export function setSaveText(el, note, fallback = "자동 저장됨") {
  el.textContent = `저장: ${note || fallback}`;
}

// Position line ("위치: (x, y)").
export function setPosText(el, x, y) {
  el.textContent = `위치: (${x.toFixed(1)}, ${y.toFixed(1)})`;
}

// src/render/next/shell.js — page shell shared by the next-gen games
// (ENGINE-NEXT-01 candidate): fixed-step loop, explicit input frames,
// versioned save slot, restart, touch D-pad and the test probe.
// Render-side only. The sim (src/core/next/runtime.js) never imports this.
//
// Input contract: a page never mutates sim state. It calls runner.push(cmd)
// and the shell feeds at most ONE command per 1/60 s tick as that tick's
// input frame. Every fed frame is recorded, so a browser session can be
// exported and replayed headlessly (runner.record()).
import { TICK, createRecorder } from "../../core/next/runtime.js";
import { serializeSave, parseSave } from "../../core/next/save.js";
import { createRoundButton } from "../hud.js";

// localStorage wrapper for one game's versioned save. A save that fails
// parseSave() (corrupted, other game, unknown version) is left in place
// under the key and reported — the game then starts fresh and the next
// autosave overwrites it. Storage errors (private mode, quota) never throw.
export function createSaveSlot({ key, game, world }) {
  const opts = { gameId: game.id, version: game.version, validate: (state) => game.validateState(state, world) };
  return {
    key,
    load() {
      let text = null;
      try { text = localStorage.getItem(key); } catch { return { ok: false, code: "E_STORAGE", detail: "read" }; }
      if (text === null) return { ok: false, code: "E_NONE", detail: "" };
      return parseSave(text, opts);
    },
    save(session) {
      try {
        localStorage.setItem(key, serializeSave({ gameId: game.id, version: game.version, state: game.snapshot(session) }));
        return true;
      } catch { return false; }
    },
    clear() {
      try { localStorage.removeItem(key); return true; } catch { return false; }
    },
  };
}

// Owns the session: start/restore, queued commands -> input frames, fixed
// stepping, autosave and restart.
//   onStep(state, events, input)  after every tick (HUD refresh, sounds)
//   shouldSave(state, events)     return a note string to autosave now
export function createRunner({ game, world, seed, saveSlot = null, onStep = null, shouldSave = null, autosaveTicks = 300 }) {
  let session = null;
  let recorder = null;
  let loadResult = { ok: false, code: "E_NONE", detail: "" };
  let lastSaveTick = 0;
  let saveNote = "";
  const queue = [];

  function begin(fromSave) {
    queue.length = 0;
    session = null;
    if (fromSave && saveSlot) {
      loadResult = saveSlot.load();
      if (loadResult.ok) {
        try { session = game.restore(loadResult.state, world); } catch (e) {
          loadResult = { ok: false, code: "E_SHAPE", detail: String(e && e.message) };
        }
      }
    }
    if (!session) session = game.start(seed, world);
    // A restored session is not replayable from tick 0, so the recorder
    // only exists for sessions that started fresh.
    recorder = session.state.tick === 0 ? createRecorder(game, seed, { checkpointEvery: 600 }) : null;
    lastSaveTick = session.state.tick;
  }
  begin(true);

  const runner = {
    get session() { return session; },
    get state() { return session.state; },
    get loadResult() { return loadResult; },
    get saveNote() { return saveNote; },
    get pending() { return queue.length; },
    // Queue one command (a plain object) for the next free tick.
    push(cmd) {
      if (cmd && typeof cmd === "object" && queue.length < 240) queue.push(cmd);
    },
    tick() {
      const input = queue.length > 0 ? queue.shift() : {};
      game.step(session, input);
      if (recorder) recorder.capture(session, input);
      const state = session.state;
      const events = state.ecs ? state.ecs.events : [];
      if (onStep) onStep(state, events, input);
      let note = shouldSave ? shouldSave(state, events, input) : null;
      if (!note && autosaveTicks > 0 && state.tick - lastSaveTick >= autosaveTicks) note = "자동 저장됨";
      if (note) runner.save(note);
      return state;
    },
    save(note = "저장됨") {
      if (!saveSlot) return false;
      const ok = saveSlot.save(session);
      lastSaveTick = session.state.tick;
      saveNote = ok ? note : "저장 실패";
      return ok;
    },
    // New game from tick 0 with the same seed; the old save is replaced.
    restart() {
      if (saveSlot) saveSlot.clear();
      begin(false);
      saveNote = "새 게임";
      if (onStep) onStep(session.state, [], {});
    },
    record() { return recorder ? recorder.finish(session) : null; },
    inspect() { return game.inspect(session); },
  };
  return runner;
}

// requestAnimationFrame loop with a fixed-step accumulator. At most
// maxCatchUp ticks run per frame so a background tab does not spiral.
// stats.speed (1, 2, 4…) is a render-side time multiplier for games with a
// fast-forward button: the sim still advances in whole 1/60 s ticks, only
// more of them per second of wall time, so determinism is unaffected.
export function startLoop({ runner, render, maxCatchUp = 8 }) {
  let last = performance.now();
  let acc = 0;
  const stats = { frames: 0, ticks: 0, lastFrameMs: 0, speed: 1, paused: false };
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const speed = Math.max(1, Math.min(16, Math.floor(stats.speed) || 1));
    if (!stats.paused) acc += dt * speed;
    const limit = maxCatchUp * speed;
    let n = 0;
    while (acc >= TICK && n < limit) {
      acc -= TICK;
      runner.tick();
      n += 1;
    }
    if (n === limit) acc = 0;
    stats.ticks += n;
    stats.frames += 1;
    render(dt, now / 1000);
    stats.lastFrameMs = performance.now() - now;
  }
  requestAnimationFrame(frame);
  return stats;
}

// Keyboard: map of key (lower-case e.key, " " for space) -> handler.
// preventDefault only on handled keys so browser shortcuts keep working.
export function bindKeys(map) {
  window.addEventListener("keydown", (e) => {
    if (e.repeat && !map.__repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const handler = map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (handler) { handler(e); e.preventDefault(); }
  });
}
export const ARROW_DIRS = { ArrowUp: "up", ArrowRight: "right", ArrowDown: "down", ArrowLeft: "left", w: "up", d: "right", s: "down", a: "left" };

// Four-way touch D-pad built from the HUD kit's round buttons (bottom-left).
// onDir("up" | "right" | "down" | "left") runs on pointerdown.
export function createDpad({ onDir, size = 52, left = 14, bottom = 58, background = "rgba(40, 50, 80, 0.85)" }) {
  const spec = [["up", "▲", 1, 2], ["left", "◀", 0, 1], ["right", "▶", 2, 1], ["down", "▼", 1, 0]];
  const gap = 4;
  return spec.map(([dir, label, col, row]) => {
    const btn = createRoundButton({ id: `dpad-${dir}`, label, size, background, onPress: () => onDir(dir) });
    btn.style.left = `${left + col * (size + gap)}px`;
    btn.style.bottom = `${bottom + row * (size + gap)}px`;
    btn.style.borderRadius = "14px";
    btn.setAttribute("aria-label", dir);
    return btn;
  });
}

// Test/handoff probe: window.__ALDOL_NEXT__ = { game, backend, inspect(),
// state(), record(), loadResult(), board info, ... }. Read-only helpers plus
// push(cmd) (the same entry the UI uses) — nothing here bypasses the sim.
export function installProbe({ runner, game, board = null, extra = {} }) {
  const probe = {
    game: game.id,
    version: game.version,
    backend: "js",
    inspect: () => runner.inspect(),
    state: () => structuredClone(runner.state),
    record: () => runner.record(),
    loadResult: () => ({ ok: runner.loadResult.ok, code: runner.loadResult.code || null }),
    saveNote: () => runner.saveNote,
    push: (cmd) => runner.push(cmd),
    cellToScreen: board ? (c, r) => board.cellToScreen(c, r) : null,
    renderInfo: board ? () => board.info() : null,
    ...extra,
  };
  window.__ALDOL_NEXT__ = probe;
  return probe;
}

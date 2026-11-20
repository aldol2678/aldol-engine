// WebAudio player for engine voices (renderer-side only, never the sim).
// Lazy AudioContext: browsers block audio before the first user gesture, so
// the context is created on the first play()/startBgm() call. Every call is
// defensive — if audio is unavailable, play() only records the name, so a
// broken audio path can never break the game.

import { scheduleVoice, BGM_CHORDS, BGM_CHORD_SECONDS } from "../core/audio.js";

export function createAudioManager({ volume = 0.5 } = {}) {
  let ctx = null;
  let master = null;
  let muted = false;
  let bgmTimer = null;
  let bgmChord = 0;
  const played = [];

  function ensure() {
    if (typeof window === "undefined") return null;
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : volume;
        master.connect(ctx.destination);
      }
      if (ctx.state === "suspended") void ctx.resume();
      return ctx;
    } catch {
      return null;
    }
  }

  function play(name) {
    played.push(name);
    const c = ensure();
    if (!c || !master) return;
    try {
      const t0 = c.currentTime + 0.01;
      for (const e of scheduleVoice(name)) {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = e.type;
        o.frequency.value = e.freq;
        g.gain.setValueAtTime(0, t0 + e.at);
        g.gain.linearRampToValueAtTime(e.gain, t0 + e.at + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + e.at + e.dur);
        o.connect(g);
        g.connect(master);
        o.start(t0 + e.at);
        o.stop(t0 + e.at + e.dur + 0.05);
      }
    } catch {
      // Audio must never break the game.
    }
  }

  function playChord(freqs, t0, dur) {
    for (const freq of freqs) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.05, t0 + 0.8);
      g.gain.setValueAtTime(0.05, t0 + dur - 0.8);
      g.gain.linearRampToValueAtTime(0, t0 + dur);
      o.connect(g);
      g.connect(master);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    }
  }

  function startBgm() {
    if (bgmTimer !== null) return;
    const c = ensure();
    if (!c || !master) return;
    const tick = () => {
      try {
        playChord(BGM_CHORDS[bgmChord % BGM_CHORDS.length], c.currentTime + 0.05, BGM_CHORD_SECONDS);
        bgmChord++;
      } catch {
        // Ignore.
      }
    };
    tick();
    bgmTimer = setInterval(tick, BGM_CHORD_SECONDS * 1000);
  }

  function stopBgm() {
    if (bgmTimer !== null) {
      clearInterval(bgmTimer);
      bgmTimer = null;
    }
  }

  function setMuted(m) {
    muted = m;
    if (master) master.gain.value = m ? 0 : volume;
  }

  return {
    play,
    startBgm,
    stopBgm,
    setMuted,
    get muted() {
      return muted;
    },
    get played() {
      return [...played];
    },
  };
}

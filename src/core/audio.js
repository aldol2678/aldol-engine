// Voice table + schedule (pure: no AudioContext, no wall clock, no RNG).
// A voice is a list of notes {at, freq, dur, type, gain}.
// The renderer (src/render/audio.js) plays the schedule through WebAudio;
// this module stays testable in Node.
export const VOICES = {
  cast: [{ at: 0, freq: 392, dur: 0.12, type: "sine", gain: 0.25 }],
  bite: [
    { at: 0, freq: 659.25, dur: 0.1, type: "triangle", gain: 0.3 },
    { at: 0.09, freq: 880, dur: 0.12, type: "triangle", gain: 0.3 },
  ],
  catch: [523.25, 659.25, 783.99, 1046.5].map((freq, i) => ({ at: i * 0.09, freq, dur: 0.18, type: "triangle", gain: 0.3 })),
  talk: [
    { at: 0, freq: 523.25, dur: 0.08, type: "sine", gain: 0.2 },
    { at: 0.07, freq: 392, dur: 0.1, type: "sine", gain: 0.2 },
  ],
  quest: [523.25, 659.25, 783.99, 1046.5, 1318.5].map((freq, i) => ({ at: i * 0.1, freq, dur: 0.25, type: "triangle", gain: 0.28 })),
  hurt: [{ at: 0, freq: 110, dur: 0.25, type: "sawtooth", gain: 0.25 }],
  heal: [
    { at: 0, freq: 523.25, dur: 0.3, type: "sine", gain: 0.22 },
    { at: 0.12, freq: 783.99, dur: 0.35, type: "sine", gain: 0.22 },
  ],
  hit: [{ at: 0, freq: 220, dur: 0.08, type: "square", gain: 0.18 }],
};

export function scheduleVoice(name, when = 0) {
  const voice = VOICES[name];
  if (!voice) return [];
  return voice.map((e) => ({ ...e, at: e.at + when }));
}

// BGM: slow 4-chord pad loop (C – Am – F – G), one chord per chordSeconds.
export const BGM_CHORDS = [
  [261.63, 329.63, 392.0],
  [220.0, 261.63, 329.63],
  [174.61, 220.0, 261.63],
  [196.0, 246.94, 293.66],
];
export const BGM_CHORD_SECONDS = 4;

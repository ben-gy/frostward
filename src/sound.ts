// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * sound.ts — procedural Web Audio, extended from patterns/sound.ts with the
 * noises this game actually needs. Zero asset files, so the bundle stays tiny
 * and the game works offline.
 *
 * Frostward's audio does real work rather than decorating: the Rime's hiss is
 * PITCHED BY HOW MUCH FROZE, so you hear the size of a step before you have
 * finished reading the board, and the countdown carries the round start because
 * players are watching the grid, not the overlay.
 *
 * Call `sfx.unlock()` from the first user gesture or every browser blocks audio.
 */

export type SfxName =
  | 'select'
  | 'deselect'
  | 'veer'
  | 'ridge'
  | 'thaw'
  | 'ember'
  | 'creep'
  | 'guard'
  | 'snuff'
  | 'out'
  | 'commit'
  | 'reveal'
  | 'beat'
  | 'go'
  | 'win'
  | 'lose';

interface Patch {
  type: OscillatorType;
  /** [startFreq, endFreq] Hz — glides between them over `dur`. */
  freq: [number, number];
  dur: number;
  /** Peak gain 0..1. */
  gain?: number;
  /** Mix in a noise burst (wind, ice, stone). */
  noise?: number;
  /** Band-pass the noise here, sweeping to the second value. */
  noiseBand?: [number, number];
  /** Play a second voice a fifth up for a fuller chime. */
  fifth?: boolean;
}

const PATCHES: Record<SfxName, Patch> = {
  select: { type: 'triangle', freq: [520, 760], dur: 0.07, gain: 0.16 },
  deselect: { type: 'triangle', freq: [620, 380], dur: 0.07, gain: 0.12 },
  // The wind: almost all noise, swept, barely any tone.
  veer: { type: 'sine', freq: [220, 300], dur: 0.42, gain: 0.05, noise: 0.5, noiseBand: [600, 2400] },
  ridge: { type: 'sine', freq: [150, 58], dur: 0.2, gain: 0.32, noise: 0.28, noiseBand: [200, 90] },
  thaw: { type: 'triangle', freq: [430, 880], dur: 0.36, gain: 0.2, fifth: true },
  ember: { type: 'sawtooth', freq: [900, 220], dur: 0.22, gain: 0.18, noise: 0.35, noiseBand: [2600, 700] },
  // The Rime itself. Pitch is modulated at the call site by how much froze.
  creep: { type: 'sine', freq: [1500, 700], dur: 0.5, gain: 0.07, noise: 0.55, noiseBand: [3000, 900] },
  guard: { type: 'triangle', freq: [700, 1050], dur: 0.16, gain: 0.24 },
  snuff: { type: 'sawtooth', freq: [420, 70], dur: 0.6, gain: 0.3, noise: 0.2, noiseBand: [900, 120] },
  out: { type: 'sawtooth', freq: [260, 46], dur: 1, gain: 0.32, noise: 0.25, noiseBand: [700, 80] },
  commit: { type: 'square', freq: [660, 880], dur: 0.09, gain: 0.16 },
  reveal: { type: 'square', freq: [400, 620], dur: 0.12, gain: 0.16 },
  beat: { type: 'square', freq: [520, 520], dur: 0.13, gain: 0.22 },
  go: { type: 'square', freq: [780, 1180], dur: 0.3, gain: 0.26, fifth: true },
  win: { type: 'triangle', freq: [520, 1180], dur: 0.7, gain: 0.26, fifth: true },
  lose: { type: 'sawtooth', freq: [340, 90], dur: 0.8, gain: 0.26 },
};

export interface Sfx {
  unlock(): void;
  /** `rate` shifts the whole patch's pitch — 1 is as written. */
  play(name: SfxName, rate?: number): void;
  muted(): boolean;
  setMuted(m: boolean): void;
}

export function createSfx(initialMuted = false): Sfx {
  let ctx: AudioContext | null = null;
  let muted = initialMuted;
  let noise: AudioBuffer | null = null;

  const ensure = (): AudioContext | null => {
    try {
      if (!ctx) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') void ctx.resume();
      return ctx;
    } catch {
      return null;
    }
  };

  /** One second of white noise, made once and reused by every noisy patch. */
  const noiseBuffer = (ac: AudioContext): AudioBuffer => {
    if (noise) return noise;
    const len = ac.sampleRate;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    noise = buf;
    return buf;
  };

  return {
    unlock() {
      ensure();
    },

    play(name, rate = 1) {
      if (muted) return;
      const ac = ensure();
      if (!ac) return;
      try {
        const p = PATCHES[name];
        const t0 = ac.currentTime;
        const f0 = Math.max(20, p.freq[0] * rate);
        const f1 = Math.max(20, p.freq[1] * rate);

        const g = ac.createGain();
        g.gain.setValueAtTime(p.gain ?? 0.22, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
        g.connect(ac.destination);

        const voices = p.fifth ? [1, 1.5] : [1];
        for (const mul of voices) {
          const osc = ac.createOscillator();
          osc.type = p.type;
          osc.frequency.setValueAtTime(f0 * mul, t0);
          osc.frequency.exponentialRampToValueAtTime(f1 * mul, t0 + p.dur);
          const vg = ac.createGain();
          vg.gain.value = mul === 1 ? 1 : 0.5;
          osc.connect(vg);
          vg.connect(g);
          osc.start(t0);
          osc.stop(t0 + p.dur);
        }

        if (p.noise) {
          const src = ac.createBufferSource();
          src.buffer = noiseBuffer(ac);
          src.loop = true;
          const band = ac.createBiquadFilter();
          band.type = 'bandpass';
          band.Q.value = 0.9;
          const [b0, b1] = p.noiseBand ?? [1200, 1200];
          band.frequency.setValueAtTime(Math.max(40, b0 * rate), t0);
          band.frequency.exponentialRampToValueAtTime(Math.max(40, b1 * rate), t0 + p.dur);
          const ng = ac.createGain();
          ng.gain.setValueAtTime((p.gain ?? 0.22) * p.noise, t0);
          ng.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
          src.connect(band);
          band.connect(ng);
          ng.connect(ac.destination);
          src.start(t0);
          src.stop(t0 + p.dur);
        }
      } catch {
        // Audio is decoration; never let it take the game down.
      }
    },

    muted: () => muted,
    setMuted(m) {
      muted = m;
    },
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * fx.ts — screen shake and particles, on a DOM board.
 *
 * Everything here respects `prefers-reduced-motion` by degrading rather than
 * disappearing: shake becomes a flash, particle counts drop to a token few. A
 * player who asked for less motion should still be able to see that something
 * happened.
 */

const reduced = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Nudge an element for `ms`, scaled by `strength` (0..1). */
export function shake(el: HTMLElement | null, strength = 0.5, ms = 320): void {
  if (!el) return;
  if (reduced()) {
    el.classList.add('fx-flash');
    setTimeout(() => el.classList.remove('fx-flash'), ms);
    return;
  }
  el.style.setProperty('--shake', `${(2 + strength * 8).toFixed(1)}px`);
  el.classList.remove('fx-shake');
  // Force a reflow so re-triggering mid-animation restarts it.
  void el.offsetWidth;
  el.classList.add('fx-shake');
  setTimeout(() => el.classList.remove('fx-shake'), ms);
}

export interface BurstOpts {
  count?: number;
  color?: string;
  spread?: number;
  ms?: number;
}

/**
 * A radial spray of motes from the centre of `target`, drawn into `layer`.
 *
 * The particles are plain divs animated by one CSS keyframe reading two custom
 * properties, so there is no rAF loop to keep alive and a backgrounded tab
 * cannot leave half-finished particles wedged on the board.
 */
export function burst(layer: HTMLElement | null, target: HTMLElement | null, opts: BurstOpts = {}): void {
  if (!layer || !target) return;
  const n = Math.max(1, Math.round((opts.count ?? 10) * (reduced() ? 0.3 : 1)));
  const spread = opts.spread ?? 46;
  const ms = opts.ms ?? 620;
  const lr = layer.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  if (tr.width === 0 && tr.height === 0) return;
  const cx = tr.left - lr.left + tr.width / 2;
  const cy = tr.top - lr.top + tr.height / 2;

  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + i * 0.7;
    const d = spread * (0.45 + ((i * 37) % 100) / 100);
    const mote = document.createElement('span');
    mote.className = 'mote';
    mote.style.left = `${cx}px`;
    mote.style.top = `${cy}px`;
    mote.style.setProperty('--dx', `${(Math.cos(a) * d).toFixed(1)}px`);
    mote.style.setProperty('--dy', `${(Math.sin(a) * d).toFixed(1)}px`);
    mote.style.setProperty('--ms', `${ms}ms`);
    if (opts.color) mote.style.background = opts.color;
    layer.appendChild(mote);
    setTimeout(() => mote.remove(), ms + 60);
  }
}

/** Drop every particle currently on the layer — used on teardown. */
export function clearFx(layer: HTMLElement | null): void {
  if (layer) layer.innerHTML = '';
}

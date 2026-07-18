/**
 * layout.test.ts — the phone-layout invariants, as source-level guards.
 *
 * These are RATCHETS, not a substitute for looking. jsdom has no layout engine,
 * so no unit test can see an overflow or an overlap; the only place those
 * surface is a real browser at ~375px, once per mode (principle #20). What this
 * file does is stop a fix from being silently reverted, by pinning the exact CSS
 * decisions that make the biggest board fit.
 *
 * Each assertion below corresponds to a specific way a board game breaks on a
 * phone, and the arithmetic that proves it does not.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MODES, MODE_IDS } from '../src/modes';

const css = readFileSync('src/styles/main.css', 'utf8');
const flat = css.replace(/\s+/g, ' ');

/** The block of rules for a selector, up to the next top-level rule. */
function block(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('the board fits a phone, in every mode', () => {
  it('keeps the biggest board’s cells at or above a 28px hit target at 375px', () => {
    // The arithmetic this file exists to protect. The grid has NO gap and each
    // cell button is the full pitch, so pitch = available width / columns, and
    // the board bleeds back over .main-content's padding on a phone.
    const MAIN_PAD = 12;
    const WRAP_PAD = 2;
    const BLEED = 12;
    const available = 375 - 2 * (MAIN_PAD - BLEED) - 2 * WRAP_PAD;
    for (const id of MODE_IDS) {
      const pitch = available / MODES[id].size;
      expect(
        pitch,
        `${id} (${MODES[id].size} columns) gives ${pitch.toFixed(1)}px cells`,
      ).toBeGreaterThanOrEqual(28);
    }
  });

  it('actually applies that bleed, or the arithmetic above is fiction', () => {
    expect(flat, 'the board must bleed past .main-content padding on a phone').toMatch(
      /@media \(max-width: 480px\) \{ \.board-wrap \{ margin-inline: -12px/,
    );
    expect(block('.main-content')).toMatch(/padding:\s*12px/);
    expect(block('.board-wrap')).toMatch(/padding:\s*2px/);
  });

  it('has NO grid gap — the gap would come straight off the hit target', () => {
    // Cells draw their own inset with padding + background-clip instead, so the
    // visible tile is smaller than the button. Hit size is independent of art
    // size: expand the target, not the tile.
    expect(block('.board')).toMatch(/gap:\s*0\s*;/);
    expect(block('.cell')).toMatch(/padding:\s*1px/);
    expect(block('.cell')).toMatch(/background-clip:\s*content-box/);
  });

  it('sizes the grid from the mode, never from a hardcoded column count', () => {
    // A hardcoded 5 or 11 here is exactly the shape of the Driftlock bug: sized
    // for the default, broken in the mode that reaches the extreme.
    expect(block('.board')).toContain('repeat(var(--n), minmax(0, 1fr))');
    expect(block('.board')).not.toMatch(/repeat\(\s*\d+/);
    const render = readFileSync('src/render.ts', 'utf8');
    expect(render, 'the column count must come from the state').toContain('--n:${state.size}');
  });

  it('uses minmax(0, 1fr) so a column can never refuse to shrink', () => {
    // `1fr` alone floors at min-content, which is how a grid silently overflows.
    expect(block('.board')).toContain('minmax(0, 1fr)');
  });

  it('caps the board by viewport HEIGHT as well as width', () => {
    // Width-only sizing pushes the card tray off the bottom of a short screen
    // and balloons the board on a desktop.
    const b = block('.board');
    expect(b).toMatch(/width:\s*min\(/);
    expect(b).toContain('var(--vh)');
    expect(b).toMatch(/max-height:\s*100%/);
    expect(b).toMatch(/aspect-ratio:\s*1\s*\/\s*1/);
  });

  it('never lets the page scroll sideways', () => {
    const mobile = readFileSync('src/styles/mobile.css', 'utf8').replace(/\s+/g, ' ');
    expect(mobile).toContain('overflow-x: hidden');
    expect(mobile).toContain('max-width: 100%');
  });
});

describe('the hand cannot balloon', () => {
  it('caps a flex-grow card that also has an aspect-ratio', () => {
    // A flex-grow card with an aspect-ratio and no max-width grows to fill the
    // row as its siblings are spent — the last card ends up filling the screen.
    const c = block('.card');
    expect(c).toMatch(/flex:\s*1 1 0/);
    expect(c).toMatch(/max-width:\s*\d+px/);
    expect(c).toMatch(/max-height:\s*\d+px/);
    expect(c).toMatch(/min-width:\s*0/);
  });

  it('centres the hand safely, so a wide hand is never clipped at the start', () => {
    expect(block('.hand')).toContain('safe center');
  });

  it('leaves room for the home indicator under the tray', () => {
    expect(block('.tray')).toContain('env(safe-area-inset-bottom)');
  });
});

describe('nothing invisible can sit on top of the board', () => {
  it('keeps the countdown non-interactive', () => {
    expect(block('.countdown')).toMatch(/pointer-events:\s*none/);
  });

  it('keeps the particle layer non-interactive', () => {
    expect(block('.fx-layer')).toMatch(/pointer-events:\s*none/);
  });

  it('repeats the [hidden] override in the game stylesheet', () => {
    expect(flat).toContain('[hidden] { display: none !important; }');
  });

  it('gives the board its own gestures so a drag never scrolls the page', () => {
    expect(block('.board')).toMatch(/touch-action:\s*none/);
    expect(block('.card')).toMatch(/touch-action:\s*none/);
  });
});

describe('touch targets', () => {
  it('keeps every button at the 44px floor', () => {
    const mobile = readFileSync('src/styles/mobile.css', 'utf8').replace(/\s+/g, ' ');
    expect(mobile).toContain('min-height: 44px');
    expect(mobile).toContain('min-width: 44px');
  });

  it('exempts the board cells deliberately, not by accident', () => {
    // `all: unset` is what lets a cell go below the 44px button floor, which is
    // correct for a 13x13 grid and wrong for anything else.
    expect(block('.cell')).toContain('all: unset');
  });

  it('respects prefers-reduced-motion', () => {
    const mobile = readFileSync('src/styles/mobile.css', 'utf8');
    expect(mobile).toContain('prefers-reduced-motion: reduce');
    const fx = readFileSync('src/fx.ts', 'utf8');
    expect(fx, 'particles and shake must degrade, not just vanish').toContain('prefers-reduced-motion');
  });
});

describe('colour is never the only channel', () => {
  it('gives every seat a distinct glyph as well as a colour', () => {
    const render = readFileSync('src/render.ts', 'utf8');
    const at = render.indexOf('SEAT_GLYPHS');
    const line = render.slice(at, render.indexOf(';', at));
    const glyphs = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(glyphs).toHaveLength(4);
    expect(new Set(glyphs).size, 'two seats share a glyph').toBe(4);
  });

  it('distinguishes a worn hearth by SHAPE, not just a shade', () => {
    // A hearth one freeze from going dark is the single most important thing on
    // the board; it must not rely on a colour difference.
    expect(css).toMatch(/\.cell\.hearth\.worn::after[^}]*box-shadow:\s*inset/);
    expect(css).toMatch(/\.pip\.worn[^}]*box-shadow:\s*inset/);
  });

  it('defines a colour for all four seats', () => {
    for (const p of ['--p0', '--p1', '--p2', '--p3']) expect(css).toContain(`${p}:`);
  });
});

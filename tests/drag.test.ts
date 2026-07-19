/**
 * drag.test.ts — tap must stay a first-class play action.
 *
 * Frostward's cards are dragged onto the board, but a naive "drag on
 * pointerdown" destroys the tap that the whole rest of the UI relies on. The
 * classifier is pure, so the decision can be tested exhaustively without any
 * event timing at all.
 *
 * The thresholds are the verified defaults from patterns/MOBILE_CONTROLS.md.
 */

import { describe, expect, it } from 'vitest';
import { classifyRelease, type GestureThresholds } from '@ben-gy/game-engine/drag';

const T: GestureThresholds = { tapSlop: 3, swipeDist: 50, swipeVel: 0.5, swipeMaxMs: 250 };

describe('classifyRelease', () => {
  it('is a TAP when the press never crossed the drag threshold', () => {
    expect(classifyRelease(0, 0, 100, false, T).kind).toBe('tap');
    // Even a long, far press that never promoted stays a tap.
    expect(classifyRelease(200, 200, 4000, false, T).kind).toBe('tap');
  });

  it('is a TAP when the finger came back to where it started', () => {
    expect(classifyRelease(2, 1, 400, true, T).kind).toBe('tap');
  });

  it('is a DRAG when it moved far but slowly', () => {
    expect(classifyRelease(120, 40, 900, true, T).kind).toBe('drag');
  });

  it('is a SWIPE when it moved far and fast', () => {
    const g = classifyRelease(80, 4, 100, true, T);
    expect(g.kind).toBe('swipe');
    expect(g.kind === 'swipe' && g.dir).toBe('right');
  });

  it('locks a swipe to its dominant axis', () => {
    expect(classifyRelease(-80, 20, 100, true, T)).toMatchObject({ dir: 'left' });
    expect(classifyRelease(10, 80, 100, true, T)).toMatchObject({ dir: 'down' });
    expect(classifyRelease(10, -80, 100, true, T)).toMatchObject({ dir: 'up' });
  });

  it('treats a slow flick as a drag, however far it went', () => {
    expect(classifyRelease(300, 0, 3000, true, T).kind).toBe('drag');
  });

  it('never divides by zero on an instantaneous release', () => {
    expect(() => classifyRelease(60, 0, 0, true, T)).not.toThrow();
    expect(classifyRelease(60, 0, 0, true, T).kind).toBe('swipe');
  });

  it('breaks an exact diagonal toward the horizontal, deterministically', () => {
    expect(classifyRelease(60, 60, 100, true, T)).toMatchObject({ dir: 'right' });
    expect(classifyRelease(-60, -60, 100, true, T)).toMatchObject({ dir: 'left' });
  });

  it('sits exactly on the documented boundaries', () => {
    // tapSlop is inclusive: 3px is still a tap, 3.1px is not.
    expect(classifyRelease(3, 0, 500, true, T).kind).toBe('tap');
    expect(classifyRelease(4, 0, 500, true, T).kind).toBe('drag');
    // swipeMaxMs is exclusive: 249ms can swipe, 250ms cannot.
    expect(classifyRelease(60, 0, 249, true, T).kind).toBe('swipe');
    expect(classifyRelease(60, 0, 250, true, T).kind).toBe('drag');
  });
});

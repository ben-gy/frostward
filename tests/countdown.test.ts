/**
 * countdown.test.ts — 3, 2, 1, BLOW.
 *
 * Timers are injected so this is exact rather than flaky, and so the assertion
 * that it uses a repeating timer (not rAF) is structural: a backgrounded tab
 * pauses rAF, and a countdown that freezes when a player glances at another tab
 * strands the whole room.
 */

import { describe, expect, it, vi } from 'vitest';
import { startCountdown } from '../src/countdown';

/** A hand-cranked clock standing in for setInterval. */
function clock() {
  let fn: (() => void) | null = null;
  let cleared = false;
  return {
    setTimer: (f: () => void) => {
      fn = f;
      return 1;
    },
    clearTimer: () => {
      cleared = true;
    },
    tick(n = 1) {
      for (let i = 0; i < n; i++) fn?.();
    },
    get cleared() {
      return cleared;
    },
  };
}

describe('startCountdown', () => {
  it('beats 3, 2, 1, 0 and then finishes exactly once', () => {
    const c = clock();
    const beats: number[] = [];
    const done = vi.fn();
    startCountdown({ onBeat: (n) => beats.push(n), onDone: done, setTimer: c.setTimer, clearTimer: c.clearTimer });
    expect(beats).toEqual([3]); // the first beat is immediate, not after a delay
    c.tick(3);
    expect(beats).toEqual([3, 2, 1, 0]);
    expect(done).toHaveBeenCalledTimes(1);
    c.tick(5);
    expect(beats).toEqual([3, 2, 1, 0]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('stops its timer the moment it finishes', () => {
    const c = clock();
    startCountdown({ onBeat: () => {}, onDone: () => {}, setTimer: c.setTimer, clearTimer: c.clearTimer });
    c.tick(3);
    expect(c.cleared).toBe(true);
  });

  it('cancels cleanly mid-count and never fires onDone', () => {
    const c = clock();
    const done = vi.fn();
    const cd = startCountdown({ onBeat: () => {}, onDone: done, setTimer: c.setTimer, clearTimer: c.clearTimer });
    c.tick(1);
    cd.cancel();
    expect(c.cleared).toBe(true);
    c.tick(5);
    expect(done).not.toHaveBeenCalled();
    expect(cd.done()).toBe(true);
  });

  it('cancelling after it finished is a no-op, not a double teardown', () => {
    const c = clock();
    const done = vi.fn();
    const cd = startCountdown({ onBeat: () => {}, onDone: done, setTimer: c.setTimer, clearTimer: c.clearTimer });
    c.tick(3);
    cd.cancel();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('honours a custom starting number', () => {
    const c = clock();
    const beats: number[] = [];
    startCountdown({ from: 5, onBeat: (n) => beats.push(n), onDone: () => {}, setTimer: c.setTimer, clearTimer: c.clearTimer });
    c.tick(5);
    expect(beats).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it('runs on real timers too, in step with the beat length', async () => {
    vi.useFakeTimers();
    const beats: number[] = [];
    const done = vi.fn();
    startCountdown({ beatMs: 100, onBeat: (n) => beats.push(n), onDone: done });
    expect(beats).toEqual([3]);
    vi.advanceTimersByTime(250);
    expect(beats).toEqual([3, 2, 1]);
    vi.advanceTimersByTime(100);
    expect(done).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(beats).toEqual([3, 2, 1, 0]);
    vi.useRealTimers();
  });
});

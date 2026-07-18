/**
 * countdown.ts — 3, 2, 1, BLOW before a round begins.
 *
 * A round never begins the instant the board appears. Without this, whoever
 * happens to be looking at their screen gets a free turn of thinking time on a
 * board everyone else has not seen yet — and in a game where the whole opening
 * is reading where the cone will point, that is not a small unfairness.
 *
 * The AUDIO carries it: players watch the grid, not the overlay, so each beat
 * fires a sound whether or not anything is rendering.
 *
 * setInterval, never rAF alone: a backgrounded tab pauses rAF, and a countdown
 * that freezes when you glance at another tab strands the rest of the room.
 * Each peer counts locally from the host's start message — in step to within one
 * network hop, and the turn clock is host-authoritative anyway.
 */

export interface CountdownOpts {
  from?: number;
  beatMs?: number;
  /** Fires per beat. `n` is 3, 2, 1 then 0 for GO. */
  onBeat: (n: number) => void;
  onDone: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface Countdown {
  cancel(): void;
  done(): boolean;
}

export function startCountdown(opts: CountdownOpts): Countdown {
  const from = opts.from ?? 3;
  const beatMs = opts.beatMs ?? 650;
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let n = from;
  let finished = false;
  let handle: unknown = null;

  opts.onBeat(n);

  const stop = (): void => {
    if (handle !== null) clearTimer(handle);
    handle = null;
  };

  handle = setTimer(() => {
    if (finished) return;
    n--;
    opts.onBeat(n);
    if (n <= 0) {
      finished = true;
      stop();
      opts.onDone();
    }
  }, beatMs);

  return {
    cancel() {
      if (finished) return;
      finished = true;
      stop();
    },
    done: () => finished,
  };
}

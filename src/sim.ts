/**
 * sim.ts — headless AI-vs-AI matches, so the balance question is measured and
 * not argued (principle #18).
 *
 * This exists before the tuning did. The point is not "does the game work" —
 * unit tests answer that — it is "is it still a game on turn 4", which no unit
 * test and no ninety seconds of playing it yourself can see.
 *
 * Everything here is deterministic: seeded rng, no Math.random, no clock.
 */

import { botCommit, type BotOpts } from './bot';
import { createState, litCount, resolveTurn, type Rules, type Seat, type State } from './game';
import { makeRng } from '@ben-gy/game-engine/rng';

export interface SimResult {
  seed: number;
  mode: string;
  players: number;
  winners: number[];
  turns: number;
  /** litBySeat after each turn. `history[t][seat]`, t is 0-based. */
  history: number[][];
  finalLit: number[];
  /** The winner never lost a single hearth. */
  untouched: boolean;
  state: State;
}

export interface MatchOpts extends BotOpts {
  rules?: Partial<Rules>;
}

export function playMatch(seed: number, mode: string, players: number, opts: MatchOpts = {}): SimResult {
  const seats: Seat[] = Array.from({ length: players }, (_, i) => ({ name: `P${i + 1}`, isBot: true }));
  const s = createState(seed, mode, seats, opts.rules);
  const rngs = seats.map((_, i) => makeRng(`${seed}:bot:${i}`));
  const history: number[][] = [];

  let guard = 0;
  while (!s.over && guard++ < 500) {
    const commits = s.players.map((p) => (p.out === null ? botCommit(s, p.seat, rngs[p.seat], opts) : null));
    resolveTurn(s, commits);
    history.push(s.players.map(litCount));
  }

  const finalLit = s.players.map(litCount);
  const untouched =
    s.winners.length === 1 && finalLit[s.winners[0]] === s.players[s.winners[0]].hearths.length;

  return {
    seed,
    mode,
    players,
    winners: s.winners.slice(),
    turns: history.length,
    history,
    finalLit,
    untouched,
    state: s,
  };
}

/**
 * Who was ahead after turn `n`, or null if it was tied.
 *
 * Returning null for a tie is load-bearing. On Hexbloom a plausible-looking
 * measurement "proved" the trailer out-earned the leader purely because tied
 * positions were being counted as behind. A tie is not a lead.
 */
export function leaderAfter(r: SimResult, n: number): number | null {
  const row = r.history[n - 1];
  if (!row) return null;
  const best = Math.max(...row);
  const at = row.map((v, i) => (v === best ? i : -1)).filter((i) => i >= 0);
  return at.length === 1 ? at[0] : null;
}

export interface Curve {
  turn: number;
  /** Games where somebody was uniquely ahead at this turn. */
  samples: number;
  /** Of those, the fraction where that player went on to win. */
  holds: number;
}

/** P(the player leading at turn N eventually wins), sampled across the match. */
export function leaderCurve(results: SimResult[], turns: number[]): Curve[] {
  return turns.map((turn) => {
    let samples = 0;
    let wins = 0;
    for (const r of results) {
      const leader = leaderAfter(r, turn);
      if (leader === null) continue;
      samples++;
      if (r.winners.includes(leader)) wins++;
    }
    return { turn, samples, holds: samples ? wins / samples : 0 };
  });
}

/**
 * Fraction of matches where SOMEBODY is already uniquely ahead by turn `n`.
 *
 * This turned out to be the most useful single number in the whole tuning pass,
 * and much more stable than P(leader wins) that early — because when the game is
 * healthy there is barely a sample to compute P over. It reads directly as "how
 * often is this already somebody's game on turn 4".
 */
export function decidedBy(results: SimResult[], n: number): number {
  const early = results.filter((r) => leaderAfter(r, n) !== null).length;
  return results.length ? early / results.length : 0;
}

/** Fraction of matches each seat won. Ties count as a shared win. */
export function seatWinRates(results: SimResult[], players: number): number[] {
  const wins = new Array(players).fill(0);
  for (const r of results) for (const w of r.winners) wins[w] += 1 / r.winners.length;
  return wins.map((w) => w / results.length);
}

export function runSuite(
  mode: string,
  players: number,
  count: number,
  opts: MatchOpts = {},
  seedBase = 1000,
): SimResult[] {
  const out: SimResult[] = [];
  for (let i = 0; i < count; i++) out.push(playMatch(seedBase + i, mode, players, opts));
  return out;
}

export function median(values: number[]): number {
  const a = values.slice().sort((x, y) => x - y);
  return a.length ? a[(a.length / 2) | 0] : 0;
}

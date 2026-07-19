/**
 * bot.test.ts — the opponent, and the referee.
 *
 * The bot fills solo seats, plays out a peer who has gone quiet, and drives
 * every game in tests/balance.test.ts. So a bot that quietly plays badly does
 * not just make a weak opponent — it invalidates the balance measurements that
 * the whole design was tuned against.
 *
 * The load-bearing assertion is the first one: whatever it returns must be LEGAL
 * against the board it was shown. It caught a real defect — a turn-one hand of
 * three Thaws scored no candidate (nothing is worth melting yet), and the
 * fallback returned a nonsense target that burned the card for nothing.
 */

import { describe, expect, it } from 'vitest';
import { botCommit } from '../src/bot';
import {
  createState,
  legalTarget,
  resolveTurn,
  type Commit,
  type Seat,
  type State,
} from '../src/game';
import { makeRng } from '@ben-gy/game-engine/rng';
import { MODE_IDS } from '../src/modes';

const seats = (n: number): Seat[] =>
  Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}`, isBot: true }));

/** Assert a commit is legal against `s` for `seat`, and say why if it is not. */
function expectLegal(s: State, seat: number, c: Commit): void {
  const hand = s.players[seat].hand;
  expect(Number.isInteger(c.card), `seat ${seat} card ${c.card}`).toBe(true);
  expect(c.card).toBeGreaterThanOrEqual(0);
  expect(c.card).toBeLessThan(hand.length);
  const kind = hand[c.card];
  if (kind === 'veer') {
    expect([1, -1], `seat ${seat} veer dir ${c.dir}`).toContain(c.dir);
    return;
  }
  expect(
    legalTarget(s, kind, c.cell ?? -1),
    `turn ${s.turn} seat ${seat} played ${kind} at ${c.cell}, which is illegal`,
  ).toBe(true);
}

describe('botCommit', () => {
  it('always returns a play that is LEGAL against the board it was shown', () => {
    for (const mode of MODE_IDS) {
      for (const players of [2, 3, 4]) {
        const s = createState(9001, mode, seats(players));
        const rngs = s.players.map((_, i) => makeRng(`bot:${i}`));
        let guard = 0;
        while (!s.over && guard++ < 200) {
          const commits = s.players.map((p, i) => (p.out === null ? botCommit(s, i, rngs[i]) : null));
          commits.forEach((c, i) => c && expectLegal(s, i, c));
          resolveTurn(s, commits);
        }
        expect(s.over).toBe(true);
      }
    }
  });

  it('finds a legal play on turn one even from an all-Thaw hand', () => {
    // The exact shape of the defect: nothing is near enough to a hearth to be
    // worth melting yet, so no Thaw candidate scores and the fallback runs.
    const s = createState(4, 'drift', seats(2));
    s.players[0].hand = ['thaw', 'thaw', 'thaw'];
    const c = botCommit(s, 0, makeRng(1));
    expectLegal(s, 0, c);
    expect(s.players[0].hand[c.card]).toBe('thaw');
  });

  it('finds a legal play from an all-Ridge hand', () => {
    const s = createState(4, 'drift', seats(2));
    s.players[0].hand = ['ridge', 'ridge', 'ridge'];
    expectLegal(s, 0, botCommit(s, 0, makeRng(1)));
  });

  it('finds a legal play from an all-Ember hand', () => {
    const s = createState(4, 'drift', seats(2));
    s.players[0].hand = ['ember', 'ember', 'ember'];
    expectLegal(s, 0, botCommit(s, 0, makeRng(1)));
  });

  it('is deterministic — the same board and stream give the same play', () => {
    const s = createState(77, 'drift', seats(3));
    expect(botCommit(s, 1, makeRng(5))).toEqual(botCommit(s, 1, makeRng(5)));
  });

  it('burns a card only rarely, and only to contention', () => {
    // A wasted card IS legal here: commits are simultaneous, so two players can
    // target the same cell and the seeded resolution order decides who gets it.
    // What must not happen is bots burning cards routinely.
    let wasted = 0;
    let played = 0;
    for (const mode of MODE_IDS) {
      const s = createState(313, mode, seats(4));
      const rngs = s.players.map((_, i) => makeRng(`bot:${i}`));
      let guard = 0;
      while (!s.over && guard++ < 200) {
        resolveTurn(
          s,
          s.players.map((p, i) => (p.out === null ? botCommit(s, i, rngs[i]) : null)),
        );
      }
      for (const p of s.players) {
        wasted += p.stats.wasted;
        played += p.stats.veer + p.stats.ridge + p.stats.thaw + p.stats.ember + p.stats.wasted;
      }
    }
    expect(played).toBeGreaterThan(100);
    expect(wasted / played, `bots burned ${wasted} of ${played} cards`).toBeLessThan(0.08);
  });

  it('defends: it walls or melts when its hearth is about to be taken', () => {
    // A bot that ignores an imminent snuff would make the balance sim measure a
    // game nobody is actually playing.
    const s = createState(1212, 'drift', seats(2));
    const me = s.players[0];
    // Bury the hearth in frost so the next step reaches it.
    const cell = me.hearths[0];
    const N = s.size;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1]]) {
      const x = (cell % N) + dx;
      const y = ((cell / N) | 0) + dy;
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const n = y * N + x;
      if (s.hearthAt[n] < 0) s.cells[n] = 1;
    }
    me.hand = ['ridge', 'thaw', 'veer'];
    const c = botCommit(s, 0, makeRng(2));
    const kind = me.hand[c.card];
    expect(['ridge', 'thaw', 'veer']).toContain(kind);
    if (kind !== 'veer') {
      // Whatever it did, it did it near the hearth it is losing.
      const d = Math.max(
        Math.abs((c.cell! % N) - (cell % N)),
        Math.abs(((c.cell! / N) | 0) - ((cell / N) | 0)),
      );
      expect(d, 'the bot defended somewhere else entirely').toBeLessThanOrEqual(3);
    }
  });
});

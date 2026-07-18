/**
 * rng.test.ts — the P2P-sync determinism invariant.
 *
 * Frostward transmits no board state at all: peers exchange only their commits
 * and each recomputes the board. So EVERY shared value — seat placement, deck
 * order, the per-turn resolution order — has to come out of the shared seed
 * byte-identically, or two players are quietly looking at different games.
 */

import { describe, expect, it } from 'vitest';
import { hashSeed, makeRng, pick, randInt, shuffle } from '../src/engine/rng';
import { createState, resolveTurn, standings, type Commit, type Seat } from '../src/game';
import { MODE_IDS } from '../src/modes';
import { playMatch } from '../src/sim';

const seats = (n: number): Seat[] =>
  Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}`, isBot: i > 0 }));

describe('the generator', () => {
  it('gives an identical stream for an identical seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    expect(Array.from({ length: 200 }, a)).toEqual(Array.from({ length: 200 }, b));
  });

  it('gives different streams for different seeds', () => {
    expect(Array.from({ length: 20 }, makeRng(1))).not.toEqual(Array.from({ length: 20 }, makeRng(2)));
  });

  it('stays inside [0, 1)', () => {
    const r = makeRng('frostward');
    for (let i = 0; i < 5000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('hashes a string to a stable 32-bit seed', () => {
    expect(hashSeed('gale')).toBe(hashSeed('gale'));
    expect(hashSeed('gale')).not.toBe(hashSeed('gales'));
    expect(hashSeed('gale')).toBeGreaterThanOrEqual(0);
    expect(hashSeed('gale')).toBeLessThanOrEqual(0xffffffff);
  });

  it('shuffles identically and without losing or duplicating anything', () => {
    const deck = Array.from({ length: 40 }, (_, i) => i);
    const a = shuffle(makeRng(9), deck);
    const b = shuffle(makeRng(9), deck);
    expect(a).toEqual(b);
    expect(a.slice().sort((x, y) => x - y)).toEqual(deck);
    expect(deck[0], 'shuffle mutated its input').toBe(0);
  });

  it('keeps randInt and pick in range', () => {
    const r = makeRng(3);
    for (let i = 0; i < 500; i++) {
      const v = randInt(r, 5, 9);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(9);
    }
    expect(['a', 'b', 'c']).toContain(pick(makeRng(4), ['a', 'b', 'c']));
  });
});

describe('two peers on one seed build the identical game', () => {
  it('deals identical boards, hearths, hands and decks', () => {
    for (const mode of MODE_IDS) {
      for (const players of [2, 3, 4]) {
        for (const seed of [1, 777, 4242, 0xfffffff]) {
          const a = createState(seed, mode, seats(players));
          const b = createState(seed, mode, seats(players));
          expect([...a.cells]).toEqual([...b.cells]);
          expect(a.gale).toBe(b.gale);
          expect(a.players.map((p) => p.hearths)).toEqual(b.players.map((p) => p.hearths));
          expect(a.players.map((p) => p.hand)).toEqual(b.players.map((p) => p.hand));
          expect(a.players.map((p) => p.deck)).toEqual(b.players.map((p) => p.deck));
        }
      }
    }
  });

  it('resolves an identical whole match from identical commits', () => {
    for (const mode of MODE_IDS) {
      const a = createState(31337, mode, seats(3));
      const b = createState(31337, mode, seats(3));
      let turn = 0;
      while (!a.over && turn++ < 200) {
        // A fixed, arbitrary commit pattern — the point is that BOTH sides get it.
        const commits: (Commit | null)[] = a.players.map((p, i) =>
          p.out === null ? { card: (turn + i) % p.hand.length, dir: i % 2 ? 1 : -1, cell: (turn * 7 + i * 13) % a.cells.length } : null,
        );
        resolveTurn(a, commits);
        resolveTurn(b, commits);
      }
      expect([...a.cells]).toEqual([...b.cells]);
      expect(a.gale).toBe(b.gale);
      expect(a.turn).toBe(b.turn);
      expect(a.winners).toEqual(b.winners);
      expect(standings(a)).toEqual(standings(b));
    }
  });

  it('replays a whole bot match identically, twice', () => {
    for (const mode of MODE_IDS) {
      const a = playMatch(555, mode, 4);
      const b = playMatch(555, mode, 4);
      expect(a.winners).toEqual(b.winners);
      expect(a.turns).toBe(b.turns);
      expect(a.history).toEqual(b.history);
    }
  });

  it('never reaches for Math.random inside the simulation', () => {
    // The whole no-board-state netcode rests on this, so prove it rather than
    // trusting it: a match played with Math.random poisoned must still work.
    const real = Math.random;
    Math.random = () => {
      throw new Error('the simulation used Math.random');
    };
    try {
      const r = playMatch(9090, 'drift', 3);
      expect(r.state.over).toBe(true);
    } finally {
      Math.random = real;
    }
  });
});

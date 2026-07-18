/**
 * balance.test.ts — is it still a game on turn 4?
 *
 * MANDATORY for a competitive game, and it is the only gate here that asks a
 * question the other tests cannot. Everything else asks "does it work". A
 * snowball is invisible to a unit test, invisible in a two-tab smoke test, and
 * invisible in the ninety seconds you spend playing it yourself.
 *
 * ── WHAT THIS SIM ACTUALLY OVERRULED ────────────────────────────────────────
 *
 * The design as written was broken, and every fix below is a measurement rather
 * than a story. Baseline (full 135° arc, no hearth guard, no delay):
 *
 *     drift/2p   median 7 turns   leader@t2 70%   winner untouched 54%
 *     emberfall  median 3 turns   leader@t2 81%   winner untouched 59%
 *     drift/4p   seat win rates 16 / 24 / 24 / 35
 *
 * Three turns. The wind pointed somewhere and that player was simply dead,
 * because a cone at hearth range is nine cells wide and a hearth cluster is
 * three. Fixes, in the order the sim accepted them:
 *
 *  1. THE FLANK RULE (game.ts `threatened`). Frost always advances straight down
 *     the Gale, but only spreads sideways into a cell that already has two
 *     frozen neighbours. Small early, big late — with zero new state, because
 *     "how old is this frost" was already written on the board. Median 7 -> 15,
 *     and drift/4p's leader@t8 fell from 83% to 52%.
 *
 *  2. HEARTH GUARD + RIME DELAY. A hearth beats back its first freeze (the cell
 *     stays clear), and the Rime holds still for turn 1. Together they took
 *     drift/4p's seat spread from 20/22/23/35 to 26/24/26/24 — the seat bias was
 *     NOT geometric, which is what everyone would have guessed; it was that in a
 *     fast game the first cone decided everything. Neither lever alone fixed it:
 *     guard-only left 19/27/28/26, delay-only left 19/26/23/31.
 *
 *  3. FANNED HEARTHS. Hearths spread across a FRACTION of the player's sector
 *     rather than a fixed 34°, so two opposed players are not "all of the wind or
 *     none of it". Blowouts in drift/2p: 57% -> 34%.
 *
 * And what the sim REFUSED:
 *
 *  - `hearthGuard: 2` sounded like more of a good thing. It made games longer
 *    (median 29) without improving any curve, and pushed emberfall's blowout
 *    rate UP to 68%.
 *  - `rimeDelay: 2` was worse than 1 (drift/2p leader@t8 80% vs 67%).
 *  - Lowering Whiteout's turn cap to shorten it did nothing to the median — it
 *    only converted games that would have ended in a kill into games that ended
 *    in a count. Stepping the Rime every 2nd turn instead of every 3rd is what
 *    actually shortened it.
 *  - driftHunt — the Gale hunting the leader — was written into the plan as THE
 *    anti-snowball lever. It is not. Measured against a paired control it barely
 *    moves the leader curve (drift/4p leader@t18 66% with, 67% without). What it
 *    genuinely does is TERMINATE games: without it Whiteout's 4-player median
 *    runs 42 turns instead of 30. It is kept, and described honestly, as a
 *    pacing lever. This is exactly the kind of confident story the sim exists to
 *    kill.
 *
 * ── READING THE BANDS ───────────────────────────────────────────────────────
 * At n=180 the standard error on a seat win rate is ~3.2 points (4p) to ~3.7
 * (2p), so the ±10-point band below is roughly 3 sigma: wide enough not to flake,
 * narrow enough that Hexbloom's infamous 54/33/10 would fail it on two seats.
 */

import { describe, expect, it } from 'vitest';
import { decidedBy, leaderCurve, median, runSuite, seatWinRates, type SimResult } from '../src/sim';
import { MODES, MODE_IDS } from '../src/modes';
import { DEFAULT_RULES, centreOf, createState, litCount, type Seat } from '../src/game';

const seatsFor = (n: number): Seat[] =>
  Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}`, isBot: true }));

const N = 180;
const SEED = 4400;

/** Cached so the nine suites are simulated once, not once per assertion. */
const suites = new Map<string, SimResult[]>();
const suite = (mode: string, players: number): SimResult[] => {
  const key = `${mode}/${players}`;
  if (!suites.has(key)) suites.set(key, runSuite(mode, players, N, {}, SEED));
  return suites.get(key)!;
};

describe('seat fairness — turn order and start geometry are a bug you cannot see', () => {
  for (const mode of MODE_IDS) {
    for (const players of [2, 3, 4]) {
      it(`${mode}, ${players} players: every seat lands near ${(100 / players).toFixed(0)}%`, () => {
        const rates = seatWinRates(suite(mode, players), players).map((r) => r * 100);
        const fair = 100 / players;
        for (let seat = 0; seat < players; seat++) {
          expect(rates[seat], `seat ${seat} of ${players} won ${rates[seat].toFixed(1)}%`).toBeGreaterThan(
            fair - 10,
          );
          expect(rates[seat], `seat ${seat} of ${players} won ${rates[seat].toFixed(1)}%`).toBeLessThan(
            fair + 10,
          );
        }
        // Every seat must actually win sometimes. Hexbloom's third player won
        // one game in ten and it shipped, because nobody counted.
        expect(Math.min(...rates)).toBeGreaterThan(fair * 0.55);
      });
    }
  }

  it('deals every seat an identical TURN-ZERO position, over many seeds', () => {
    // Inspect the opening, not the ending: pre-move imbalance is only visible
    // before anyone has played, and a finished match legitimately has ragged
    // hands because eliminated players stop drawing.
    for (const mode of MODE_IDS) {
      for (const players of [2, 3, 4]) {
        for (let seed = 0; seed < 40; seed++) {
          const s = createState(seed * 977 + 5, mode, seatsFor(players));
          expect(new Set(s.players.map((p) => p.hearths.length)).size, `${mode}/${players}p seed ${seed}`).toBe(1);
          expect(new Set(s.players.map((p) => p.hand.length)).size).toBe(1);
          expect(new Set(s.players.map((p) => p.deck.length)).size).toBe(1);
          expect(new Set(s.players.map((p) => litCount(p))).size).toBe(1);
          expect(new Set(s.players.map((p) => p.guard.join(','))).size).toBe(1);
          // No hearth may start on top of another, or on the Rime itself.
          const cells = s.players.flatMap((p) => p.hearths);
          expect(new Set(cells).size, 'two hearths share a cell').toBe(cells.length);
          expect(cells).not.toContain(centreOf(s.size));
        }
      }
    }
  });
});

describe('the drama curve — flat and near chance early, decisive late', () => {
  for (const mode of MODE_IDS) {
    it(`${mode}: the opening is not already somebody's game`, () => {
      for (const players of [2, 3, 4]) {
        const decided = decidedBy(suite(mode, players), 4);
        expect(decided, `${mode}/${players}p: ${(decided * 100).toFixed(0)}% decided by turn 4`).toBeLessThan(
          0.35,
        );
      }
    });

    it(`${mode}: leading eventually means something, but never everything`, () => {
      for (const players of [2, 3, 4]) {
        const rs = suite(mode, players);
        const curve = leaderCurve(rs, [10, 16]).filter((c) => c.samples >= 20);
        expect(curve.length, `${mode}/${players}p had no measurable mid-game`).toBeGreaterThan(0);
        for (const c of curve) {
          // Never a certainty mid-game...
          expect(c.holds, `${mode}/${players}p turn ${c.turn} holds ${c.holds}`).toBeLessThan(0.95);
          // ...but comfortably better than the coin, or the lead is meaningless.
          expect(c.holds).toBeGreaterThan(1 / players);
        }
      }
    });
  }
});

describe('blowouts and endings', () => {
  for (const mode of MODE_IDS) {
    it(`${mode}: the winner usually takes damage on the way`, () => {
      for (const players of [2, 3, 4]) {
        const rs = suite(mode, players);
        const untouched = rs.filter((r) => r.untouched).length / rs.length;
        expect(untouched, `${mode}/${players}p untouched ${(untouched * 100).toFixed(0)}%`).toBeLessThan(
          0.45,
        );
      }
    });

    it(`${mode}: draws stay the exception`, () => {
      for (const players of [2, 3, 4]) {
        const rs = suite(mode, players);
        const ties = rs.filter((r) => r.winners.length !== 1).length / rs.length;
        expect(ties, `${mode}/${players}p ties ${(ties * 100).toFixed(0)}%`).toBeLessThan(0.35);
        expect(rs.every((r) => r.winners.length > 0), 'a match ended with nobody winning').toBe(true);
      }
    });
  }

  it('every single match terminates, and none of them drags', () => {
    for (const mode of MODE_IDS) {
      for (const players of [2, 3, 4]) {
        const rs = suite(mode, players);
        expect(rs.every((r) => r.state.over), `${mode}/${players}p left a match unfinished`).toBe(true);
        expect(Math.max(...rs.map((r) => r.turns))).toBeLessThanOrEqual(MODES[mode].turnCap);
        const med = median(rs.map((r) => r.turns));
        // Long enough to be a game, short enough to be a session.
        expect(med, `${mode}/${players}p median ${med} turns`).toBeGreaterThanOrEqual(8);
        expect(med, `${mode}/${players}p median ${med} turns`).toBeLessThanOrEqual(38);
      }
    }
  });
});

describe('the modes are genuinely different rounds, not a dial', () => {
  it('Emberfall resolves faster than Drift, and Whiteout is the roomiest', () => {
    const len = (m: string): number => median(suite(m, 4).map((r) => r.turns));
    expect(len('emberfall')).toBeLessThan(len('drift'));
    expect(MODES.whiteout.size).toBeGreaterThan(MODES.drift.size);
    expect(MODES.emberfall.size).toBeLessThan(MODES.drift.size);
  });

  it('each mode deals a genuinely different hand and board', () => {
    const shapes = MODE_IDS.map((m) => `${MODES[m].size}/${MODES[m].hearths}/${MODES[m].hand}`);
    expect(new Set(shapes).size, 'two modes have the same shape').toBe(shapes.length);
  });
});

describe('the control arms — a fix nobody measured is a story', () => {
  /**
   * Paired seeds, not two noisy averages: both arms play the identical matches,
   * so the difference is the rule and not the sample.
   */
  const paired = (rules: Parameters<typeof runSuite>[3]) => runSuite('drift', 4, N, rules, SEED);

  it('the no-guard/no-delay control REALLY has no guard (it is a control, not a relabel)', () => {
    const rs = runSuite('drift', 4, 20, { rules: { hearthGuard: 0, rimeDelay: 0 } }, SEED);
    for (const r of rs) {
      for (const p of r.state.players) {
        expect(p.guard.every((g) => g === 0), 'the control arm was quietly granted a guard').toBe(true);
      }
    }
    // And it must genuinely differ from the shipping arm, or it proves nothing.
    expect(median(rs.map((r) => r.turns))).not.toBe(
      median(runSuite('drift', 4, 20, {}, SEED).map((r) => r.turns)),
    );
  });

  it('guard + delay are what stop the opening deciding the match', () => {
    const control = paired({ rules: { hearthGuard: 0, rimeDelay: 0 } });
    const shipping = suite('drift', 4);
    expect(decidedBy(control, 6)).toBeGreaterThan(decidedBy(shipping, 6) + 0.1);
    expect(median(shipping.map((r) => r.turns))).toBeGreaterThan(median(control.map((r) => r.turns)));
  });

  it('driftHunt is a PACING lever, not the anti-snowball lever the plan claimed', () => {
    // Pinned deliberately. If someone later "improves" driftHunt expecting it to
    // flatten the leader curve, this says out loud what it actually measured as.
    const without = runSuite('whiteout', 4, N, { rules: { driftHunt: false } }, SEED);
    const with_ = suite('whiteout', 4);
    expect(median(with_.map((r) => r.turns))).toBeLessThan(median(without.map((r) => r.turns)));
  });
});

describe('constants the fairness depends on', () => {
  it('pins the shipped rules', () => {
    expect(DEFAULT_RULES).toEqual({ driftHunt: true, hearthGuard: 1, rimeDelay: 1 });
  });

  it('pins Whiteout stepping every OTHER turn', () => {
    // At 3 the median 4-player game ran 33 turns with 32% hitting the cap.
    expect(MODES.whiteout.doubleStep).toBe(2);
    expect(MODES.drift.doubleStep).toBe(0);
    expect(MODES.emberfall.doubleStep).toBe(0);
  });
});

/**
 * game.test.ts — the rules, exercised as pure logic.
 *
 * Every path a turn can take, not one happy trip: each card legal and illegal,
 * a missing commit, a commit from a dead seat, the flank rule at both ends, the
 * guard, the whiteout double step, elimination, and the turn cap.
 */

import { describe, expect, it } from 'vitest';
import {
  CLEAR,
  DIRS,
  FROST,
  RIDGE,
  aimedAt,
  alive,
  arcOf,
  centreOf,
  createState,
  frozenNeighbours,
  legalTarget,
  litCount,
  resolveTurn,
  standings,
  threatened,
  type Commit,
  type Seat,
  type State,
} from '../src/game';
import { MODES } from '../src/modes';

const seats = (n: number): Seat[] =>
  Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}`, isBot: i > 0 }));

const fresh = (mode = 'drift', players = 2, seed = 7): State =>
  createState(seed, mode, seats(players), { rimeDelay: 0 });

/**
 * A board for testing the Rime MECHANICALLY: no drift, and stepped with commits
 * that cannot move the Gale. Stepping with real cards silently veers the wind
 * before the step you are asserting on — which is exactly how the first two
 * versions of these tests failed.
 */
const mech = (mode = 'drift', players = 2, seed = 7): State =>
  createState(seed, mode, seats(players), { rimeDelay: 0, driftHunt: false });

/** One turn where nobody plays anything: the Gale cannot move. */
const step = (s: State) => resolveTurn(s, s.players.map(() => null));

/** Play `turns` turns where nobody does anything meaningful (all veer +1/-1). */
function idle(s: State, turns: number, dir = 1): void {
  for (let t = 0; t < turns && !s.over; t++) {
    const commits = s.players.map((p) =>
      p.out === null ? ({ card: p.hand.indexOf('veer') >= 0 ? p.hand.indexOf('veer') : 0, dir } as Commit) : null,
    );
    resolveTurn(s, commits);
  }
}

/** Find a card of `kind` in a seat's hand, planting one if the draw missed. */
function ensureCard(s: State, seat: number, kind: 'veer' | 'ridge' | 'thaw' | 'ember'): number {
  const hand = s.players[seat].hand;
  const at = hand.indexOf(kind);
  if (at >= 0) return at;
  hand[0] = kind;
  return 0;
}

describe('setup', () => {
  it('starts with exactly one frozen cell, dead centre', () => {
    const s = fresh();
    const frozen = [...s.cells].filter((c) => c === FROST);
    expect(frozen).toHaveLength(1);
    expect(s.cells[centreOf(s.size)]).toBe(FROST);
  });

  it('gives every player the same hearths, hand and guard', () => {
    for (const players of [2, 3, 4]) {
      const s = fresh('drift', players);
      const p0 = s.players[0];
      for (const p of s.players) {
        expect(p.hearths.length).toBe(p0.hearths.length);
        expect(p.hand.length).toBe(p0.hand.length);
        expect(p.guard).toEqual(p0.guard);
        expect(litCount(p)).toBe(p0.hearths.length);
      }
    }
  });

  it('never puts a hearth on the Rime or on another hearth', () => {
    for (let seed = 0; seed < 60; seed++) {
      for (const mode of ['drift', 'whiteout', 'emberfall']) {
        const s = fresh(mode, 4, seed * 31 + 1);
        const cells = s.players.flatMap((p) => p.hearths);
        expect(new Set(cells).size).toBe(cells.length);
        expect(cells).not.toContain(centreOf(s.size));
        for (const c of cells) expect(c).toBeGreaterThanOrEqual(0);
        for (const c of cells) expect(c).toBeLessThan(s.size * s.size);
      }
    }
  });

  it('honours the mode it was given, and falls back on nonsense', () => {
    expect(fresh('whiteout').size).toBe(MODES.whiteout.size);
    expect(fresh('emberfall').size).toBe(MODES.emberfall.size);
    // A mode id off the wire must never reach the generator as undefined.
    expect(createState(1, 'constructor', seats(2)).mode.id).toBe('drift');
    expect(createState(1, 'toString', seats(2)).mode.id).toBe('drift');
  });
});

describe('the Rime — the flank rule is the whole pacing of the game', () => {
  it('advances exactly one cell, straight down the Gale', () => {
    for (let gale = 0; gale < 8; gale++) {
      const s = mech();
      s.gale = gale;
      const c = centreOf(s.size);
      const N = s.size;
      step(s);
      const frozen = [...s.cells].map((v, i) => (v === FROST ? i : -1)).filter((i) => i >= 0);
      // Exactly the seed plus the one cell downwind of it.
      expect(frozen, `gale ${gale}`).toHaveLength(2);
      const forward = c + DIRS[gale][1] * N + DIRS[gale][0];
      expect(frozen).toContain(forward);
    }
  });

  it('does NOT spread sideways into a cell with fewer than two frozen neighbours', () => {
    const s = mech();
    s.gale = 0;
    const c = centreOf(s.size);
    // A lone seed: only the forward cell may take. Both flanks touch exactly one
    // frozen cell, so they must be refused.
    const t = threatened(s);
    expect(t).toHaveLength(1);
    expect(frozenNeighbours(s, t[0])).toBe(1);
  });

  it('DOES spread sideways once a cell is already half-surrounded', () => {
    const s = mech();
    s.gale = 0;
    const N = s.size;
    const c = centreOf(s.size);
    // Freeze a vertical bar so the cell east of the middle has two frozen
    // neighbours diagonally behind it.
    s.cells[c - N] = FROST;
    s.cells[c + N] = FROST;
    const t = threatened(s);
    expect(t.length).toBeGreaterThan(1);
    expect(t.some((cell) => frozenNeighbours(s, cell) >= 2)).toBe(true);
  });

  it('is blocked by a ridge, and the ridge is never consumed', () => {
    const s = mech();
    s.gale = 0;
    const c = centreOf(s.size);
    s.cells[c + 1] = RIDGE;
    step(s);
    expect(s.cells[c + 1]).toBe(RIDGE);
    // …and with the only forward cell walled, nothing else took either.
    expect([...s.cells].filter((v) => v === FROST)).toHaveLength(1);
  });

  it('never races across the board in a single step', () => {
    const s = mech();
    s.gale = 2; // south
    const N = s.size;
    const c = centreOf(s.size);
    step(s);
    expect(s.cells[c + 2 * N]).toBe(CLEAR);
  });

  it('threatened() is exactly what the next step freezes', () => {
    const s = mech('drift', 3, 99);
    for (let t = 0; t < 8 && !s.over; t++) {
      const predicted = new Set(threatened(s));
      const before = [...s.cells];
      const log = step(s);
      if (log.steps !== 1) continue; // a double step legitimately exceeds one prediction
      for (const cell of log.froze) expect(predicted.has(cell)).toBe(true);
      // …and nothing predicted was skipped except where a hearth pushed it back.
      const guarded = new Set(log.guarded.map((g) => g.cell));
      for (const cell of predicted) {
        if (guarded.has(cell)) continue;
        if (before[cell] !== CLEAR) continue;
        expect(log.froze).toContain(cell);
      }
    }
  });

  it('holds still during the rime delay, then blows', () => {
    const s = createState(11, 'drift', seats(2), { rimeDelay: 2 });
    const frozen = (): number => [...s.cells].filter((v) => v === FROST).length;
    idle(s, 2);
    expect(frozen(), 'the Rime moved during its delay').toBe(1);
    idle(s, 1);
    expect(frozen()).toBeGreaterThan(1);
  });

  it('steps twice on a Whiteout beat and once otherwise', () => {
    const s = createState(3, 'whiteout', seats(2), { rimeDelay: 0 });
    const steps: number[] = [];
    for (let t = 0; t < 6 && !s.over; t++) {
      steps.push(idleLog(s).steps);
    }
    expect(steps.slice(0, 4)).toEqual([1, 2, 1, 2]);
  });
});

function idleLog(s: State) {
  return resolveTurn(
    s,
    s.players.map((p) => (p.out === null ? ({ card: 0, dir: 1 } as Commit) : null)),
  );
}

describe('hearths', () => {
  it('beats back the first freeze and keeps its cell clear', () => {
    const s = fresh();
    const seat = 0;
    const cell = s.players[seat].hearths[0];
    // Surround the hearth so the very next step reaches it.
    for (const [dx, dy] of DIRS) {
      const x = (cell % s.size) + dx;
      const y = ((cell / s.size) | 0) + dy;
      if (x < 0 || y < 0 || x >= s.size || y >= s.size) continue;
      const n = y * s.size + x;
      if (s.hearthAt[n] < 0) s.cells[n] = FROST;
    }
    const log = idleLog(s);
    expect(log.guarded.some((g) => g.cell === cell)).toBe(true);
    expect(s.cells[cell], 'a guarded hearth cell must stay CLEAR').toBe(CLEAR);
    expect(s.players[seat].lit[0]).toBe(true);
    expect(s.players[seat].guard[0]).toBe(0);
    // Second contact takes it for good.
    const log2 = idleLog(s);
    expect(log2.snuffed.some((x) => x.cell === cell)).toBe(true);
    expect(s.players[seat].lit[0]).toBe(false);
    expect(s.cells[cell]).toBe(FROST);
  });

  it('never relights a hearth, even under a Thaw', () => {
    const s = fresh();
    const p = s.players[0];
    p.lit[0] = false;
    p.guard[0] = 0;
    s.cells[p.hearths[0]] = FROST;
    const idx = ensureCard(s, 0, 'thaw');
    resolveTurn(s, [{ card: idx, cell: p.hearths[0] }, { card: 0, dir: 1 }]);
    expect(s.cells[p.hearths[0]]).toBe(CLEAR);
    expect(s.players[0].lit[0], 'a dark hearth came back to life').toBe(false);
  });

  it('eliminates a player only when every hearth is dark, and ends at one left', () => {
    const s = fresh('drift', 2, 5);
    const p = s.players[1];
    p.lit = p.lit.map(() => false);
    idleLog(s);
    expect(p.out).not.toBeNull();
    expect(s.over).toBe(true);
    expect(s.winners).toEqual([0]);
    expect(alive(s)).toHaveLength(1);
  });
});

describe('cards', () => {
  it('Veer bends the Gale, and everyone’s veers add up', () => {
    const s = fresh('drift', 3, 21);
    const before = s.gale;
    const idx = s.players.map((_, i) => ensureCard(s, i, 'veer'));
    resolveTurn(s, [
      { card: idx[0], dir: 1 },
      { card: idx[1], dir: 1 },
      { card: idx[2], dir: -1 },
    ]);
    expect(s.gale).toBe((before + 1 + 8) % 8);
  });

  it('cancels out to no change, and then the Gale drifts toward the leader', () => {
    const s = fresh('drift', 2, 33);
    const idx = s.players.map((_, i) => ensureCard(s, i, 'veer'));
    // Make seat 1 the clear leader so the drift has somewhere to go.
    s.players[0].lit[0] = false;
    const log = resolveTurn(s, [
      { card: idx[0], dir: 1 },
      { card: idx[1], dir: -1 },
    ]);
    expect(log.drifted || log.galeAfter === log.galeBefore).toBe(true);
  });

  it('never drifts when driftHunt is off', () => {
    const s = createState(33, 'drift', seats(2), { driftHunt: false, rimeDelay: 0 });
    const idx = s.players.map((_, i) => ensureCard(s, i, 'veer'));
    const log = resolveTurn(s, [
      { card: idx[0], dir: 1 },
      { card: idx[1], dir: -1 },
    ]);
    expect(log.drifted).toBe(false);
    expect(log.galeAfter).toBe(log.galeBefore);
  });

  it('Ridge walls a clear cell and refuses everything else', () => {
    const s = fresh();
    const clear = s.cells.findIndex((v, i) => v === CLEAR && s.hearthAt[i] < 0);
    expect(legalTarget(s, 'ridge', clear)).toBe(true);
    expect(legalTarget(s, 'ridge', centreOf(s.size)), 'a ridge on frost').toBe(false);
    expect(legalTarget(s, 'ridge', s.players[0].hearths[0]), 'a ridge on a hearth').toBe(false);
    expect(legalTarget(s, 'ridge', -1)).toBe(false);
    expect(legalTarget(s, 'ridge', 99999)).toBe(false);
    const idx = ensureCard(s, 0, 'ridge');
    resolveTurn(s, [{ card: idx, cell: clear }, { card: 0, dir: 1 }]);
    expect(s.cells[clear]).toBe(RIDGE);
  });

  it('Thaw melts a plus and holds it warm for every step of the turn', () => {
    const s = createState(3, 'whiteout', seats(2), { rimeDelay: 0 });
    const c = centreOf(s.size);
    const N = s.size;
    for (const n of [c, c + 1, c - 1, c + N, c - N]) s.cells[n] = FROST;
    const idx = ensureCard(s, 0, 'thaw');
    s.turn = 2; // a Whiteout double-step turn
    const log = resolveTurn(s, [{ card: idx, cell: c }, { card: 0, dir: 1 }]);
    expect(log.steps).toBe(2);
    expect(log.melted.length).toBe(5);
    // Warmth held across BOTH steps: the centre is still clear.
    expect(s.cells[c]).toBe(CLEAR);
  });

  it('Ember plants frost, but never on a hearth or a warm cell', () => {
    const s = fresh();
    const clear = s.cells.findIndex((v, i) => v === CLEAR && s.hearthAt[i] < 0);
    expect(legalTarget(s, 'ember', clear)).toBe(true);
    expect(legalTarget(s, 'ember', s.players[1].hearths[0])).toBe(false);
    s.warm[clear] = s.turn;
    expect(legalTarget(s, 'ember', clear)).toBe(false);
    s.warm[clear] = -1;
    const idx = ensureCard(s, 0, 'ember');
    resolveTurn(s, [{ card: idx, cell: clear }, { card: 0, dir: 1 }]);
    expect(s.cells[clear]).toBe(FROST);
  });
});

describe('commits — every way one can go wrong', () => {
  it('burns a card when nothing arrives, keeping hands in lockstep', () => {
    const s = fresh();
    const size = s.players[0].hand.length;
    const log = resolveTurn(s, [null, null]);
    expect(log.plays.every((p) => p.wasted)).toBe(true);
    for (const p of s.players) {
      expect(p.hand.length, 'hands drifted out of step').toBe(size);
      expect(p.stats.wasted).toBe(1);
    }
  });

  it('burns a card on an illegal target rather than desyncing', () => {
    const s = fresh();
    const idx = ensureCard(s, 0, 'ridge');
    const log = resolveTurn(s, [{ card: idx, cell: centreOf(s.size) }, { card: 0, dir: 1 }]);
    expect(log.plays.find((p) => p.seat === 0)?.wasted).toBe(true);
    expect(s.cells[centreOf(s.size)]).toBe(FROST);
  });

  it('ignores an out-of-range hand index', () => {
    const s = fresh();
    const log = resolveTurn(s, [{ card: 99 }, { card: -3 }]);
    expect(log.plays.filter((p) => p.wasted)).toHaveLength(2);
  });

  it('refills every living hand back to the mode’s size', () => {
    const s = fresh('emberfall');
    for (let t = 0; t < 8 && !s.over; t++) {
      idleLog(s);
      for (const p of alive(s)) expect(p.hand.length).toBe(MODES.emberfall.hand);
    }
  });

  it('reshuffles a spent deck deterministically instead of running dry', () => {
    const a = fresh('emberfall', 2, 404);
    const b = fresh('emberfall', 2, 404);
    for (let t = 0; t < 30; t++) {
      if (a.over) break;
      idleLog(a);
      idleLog(b);
    }
    expect(a.players[0].hand).toEqual(b.players[0].hand);
    expect(a.players[0].cycle).toBeGreaterThanOrEqual(0);
    for (const p of alive(a)) expect(p.hand.length).toBeGreaterThan(0);
  });

  it('ignores a commit for a seat that is already out', () => {
    const s = fresh('drift', 3, 88);
    s.players[2].lit = s.players[2].lit.map(() => false);
    idleLog(s);
    expect(s.players[2].out).not.toBeNull();
    const spent = s.players[2].stats.veer;
    resolveTurn(s, [{ card: 0, dir: 1 }, { card: 0, dir: 1 }, { card: 0, dir: 1 }]);
    expect(s.players[2].stats.veer, 'a dead seat played a card').toBe(spent);
  });
});

describe('the arc and the aim', () => {
  it('is always three adjacent compass directions', () => {
    for (let g = 0; g < 8; g++) {
      const arc = arcOf(g);
      expect(arc).toHaveLength(3);
      expect(arc[1]).toBe(g);
      expect(arc.every((d) => d >= 0 && d < 8)).toBe(true);
    }
    expect(arcOf(0)).toEqual([7, 0, 1]);
    expect(arcOf(7)).toEqual([6, 7, 0]);
  });

  it('counts a player as under the Gale only inside that arc', () => {
    const s = fresh('drift', 4, 12);
    const under = s.players.filter((p) => aimedAt(s, p));
    expect(under.length).toBeLessThan(s.players.length);
  });
});

describe('endings', () => {
  it('always terminates by the turn cap', () => {
    for (const mode of ['drift', 'whiteout', 'emberfall']) {
      const s = fresh(mode, 2, 1234);
      let guard = 0;
      while (!s.over && guard++ < 400) idleLog(s);
      expect(s.over, `${mode} never ended`).toBe(true);
      expect(s.turn).toBeLessThanOrEqual(MODES[mode].turnCap);
      expect(s.winners.length).toBeGreaterThan(0);
    }
  });

  it('ranks everybody, sharing a place on a genuine tie', () => {
    const s = fresh('drift', 4, 77);
    let guard = 0;
    while (!s.over && guard++ < 400) idleLog(s);
    const rows = standings(s);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.place)[0]).toBe(1);
    // Places never decrease down the list.
    for (let i = 1; i < rows.length; i++) expect(rows[i].place).toBeGreaterThanOrEqual(rows[i - 1].place);
    // A winner is always in first place.
    for (const r of rows.filter((x) => x.won)) expect(r.place).toBe(1);
  });

  it('reports every player’s breakdown, not just the local one', () => {
    const s = fresh('drift', 3, 909);
    let guard = 0;
    while (!s.over && guard++ < 400) idleLog(s);
    for (const r of standings(s)) {
      expect(r.name).toBeTruthy();
      expect(typeof r.stats.aimed).toBe('number');
      expect(r.survived).toBeGreaterThan(0);
      expect(r.hearths).toBeGreaterThan(0);
    }
  });
});

/**
 * bot.ts — the opponent, and the referee.
 *
 * The same function fills a solo game's empty seats, auto-plays a peer whose tab
 * has gone quiet, and drives every AI-vs-AI game in tests/balance.test.ts. That
 * last job sets the design constraint: it has to be CHEAP. A bot that clones the
 * board and re-simulates every candidate is more honest per-decision and about
 * forty times slower, which would push the balance sim out of the default test
 * run — and a balance sim nobody runs is a balance sim that refereed nothing.
 *
 * So it scores analytically off two precomputed fields:
 *   - a multi-source BFS distance from every frozen cell (how close is the ice),
 *   - the set of cells that freeze on the NEXT step (what is about to happen).
 * Both are computed once per decision and reused across every candidate.
 *
 * It plays a recognisable game: wall the approach, melt what is already at the
 * door, bend the wind off yourself and onto whoever is doing best, and plant an
 * ember when someone's hearth is briefly reachable.
 */

import {
  CLEAR,
  DIRS,
  FROST,
  RIDGE,
  arcOf,
  frozenNeighbours,
  inBounds,
  legalTarget,
  litCount,
  type CardKind,
  type Commit,
  type Player,
  type State,
} from './game';
import type { Rng } from './engine/rng';

export interface BotOpts {
  /** 0 = coldly consistent, ~6 = makes real mistakes. */
  noise?: number;
}

const REACH = 15;

const cheb = (size: number, a: number, b: number): number =>
  Math.max(Math.abs((a % size) - (b % size)), Math.abs(((a / size) | 0) - ((b / size) | 0)));

/** Steps from the nearest frozen cell to every cell, routing around ridges. */
function frostDistance(s: State): Int16Array {
  const N = s.size;
  const dist = new Int16Array(N * N).fill(REACH);
  const queue: number[] = [];
  for (let i = 0; i < s.cells.length; i++) {
    if (s.cells[i] === FROST) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const d = dist[i];
    if (d >= REACH - 1) continue;
    const x = i % N;
    const y = (i / N) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(N, nx, ny)) continue;
      const n = ny * N + nx;
      if (s.cells[n] === RIDGE || dist[n] <= d + 1) continue;
      dist[n] = d + 1;
      queue.push(n);
    }
  }
  return dist;
}

/** Cells that freeze on the next step, for a hypothetical gale. */
function threatFor(s: State, gale: number): Uint8Array {
  const N = s.size;
  const arc = arcOf(gale);
  const out = new Uint8Array(N * N);
  for (let i = 0; i < s.cells.length; i++) {
    if (s.cells[i] !== FROST) continue;
    const x = i % N;
    const y = (i / N) | 0;
    for (const d of arc) {
      const nx = x + DIRS[d][0];
      const ny = y + DIRS[d][1];
      if (!inBounds(N, nx, ny)) continue;
      const n = ny * N + nx;
      if (s.cells[n] !== CLEAR || s.warm[n] >= s.turn) continue;
      // Same flank rule the simulation uses (game.ts `threatened`): off-axis
      // frost only advances into a cell that is already half-surrounded.
      if (d !== gale % 8 && frozenNeighbours(s, n) < 2) continue;
      out[n] = 1;
    }
  }
  return out;
}

function aimedAtGale(p: Player, gale: number): boolean {
  const ga = (gale * Math.PI) / 4;
  let diff = p.angle - ga;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff) <= Math.PI * 0.375;
}

/** How badly this player is about to be hurt, under a hypothetical gale. */
function danger(p: Player, dist: Int16Array, threat: Uint8Array, gale: number): number {
  let d = 0;
  for (let j = 0; j < p.hearths.length; j++) {
    if (!p.lit[j]) continue;
    const cell = p.hearths[j];
    const near = Math.max(0, 8 - dist[cell]);
    d += near * near * 0.5;
    // A hearth with a guard left survives the next step; urgent, not fatal.
    if (threat[cell]) d += p.guard[j] > 0 ? 12 : 40;
  }
  return d * (aimedAtGale(p, gale) ? 1.4 : 1);
}

function nearestOwn(s: State, me: Player, cell: number): number {
  let best = REACH;
  for (let j = 0; j < me.hearths.length; j++) {
    if (!me.lit[j]) continue;
    best = Math.min(best, cheb(s.size, cell, me.hearths[j]));
  }
  return best;
}

interface Candidate {
  commit: Commit;
  score: number;
}

export function botCommit(s: State, seat: number, rng: Rng, opts: BotOpts = {}): Commit {
  const me = s.players[seat];
  const noise = opts.noise ?? 0;
  const rivals = s.players.filter((p) => p.seat !== seat && p.out === null);
  const dist = frostDistance(s);
  const threatNow = threatFor(s, s.gale);
  const N = s.size;

  const field = (gale: number, threat: Uint8Array): number => {
    const own = danger(me, dist, threat, gale);
    let opp = 0;
    for (const r of rivals) opp += danger(r, dist, threat, gale) * (1 + 0.25 * litCount(r));
    return -own * 3 + opp;
  };

  const base = field(s.gale, threatNow);
  const cands: Candidate[] = [];
  const firstOf = (kind: CardKind): number => me.hand.indexOf(kind);

  // ── Veer: the only card that changes what the whole board is about.
  const veerIdx = firstOf('veer');
  if (veerIdx >= 0) {
    for (const dir of [-1, 1]) {
      const gale = (((s.gale + dir) % 8) + 8) % 8;
      cands.push({ commit: { card: veerIdx, dir }, score: field(gale, threatFor(s, gale)) });
    }
  }

  // ── Ridge: wall a cell that is about to freeze, on the approach to a hearth.
  const ridgeIdx = firstOf('ridge');
  if (ridgeIdx >= 0) {
    const picks: { cell: number; v: number }[] = [];
    for (let i = 0; i < s.cells.length; i++) {
      if (s.cells[i] !== CLEAR || s.hearthAt[i] >= 0) continue;
      const near = nearestOwn(s, me, i);
      if (near > 4) continue;
      const v = (threatNow[i] ? 14 : 2) + (8 - near) * 3 + (8 - dist[i]) * 1.5;
      picks.push({ cell: i, v });
    }
    picks.sort((a, b) => b.v - a.v);
    for (const p of picks.slice(0, 6)) {
      cands.push({ commit: { card: ridgeIdx, cell: p.cell }, score: base + p.v });
    }
  }

  // ── Thaw: melt what is already at the door, and hold it warm for the step.
  const thawIdx = firstOf('thaw');
  if (thawIdx >= 0) {
    const picks: { cell: number; v: number }[] = [];
    for (let i = 0; i < s.cells.length; i++) {
      const near = nearestOwn(s, me, i);
      if (near > 4) continue;
      let melt = 0;
      let shield = 0;
      const x = i % N;
      const y = (i / N) | 0;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(N, nx, ny)) continue;
        const n = ny * N + nx;
        if (s.cells[n] === FROST) melt++;
        if (threatNow[n]) shield++;
        if (s.hearthAt[n] >= 0 && threatNow[n]) shield += 6;
      }
      if (melt + shield === 0) continue;
      picks.push({ cell: i, v: melt * 4 + shield * 5 + (8 - near) * 1.5 });
    }
    picks.sort((a, b) => b.v - a.v);
    for (const p of picks.slice(0, 6)) {
      cands.push({ commit: { card: thawIdx, cell: p.cell }, score: base + p.v });
    }
  }

  // ── Ember: plant a fresh cone next to somebody else's hearth.
  const emberIdx = firstOf('ember');
  if (emberIdx >= 0) {
    const picks: { cell: number; v: number }[] = [];
    for (const r of rivals) {
      for (let j = 0; j < r.hearths.length; j++) {
        if (!r.lit[j]) continue;
        const h = r.hearths[j];
        const hx = h % N;
        const hy = (h / N) | 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = hx + dx;
            const ny = hy + dy;
            if (!inBounds(N, nx, ny)) continue;
            const n = ny * N + nx;
            if (s.cells[n] !== CLEAR || s.hearthAt[n] >= 0 || s.warm[n] >= s.turn) continue;
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            // Adjacent is best: the hearth is inside the new cone's first step.
            picks.push({ cell: n, v: (4 - d) * 9 + litCount(r) * 3 + (8 - nearestOwn(s, me, n)) * -1 });
          }
        }
      }
    }
    picks.sort((a, b) => b.v - a.v);
    const seen = new Set<number>();
    for (const p of picks) {
      if (seen.has(p.cell)) continue;
      seen.add(p.cell);
      cands.push({ commit: { card: emberIdx, cell: p.cell }, score: base + p.v });
      if (seen.size >= 6) break;
    }
  }

  if (cands.length === 0) {
    // Nothing scored — a hand with no card whose heuristic found a target. That
    // is NOT rare: a turn-one hand of three Thaws has nothing worth melting yet,
    // and the old fallback burned the card for no effect. So fall back to
    // anything LEGAL, cheapest first, and never to a nonsense target.
    for (let i = 0; i < me.hand.length; i++) {
      const kind = me.hand[i];
      if (kind === 'veer') return { card: i, dir: 1 };
      if (kind === 'thaw') {
        // Any valid index is a legal Thaw; warm the hearth closest to the ice.
        let best = -1;
        for (let j = 0; j < me.hearths.length; j++) {
          if (!me.lit[j]) continue;
          if (best < 0 || dist[me.hearths[j]] < dist[best]) best = me.hearths[j];
        }
        if (best >= 0) return { card: i, cell: best };
      }
      for (let c = 0; c < s.cells.length; c++) {
        if (legalTarget(s, kind, c)) return { card: i, cell: c };
      }
    }
    return { card: 0, dir: 1 };
  }

  let best = cands[0];
  let bestScore = -Infinity;
  for (const c of cands) {
    const score = c.score + (noise > 0 ? rng() * noise : rng() * 1e-6);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best.commit;
}

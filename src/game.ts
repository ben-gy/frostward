// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * game.ts — the whole of Frostward's rules, as a pure deterministic simulation.
 *
 * Nothing in here touches the DOM, the clock, or Math.random. A round is a pure
 * function of (seed, mode, roster, every commit so far) — which is why the P2P
 * layer only ever ships COMMITS: every peer recomputes a byte-identical board,
 * and a host transfer is a no-op state-wise because the promoted peer already
 * holds the same state it would have inherited.
 *
 * The rule, in one line: the Rime spreads only into the Gale's forward arc, so
 * it grows as a cone that sweeps as the wind swings.
 */

import { makeRng, shuffle, type Rng } from '@ben-gy/game-engine/rng';
import { modeOf, type Mode } from './modes';

// ── cells ───────────────────────────────────────────────────────────────────

export const CLEAR = 0;
export const FROST = 1;
export const RIDGE = 2;

/**
 * Eight compass directions in SCREEN coordinates (y grows downward), starting at
 * east and going clockwise, so `d * PI/4` is the direction's angle under the
 * same atan2(dy, dx) the seat placement uses. Keeping one angle convention is
 * what lets the drift rule compare a gale to a seat without a sign bug.
 */
export const DIRS: readonly (readonly [number, number])[] = [
  [1, 0], // 0 E
  [1, 1], // 1 SE
  [0, 1], // 2 S
  [-1, 1], // 3 SW
  [-1, 0], // 4 W
  [-1, -1], // 5 NW
  [0, -1], // 6 N
  [1, -1], // 7 NE
];

export const DIR_NAMES = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] as const;

// ── cards ───────────────────────────────────────────────────────────────────

export type CardKind = 'veer' | 'ridge' | 'thaw' | 'ember';

export const CARD_INFO: Record<CardKind, { name: string; glyph: string; help: string }> = {
  veer: { name: 'Veer', glyph: '↻', help: 'Bend the Gale 45°. Everyone’s veers this turn add up.' },
  ridge: { name: 'Ridge', glyph: '▣', help: 'Raise a wall on a clear cell. Frost cannot enter it.' },
  thaw: { name: 'Thaw', glyph: '✳', help: 'Melt a plus-shaped patch. It cannot refreeze this turn.' },
  ember: { name: 'Ember', glyph: '✦', help: 'Freeze one clear cell anywhere. A new cone, wherever you like.' },
};

/** What a player committed for a turn. `cell` is a board index; `dir` is ±1. */
export interface Commit {
  /** Index into the player's hand. */
  card: number;
  /** Veer only: -1 (anticlockwise) or +1 (clockwise). */
  dir?: number;
  /** Ridge / Thaw / Ember only: the target cell index. */
  cell?: number;
}

// ── state ───────────────────────────────────────────────────────────────────

export interface PlayerStats {
  veer: number;
  ridge: number;
  thaw: number;
  ember: number;
  /** Commits that were missing or illegal — the card burned for nothing. */
  wasted: number;
  /** Hearths snuffed. */
  lost: number;
  /** Turns the Gale's forward arc was pointing into this player's sector. */
  aimed: number;
}

export interface Player {
  seat: number;
  name: string;
  isBot: boolean;
  /** Cell index of each hearth. Fixed for the round. */
  hearths: number[];
  /** Parallel to `hearths`. A snuffed hearth never relights. */
  lit: boolean[];
  /** Parallel to `hearths`. Freezes this hearth can still beat back. */
  guard: number[];
  hand: CardKind[];
  deck: CardKind[];
  /** How many times the deck has been reshuffled — seeds the next shuffle. */
  cycle: number;
  /** Turn this player was eliminated, or null while still in. */
  out: number | null;
  /** Angle from the board centre to this player's hearth cluster. */
  angle: number;
  stats: PlayerStats;
}

export interface SnuffEvent {
  seat: number;
  cell: number;
}

export interface PlayEvent {
  seat: number;
  card: CardKind;
  dir?: number;
  cell?: number;
  /** The commit was missing or illegal; the card burned with no effect. */
  wasted?: boolean;
}

export interface TurnLog {
  turn: number;
  galeBefore: number;
  galeAfter: number;
  /** The Gale drifted toward the leader because nobody bent it. */
  drifted: boolean;
  plays: PlayEvent[];
  ridged: number[];
  melted: number[];
  embers: number[];
  froze: number[];
  snuffed: SnuffEvent[];
  /** Hearths that beat the frost back this turn, burning a guard. */
  guarded: SnuffEvent[];
  eliminated: number[];
  /** Rime steps this turn — 2 on a whiteout. */
  steps: number;
}

/**
 * Rule levers the balance sim is allowed to switch off, so a "fix" can be
 * MEASURED against a genuine control arm rather than argued for. A control arm
 * that is silently granted the mechanic back is not a control arm — the sim
 * asserts each of these actually changes the numbers.
 */
export interface Rules {
  /** The Gale hunts the leader when nobody bends it. A PACING lever — see below. */
  driftHunt: boolean;
  /**
   * How many freezes a hearth beats back before it goes dark. 1 = every hearth
   * survives its first contact with the Rime, and the cell it stands on stays
   * clear — the frost is pushed off, not absorbed.
   */
  hearthGuard: number;
  /** Turns before the Rime takes its first step. The opening negotiation. */
  rimeDelay: number;
}

export const DEFAULT_RULES: Rules = { driftHunt: true, hearthGuard: 1, rimeDelay: 1 };

export interface State {
  mode: Mode;
  rules: Rules;
  seed: number;
  size: number;
  cells: Uint8Array;
  /** Cell resists freezing while `warm[i] >= turn`. Set by Thaw. */
  warm: Int32Array;
  /** Cell -> seat*100 + hearthIndex, or -1. */
  hearthAt: Int32Array;
  gale: number;
  /** 1-based. The turn currently being committed to. */
  turn: number;
  players: Player[];
  over: boolean;
  /** Seats that won. More than one only on a genuine tie. */
  winners: number[];
  log: TurnLog[];
}

// ── setup ───────────────────────────────────────────────────────────────────

export interface Seat {
  name: string;
  isBot: boolean;
}

function buildDeck(mode: Mode, rng: Rng): CardKind[] {
  const flat: CardKind[] = [];
  for (const [kind, n] of Object.entries(mode.deck) as [CardKind, number][]) {
    for (let i = 0; i < n; i++) flat.push(kind);
  }
  return shuffle(rng, flat);
}

/**
 * Place a player's hearths on a circle at `angle`, then nudge deterministically
 * if a rounded position collides with something already placed.
 *
 * Seats sit at `2πk/P + θ(seed)` with θ SEED-RANDOM. That is the whole of the
 * seat-fairness story: a square lattice is not perfectly P-fold symmetric for
 * P = 3, so instead of pretending it is, the residual asymmetry is decoupled
 * from the seat index. Averaged over seeds every seat gets the same board.
 * tests/balance.test.ts measures that rather than trusting it.
 */
function placeHearths(
  s: State,
  angle: number,
  count: number,
  players: number,
  taken: Set<number>,
): number[] {
  const N = s.size;
  const c = (N - 1) / 2;
  const r = 0.4 * (N - 1);
  // Hearths fan across a fixed FRACTION of the player's own sector, so with two
  // players they sit 38° apart and with four they sit 19° apart. A fixed gap
  // made two-player a coin toss: opposed seats are 180° apart, a tight cluster
  // fits inside one cone, and the wind was either entirely on you or entirely
  // off you. Fanning them means a cone position is a gradient, not a verdict.
  const sector = (2 * Math.PI) / players;
  const spread = (sector * 0.42) / Math.max(1, count - 1);
  const out: number[] = [];
  for (let j = 0; j < count; j++) {
    const a = angle + (j - (count - 1) / 2) * spread;
    let x = Math.round(c + r * Math.cos(a));
    let y = Math.round(c + r * Math.sin(a));
    x = Math.max(0, Math.min(N - 1, x));
    y = Math.max(0, Math.min(N - 1, y));
    let idx = y * N + x;
    if (taken.has(idx)) {
      // Deterministic spiral outward through a fixed offset order.
      let found = -1;
      for (let ring = 1; ring <= N && found < 0; ring++) {
        for (const d of DIRS) {
          const nx = x + d[0] * ring;
          const ny = y + d[1] * ring;
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const ni = ny * N + nx;
          if (!taken.has(ni) && ni !== centreOf(N)) {
            found = ni;
            break;
          }
        }
      }
      idx = found >= 0 ? found : idx;
    }
    taken.add(idx);
    out.push(idx);
  }
  return out;
}

export function centreOf(size: number): number {
  const c = (size - 1) / 2;
  return c * size + c;
}

export function createState(seed: number, modeId: string, seats: Seat[], rules?: Partial<Rules>): State {
  const mode = modeOf(modeId);
  const N = mode.size;
  const board = makeRng(`${seed}:board`);
  const theta = board() * Math.PI * 2;

  const s: State = {
    mode,
    rules: { ...DEFAULT_RULES, ...rules },
    seed,
    size: N,
    cells: new Uint8Array(N * N),
    warm: new Int32Array(N * N).fill(-1),
    hearthAt: new Int32Array(N * N).fill(-1),
    gale: Math.floor(board() * 8) % 8,
    turn: 1,
    players: [],
    over: false,
    winners: [],
    log: [],
  };

  const taken = new Set<number>([centreOf(N)]);
  for (let k = 0; k < seats.length; k++) {
    const angle = theta + (2 * Math.PI * k) / seats.length;
    const hearths = placeHearths(s, angle, mode.hearths, seats.length, taken);
    const deckRng = makeRng(`${seed}:deck:${k}:0`);
    const deck = buildDeck(mode, deckRng);
    const hand: CardKind[] = [];
    for (let i = 0; i < mode.hand; i++) hand.push(deck.pop()!);
    s.players.push({
      seat: k,
      name: seats[k].name,
      isBot: seats[k].isBot,
      hearths,
      lit: hearths.map(() => true),
      guard: hearths.map(() => s.rules.hearthGuard),
      hand,
      deck,
      cycle: 0,
      out: null,
      angle,
      stats: { veer: 0, ridge: 0, thaw: 0, ember: 0, wasted: 0, lost: 0, aimed: 0 },
    });
    for (let j = 0; j < hearths.length; j++) s.hearthAt[hearths[j]] = k * 100 + j;
  }

  // The Rime starts as a single frozen cell at the exact centre.
  s.cells[centreOf(N)] = FROST;
  return s;
}

// ── queries ─────────────────────────────────────────────────────────────────

export const litCount = (p: Player): number => p.lit.filter(Boolean).length;

export const alive = (s: State): Player[] => s.players.filter((p) => p.out === null);

export function inBounds(size: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < size && y < size;
}

/** The three directions the Rime can spread in, for a given gale. */
export function arcOf(gale: number): number[] {
  return [(gale + 7) % 8, gale % 8, (gale + 1) % 8];
}

/** How many of a cell's eight neighbours are already frozen. */
export function frozenNeighbours(s: State, cell: number): number {
  const N = s.size;
  const x = cell % N;
  const y = (cell / N) | 0;
  let n = 0;
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (inBounds(N, nx, ny) && s.cells[ny * N + nx] === FROST) n++;
  }
  return n;
}

/**
 * Which cells freeze on the next step — the single source of truth for both the
 * simulation and the threat glow, so what the board warns you about is exactly
 * what happens.
 *
 * THE SHAPE OF THE RIME, and the reason the game has a middle:
 *
 * Straight down the Gale, frost always advances. On the two FLANKS of the arc it
 * only advances into a cell that already has two frozen neighbours. So the Rime
 * moves as a narrow point and fills in behind itself: young frost is a finger one
 * ridge can stop, old frost is a wall you cannot.
 *
 * The first build spread the full 135° arc unconditionally, and the balance sim
 * killed it flat: a cone at hearth range was nine cells wide against a three-cell
 * hearth cluster, so whoever the wind found lost EVERYTHING in one step. Median
 * game 3-10 turns; whoever led on turn 2 won 70-81% of the time; the winner
 * finished untouched in over half of all games. That is a slot machine, not a
 * board game. The fix is the shape principle that keeps working: make the early
 * game small and the late game big — and here it costs no new state at all,
 * because "how old is this frost" is already written on the board as "how many
 * of my neighbours are frozen".
 */
export function threatened(s: State): number[] {
  const out: number[] = [];
  const seen = new Uint8Array(s.cells.length);
  const N = s.size;
  const gale = s.gale % 8;
  const arc = arcOf(s.gale);
  for (let i = 0; i < s.cells.length; i++) {
    if (s.cells[i] !== FROST) continue;
    const x = i % N;
    const y = (i / N) | 0;
    for (const d of arc) {
      const nx = x + DIRS[d][0];
      const ny = y + DIRS[d][1];
      if (!inBounds(N, nx, ny)) continue;
      const n = ny * N + nx;
      if (s.cells[n] !== CLEAR || s.warm[n] >= s.turn || seen[n]) continue;
      if (d !== gale && frozenNeighbours(s, n) < 2) continue;
      seen[n] = 1;
      out.push(n);
    }
  }
  return out;
}

/**
 * True when the Gale's forward arc covers any of this player's hearths.
 *
 * Measured against the HEARTHS, not the seat's centre angle. Hearths fan across
 * a fraction of the sector, so a centre-angle test reported "0 turns under the
 * Gale" for a player who had just watched the cone eat the outer hearth of their
 * own fan — a summary line that flatly contradicted what they saw happen.
 */
export function aimedAt(s: State, p: Player): boolean {
  const c = (s.size - 1) / 2;
  const ga = (s.gale * Math.PI) / 4;
  for (const cell of p.hearths) {
    const dx = (cell % s.size) - c;
    const dy = ((cell / s.size) | 0) - c;
    let diff = Math.atan2(dy, dx) - ga;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) <= Math.PI * 0.375) return true; // the 3-direction arc, 67.5°
  }
  return false;
}

export function legalTarget(s: State, kind: CardKind, cell: number): boolean {
  if (!Number.isInteger(cell) || cell < 0 || cell >= s.cells.length) return false;
  if (kind === 'ridge') return s.cells[cell] === CLEAR && s.hearthAt[cell] < 0;
  if (kind === 'thaw') return true; // any cell; the plus does whatever it can
  if (kind === 'ember') {
    return s.cells[cell] === CLEAR && s.hearthAt[cell] < 0 && s.warm[cell] < s.turn;
  }
  return false;
}

// ── the turn ────────────────────────────────────────────────────────────────

/**
 * The Rime reaches `cell`. Returns whether the cell actually freezes.
 *
 * A lit hearth with guard left BEATS THE FROST BACK — it burns a guard and the
 * cell stays clear. That one rule is what turns "the wind found you" from a
 * verdict into a warning: you get a turn to wall, melt or veer before the second
 * pass takes the hearth for good.
 */
function hitCell(s: State, cell: number, log: TurnLog): boolean {
  const h = s.hearthAt[cell];
  if (h < 0) return true;
  const seat = (h / 100) | 0;
  const idx = h % 100;
  const p = s.players[seat];
  if (!p.lit[idx]) return true; // already dark; it is just a cell now
  if (p.guard[idx] > 0) {
    p.guard[idx]--;
    log.guarded.push({ seat, cell });
    return false;
  }
  p.lit[idx] = false;
  p.stats.lost++;
  log.snuffed.push({ seat, cell });
  return true;
}

function rimeStep(s: State, log: TurnLog): void {
  // threatened() reads s.cells and never writes, so the front advances exactly
  // one cell per step rather than racing across the board — and the glow the
  // player was shown is, by construction, the step they actually get.
  for (const n of threatened(s)) {
    if (!hitCell(s, n, log)) continue; // a hearth pushed it back
    s.cells[n] = FROST;
    log.froze.push(n);
  }
}

/**
 * Nobody bent the wind, so it hunts the warmth: the Gale turns one step toward
 * whoever still holds the most lit hearths.
 *
 * It was designed as the anti-snowball lever. IT IS NOT — tests/balance.test.ts
 * measured it against a paired control and the leader curve barely moves
 * (Drift 4p, leading at turn 18 wins 66% with it and 67% without). What it
 * genuinely does is TERMINATE games: without it Whiteout's 4-player median runs
 * 42 turns instead of 30, because two players veering against each other forever
 * pins the cone and nothing resolves. So it is kept as a pacing lever, and the
 * test pins that description so nobody re-derives the original story.
 *
 * It is a pure function of the visible board — no hidden state, nothing to sync.
 */
function driftTowardLeader(s: State): boolean {
  const live = alive(s);
  if (live.length < 2) return false;
  const best = Math.max(...live.map(litCount));
  const leaders = live.filter((p) => litCount(p) === best);
  const ga = (s.gale * Math.PI) / 4;
  const delta = (p: Player): number => {
    let d = p.angle - ga;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  };
  // Nearest in angle first, then lowest seat — angle-nearest keeps the tiebreak
  // seat-neutral, because θ is seed-random.
  let target = leaders[0];
  for (const p of leaders) {
    const a = Math.abs(delta(p));
    const b = Math.abs(delta(target));
    if (a < b - 1e-9 || (Math.abs(a - b) < 1e-9 && p.seat < target.seat)) target = p;
  }
  const d = delta(target);
  if (Math.abs(d) < Math.PI / 8) return false; // already pointing there
  s.gale = (s.gale + (d > 0 ? 1 : -1) + 8) % 8;
  return true;
}

function drawUp(s: State, p: Player): void {
  while (p.hand.length < s.mode.hand) {
    if (p.deck.length === 0) {
      p.cycle++;
      p.deck = buildDeck(s.mode, makeRng(`${s.seed}:deck:${p.seat}:${p.cycle}`));
    }
    p.hand.push(p.deck.pop()!);
  }
}

function applyThaw(s: State, cell: number, log: TurnLog): void {
  const N = s.size;
  const x = cell % N;
  const y = (cell / N) | 0;
  const plus = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dx, dy] of plus) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(N, nx, ny)) continue;
    const n = ny * N + nx;
    if (s.cells[n] === RIDGE) continue;
    if (s.cells[n] === FROST) {
      s.cells[n] = CLEAR;
      log.melted.push(n);
    }
    // Warmth holds through EVERY Rime step this turn, which is exactly why Thaw
    // is worth more in Whiteout than the raw melt count suggests.
    s.warm[n] = s.turn;
  }
}

/**
 * Resolve one whole turn: apply every commit, bend the Gale, step the Rime,
 * snuff hearths, eliminate, redraw. Mutates `s` and returns what happened so the
 * renderer can animate it and the summary can report it.
 *
 * `commits[i]` is seat i's commit, or null if it never arrived (the card burns).
 */
export function resolveTurn(s: State, commits: (Commit | null)[]): TurnLog {
  const log: TurnLog = {
    turn: s.turn,
    galeBefore: s.gale,
    galeAfter: s.gale,
    drifted: false,
    plays: [],
    ridged: [],
    melted: [],
    embers: [],
    froze: [],
    snuffed: [],
    guarded: [],
    eliminated: [],
    steps: 1,
  };
  if (s.over) return log;

  const live = alive(s);
  for (const p of live) if (aimedAt(s, p)) p.stats.aimed++;

  // Resolution order is seed-shuffled EVERY turn, so no seat holds a permanent
  // last word on a contested cell.
  const order = shuffle(makeRng(`${s.seed}:order:${s.turn}`), live.map((p) => p.seat));

  let netVeer = 0;
  for (const seat of order) {
    const p = s.players[seat];
    const c = commits[seat] ?? null;
    const handIdx = c && Number.isInteger(c.card) && c.card >= 0 && c.card < p.hand.length ? c.card : -1;
    if (handIdx < 0) {
      // Nothing arrived (or it was nonsense): burn the first card so hands stay
      // in lockstep on every peer, and record it honestly in the summary.
      if (p.hand.length) {
        const burned = p.hand.splice(0, 1)[0];
        p.stats.wasted++;
        log.plays.push({ seat, card: burned, wasted: true });
      }
      continue;
    }
    const kind = p.hand[handIdx];
    p.hand.splice(handIdx, 1);

    if (kind === 'veer') {
      const dir = c!.dir === -1 ? -1 : 1;
      netVeer += dir;
      p.stats.veer++;
      log.plays.push({ seat, card: kind, dir });
      continue;
    }

    const cell = c!.cell ?? -1;
    if (!legalTarget(s, kind, cell)) {
      p.stats.wasted++;
      log.plays.push({ seat, card: kind, wasted: true });
      continue;
    }
    if (kind === 'ridge') {
      s.cells[cell] = RIDGE;
      log.ridged.push(cell);
      p.stats.ridge++;
    } else if (kind === 'thaw') {
      applyThaw(s, cell, log);
      p.stats.thaw++;
    } else {
      s.cells[cell] = FROST;
      log.embers.push(cell);
      p.stats.ember++;
    }
    log.plays.push({ seat, card: kind, cell });
  }

  if (netVeer !== 0) {
    s.gale = (((s.gale + netVeer) % 8) + 8) % 8;
  } else if (s.rules.driftHunt) {
    log.drifted = driftTowardLeader(s);
  }
  log.galeAfter = s.gale;

  // The Gale gathers before it blows: the first turns are pure negotiation over
  // where the cone will point, with nothing lost yet.
  const steps =
    s.turn <= s.rules.rimeDelay
      ? 0
      : s.mode.doubleStep > 0 && s.turn % s.mode.doubleStep === 0
        ? 2
        : 1;
  log.steps = steps;
  for (let i = 0; i < steps; i++) rimeStep(s, log);

  for (const p of live) {
    if (litCount(p) === 0) {
      p.out = s.turn;
      log.eliminated.push(p.seat);
    }
  }

  for (const p of alive(s)) drawUp(s, p);

  const remaining = alive(s);
  if (remaining.length <= 1 || s.turn >= s.mode.turnCap) {
    s.over = true;
    if (remaining.length === 1) {
      s.winners = [remaining[0].seat];
    } else if (remaining.length === 0) {
      // Everyone went dark on the same step. The last ones standing share it.
      const lastTurn = Math.max(...s.players.map((p) => p.out ?? 0));
      s.winners = s.players.filter((p) => p.out === lastTurn).map((p) => p.seat);
    } else {
      // The cap was reached with survivors. Most hearths still lit wins, and
      // then LEAST WORN DOWN — total guard left. Without that second key a third
      // of big Whiteout games ended in a shrug, because on a roomy board several
      // players finish the cap untouched at three hearths each.
      const key = (p: Player): number => litCount(p) * 100 + p.guard.reduce((a, b) => a + b, 0);
      const best = Math.max(...remaining.map(key));
      s.winners = remaining.filter((p) => key(p) === best).map((p) => p.seat);
    }
  } else {
    s.turn++;
  }

  s.log.push(log);
  return log;
}

// ── standings ───────────────────────────────────────────────────────────────

export interface Standing {
  seat: number;
  name: string;
  isBot: boolean;
  place: number;
  lit: number;
  /** Total unspent hearth guard — the tiebreak, and "how close it was". */
  guard: number;
  hearths: number;
  survived: number;
  won: boolean;
  stats: PlayerStats;
}

/**
 * Everyone's outcome, ranked — never just the local player's (principle #9).
 * Survivors first by hearths held, then the eliminated by how long they lasted.
 * Equal results share a place rather than being split by seat index, which would
 * be an invisible seat advantage in the standings themselves.
 */
export function standings(s: State): Standing[] {
  const rows = s.players.map((p) => ({
    seat: p.seat,
    name: p.name,
    isBot: p.isBot,
    place: 0,
    lit: litCount(p),
    guard: p.guard.reduce((a, b) => a + b, 0),
    hearths: p.hearths.length,
    survived: p.out === null ? s.turn : p.out,
    won: s.winners.includes(p.seat),
    stats: p.stats,
  }));
  const rank = (r: (typeof rows)[number]): number => r.survived * 1000 + r.lit * 100 + r.guard;
  rows.sort((a, b) => rank(b) - rank(a) || a.seat - b.seat);
  let place = 0;
  let lastKey = NaN;
  rows.forEach((r, i) => {
    const key = rank(r);
    if (key !== lastKey) {
      place = i + 1;
      lastKey = key;
    }
    r.place = place;
  });
  return rows;
}

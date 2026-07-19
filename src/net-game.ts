/**
 * net-game.ts — one round of Frostward, over the wire or entirely alone.
 *
 * THE NETCODE MODEL, and why it is this one:
 *
 * A round is a pure function of (seed, mode, roster, every commit so far). So no
 * board state is ever transmitted. The host adjudicates only WHICH commits
 * happened and broadcasts them; every peer runs the identical `resolveTurn` and
 * arrives at a byte-identical board.
 *
 * Three things fall out of that for free:
 *
 *  1. HOST TRANSFER IS A NO-OP, STATE-WISE. Every peer already applied every
 *     turn itself, so a promoted peer inherits nothing — it just starts
 *     collecting commits and running the clock. `setHost(true)` is the whole
 *     takeover, and tests/takeover.test.ts proves a promoted client can drive
 *     the match all the way to game over.
 *  2. A LATE JOINER NEEDS ONLY THE REPLAY. `sync` carries the seed, the roster
 *     and the list of past commits — a couple of kilobytes for a whole match —
 *     and the joiner rebuilds the exact board by replaying it.
 *  3. PACKET LOSS HEALS ITSELF. A peer re-sends its commit for the current turn
 *     every 1.5s until it sees that turn resolve. That single rule covers a
 *     dropped packet AND a host that vanished mid-turn, with no extra protocol.
 *
 * A seat whose player has gone (never connected, or closed the tab) is played by
 * the bot — the host commits for it, so the table never stalls on an empty chair.
 */

import { botCommit } from './bot';
import {
  alive,
  createState,
  resolveTurn,
  type Commit,
  type Seat,
  type State,
  type TurnLog,
} from './game';
import { makeRng, type Rng } from '@ben-gy/game-engine/rng';

export interface RosterEntry {
  /** Peer id, or '' for a seat that is played by the bot. */
  id: string;
  name: string;
}

export interface CommitMsg {
  t: number;
  /** null WITHDRAWS this seat's commit for the turn — "I changed my mind". */
  c: Commit | null;
}

export interface TurnMsg {
  t: number;
  /** One entry per seat, in seat order. */
  c: (Commit | null)[];
}

export interface SyncMsg {
  seed: number;
  mode: string;
  roster: RosterEntry[];
  /** Every resolved turn's commits, in order. Replay rebuilds the board. */
  history: (Commit | null)[][];
}

/**
 * Who has locked a card in — never WHAT they locked in.
 *
 * Only the host receives commits, so without this a guest sees nobody ready,
 * ever, until the turn resolves. In a game whose whole tension is simultaneous
 * commitment, "who are we still waiting for" is the only social information
 * there is, and the host had all of it while everyone else had none.
 */
export interface LockMsg {
  t: number;
  s: number[];
}

export interface Transport {
  sendCommit(msg: CommitMsg): void;
  sendTurn(msg: TurnMsg): void;
  sendLocks(msg: LockMsg): void;
  sendSync(msg: SyncMsg, to?: string): void;
}

const NO_TRANSPORT: Transport = {
  sendCommit: () => {},
  sendTurn: () => {},
  sendLocks: () => {},
  sendSync: () => {},
};

export interface MatchConfig {
  seed: number;
  mode: string;
  roster: RosterEntry[];
  /** This peer's id. '' in solo. */
  selfId: string;
  isHost: boolean;
  /** Ms a turn waits for commits before the host plays the stragglers. 0 = none. */
  turnMs?: number;
  transport?: Transport;
  /** Bot difficulty for seats without a player. Higher = sloppier. */
  botNoise?: number;
  onTurn?: (log: TurnLog) => void;
  onChange?: () => void;
  onOver?: () => void;
}

export class Match {
  readonly state: State;
  readonly roster: RosterEntry[];
  /** This peer's seat, or -1 when spectating (joined after the round began). */
  readonly mySeat: number;

  private host: boolean;
  private readonly transport: Transport;
  private readonly turnMs: number;
  private readonly botNoise: number;
  private readonly botRng: Rng[];
  private readonly cfg: MatchConfig;

  /** Commits gathered for the turn currently being played. */
  private pending: (Commit | null)[];
  private got = new Set<number>();
  private history: (Commit | null)[][] = [];
  /** Seats whose player has left; the bot plays them out. */
  private gone = new Set<number>();
  /** Guests only: the seats the host says are locked in for this turn. */
  private remoteLocked: number[] = [];

  private deadlineAt = 0;
  private clock?: ReturnType<typeof setInterval>;
  private resend?: ReturnType<typeof setInterval>;
  private myCommit: Commit | null = null;
  private destroyed = false;
  private resolving = false;

  constructor(cfg: MatchConfig) {
    this.cfg = cfg;
    this.roster = cfg.roster;
    this.transport = cfg.transport ?? NO_TRANSPORT;
    this.turnMs = cfg.turnMs ?? 0;
    this.botNoise = cfg.botNoise ?? 0;
    this.host = cfg.isHost;

    const seats: Seat[] = cfg.roster.map((r) => ({ name: r.name, isBot: r.id === '' }));
    this.state = createState(cfg.seed, cfg.mode, seats);
    this.mySeat = cfg.selfId ? cfg.roster.findIndex((r) => r.id === cfg.selfId) : 0;
    this.botRng = seats.map((_, i) => makeRng(`${cfg.seed}:bot:${i}`));
    this.pending = seats.map(() => null);
    this.armTurn();
  }

  // ── the local player ──────────────────────────────────────────────────────

  /** True once this peer has locked a card in for the current turn. */
  committed(): boolean {
    return this.myCommit !== null;
  }

  /** Seats that have locked in — drives the "who are we waiting for" chips. */
  lockedSeats(): number[] {
    if (this.host) return [...this.got].sort((a, b) => a - b);
    // A guest only knows what the host has told it, plus its own certainty.
    const seats = new Set(this.remoteLocked);
    if (this.myCommit && this.mySeat >= 0) seats.add(this.mySeat);
    return [...seats].sort((a, b) => a - b);
  }

  /** Ms left on the host's clock, or null when there is no clock (solo). */
  remainingMs(): number | null {
    if (!this.turnMs || this.state.over) return null;
    return Math.max(0, this.deadlineAt - Date.now());
  }

  commit(c: Commit): void {
    if (this.destroyed || this.state.over || this.mySeat < 0) return;
    if (this.myCommit) return;
    this.myCommit = c;
    this.receive(this.mySeat, c);
    // Re-announce until the turn resolves. Covers a dropped packet and a host
    // that disappeared between our send and its broadcast.
    if (!this.host) {
      this.transport.sendCommit({ t: this.state.turn, c });
      this.resend = setInterval(() => {
        if (this.myCommit) this.transport.sendCommit({ t: this.state.turn, c: this.myCommit });
      }, 1500);
    }
    this.cfg.onChange?.();
  }

  /** Undo the lock-in, while the turn is still open. */
  uncommit(): void {
    if (this.destroyed || !this.myCommit || this.mySeat < 0) return;
    this.myCommit = null;
    this.got.delete(this.mySeat);
    this.pending[this.mySeat] = null;
    this.stopResend();
    if (this.host) this.transport.sendLocks({ t: this.state.turn, s: [...this.got] });
    // A guest MUST tell the host, or "Change my card" only changes the button:
    // the host still holds the withdrawn commit and will resolve the turn with
    // the card the player just took back.
    else this.transport.sendCommit({ t: this.state.turn, c: null });
    this.cfg.onChange?.();
  }

  // ── the wire ──────────────────────────────────────────────────────────────

  /** A peer's commit arrived. Only the host acts on these. */
  onCommitMsg(msg: CommitMsg, from: string): void {
    if (!this.host || this.destroyed || this.state.over) return;
    if (!msg || msg.t !== this.state.turn) return;
    const seat = this.roster.findIndex((r) => r.id === from);
    if (seat < 0) return; // a spectator, or a stale roster
    if (msg.c === null) {
      if (!this.got.delete(seat)) return;
      this.pending[seat] = null;
      this.transport.sendLocks({ t: this.state.turn, s: [...this.got] });
      this.cfg.onChange?.();
      return;
    }
    this.receive(seat, msg.c);
  }

  /** The host's roll-call of who is ready. Guests render it; the host ignores it. */
  onLockMsg(msg: LockMsg): void {
    if (this.host || this.destroyed || !msg || msg.t !== this.state.turn) return;
    this.remoteLocked = Array.isArray(msg.s) ? msg.s : [];
    this.cfg.onChange?.();
  }

  /** The host's authoritative resolution. Everyone applies it identically. */
  onTurnMsg(msg: TurnMsg): void {
    if (this.destroyed || !msg || msg.t !== this.state.turn || this.state.over) return;
    this.apply(msg.c);
  }

  /** A spectator's rebuild, or a desync heal. */
  onSyncMsg(msg: SyncMsg): void {
    if (this.destroyed || !msg?.history) return;
    // Only ever move FORWARD: a late sync must not rewind a peer that is ahead.
    if (msg.history.length <= this.history.length) return;
    for (let t = this.history.length; t < msg.history.length; t++) {
      if (this.state.over) break;
      this.apply(msg.history[t]);
    }
  }

  syncPayload(): SyncMsg {
    return {
      seed: this.cfg.seed,
      mode: this.cfg.mode,
      roster: this.roster,
      history: this.history,
    };
  }

  sendSyncTo(peer: string): void {
    if (this.host) this.transport.sendSync(this.syncPayload(), peer);
  }

  // ── host role ─────────────────────────────────────────────────────────────

  isHost(): boolean {
    return this.host;
  }

  /**
   * Promotion (or demotion). The whole takeover: there is no state to inherit,
   * because this peer has been running the identical simulation all along.
   */
  setHost(next: boolean): void {
    if (this.destroyed || this.host === next) return;
    this.host = next;
    if (next) {
      // Peers re-announce their commits every 1.5s, so anything already sent
      // arrives shortly. Reset the clock so the new host does not immediately
      // time out a turn on the old host's deadline.
      this.armTurn();
      this.stopResend();
      if (this.myCommit) this.receive(this.mySeat, this.myCommit);
    }
    this.cfg.onChange?.();
  }

  /** A peer left. Its seat is played out by the bot rather than stalling. */
  dropPeer(id: string): void {
    const seat = this.roster.findIndex((r) => r.id === id);
    if (seat < 0) return;
    this.gone.add(seat);
    this.cfg.onChange?.();
    if (this.host) this.maybeResolve();
  }

  /** Seats nobody is playing — bots and departed peers. Shown in the HUD. */
  isBotSeat(seat: number): boolean {
    return this.roster[seat]?.id === '' || this.gone.has(seat);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.clock) clearInterval(this.clock);
    this.clock = undefined;
    this.stopResend();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private stopResend(): void {
    if (this.resend) clearInterval(this.resend);
    this.resend = undefined;
  }

  private receive(seat: number, c: Commit): void {
    if (this.got.has(seat)) return;
    if (this.state.players[seat]?.out !== null) return;
    this.got.add(seat);
    this.pending[seat] = c;
    // Tell the room WHO is ready (never what they played).
    if (this.host) this.transport.sendLocks({ t: this.state.turn, s: [...this.got] });
    this.cfg.onChange?.();
    // `resolving` stops re-entrancy: maybeResolve() fills bot seats by calling
    // straight back into here, and without the guard the turn could resolve
    // half-way through that loop with the remaining bots left unasked.
    if (this.host && !this.resolving) this.maybeResolve();
  }

  private botFor(seat: number): Commit {
    return botCommit(this.state, seat, this.botRng[seat], { noise: this.botNoise });
  }

  /**
   * Fill every seat nobody is going to answer for, and resolve while the table
   * is full.
   *
   * A LOOP, not recursion, and that distinction is a bug I already wrote once:
   * resolving a turn calls apply() -> armTurn() -> maybeResolve(), which the
   * re-entrancy guard then refused, so the follow-up never happened. With a loop
   * the guard only does its real job — stopping receive() from resolving a turn
   * half-way through the very loop that is filling its seats — and consecutive
   * all-bot turns still play themselves out.
   */
  private maybeResolve(): void {
    if (!this.host || this.state.over || this.destroyed || this.resolving) return;
    this.resolving = true;
    try {
      let guard = 0;
      while (!this.state.over && !this.destroyed && guard++ < 500) {
        const live = alive(this.state).map((p) => p.seat);
        for (const seat of live) {
          if (!this.got.has(seat) && this.isBotSeat(seat)) this.receive(seat, this.botFor(seat));
        }
        // Somebody real still owes us a card: stop and wait for them.
        if (!live.every((seat) => this.got.has(seat))) break;
        this.resolveNow();
      }
    } finally {
      this.resolving = false;
    }
  }

  /** The clock ran out: the host plays the silent seats and moves the game on. */
  private timeOut(): void {
    if (!this.host || this.state.over || this.destroyed) return;
    for (const p of alive(this.state)) {
      if (!this.got.has(p.seat)) this.receive(p.seat, this.botFor(p.seat));
    }
    this.resolveNow();
  }

  private resolveNow(): void {
    const commits = this.pending.slice();
    this.transport.sendTurn({ t: this.state.turn, c: commits });
    this.apply(commits);
  }

  private apply(commits: (Commit | null)[]): void {
    const log = resolveTurn(this.state, commits);
    this.history.push(commits);
    this.pending = this.roster.map(() => null);
    this.got.clear();
    this.remoteLocked = [];
    this.myCommit = null;
    this.stopResend();
    this.armTurn();
    this.cfg.onTurn?.(log);
    this.cfg.onChange?.();
    if (this.state.over) {
      if (this.clock) clearInterval(this.clock);
      this.clock = undefined;
      this.cfg.onOver?.();
    }
  }

  /**
   * Restart the turn clock. A `setInterval`, deliberately: a backgrounded tab
   * pauses rAF, and a host that tabs away must not freeze everyone else's round.
   */
  private armTurn(): void {
    if (this.clock) clearInterval(this.clock);
    this.clock = undefined;
    if (this.state.over || this.destroyed) return;
    this.deadlineAt = Date.now() + this.turnMs;
    if (this.turnMs) {
      this.clock = setInterval(() => {
        if (this.host && Date.now() >= this.deadlineAt) this.timeOut();
        this.cfg.onChange?.();
      }, 250);
    }
    // A fresh turn may already be fully answerable — every remaining seat is a
    // bot. This MUST run even with no clock (solo), or a solo player whose own
    // hearths have all gone dark leaves two bots facing each other with nothing
    // left to drive them, and the game hangs on a frozen board forever.
    if (this.host) this.maybeResolve();
  }
}

/** Build a solo match: you in seat 0, bots in the rest. */
export function soloMatch(
  seed: number,
  mode: string,
  playerName: string,
  bots: number,
  botNoise: number,
  hooks: Pick<MatchConfig, 'onTurn' | 'onChange' | 'onOver'>,
): Match {
  const roster: RosterEntry[] = [{ id: 'me', name: playerName }];
  const names = ['Rime', 'Hollow', 'Cinder'];
  for (let i = 0; i < bots; i++) roster.push({ id: '', name: names[i % names.length] });
  return new Match({ seed, mode, roster, selfId: 'me', isHost: true, botNoise, ...hooks });
}

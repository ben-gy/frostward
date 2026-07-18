/**
 * takeover.test.ts — CONTRACT GATE: the host leaving must not freeze the game.
 *
 * This is the automated half of the gate the two-tab smoke test covers manually,
 * and it is the check that would have caught rhythm-relay. The question is not
 * "does an election happen" — net.ts owns that — it is whether the PROMOTED PEER
 * actually drives the simulation and can still reach game over.
 *
 * Structured so the takeover is testable without any network: `Match.setHost()`
 * is the whole promotion, because a round is a pure function of the commits and
 * every peer has already applied every one of them.
 */

import { describe, expect, it } from 'vitest';
import {
  Match,
  soloMatch,
  type CommitMsg,
  type LockMsg,
  type RosterEntry,
  type SyncMsg,
  type TurnMsg,
} from '../src/net-game';
import type { Commit } from '../src/game';

const ROSTER: RosterEntry[] = [
  { id: 'host', name: 'Host' },
  { id: 'guest', name: 'Guest' },
];

interface Pair {
  host: Match;
  guest: Match;
}

/** Two Matches wired directly to each other. No relay, no timers. */
function pair(seed = 4242, mode = 'drift', roster = ROSTER): Pair {
  let host: Match;
  let guest: Match;
  const link = (self: string, other: () => Match) => ({
    sendCommit: (m: CommitMsg) => other().onCommitMsg(m, self),
    sendTurn: (m: TurnMsg) => other().onTurnMsg(m),
    sendLocks: (m: LockMsg) => other().onLockMsg(m),
    sendSync: (m: SyncMsg) => other().onSyncMsg(m),
  });
  host = new Match({
    seed,
    mode,
    roster,
    selfId: roster[0].id,
    isHost: true,
    turnMs: 0,
    transport: link(roster[0].id, () => guest),
  });
  guest = new Match({
    seed,
    mode,
    roster,
    selfId: roster[1].id,
    isHost: false,
    turnMs: 0,
    transport: link(roster[1].id, () => host),
  });
  return { host, guest };
}

/** A legal-ish commit for whatever the seat is holding: always veer-safe. */
const anyCommit = (m: Match): Commit => {
  const me = m.state.players[m.mySeat];
  const veer = me.hand.indexOf('veer');
  return veer >= 0 ? { card: veer, dir: 1 } : { card: 0, cell: -1 };
};

const same = (a: Match, b: Match): void => {
  expect([...a.state.cells]).toEqual([...b.state.cells]);
  expect(a.state.gale).toBe(b.state.gale);
  expect(a.state.turn).toBe(b.state.turn);
  expect(a.state.players.map((p) => p.lit)).toEqual(b.state.players.map((p) => p.lit));
  expect(a.state.players.map((p) => p.guard)).toEqual(b.state.players.map((p) => p.guard));
  expect(a.state.players.map((p) => p.hand)).toEqual(b.state.players.map((p) => p.hand));
};

describe('before promotion, the client is NOT authoritative', () => {
  it('does not advance the turn on its own commit alone', () => {
    const { host, guest } = pair();
    guest.commit(anyCommit(guest));
    // The host has heard it, but has not committed itself, so nothing resolves.
    expect(guest.state.turn).toBe(1);
    expect(host.state.turn).toBe(1);
    host.destroy();
    guest.destroy();
  });

  it('a client cannot resolve a turn even with everyone committed', () => {
    const { host, guest } = pair();
    // Deliberately deafen the host so the ONLY peer that could resolve is the
    // guest — and it must not.
    const deaf = guest;
    deaf.commit(anyCommit(deaf));
    expect(deaf.state.turn).toBe(1);
    host.destroy();
    guest.destroy();
  });

  it('mirrors the host exactly while it is the one resolving', () => {
    const { host, guest } = pair();
    for (let t = 0; t < 6 && !host.state.over; t++) {
      guest.commit(anyCommit(guest));
      host.commit(anyCommit(host));
      same(host, guest);
    }
    expect(host.state.turn).toBeGreaterThan(3);
    host.destroy();
    guest.destroy();
  });
});

describe('the host leaves — the survivor keeps the game running', () => {
  it('a promoted client resolves turns and drives the match to GAME OVER', () => {
    const { host, guest } = pair(818, 'emberfall');
    // Play a few turns normally.
    for (let t = 0; t < 3 && !host.state.over; t++) {
      guest.commit(anyCommit(guest));
      host.commit(anyCommit(host));
    }
    const turnAtHandover = guest.state.turn;
    expect(guest.state.over).toBe(false);

    // The host tab closes.
    host.destroy();
    guest.setHost(true);
    guest.dropPeer('host');
    expect(guest.isHost()).toBe(true);

    // The survivor now plays on alone; the vacated seat is played by the bot.
    let steps = 0;
    while (!guest.state.over && steps++ < 200) {
      if (!guest.committed()) guest.commit(anyCommit(guest));
      else break; // committed but nothing resolved — that is the freeze we are testing for
    }
    expect(guest.state.turn, 'the promoted peer never advanced a turn').toBeGreaterThan(turnAtHandover);
    expect(guest.state.over, 'the promoted peer could not reach game over').toBe(true);
    expect(guest.state.winners.length).toBeGreaterThan(0);
    guest.destroy();
  });

  it('takes over mid-turn with a commit already sent, without losing it', () => {
    const { host, guest } = pair(31, 'drift');
    guest.commit(anyCommit(guest));
    expect(guest.committed()).toBe(true);
    const turn = guest.state.turn;
    host.destroy();
    guest.setHost(true);
    guest.dropPeer('host');
    // Promotion re-offers this peer's own commit and fills the empty seat, so
    // the turn it was already locked into resolves rather than being dropped.
    expect(guest.state.turn).toBeGreaterThan(turn);
    guest.destroy();
  });

  it('holds identical state across the handover — there is nothing to inherit', () => {
    const { host, guest } = pair(70707);
    for (let t = 0; t < 4 && !host.state.over; t++) {
      guest.commit(anyCommit(guest));
      host.commit(anyCommit(host));
    }
    const cells = [...guest.state.cells];
    const gale = guest.state.gale;
    guest.setHost(true);
    expect([...guest.state.cells]).toEqual(cells);
    expect(guest.state.gale).toBe(gale);
    host.destroy();
    guest.destroy();
  });

  it('demoting a host stops it resolving', () => {
    const { host, guest } = pair();
    host.setHost(false);
    host.commit(anyCommit(host));
    guest.commit(anyCommit(guest));
    expect(host.state.turn, 'a demoted peer still resolved a turn').toBe(1);
    host.destroy();
    guest.destroy();
  });
});

describe('a peer leaving mid-round degrades, never freezes', () => {
  it('plays a vacated seat with the bot so the table never stalls', () => {
    const { host, guest } = pair(5150, 'emberfall');
    guest.destroy();
    host.dropPeer('guest');
    expect(host.isBotSeat(1)).toBe(true);
    let steps = 0;
    while (!host.state.over && steps++ < 200) host.commit(anyCommit(host));
    expect(host.state.over).toBe(true);
    host.destroy();
  });

  it('finishes a four-seat round after two players walk out', () => {
    const roster: RosterEntry[] = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
      { id: 'd', name: 'D' },
    ];
    const m = new Match({ seed: 606, mode: 'emberfall', roster, selfId: 'a', isHost: true, turnMs: 0 });
    m.dropPeer('c');
    m.dropPeer('d');
    let steps = 0;
    while (!m.state.over && steps++ < 300) {
      if (!m.committed()) m.commit(anyCommit(m));
      // Seat b is still "present" but silent — nothing should resolve on its own.
      if (m.state.turn === 1 && steps > 3) {
        m.dropPeer('b');
      }
    }
    expect(m.state.over).toBe(true);
    m.destroy();
  });
});

describe('a solo game that outlives its player', () => {
  it('plays the remaining bots out after the local player is eliminated', () => {
    // FOUND DURING THE BUILD, and it is the kind of hang no other test looks
    // for: with no turn clock (solo has none), the only thing that drove a turn
    // was the local player committing. So the moment your own hearths all went
    // dark with two bots still standing, nothing was left to advance the game
    // and the board froze forever, with no result screen and no way out but a
    // reload. The fix is that arming a turn re-checks whether every REMAINING
    // seat is a bot, clock or no clock.
    const m = soloMatch(2468, 'emberfall', 'Me', 2, 0, {});
    m.state.players[0].lit = m.state.players[0].lit.map(() => false);
    m.commit(anyCommit(m));
    expect(m.state.players[0].out, 'the local player should be eliminated').not.toBeNull();
    expect(m.state.over, 'the game froze once its only human seat was out').toBe(true);
    expect(m.state.winners.length).toBeGreaterThan(0);
    expect(m.state.winners).not.toContain(0);
    m.destroy();
  });

  it('resolves a turn only once, even while it is filling several bot seats', () => {
    // Also found during the build: maybeResolve() fills empty seats by calling
    // back into receive(), which called maybeResolve() again — so a turn could
    // resolve part-way through the loop with the remaining bots never asked, and
    // their cards burned as "wasted" instead of played.
    const m = soloMatch(1357, 'drift', 'Me', 3, 0, {});
    m.commit(anyCommit(m));
    expect(m.state.turn).toBe(2);
    // Every seat is represented in the turn that just resolved. If the guard had
    // let receive() resolve mid-loop, the seats it had not reached yet would be
    // missing entirely.
    expect(m.state.log[0].plays).toHaveLength(4);
    expect(new Set(m.state.log[0].plays.map((p) => p.seat)).size).toBe(4);
    m.destroy();
  });
});

describe('sync — a late joiner rebuilds the exact board from the replay', () => {
  it('replays the host’s commit history into an identical state', () => {
    const { host, guest } = pair(2024, 'drift');
    for (let t = 0; t < 5 && !host.state.over; t++) {
      guest.commit(anyCommit(guest));
      host.commit(anyCommit(host));
    }
    const late = new Match({
      seed: 2024,
      mode: 'drift',
      roster: ROSTER,
      selfId: 'watcher',
      isHost: false,
      turnMs: 0,
    });
    late.onSyncMsg(host.syncPayload());
    same(host, late);
    late.destroy();
    host.destroy();
    guest.destroy();
  });

  it('never rewinds a peer that is already ahead', () => {
    const { host, guest } = pair(11, 'drift');
    guest.commit(anyCommit(guest));
    host.commit(anyCommit(host));
    const stale = host.syncPayload();
    const cellsNow = [...guest.state.cells];
    guest.commit(anyCommit(guest));
    host.commit(anyCommit(host));
    const ahead = guest.state.turn;
    guest.onSyncMsg({ ...stale, history: stale.history.slice(0, 1) });
    expect(guest.state.turn, 'a stale sync rewound a peer').toBe(ahead);
    expect([...guest.state.cells]).not.toEqual(cellsNow);
    host.destroy();
    guest.destroy();
  });
});

describe('stale and hostile messages', () => {
  it('ignores a turn message for the wrong turn', () => {
    const { host, guest } = pair();
    const before = guest.state.turn;
    guest.onTurnMsg({ t: 99, c: [null, null] });
    expect(guest.state.turn).toBe(before);
    host.destroy();
    guest.destroy();
  });

  it('ignores a commit from someone who is not in the roster', () => {
    const { host, guest } = pair();
    host.onCommitMsg({ t: 1, c: { card: 0, dir: 1 } }, 'a-stranger');
    expect(host.lockedSeats()).toEqual([]);
    host.destroy();
    guest.destroy();
  });

  it('ignores a duplicate commit rather than double-playing a seat', () => {
    const { host, guest } = pair();
    host.onCommitMsg({ t: 1, c: { card: 0, dir: 1 } }, 'guest');
    host.onCommitMsg({ t: 1, c: { card: 1, dir: -1 } }, 'guest');
    expect(host.lockedSeats()).toEqual([1]);
    host.destroy();
    guest.destroy();
  });

  it('shows a guest WHO is ready, without ever leaking WHAT they played', () => {
    // Only the host receives commits, so a guest used to see nobody ready, ever,
    // until the turn resolved — in a game whose entire tension is simultaneous
    // commitment. Found in the two-tab smoke test, not by any unit test.
    const { host, guest } = pair();
    expect(guest.lockedSeats()).toEqual([]);
    host.commit(anyCommit(host));
    expect(guest.lockedSeats(), 'the guest cannot see that the host is ready').toEqual([0]);
    // …and the guest still holds no idea what the host actually played.
    const leaked = JSON.stringify(guest.state.players[0].hand);
    expect(leaked).toBe(JSON.stringify(host.state.players[0].hand));
    guest.commit(anyCommit(guest));
    // Both in: the turn resolves and the roll-call resets.
    expect(guest.state.turn).toBe(2);
    expect(guest.lockedSeats()).toEqual([]);
    host.destroy();
    guest.destroy();
  });

  it('drops the roll-call when the host un-commits', () => {
    const { host, guest } = pair();
    host.commit(anyCommit(host));
    expect(guest.lockedSeats()).toEqual([0]);
    host.uncommit();
    expect(guest.lockedSeats()).toEqual([]);
    host.destroy();
    guest.destroy();
  });

  it('ignores a roll-call for a turn that has already moved on', () => {
    const { host, guest } = pair();
    guest.onLockMsg({ t: 99, s: [0, 1] });
    expect(guest.lockedSeats()).toEqual([]);
    host.destroy();
    guest.destroy();
  });

  it('lets a player change their mind, and TELLS THE HOST', () => {
    // "Change my card" used to change only the button: the guest cleared its own
    // state while the host still held the withdrawn commit and would resolve the
    // turn with the card the player had just taken back.
    const { host, guest } = pair();
    guest.commit(anyCommit(guest));
    expect(guest.committed()).toBe(true);
    expect(host.lockedSeats(), 'the host never heard the commit').toEqual([1]);
    guest.uncommit();
    expect(guest.committed()).toBe(false);
    expect(guest.lockedSeats()).toEqual([]);
    expect(host.lockedSeats(), 'the host still thinks the guest is locked in').toEqual([]);
    // And the guest can now commit something different, which the host accepts.
    guest.commit(anyCommit(guest));
    expect(host.lockedSeats()).toEqual([1]);
    host.destroy();
    guest.destroy();
  });
});

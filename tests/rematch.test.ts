/**
 * rematch.test.ts — the multi-round protocol, driven with N simulated peers.
 *
 *  - COVERED: our round protocol. Votes, quorum, monotonic round numbers, the
 *    frozen roster, the host's mode travelling frozen, host handover mid-results,
 *    and the no-deadlock grace countdown.
 *  - NOT COVERED: the transport bug. A fake bus sits ABOVE Trystero's room cache,
 *    so it structurally cannot contain that defect — net-lifecycle.test.ts and
 *    trystero-rejoin.test.ts own it. Do not "cover" the transport here and call
 *    it done; that false confidence is how the bug shipped twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo } from '@ben-gy/game-engine/rematch';
import type { Net, PeerId } from '@ben-gy/game-engine/net';
import { MODES } from '../src/modes';

class Bus {
  peers = new Map<PeerId, Map<string, Set<(d: unknown, from: PeerId) => void>>>();
  /** Roster watchers, per peer — how createRounds learns the room changed. */
  watchers = new Map<PeerId, Set<(peers: PeerId[]) => void>>();
  join(id: PeerId): void {
    this.peers.set(id, new Map());
    this.watchers.set(id, new Set());
    this.announce();
  }
  part(id: PeerId): void {
    this.peers.delete(id);
    this.watchers.delete(id);
    this.announce();
  }
  /** Tell every remaining peer the roster moved, as net.onPeersChange does. */
  announce(): void {
    const roster = this.roster();
    for (const cbs of this.watchers.values()) for (const cb of cbs) cb(roster);
  }
  watch(id: PeerId, cb: (peers: PeerId[]) => void): () => void {
    const set = this.watchers.get(id)!;
    set.add(cb);
    return () => set.delete(cb);
  }
  roster(): PeerId[] {
    return [...this.peers.keys()].sort();
  }
  send(from: PeerId, name: string, data: unknown, to?: PeerId | PeerId[]): void {
    const targets = to ? (Array.isArray(to) ? to : [to]) : this.roster().filter((p) => p !== from);
    for (const t of targets) {
      for (const h of this.peers.get(t)?.get(name) ?? []) h(data, from);
    }
  }
  on(id: PeerId, name: string, h: (d: unknown, from: PeerId) => void): () => void {
    const chans = this.peers.get(id)!;
    if (!chans.has(name)) chans.set(name, new Set());
    chans.get(name)!.add(h);
    return () => chans.get(name)!.delete(h);
  }
}

function mockNet(bus: Bus, selfId: PeerId): Net {
  bus.join(selfId);
  return {
    selfId,
    peers: () => bus.roster(),
    host: () => bus.roster()[0] ?? null,
    isHost: () => bus.roster()[0] === selfId,
    hostSettled: () => true,
    // This bus is always settled at term 1: it models the round protocol, not
    // the election. host-election.test.ts owns epochs.
    hostEpoch: () => 1,
    count: () => bus.roster().length,
    onPeersChange: (cb) => bus.watch(selfId, cb),
    // Nothing here can be unsettled, so there is never a room to take over…
    takeover: () => {},
    // …and no transport to introspect. Shaped enough for the ?netdebug= HUD.
    netDiag: () => ({
      selfId,
      host: bus.roster()[0] ?? null,
      epoch: 1,
      settled: true,
      peers: bus.roster(),
      relaySockets: {},
      turn: false,
    }),
    channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
      const off = bus.on(selfId, name, onReceive as (d: unknown, from: PeerId) => void);
      const send = ((data: T, to?: PeerId | PeerId[]) => bus.send(selfId, name, data, to)) as ((
        data: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: () => void };
      send.off = off;
      return send;
    },
    ping: async () => 0,
    leave: async () => bus.part(selfId),
  };
}

const modeOf = (i: RoundInfo): string | undefined => (i.opts as { mode?: string } | undefined)?.mode;

interface Seat {
  id: PeerId;
  net: Net;
  rounds: ReturnType<typeof createRounds>;
  got: RoundInfo[];
}

function table(ids: PeerId[], opts: { minPlayers?: number; modes?: Record<string, string> } = {}): Seat[] {
  const bus = new Bus();
  return ids.map((id) => {
    const net = mockNet(bus, id);
    const seat: Seat = { id, net, rounds: null as never, got: [] };
    seat.rounds = createRounds({
      net,
      playerName: id.toUpperCase(),
      minPlayers: opts.minPlayers ?? 2,
      roundOpts: opts.modes ? () => ({ mode: opts.modes![id] }) : undefined,
      onRound: (info) => seat.got.push(info),
    });
    return seat;
  });
}

let seats: Seat[];
beforeEach(() => {
  seats = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Let the roster go quiet, then let the host notice.
 *
 * An automatic start is deliberately no longer synchronous with the last vote.
 * A mesh that is still forming produces a burst of joins, and a host that froze
 * its roster inside that burst locked out whoever was one handshake behind —
 * which is what "I got ejected when the round started" actually was. So the host
 * refuses to start until the roster has held still for ROSTER_SETTLE_MS (4s),
 * and a 1.5s poll re-attempts the start once it has. Six seconds covers the
 * window plus the next poll tick.
 *
 * Call this after the votes, in place of expecting an instant start. It is not a
 * weakening: every assertion about WHO is in the roster and WHAT they play is
 * unchanged — only the moment the host is willing to commit to it has moved.
 */
const settle = (): void => {
  vi.advanceTimersByTime(6000);
};

describe('createRounds — starting a round', () => {
  it('starts once every peer has voted, with one host and an identical seed', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats.map((s) => s.got.length)).toEqual([1, 1]);
    expect(seats[0].got[0].seed).toBe(seats[1].got[0].seed);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
    expect(seats[0].got[0].round).toBe(1);
  });

  it('freezes ONE roster into the start, so seats match on every peer', () => {
    // In Frostward the roster INDEX is the seat, which is the corner of the
    // board you are defending. Two peers disagreeing here would each be
    // guarding the other's hearths.
    seats = table(['b', 'a', 'c'], { minPlayers: 3 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    const rosters = seats.map((s) => s.got[0].players.map((p) => `${p.id}:${p.name}`));
    expect(rosters[0]).toEqual(rosters[1]);
    expect(rosters[1]).toEqual(rosters[2]);
    expect(rosters[0]).toEqual(['a:A', 'b:B', 'c:C']);
  });

  it('waits below quorum', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 3 });
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle();
    expect(seats.every((s) => s.got.length === 0)).toBe(true);
    seats[2].rounds.vote();
    settle();
    expect(seats.every((s) => s.got.length === 1)).toBe(true);
  });

  it('fills a full 4-player table with one seed and one roster', () => {
    seats = table(['a', 'b', 'c', 'd'], { minPlayers: 4 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats.map((s) => s.got.length)).toEqual([1, 1, 1, 1]);
    expect(new Set(seats.map((s) => s.got[0].seed)).size).toBe(1);
    for (const s of seats) expect(s.got[0].players.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
  });

  it('lets the host start early with go(), leaving a non-voter out of the roster', () => {
    seats = table(['a', 'b', 'c']);
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(0);
    // go() is deliberately NOT gated by the roster-settle window: a human
    // pressing Start has decided who is playing.
    seats[0].rounds.go();
    expect(seats[0].got[0].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('ignores a start from a peer that is not the host', () => {
    seats = table(['a', 'b']);
    seats[1].net.channel('rs', () => {})({
      round: 1,
      seed: 42,
      roster: [{ id: 'b', name: 'B' }],
    } as never);
    expect(seats.every((s) => s.got.length === 0)).toBe(true);
  });
});

describe("createRounds — the host's mode travels frozen", () => {
  it("gives every peer the HOST's mode, not the one their own menu is set to", () => {
    // A mode decides the BOARD SIZE here, so a guest dealing itself Emberfall on
    // the host's Whiteout seed is not playing a variant — it is playing a
    // different 9x9 game while the host plays a 13x13 one.
    seats = table(['a', 'b'], { modes: { a: 'drift', b: 'emberfall' } });
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats[0].net.isHost()).toBe(true);
    for (const s of seats) expect(modeOf(s.got[0])).toBe('drift');
    for (const s of seats) expect(MODES[modeOf(s.got[0])!].size).toBe(11);
  });

  it('follows the mode when the HOST is the one on Whiteout', () => {
    seats = table(['a', 'b'], { modes: { a: 'whiteout', b: 'drift' } });
    seats.forEach((s) => s.rounds.vote());
    settle();
    for (const s of seats) expect(modeOf(s.got[0])).toBe('whiteout');
    expect(MODES.whiteout.size).toBe(13);
  });

  it('carries the mode into every rematch, not just the first round', () => {
    seats = table(['a', 'b'], { modes: { a: 'emberfall', b: 'drift' } });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();
    for (const s of seats) expect(modeOf(s.got[1])).toBe('emberfall');
  });

  it("gossips the host's mode into every peer's state, before any round starts", () => {
    seats = table(['a', 'b'], { modes: { a: 'whiteout', b: 'drift' } });
    for (const s of seats) expect(s.rounds.state().hostOpts).toEqual({ mode: 'whiteout' });
  });
});

describe('createRounds — the rematch (the bug this all exists for)', () => {
  it('runs a second round in the SAME room, both peers together, one host', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats.map((s) => s.got.length)).toEqual([2, 2]);
    expect(seats[0].got[1].round).toBe(2);
    expect(seats[0].got[1].seed).toBe(seats[1].got[1].seed);
    expect(seats.filter((s) => s.got[1].isHost)).toHaveLength(1);
    expect(seats[0].got[1].seed, 'the rematch replayed the same board').not.toBe(seats[0].got[0].seed);
  });

  it('lets a peer that LEFT and rejoined mid-match ready up again', () => {
    const bus = new Bus();
    const mk = (id: PeerId): Seat => {
      const net = mockNet(bus, id);
      const seat: Seat = { id, net, rounds: null as never, got: [] };
      seat.rounds = createRounds({
        net,
        playerName: id.toUpperCase(),
        minPlayers: 2,
        onRound: (info) => seat.got.push(info),
      });
      return seat;
    };
    const a = mk('a');
    let b = mk('b');
    a.rounds.vote();
    b.rounds.vote();
    settle();
    expect(a.got[0].round).toBe(1);
    b.rounds.destroy();
    void b.net.leave();
    a.rounds.finish();
    b = mk('b');
    a.rounds.vote();
    b.rounds.vote();
    // The rejoin itself moved the roster, so the host waits out a fresh window
    // before freezing it — which is the whole point: the returning peer must be
    // in the roster it starts, not one handshake behind it.
    settle();
    expect(b.got.length, 'the rejoiner reached a new round').toBe(1);
    expect(a.got[1].round).toBe(2);
    expect(b.got[0].round).toBe(2);
    expect(a.got[1].seed).toBe(b.got[0].seed);
  });

  it("keeps both peers in each other's roster across the rematch", () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();
    for (const s of seats) {
      expect(s.got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
      expect(s.net.count()).toBe(2);
    }
  });

  it('ignores a stale or duplicated start rather than restarting a live round', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    const seed = seats[0].got[0].seed;
    seats[0].net.channel('rs', () => {})({
      round: 1,
      seed: 999,
      roster: [{ id: 'a', name: 'A' }],
    } as never);
    expect(seats[1].got.length).toBe(1);
    expect(seats[1].got[0].seed).toBe(seed);
  });

  it('does not start a rematch while a round is still being played', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats[0].got.length).toBe(1);
  });

  it('drops the vote of a peer who leaves, and still rematches the rest', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(1);
    seats[2].net.leave();
    seats[0].rounds.vote();
    settle();
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('createRounds — host handover', () => {
  it('promotes the next peer and still starts when the host leaves at results', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    expect(seats[0].net.isHost()).toBe(true);
    seats[0].net.leave();
    expect(seats[1].net.isHost()).toBe(true);
    seats[1].rounds.vote();
    seats[2].rounds.vote();
    settle();
    expect(seats[1].got.length).toBe(2);
    expect(seats[1].got[1].players.map((p) => p.id)).toEqual(['b', 'c']);
    expect(seats[1].got[1].isHost).toBe(true);
    expect(seats[2].got[1].isHost).toBe(false);
    expect(seats[1].got[1].seed).toBe(seats[2].got[1].seed);
  });
});

describe('createRounds — never deadlock waiting for a vote that never comes', () => {
  it('starts anyway once the grace countdown expires, without the silent player', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    // The grace countdown only ARMS once the roster has settled — a countdown
    // started inside a forming mesh would be a second way to freeze a partial
    // roster, which is exactly what it exists to avoid.
    settle();
    expect(seats[0].got.length).toBe(1);
    const s = seats[0].rounds.state();
    expect(s.startsInMs, 'a silent wait is indistinguishable from a hang').not.toBeNull();
    expect(s.startsInMs!).toBeGreaterThan(0);
    vi.advanceTimersByTime(8100);
    expect(seats[0].got.length).toBe(2);
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('goes with no countdown at all when everyone has voted', () => {
    seats = table(['a', 'b'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats[0].got.length).toBe(2);
    // Unanimous: the round went straight through rather than holding a grace
    // countdown for stragglers who do not exist.
    expect(seats[0].rounds.state().startsInMs).toBeNull();
  });

  it('lets the host force the rematch immediately with go()', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    // No settle(): go() is the host's explicit decision and bypasses the wait.
    seats[0].rounds.go();
    expect(seats[0].got.length).toBe(2);
  });

  it('cancels the countdown if quorum is lost again', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle();
    expect(seats[0].rounds.state().startsInMs!).toBeGreaterThan(0);
    seats[1].rounds.unvote();
    expect(seats[0].rounds.state().startsInMs).toBeNull();
    vi.advanceTimersByTime(8100);
    expect(seats[0].got.length).toBe(1);
  });

  it('a peer who readies up mid-countdown still lands in the roster', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle();
    seats[2].rounds.vote();
    settle();
    expect(seats[2].got.length).toBe(2);
    expect(seats[2].got[1].players.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('createRounds — teardown', () => {
  it('stops answering once destroyed', () => {
    seats = table(['a', 'b']);
    seats[1].rounds.destroy();
    seats.forEach((s) => s.rounds.vote());
    expect(seats[1].got.length).toBe(0);
  });
});

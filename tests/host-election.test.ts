/**
 * host-election.test.ts — who hosts a room, and when that is allowed to change.
 *
 * The rule, in one line: THE HOST ONLY CHANGES WHEN THE HOST LEAVES.
 *
 * Two shipped bugs live here, both asserted directly:
 *  1. Host stolen on join (a lower id arriving took the room it held no state for).
 *  2. Everyone hosting a room that never formed (each peer seeded itself host, so a
 *     slow or failed mesh left two players each convinced they were host, alone).
 *     In Frostward the host decides which commits count, so two hosts is two
 *     tables each resolving a different turn from the same seed.
 *
 * The peer ids are FIXED ('a', 'z') so id ORDER is deliberate. A test with real
 * random ids passes half the time and proves nothing — which is exactly how the
 * stolen-host bug survived a "clean" two-tab run.
 *
 * Each simulated peer gets its OWN module instance, because Trystero's selfId
 * and net.ts's join registry are one-per-page globals: a shared import would
 * silently give every peer the same identity.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Net } from '../src/engine/net';

interface Wire {
  peers: Map<string, Room>;
}
const wire: Wire = { peers: new Map() };

class Room {
  id: string;
  roomId: string;
  receivers = new Map<string, (d: unknown, from: string) => void>();
  joinCbs: ((id: string) => void)[] = [];
  leaveCbs: ((id: string) => void)[] = [];
  connected = new Set<string>();
  left = false;

  constructor(id: string, roomId: string) {
    this.id = id;
    this.roomId = roomId;
  }

  getPeers(): Record<string, unknown> {
    return Object.fromEntries([...this.connected].map((p) => [p, {}]));
  }

  makeAction(name: string): [(d: unknown, to?: string | string[]) => void, (cb: never) => void] {
    return [
      (data: unknown, to?: string | string[]) => {
        const targets = to ? (Array.isArray(to) ? to : [to]) : [...this.connected];
        for (const t of targets) {
          const peer = wire.peers.get(t);
          if (peer && !peer.left && peer.roomId === this.roomId) {
            peer.receivers.get(name)?.(data, this.id);
          }
        }
      },
      ((cb: (d: unknown, from: string) => void) => this.receivers.set(name, cb)) as never,
    ];
  }

  onPeerJoin(cb: (id: string) => void): void {
    this.joinCbs.push(cb);
  }
  onPeerLeave(cb: (id: string) => void): void {
    this.leaveCbs.push(cb);
  }
  async leave(): Promise<void> {
    this.left = true;
    for (const other of wire.peers.values()) {
      if (other !== this && other.connected.delete(this.id)) {
        other.leaveCbs.forEach((cb) => cb(this.id));
      }
    }
    wire.peers.delete(this.id);
  }
}

function connect(a: string, b: string): void {
  const ra = wire.peers.get(a)!;
  const rb = wire.peers.get(b)!;
  ra.connected.add(b);
  rb.connected.add(a);
  ra.joinCbs.forEach((cb) => cb(b));
  rb.joinCbs.forEach((cb) => cb(a));
}

async function peer(id: string, opts: { claimHost?: boolean } = {}): Promise<Net> {
  vi.resetModules();
  vi.doMock('trystero', () => ({
    selfId: id,
    joinRoom: (_c: { appId: string }, roomId: string) => {
      const room = new Room(id, roomId);
      wire.peers.set(id, room);
      return room;
    },
  }));
  const mod = await import('../src/engine/net');
  return mod.createNet({ appId: 'frostward', roomId: 'R', claimHost: opts.claimHost });
}

beforeEach(() => {
  wire.peers.clear();
  vi.useRealTimers();
  vi.useFakeTimers();
});

describe('host election — the incumbent keeps the room', () => {
  it('does NOT hand the room to a joiner with a lower id', async () => {
    const host = await peer('z', { claimHost: true });
    expect(host.isHost()).toBe(true);
    const joiner = await peer('a');
    connect('z', 'a');
    expect(host.isHost()).toBe(true);
    expect(joiner.isHost()).toBe(false);
    expect(joiner.host()).toBe('z');
  });

  it('settles a joiner onto the incumbent rather than making it wait out a timer', async () => {
    await peer('z', { claimHost: true });
    const joiner = await peer('a');
    expect(joiner.hostSettled()).toBe(false);
    connect('z', 'a');
    expect(joiner.hostSettled()).toBe(true);
    expect(joiner.host()).toBe('z');
  });

  it('keeps the incumbent across a full table, whatever their ids', async () => {
    const host = await peer('m', { claimHost: true });
    for (const id of ['a', 'z', 'c']) {
      await peer(id);
      connect('m', id);
    }
    expect(host.isHost()).toBe(true);
    expect(host.count()).toBe(4);
    expect(wire.peers.size).toBe(4);
  });
});

describe('host election — nobody hosts a mesh that has not formed', () => {
  it('a joiner is NOT host while it has heard nothing', async () => {
    const joiner = await peer('a');
    expect(joiner.isHost()).toBe(false);
    expect(joiner.hostSettled()).toBe(false);
    expect(joiner.host()).toBeNull();
  });

  it('two peers who cannot see each other do NOT both act as host', async () => {
    const a = await peer('a');
    const b = await peer('b');
    expect([a.isHost(), b.isHost()]).toEqual([false, false]);
    expect([a.hostSettled(), b.hostSettled()]).toEqual([false, false]);
  });

  it('falls back to an election if the room turns out to have no host', async () => {
    const a = await peer('a');
    const b = await peer('b');
    connect('a', 'b');
    vi.advanceTimersByTime(2600);
    expect(a.isHost()).toBe(true);
    expect(b.isHost()).toBe(false);
    expect(b.host()).toBe('a');
  });

  it('settles the creator immediately so "Create a room" is not a 2.5s wait', async () => {
    const host = await peer('z', { claimHost: true });
    expect(host.hostSettled()).toBe(true);
    expect(host.isHost()).toBe(true);
  });
});

describe('host election — handover happens only on leave', () => {
  it('promotes exactly ONE survivor when the host leaves, and all agree which', async () => {
    const host = await peer('m', { claimHost: true });
    const b = await peer('b');
    const c = await peer('c');
    connect('m', 'b');
    connect('m', 'c');
    connect('b', 'c');
    expect([b.isHost(), c.isHost()]).toEqual([false, false]);
    await host.leave();
    expect([b.isHost(), c.isHost()]).toEqual([true, false]);
    expect(b.host()).toBe('b');
    expect(c.host()).toBe('b');
  });

  it('does not reshuffle when a NON-host leaves', async () => {
    const host = await peer('m', { claimHost: true });
    const b = await peer('b');
    const c = await peer('c');
    connect('m', 'b');
    connect('m', 'c');
    connect('b', 'c');
    await c.leave();
    expect(host.isHost()).toBe(true);
    expect(host.host()).toBe('m');
    expect(b.isHost()).toBe(false);
    expect(b.host()).toBe('m');
  });

  it('converges when two peers each believe they host the room', async () => {
    const z = await peer('z', { claimHost: true });
    const a = await peer('a', { claimHost: true });
    expect([z.isHost(), a.isHost()]).toEqual([true, true]);
    connect('z', 'a');
    expect([z.isHost(), a.isHost()]).toEqual([false, true]);
    expect(z.host()).toBe('a');
    expect(a.host()).toBe('a');
  });

  it('stops announcing once it is no longer host', async () => {
    const z = await peer('z', { claimHost: true });
    const a = await peer('a', { claimHost: true });
    connect('z', 'a');
    expect(z.isHost()).toBe(false);
    vi.advanceTimersByTime(6000);
    expect(a.isHost()).toBe(true);
    expect(z.isHost()).toBe(false);
    expect(z.host()).toBe('a');
  });

  it('fires onHostChange exactly once per real change, so a game can take over', async () => {
    // The game wires Match.setHost to this callback; a missed or spurious fire
    // is a frozen board or two authoritative peers.
    vi.resetModules();
    const changes: [string, boolean][] = [];
    vi.doMock('trystero', () => ({
      selfId: 'b',
      joinRoom: (_c: { appId: string }, roomId: string) => {
        const room = new Room('b', roomId);
        wire.peers.set('b', room);
        return room;
      },
    }));
    const mod = await import('../src/engine/net');
    const b = mod.createNet(
      { appId: 'frostward', roomId: 'R' },
      { onHostChange: (id, self) => changes.push([id, self]) },
    );
    const host = await peer('m', { claimHost: true });
    connect('m', 'b');
    expect(changes).toEqual([['m', false]]);
    await host.leave();
    expect(changes).toEqual([
      ['m', false],
      ['b', true],
    ]);
    expect(b.isHost()).toBe(true);
  });
});

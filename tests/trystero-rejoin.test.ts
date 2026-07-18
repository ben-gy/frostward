/**
 * trystero-rejoin.test.ts — a CHARACTERIZATION test.
 *
 * It does not test our code. It pins the exact Trystero behaviour that caused
 * the "we're both the host and can't see each other" bug, so that:
 *   a) the hazard is executable fact, not folklore in a comment;
 *   b) an `npm update trystero` that changes it turns this red and makes someone
 *      re-read engine/net.ts before shipping.
 *
 * The bug, in one line: joinRoom is memoized on appId+roomId, but leave() is
 * async and defers teardown ~99ms — so leave-then-rejoin in the same tick hands
 * back the room that is about to be destroyed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinRoom } from 'trystero';

class DeadSocket {
  readyState = 0;
  url: string;
  onclose: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

class DeadPeerConnection {
  iceGatheringState = 'new';
  localDescription = null;
  createDataChannel(): Record<string, unknown> {
    return {};
  }
  createOffer(): Promise<Record<string, unknown>> {
    return new Promise(() => {});
  }
  setLocalDescription(): Promise<void> {
    return new Promise(() => {});
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

const APP = 'frostward-test';

beforeEach(() => {
  vi.stubGlobal('WebSocket', DeadSocket);
  vi.stubGlobal('RTCPeerConnection', DeadPeerConnection);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('trystero room lifecycle (pinned behaviour, v0.21.x)', () => {
  it('memoizes joinRoom on appId+roomId — a second join returns the SAME object', () => {
    const a = joinRoom({ appId: APP }, 'MEMO');
    const b = joinRoom({ appId: APP }, 'MEMO');
    expect(b).toBe(a);
    return a.leave();
  });

  it('THE TRAP: rejoining in the same tick as leave() returns the DYING room', async () => {
    const first = joinRoom({ appId: APP }, 'TRAP');
    const leaving = first.leave();
    const rejoined = joinRoom({ appId: APP }, 'TRAP');
    expect(rejoined).toBe(first);
    await leaving;
  });

  it('is safe once leave() has resolved — that is why net.leave() must be awaited', async () => {
    const first = joinRoom({ appId: APP }, 'SAFE');
    await first.leave();
    const second = joinRoom({ appId: APP }, 'SAFE');
    expect(second).not.toBe(first);
    await second.leave();
  });

  it('defers teardown well past the current tick (the window the trap lives in)', async () => {
    const room = joinRoom({ appId: APP }, 'SLOW');
    let settled = false;
    const leaving = room.leave().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await leaving;
    expect(settled).toBe(true);
  });

  it('keeps rooms with different ids distinct under the same appId', async () => {
    const a = joinRoom({ appId: APP }, 'ROOM-A');
    const b = joinRoom({ appId: APP }, 'ROOM-B');
    expect(b).not.toBe(a);
    await Promise.all([a.leave(), b.leave()]);
  });
});

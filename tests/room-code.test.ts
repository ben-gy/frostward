/**
 * room-code.test.ts — CONTRACT GATE: a friend must be able to TYPE the code.
 *
 * If a hand-typed code and the code inside the invite link do not canonicalise
 * to the same string, the two players land in different Trystero rooms, each
 * hosting an empty mesh, each looking at the code they were told. Nothing
 * errors. They just never see each other.
 *
 * Also covers "a room is a choice, not a destiny": `?room=` is read once and
 * cleared on the way out, so a reload — or reopening from a home-screen icon —
 * never drags a player back into a room they left.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clearRoomInUrl, inviteLink, mintCode, normalizeRoomCode, setRoomInUrl } from '@ben-gy/game-engine/lobby';
// The engine only ships getOrCreateRoomCode(), which MINTS when there is no
// `?room=`. Frostward must not mint on page load, so it keeps its own read-only
// reader over the engine's canonicalisation. See src/room-link.ts.
import { roomFromUrl } from '../src/room-link';

const at = (url: string): void => history.replaceState(null, '', url);

beforeEach(() => at('/'));

describe('normalizeRoomCode — a typed code and a linked code must agree', () => {
  it('uppercases, so a code read aloud and typed in lowercase still joins', () => {
    expect(normalizeRoomCode('k7qp')).toBe('K7QP');
    expect(normalizeRoomCode('K7QP')).toBe('K7QP');
  });

  it('survives the ways people actually paste a code', () => {
    for (const raw of [' K7QP ', 'k7-qp', 'K7 QP', 'k7.qp', '"K7QP"', 'k7\tqp']) {
      expect(normalizeRoomCode(raw), raw).toBe('K7QP');
    }
  });

  it('is idempotent, so re-normalising never changes the room', () => {
    const once = normalizeRoomCode('  k7-qp ');
    expect(normalizeRoomCode(once)).toBe(once);
  });

  it('caps the length so a pasted essay cannot become a room', () => {
    expect(normalizeRoomCode('ABCDEFGHIJKLMNOP')).toHaveLength(8);
  });

  it('collapses to empty when there is nothing usable', () => {
    expect(normalizeRoomCode('--- ...')).toBe('');
  });
});

describe('mintCode', () => {
  it('makes a 4-character code with no ambiguous glyphs', () => {
    for (let i = 0; i < 300; i++) {
      const code = mintCode();
      expect(code).toHaveLength(4);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
      // I/O/0/1/L are exactly the characters people mistype over the phone.
      expect(code).not.toMatch(/[IO01L]/);
    }
  });

  it('mints a code that survives a round trip through the link', () => {
    for (let i = 0; i < 100; i++) {
      const code = mintCode();
      at('/');
      const link = inviteLink(code);
      at(link);
      expect(roomFromUrl()).toBe(code);
    }
  });
});

describe('?room= is honoured once and cleared on the way out', () => {
  it('reads a code out of the URL, normalised', () => {
    at('/?room=k7-qp');
    expect(roomFromUrl()).toBe('K7QP');
  });

  it('returns null when there is no room, or the room is junk', () => {
    at('/');
    expect(roomFromUrl()).toBeNull();
    at('/?room=');
    expect(roomFromUrl()).toBeNull();
    at('/?room=--');
    expect(roomFromUrl()).toBeNull();
  });

  it('setRoomInUrl makes a link that resolves back to the same room', () => {
    at('/');
    setRoomInUrl('AB2C');
    expect(location.search).toContain('room=AB2C');
    expect(roomFromUrl()).toBe('AB2C');
  });

  it('clearRoomInUrl removes it, so a reload does not rejoin', () => {
    at('/?room=AB2C');
    clearRoomInUrl();
    expect(roomFromUrl()).toBeNull();
    expect(location.search).not.toContain('room');
  });

  it('clearRoomInUrl is safe when there was never a room', () => {
    at('/?seed=99');
    clearRoomInUrl();
    expect(location.search).toContain('seed=99');
  });

  it('keeps other parameters intact when it sets a room', () => {
    at('/?seed=99');
    setRoomInUrl('AB2C');
    expect(location.search).toContain('seed=99');
    expect(location.search).toContain('room=AB2C');
  });

  it('drops any leftover hash, so an invite link is clean', () => {
    at('/#somewhere');
    const link = inviteLink('AB2C');
    expect(link).not.toContain('#somewhere');
  });
});

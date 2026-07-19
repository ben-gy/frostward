/**
 * room-link.ts — reading `?room=` WITHOUT minting anything.
 *
 * The engine ships `getOrCreateRoomCode()`, which mints a code and pushes it
 * into the URL when there isn't one. Frostward must not do that: "Play with
 * friends" offers an explicit create-or-join screen, and a helper that quietly
 * invents a room on every page load would put a `?room=` in the URL of a player
 * who only opened the menu — so a reload, or reopening from the home-screen
 * icon, would drop them into a room they never asked for.
 *
 * So this reads the deep link and nothing else, on the engine's own
 * canonicalisation, so a typed code and a linked code still land in the same
 * Trystero room. Everything else about room codes — minting, the invite link,
 * setting and clearing the URL — comes from '@ben-gy/game-engine/lobby'.
 */

import { normalizeRoomCode } from '@ben-gy/game-engine/lobby';

/** Read `?room=` once, minting nothing. Null when there is no usable deep link. */
export function roomFromUrl(): string | null {
  const raw = new URL(location.href).searchParams.get('room');
  if (!raw) return null;
  const code = normalizeRoomCode(raw);
  return code.length >= 3 ? code : null;
}

/**
 * identity.ts — carry the player's display name between games, without cookies.
 *
 * Every game is its own subdomain, so every game is its own ORIGIN and gets its
 * own localStorage. A cookie on the parent domain would bridge them, but the
 * games promise players "no cookies", and a name is not worth breaking that for.
 *
 * So the name travels the only way left: as a `?n=` parameter on a link the
 * player themselves clicked. Each site seeds its OWN localStorage from it once
 * and strips it. No cookie, no shared store, no identifier.
 */

/** The param name. Short, and unlikely to collide with a game's own params. */
const NAME_PARAM = 'n';
const MAX_NAME = 16;

function clean(raw: string): string {
  // This string lands in other players' lobbies, so it is length-capped and
  // stripped of control characters.
  return raw
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, MAX_NAME);
}

/**
 * Read `?n=` and remove it from the URL immediately.
 *
 * The strip must happen at BOOT, before anything builds an invite link: those
 * links are derived from `location.href`, so a lingering `?n=` would ride along
 * and rename whoever accepted the invite to the host.
 */
export function takeNameFromLink(): string | null {
  const url = new URL(location.href);
  const raw = url.searchParams.get(NAME_PARAM);
  if (raw == null) return null;
  url.searchParams.delete(NAME_PARAM);
  history.replaceState(null, '', url.toString());
  const name = clean(raw);
  return name.length ? name : null;
}

export interface NameStore {
  get<T>(k: string, fallback: T): T;
  set<T>(k: string, v: T): void;
}

/**
 * Resolve this player's name for THIS game: a name carried on the link wins on
 * a first visit, otherwise whatever this game already had. A link never
 * overwrites a name the player has already chosen here.
 */
export function resolveName(store: NameStore, fallback: () => string): string {
  const fromLink = takeNameFromLink();
  const stored = store.get<string>('name', '');
  if (stored) return stored;
  const name = fromLink ?? fallback();
  store.set('name', name);
  return name;
}

/** Add the player's name to an outbound link to a sibling site. */
export function withName(href: string, name: string): string {
  const n = clean(name);
  if (!n) return href;
  try {
    const url = new URL(href, location.href);
    url.searchParams.set(NAME_PARAM, n);
    return url.toString();
  } catch {
    return href;
  }
}

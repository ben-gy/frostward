/**
 * modes.ts — three genuinely different rounds.
 *
 * A mode has to change how the game PLAYS, not a number on a dial (principle
 * #14). These three change the board, the hearth count, the hand size, the deck
 * composition AND, in Whiteout's case, the tempo of the Rime itself:
 *
 *  - Drift     11x11, 3 hearths — the reference game. One Rime step a turn.
 *  - Whiteout  13x13, 3 hearths — every 3rd turn the Rime steps TWICE. A bigger
 *              board would normally be a slower game; the whiteout inverts that,
 *              so distance stops being safety and walls start being mandatory.
 *              The deck is ridge-heavy to make that survivable.
 *  - Emberfall  9x9, 2 hearths, hand of 4, deck stuffed with Embers — nobody is
 *              far from anybody, and frost can be planted rather than steered.
 *              A knife fight; the shortest turn cap of the three.
 *
 * The host's pick is what the room plays and it travels FROZEN inside the round
 * start (see @ben-gy/game-engine/rematch `roundOpts`), because a mode that changes the
 * board size means two peers reading their own menus would be playing different
 * games on the same seed.
 */

export interface DeckSpec {
  veer: number;
  ridge: number;
  thaw: number;
  ember: number;
}

export interface Mode {
  id: string;
  name: string;
  blurb: string;
  /** Board is size x size. Odd, so there is a true centre cell for the Rime. */
  size: number;
  /** Hearths per player. Lose them all and you are out. */
  hearths: number;
  /** Cards held. */
  hand: number;
  /**
   * Every Nth turn the Rime steps twice. 0 = never.
   *
   * PINNED BY A TEST, because it is load-bearing and the obvious value is wrong.
   * Whiteout's board is the biggest, which made it the LONGEST mode rather than
   * the tensest: at doubleStep 3 the median 4-player game ran 33 turns, a third
   * hit the turn cap and ended on a count rather than a kill, and the winner
   * finished untouched 27% of the time. Stepping every 2nd turn instead took the
   * median to 24, capped games to 24% and blowouts to 19%. Dropping the turn cap
   * did NOT help — it only converted natural endings into shrugs.
   */
  doubleStep: number;
  deck: DeckSpec;
  /** Hard stop. If reached, most hearths still lit wins. */
  turnCap: number;
}

export const MODES: Record<string, Mode> = {
  drift: {
    id: 'drift',
    name: 'Drift',
    blurb: '11×11 · 3 hearths · the wind is the whole argument',
    size: 11,
    hearths: 3,
    hand: 3,
    doubleStep: 0,
    deck: { veer: 10, ridge: 6, thaw: 5, ember: 3 },
    turnCap: 60,
  },
  whiteout: {
    id: 'whiteout',
    name: 'Whiteout',
    blurb: '13×13 · every other turn the Rime steps twice',
    size: 13,
    hearths: 3,
    hand: 3,
    doubleStep: 2,
    deck: { veer: 9, ridge: 8, thaw: 6, ember: 2 },
    turnCap: 60,
  },
  emberfall: {
    id: 'emberfall',
    name: 'Emberfall',
    blurb: '9×9 · 2 hearths · hand of 4 · frost you can plant',
    size: 9,
    hearths: 2,
    hand: 4,
    doubleStep: 0,
    deck: { veer: 8, ridge: 4, thaw: 5, ember: 6 },
    turnCap: 45,
  },
};

export const MODE_IDS = ['drift', 'whiteout', 'emberfall'] as const;
export const DEFAULT_MODE = 'drift';

/**
 * Resolve a mode id that arrived off the wire (or out of localStorage, or a
 * share link). `MODES[id] || DEFAULT` is not safe: 'constructor' and 'toString'
 * are truthy properties of every object and would sail through as a Mode of
 * undefined fields. Guard untrusted keys with Object.hasOwn.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id];
  return MODES[DEFAULT_MODE];
}

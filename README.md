# Frostward

**A cone of frost sweeps the board like a searchlight — bend the wind away from your hearths, and it points at someone else.**

🎮 Play: https://frostward.benrichardson.dev

## What it is

A single frozen cell sits at the centre of the board. Every turn it spreads — but **only into the Gale's forward arc**, so it grows as a cone pointing wherever the wind points. Swing the wind and the cone sweeps across the board.

You guard three **hearths** on the rim. Each turn every player secretly commits **one card**, all at once: **Veer** bends the Gale 45° (and everyone's veers that turn *add up*, so the wind is a tug-of-war), **Ridge** walls a cell the frost cannot enter, **Thaw** melts a plus-shaped patch that cannot refreeze this turn, and **Ember** plants a brand-new cone seed anywhere on the board. Cards reveal, then the Rime steps once. A hearth it reaches beats it back the first time; the second time, that hearth goes dark for good. **Last player with a lit hearth wins.**

The whole game lives in one tension: a turn spent bending the wind is a turn not spent walling, and the only way to get the cone off your own hearths is to point it at somebody else's. Because the board only ever gets colder — Thaw buys time, it never wins — every match has a visible horizon.

Play it solo against one to three bots at three difficulties, chase a worldwide **Daily Gale** on a seed everyone shares, or open a room and play with 2–4 friends peer-to-peer.

## How to play

- **Desktop:** click a card to select it, then click a highlighted cell to place it. Veer shows two bend buttons instead.
- **Mobile:** tap a card then a cell — or **drag the card straight onto the board**. Tap is always a first-class action, never a second-class fallback.
- Straight down the wind the frost always advances. Sideways it only creeps into a cell that is already half-surrounded, so young frost is a finger one ridge can stop and old frost is a wall you cannot.
- If nobody bends the Gale on a turn, it drifts toward whoever still holds the most hearths.

**Three modes**, and they change how a round plays rather than moving a dial:

| Mode | Board | Hearths | Hand | The twist |
|---|---|---|---|---|
| **Drift** | 11×11 | 3 | 3 | The reference game — the wind is the whole argument. |
| **Whiteout** | 13×13 | 3 | 3 | Every other turn the Rime steps **twice**. Distance stops being safety. |
| **Emberfall** | 9×9 | 2 | 4 | Ember-heavy deck on a tight board. A knife fight. |

## Multiplayer

**Live peer-to-peer for 2–4 players, with no server.** Create a room and share the code (or the link — a friend can *type* the code, they don't need the link), and browsers connect directly over WebRTC. A free public signalling relay only introduces the browsers to each other; no game state is stored anywhere, and no board state is ever transmitted.

That last part is the design: a round is a pure function of `(seed, mode, roster, every commit so far)`, so peers exchange **only their committed cards** and each recomputes an identical board. Three things follow for free — a host that leaves is replaced instantly by a survivor who already holds the whole game state, a late joiner rebuilds the exact board from a few kilobytes of replay, and a dropped packet heals itself. A player who closes their tab has their seat played out by the bot, so the table never stalls on an empty chair.

Every round ends with **everyone's breakdown** — how long each player lasted, what they spent their cards on, and how many turns the Gale spent pointing at them. "Play again" starts a fresh round inside the same room, with a running match tally.

Prefer to play alone? Share a **challenge link** and a friend gets the byte-identical board to try.

## Balance

Frostward is competitive, so `tests/balance.test.ts` simulates hundreds of AI-vs-AI matches per mode and asserts on the *shape* of the outcome — every seat within a few points of chance, the opening rarely already decided, blowouts bounded, every match terminating.

It overruled the original design twice. The first build spread the full 135° arc unconditionally: a cone at hearth range was nine cells wide against a three-cell hearth cluster, so whoever the wind found lost everything at once. Median game: **three turns**. The fixes that measured well — frost advancing straight but only creeping sideways into a half-surrounded cell, a hearth that beats back its first freeze, and hearths fanned across the sector — are all documented in that file, along with the confident-sounding fixes that measured as nothing.

## Tech

- Vite 6 + vanilla TypeScript
- DOM/CSS rendering (real buttons, so keyboard and screen readers work by default)
- Shared engine: deterministic seeded RNG, Trystero P2P netcode, procedural Web Audio
- Vitest — 230 tests covering the rules, P2P determinism, host transfer, the rematch protocol, host election, phone layout and balance
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts, no service worker. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
npm run icons   # regenerate the home-screen icons
```

## License

MIT

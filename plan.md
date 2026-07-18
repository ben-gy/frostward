# Game Plan: Frostward

## Overview
- **Name:** Frostward
- **Repo name:** frostward
- **Tagline:** A cone of frost sweeps the board like a searchlight — everyone bends the wind, and bending it away from you aims it at someone else.
- **Genre (directory category):** board

## Core Loop

A single frozen cell sits at the centre of the board. Every turn it spreads — but only
**into the Gale's forward arc**, so the frost grows as a widening cone pointing wherever the
wind points. Swing the wind and the cone sweeps across the board like a searchlight.

You guard **three Hearths** in your own sector of the rim. Each turn every player secretly
commits **one card**:

- **Veer** — bend the Gale 45° left or right. Everyone's veers this turn **sum**, so the wind
  is a tug-of-war. This is the whole game: pushing it off your hearths necessarily points it
  at a rival's.
- **Ridge** — raise a stone wall on one clear cell. Frost cannot enter or pass it.
- **Thaw** — melt a plus-shaped patch of frost back to clear; it cannot refreeze this step.
- **Ember** — freeze one clear cell anywhere, planting a *new* cone seed deep in someone
  else's sector. Rare, and it changes the whole map.

Cards reveal, resolve in a seeded order, then the **Rime steps once**. Any hearth the frost
reaches goes dark. Lose all your hearths and you're out; **the last player with a lit hearth
wins**.

Tension: a turn spent veering is a turn not spent walling, and every wall you build is one
the wind will eventually come back around to. The board only ever gets colder — thaw buys
time, it never wins — so the match has a hard, visible horizon.

**Win:** be the last player with a lit hearth (or hold the most hearths at the turn cap).
**Lose:** all three hearths snuffed.

## Controls
- **Desktop:** click a card to select, click a legal cell to commit (or press `1`–`4` to
  select a card, arrows to veer, `Enter` to commit, `Esc` to deselect).
- **Mobile:** tap a card to select, tap a highlighted cell to place it — **or drag the card
  straight onto the cell** via `patterns/drag.ts` (tap stays a first-class action). Veer
  shows two large ◀ / ▶ buttons in the lower thumb zone. No D-pad; this is a board game, so
  it gets the tap/drag classifier per principle #19.

## Multiplayer
- **Mode:** live P2P (plus solo vs bots and a UTC daily seed with a share link).
- **If live P2P — shape:** **versus**. Justified, not defaulted: the single contested
  resource in this game is one number — the Gale's heading — and the *only* reason bending it
  is interesting is that the arc it leaves has to land on somebody. A co-op Frostward would
  have nothing to argue about: every player would veer the same way and the cone would sit in
  the empty middle forever. Shared-world doesn't fit either, because the Rime has to threaten
  someone or it is scenery. The adversarial pull is structural here, not a scoring shortcut.
- **Players:** 2–4. Topology: **host-authoritative**, but the sim is a *pure function* of
  `(seed, mode, roster, every commit so far)`, so every peer runs the identical simulation
  locally and the host only adjudicates *which commits happened*.
- **Channels** (all ≤ 12 bytes): `cmt` (a peer's commit: `{turn, card, target}`), `trn` (the
  host's authoritative turn resolution: `{turn, commits[], order[]}`), `sync` (host's full
  state for a late joiner / desync heal).
- **Room entry:** `createRoomEntry` — Create a room **or** type a code. `?room=` honoured once
  and cleared on the way out (`clearRoomInUrl`).
- **Late joiner:** receives `sync`, spectates the live round with the full board visible, and
  joins the next round via `rematch.ts`.
- **Peer leaves mid-round:** their seat is auto-played by the bot for the rest of the round —
  the match never stalls on an empty chair, it just gets a weaker opponent.
- **Host leaves:** `net.ts` promotes a survivor; `onHostChange → Match.setHost(true)`. Because
  every peer already holds identical state (it applied every `trn` itself), the takeover is a
  no-op state-wise: the promoted peer simply starts collecting commits, running the turn
  clock (`setInterval`, not rAF) and broadcasting `trn`. It can still drive the match to game
  over — proven by `tests/takeover.test.ts`.
- **Turn clock:** host-authoritative, 25s in multiplayer. On expiry the host auto-commits the
  bot's choice for anyone silent, so one idle player can never freeze the table.

### End of round → rematch (MANDATORY)
"Play again" **never touches the room**. `createRounds` votes a new round number and the host
broadcasts a fresh seed + the frozen roster; the Net and the whole mesh stay up for the
session. While waiting, each peer sees who has voted and a **visible countdown**
(`state().startsInMs`) after quorum; the host can always force start; the summary always
offers **Back to lobby** (which does not leave the room) as well as Menu. A player who
declines or closes the tab is dropped from the roster and the round starts without them. If
the **host** leaves at the summary, the promoted peer runs the rematch inheriting no tally.
A **running match tally** (rounds won per player) persists across rounds and is shown on
every summary.

## Juice Plan
- **Sound** (`sound.ts`, extended): `veer` (a wind whoosh — filtered noise sweep), `ridge`
  (stone thud), `thaw` (warm rising chime), `ember` (crackle), `creep` (the Rime step — a soft
  icy hiss whose pitch rises with how many cells froze), `snuff` (a hearth going dark — a
  descending sad tone), `out` (elimination), `win`. Countdown beats on 3-2-1-GO.
- **Particles:** frost motes drifting along the Gale across the whole board (CSS-animated,
  count reduced under `prefers-reduced-motion`); a burst of sparks when a hearth is snuffed;
  a warm bloom on a Thaw.
- **Screen shake:** short shake on the Rime step *only* when it snuffs a hearth; a bigger one
  on your own.
- **Tweens:** newly frozen cells scale-in with a 180ms ease; the Gale arrow rotates with a
  260ms `cubic-bezier(0.2,0.8,0.2,1)` so you *see* the wind swing; cards lift on select and
  snap 160ms on drop.
- **Feedback:** committed-player chips fill in as peers lock in; the threatened cells (what
  would freeze next step at the *current* gale) glow faintly, so the wind reads as a threat
  before it lands.

## Style Direction
**Vibe:** cold minimal — a dark winter night, a bright cone of ice, warm points of light.
**Palette:** background `#0a1622`; clear cell `#16283a`; frost `#cfe8f5`; ridge `#8b7d68`
(stone); thaw `#fbbf24` (warm amber). Players: amber `#f59e0b`, sky `#38bdf8`, pink `#f472b6`,
pale `#e2e8f0` — chosen to stay separable under deuteranopia/protanopia, and **backed by a
distinct hearth glyph per seat** (●, ▲, ■, ◆) so colour is never the only channel.
**Theme:** dark.
**Reference feel:** the readable calm of a good abstract board app, with the cone-sweep drama
of a lighthouse. Feel only, no IP.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** **DOM/CSS grid** — crisp cells, trivial hit-testing for tap/drag, accessible by
  default, and responsive without a resize handler. Particles are CSS.
- **Engine modules copied from patterns/:** `net`, `rematch`, `lobby`, `rng`, `drag`,
  `storage`, `identity`, `mobile` (+ `mobile.css`), and a game-local `sound.ts` extended from
  `patterns/sound.ts`.
- **Persistence:** localStorage via `storage.ts` — name, mute, chosen mode, how-to-play seen,
  best solo survival per mode, daily results.

### Fairness by construction (principle #18 / starting balance)
- Seats sit at angle `2πk/N + θ(seed)` on a circle of radius `0.42 × size` from the board
  centre, so no seat gets a structurally better corner; **θ is seed-random**, so whatever
  asymmetry the square lattice leaves is not attached to a seat index.
- Every player starts with an **identical** hearth count, an identical deck composition, and
  an identical hand size. Asserted over many seeds in `tests/game.test.ts`.
- The **initial Gale bisects seats 0 and 1** rather than being random — a random opening wind
  would sometimes point straight at a seat on turn 1, which is a coin flip nobody played for.
- Card **resolution order within a turn** is seed-shuffled per turn, so no seat gets a
  permanent last-word advantage on contested placements.

## Non-Goals
- No fog of war, no hidden board state (everything is public; only the *committed card* is
  secret, and only until reveal).
- No campaign, no persistent progression, no accounts.
- No public matchmaking / noticeboard this run — private rooms + solo + daily only.
- No animated tile art beyond CSS; no WebGL.

## How To Play (player-facing copy)
> The Rime spreads from the centre, but only **into the wind's forward arc** — so it grows as
> a cone pointing wherever the Gale points.
> Each turn, secretly play one card: **Veer** bends the Gale (everyone's veers add up),
> **Ridge** walls a cell, **Thaw** melts a patch, **Ember** plants new frost anywhere.
> Then the Rime steps once. Any Hearth it touches goes dark.
> **Last player with a lit Hearth wins.**

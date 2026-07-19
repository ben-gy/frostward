/**
 * main.ts — boot, screens, and the room's lifecycle.
 *
 * The one structural rule everything here bends around: ONE ROOM PER SESSION.
 * `enterRoom` is called once; the lobby, every round and every rematch happen
 * INSIDE that room, and `leaveRoom` (which awaits `net.leave()` and clears
 * `?room=`) is only reached by going back to the menu. There is no path that
 * leaves and re-joins the same room, because that hands back Trystero's dying
 * room object and leaves both players hosting an empty mesh.
 */

// feedback:begin (managed by hub/scripts/feedback/backfill.mjs)
import { mountFeedback } from './feedback';
mountFeedback();
// feedback:end

import './styles/mobile.css';
import './styles/main.css';

import { hardenViewport } from './engine/mobile';
import { createStore } from './engine/storage';
import { resolveName, withName } from './engine/identity';
import { hashSeed, newSeed } from './engine/rng';
import { createNet, type Net } from './engine/net';
import { createRounds, type RoundInfo, type Rounds } from './engine/rematch';
import {
  clearRoomInUrl,
  createLobby,
  createRoomEntry,
  roomFromUrl,
  setRoomInUrl,
} from './engine/lobby';
import { startCountdown, type Countdown } from './countdown';
import { createSfx } from './sound';
import { clearFx } from './fx';
import { DEFAULT_MODE, MODES, MODE_IDS, modeOf } from './modes';
import { CARD_INFO, litCount, type CardKind, type Commit } from './game';
import {
  Match,
  soloMatch,
  type CommitMsg,
  type LockMsg,
  type RosterEntry,
  type SyncMsg,
  type TurnMsg,
} from './net-game';
import { GameView, type ViewModel } from './render';
import { renderResults } from './results';

const APP_ID = 'frostward';
const TURN_MS = 25000;
const MAX_PLAYERS = 4;

const BOT_LEVELS = [
  { id: 'calm', name: 'Calm', noise: 9 },
  { id: 'keen', name: 'Keen', noise: 3 },
  { id: 'ruthless', name: 'Ruthless', noise: 0 },
];

const app = document.getElementById('app')!;
const store = createStore(APP_ID);
const sfx = createSfx(store.get('muted', false));

hardenViewport();

let playerName = resolveName(store, () => `Warden ${Math.floor(Math.random() * 900 + 100)}`);
let modeId = modeOf(store.get('mode', DEFAULT_MODE)).id;
let botCount = Math.min(3, Math.max(1, store.get('bots', 1)));
let botLevel = store.get('level', 'keen');

/** ?room= is honoured ONCE per page load, then never again this session. */
let deepLinkRoom = roomFromUrl();

let net: Net | null = null;
let rounds: Rounds | null = null;
let roomCode = '';
let lobbyView: { destroy(): void } | null = null;
let entryView: { destroy(): void } | null = null;
let match: Match | null = null;
let view: GameView | null = null;
let countdown: Countdown | null = null;
let roundLive = false;
let selected: number | null = null;
let notice = '';
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let resultsTimer: ReturnType<typeof setInterval> | undefined;
let soloContext: { seed: number; daily: string | null } | null = null;
const tally: Record<number, number> = {};

// ── shell ───────────────────────────────────────────────────────────────────

app.innerHTML = `
  <main class="main-content" id="screen"></main>
  <footer class="site-footer">
    Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
    · <a class="hub-link" href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
  </footer>`;
const screen = document.getElementById('screen')!;

const hub = app.querySelector<HTMLAnchorElement>('.hub-link');
if (hub) hub.href = withName(hub.href, playerName);

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

function setNotice(msg: string, ms = 5000): void {
  notice = msg;
  if (noticeTimer) clearTimeout(noticeTimer);
  if (msg) {
    noticeTimer = setTimeout(() => {
      notice = '';
      repaint();
    }, ms);
  }
}

function stopResultsTick(): void {
  if (resultsTimer) clearInterval(resultsTimer);
  resultsTimer = undefined;
}

/** Tear down whatever the previous screen owned. Never touches the Net. */
function clearScreen(): void {
  stopResultsTick();
  countdown?.cancel();
  countdown = null;
  view?.destroy();
  view = null;
  lobbyView?.destroy();
  lobbyView = null;
  entryView?.destroy();
  entryView = null;
  document.body.classList.remove('playing');
  screen.innerHTML = '';
}

function unlockAudioOnce(): void {
  sfx.unlock();
}
document.addEventListener('pointerdown', unlockAudioOnce, { once: true });
document.addEventListener('keydown', unlockAudioOnce, { once: true });

// ── menu ────────────────────────────────────────────────────────────────────

function modePicker(current: string, editable: boolean): string {
  return `<div class="modes" role="radiogroup" aria-label="Mode">
    ${MODE_IDS.map((id) => {
      const m = MODES[id];
      return `<button class="mode${id === current ? ' is-on' : ''}" type="button" data-mode="${id}"
          role="radio" aria-checked="${id === current}" ${editable ? '' : 'disabled'}>
        <b>${esc(m.name)}</b><small>${esc(m.blurb)}</small>
      </button>`;
    }).join('')}
  </div>`;
}

function wireModePicker(): void {
  screen.querySelectorAll<HTMLElement>('.mode').forEach((b) => {
    b.addEventListener('click', () => {
      modeId = modeOf(b.dataset.mode).id;
      store.set('mode', modeId);
      sfx.play('select');
      showSolo();
    });
  });
}

function showMenu(): void {
  clearScreen();
  screen.innerHTML = `
    <div class="menu">
      <h1 class="logo">Frost<span>ward</span></h1>
      <p class="tagline">The Rime only spreads into the wind. Bend the wind away from your hearths — and it points at someone else.</p>
      <div class="menu-actions">
        <button class="lobby-btn primary" type="button" data-go="solo">Play</button>
        <button class="lobby-btn" type="button" data-go="friends">Play with friends</button>
        <button class="lobby-btn" type="button" data-go="daily">Daily gale</button>
      </div>
      <div class="menu-small">
        <button class="ghost-btn" type="button" data-go="how">How to play</button>
        <button class="ghost-btn" type="button" data-go="about">About</button>
        <button class="ghost-btn" type="button" data-go="mute">${sfx.muted() ? 'Sound off' : 'Sound on'}</button>
      </div>
      <p class="menu-name">Playing as <button class="linkish" type="button" data-go="name">${esc(playerName)}</button></p>
    </div>`;

  screen.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => {
    b.addEventListener('click', () => {
      sfx.play('select');
      switch (b.dataset.go) {
        case 'solo':
          return showSolo();
        case 'friends':
          return playWithFriends();
        case 'daily':
          return startDaily();
        case 'how':
          return showHow(showMenu);
        case 'about':
          return showAbout();
        case 'mute':
          sfx.setMuted(!sfx.muted());
          store.set('muted', sfx.muted());
          return showMenu();
        case 'name':
          return showName();
      }
    });
  });

  if (!store.get('seenHow', false)) {
    store.set('seenHow', true);
    showHow(showMenu);
  }
}

function showName(): void {
  clearScreen();
  screen.innerHTML = `
    <div class="panel">
      <h2>Your name</h2>
      <p class="muted">Shown to the other players in a room.</p>
      <form class="name-form">
        <input class="text-input" type="text" maxlength="16" value="${esc(playerName)}" aria-label="Your name" />
        <button class="lobby-btn primary" type="submit">Save</button>
      </form>
      <button class="ghost-btn" type="button" data-back>Back</button>
    </div>`;
  const input = screen.querySelector<HTMLInputElement>('.text-input')!;
  screen.querySelector<HTMLFormElement>('.name-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = input.value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 16);
    if (next) {
      playerName = next;
      store.set('name', next);
    }
    showMenu();
  });
  screen.querySelector('[data-back]')?.addEventListener('click', showMenu);
}

function showHow(back: () => void): void {
  clearScreen();
  screen.innerHTML = `
    <div class="panel">
      <h2>How to play</h2>
      <ol class="how">
        <li>A single frozen cell sits at the centre. Every turn it spreads — but <b>only into the Gale's forward arc</b>, so it grows as a cone pointing wherever the wind points.</li>
        <li>You guard <b>hearths</b> on the rim. Each turn everyone secretly plays <b>one card</b>, all at once.</li>
        <li>Then the Rime steps. A hearth it reaches <b>beats it back once</b>; the next time, that hearth goes dark for good.</li>
        <li><b>Last player with a lit hearth wins.</b></li>
      </ol>
      <ul class="cards-help">
        ${(Object.keys(CARD_INFO) as CardKind[])
          .map(
            (k) =>
              `<li class="k-${k}"><span class="card-glyph">${CARD_INFO[k].glyph}</span>
               <span><b>${esc(CARD_INFO[k].name)}</b> ${esc(CARD_INFO[k].help)}</span></li>`,
          )
          .join('')}
      </ul>
      <p class="muted">Straight down the wind the frost always advances. Sideways it only creeps into a cell that is already half-surrounded — so young frost is a finger one ridge can stop, and old frost is a wall you cannot.</p>
      <p class="muted">Tap a card then a highlighted cell, or drag the card onto the board. If nobody bends the Gale, it drifts toward whoever has the most hearths left.</p>
      <button class="lobby-btn primary" type="button" data-back>Got it</button>
    </div>`;
  screen.querySelector('[data-back]')?.addEventListener('click', back);
}

function showAbout(): void {
  clearScreen();
  screen.innerHTML = `
    <div class="panel">
      <h2>About Frostward</h2>
      <p>A small board game about a spreading frost and one shared wind. Original rules, procedural art and procedural sound — no assets, no third-party fonts, no cookies, no tracking beyond an anonymous, cookie-less page-view count.</p>
      <p><b>Playing with friends</b> is peer-to-peer over WebRTC: there is no game server, and no board state is stored anywhere. Connecting does use a free public signalling relay to introduce the browsers to each other, which means the people in your room can see your IP address — the same as any direct connection. Only invite people you know.</p>
      <p>Everything else runs entirely in this tab and works offline.</p>
      <p class="muted">Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>.</p>
      <button class="lobby-btn primary" type="button" data-back>Back</button>
    </div>`;
  screen.querySelector('[data-back]')?.addEventListener('click', showMenu);
}

// ── solo ────────────────────────────────────────────────────────────────────

function showSolo(): void {
  clearScreen();
  screen.innerHTML = `
    <div class="panel">
      <h2>Play</h2>
      <p class="muted">Pick a mode.</p>
      ${modePicker(modeId, true)}
      <div class="opts">
        <div class="opt">
          <span class="opt-label">Opponents</span>
          <div class="seg" role="radiogroup" aria-label="Opponents">
            ${[1, 2, 3]
              .map(
                (n) =>
                  `<button class="seg-btn${n === botCount ? ' is-on' : ''}" type="button" data-bots="${n}" role="radio" aria-checked="${n === botCount}">${n}</button>`,
              )
              .join('')}
          </div>
        </div>
        <div class="opt">
          <span class="opt-label">They play</span>
          <div class="seg" role="radiogroup" aria-label="Difficulty">
            ${BOT_LEVELS.map(
              (l) =>
                `<button class="seg-btn${l.id === botLevel ? ' is-on' : ''}" type="button" data-level="${l.id}" role="radio" aria-checked="${l.id === botLevel}">${l.name}</button>`,
            ).join('')}
          </div>
        </div>
      </div>
      <button class="lobby-btn primary" type="button" data-start>Start</button>
      <button class="ghost-btn" type="button" data-back>Back</button>
    </div>`;

  wireModePicker();
  screen.querySelectorAll<HTMLElement>('[data-bots]').forEach((b) =>
    b.addEventListener('click', () => {
      botCount = Number(b.dataset.bots);
      store.set('bots', botCount);
      sfx.play('select');
      showSolo();
    }),
  );
  screen.querySelectorAll<HTMLElement>('[data-level]').forEach((b) =>
    b.addEventListener('click', () => {
      botLevel = b.dataset.level!;
      store.set('level', botLevel);
      sfx.play('select');
      showSolo();
    }),
  );
  screen.querySelector('[data-start]')?.addEventListener('click', () => startSolo(newSeed(), null));
  screen.querySelector('[data-back]')?.addEventListener('click', showMenu);
}

const utcDay = (): string => new Date().toISOString().slice(0, 10);

function startDaily(): void {
  startSolo(hashSeed(`frostward:${utcDay()}:${modeId}`), utcDay());
}

function startSolo(seed: number, daily: string | null): void {
  soloContext = { seed, daily };
  const noise = BOT_LEVELS.find((l) => l.id === botLevel)?.noise ?? 3;
  clearScreen();
  const m = soloMatch(seed, modeId, playerName, botCount, noise, {
    onTurn: (log) => view?.animate(log, match?.mySeat ?? 0, sfx),
    onChange: repaint,
    onOver: onRoundOver,
  });
  beginRound(m);
}

// ── multiplayer ─────────────────────────────────────────────────────────────

function playWithFriends(): void {
  if (deepLinkRoom) {
    // A deep link is consumed exactly once. After this, "Play with friends"
    // always offers create-or-join, so a reload can never drag someone back
    // into a room they have left.
    const code = deepLinkRoom;
    deepLinkRoom = null;
    return enterRoom(code, false);
  }
  if (net) return showLobby();
  clearScreen();
  entryView = createRoomEntry({
    container: screen,
    onSubmit: (code, created) => enterRoom(code, created),
    onCancel: showMenu,
  });
}

function enterRoom(code: string, created: boolean): void {
  roomCode = code;
  setRoomInUrl(code);
  clearScreen();

  net = createNet(
    { appId: APP_ID, roomId: code, claimHost: created },
    {
      onHostChange: (_id, isSelf) => {
        match?.setHost(isSelf);
        if (isSelf && match && !match.state.over) setNotice("The host left — you are the host now.");
        repaint();
      },
      onPeerJoin: (id) => {
        // Bring a late arrival up to date so they can watch the live round.
        if (net?.isHost() && match) match.sendSyncTo(id);
        repaint();
      },
      onPeerLeave: (id) => {
        match?.dropPeer(id);
        repaint();
      },
      onPeers: () => repaint(),
    },
  );

  const sendCommit = net.channel<CommitMsg>('cmt', (m, from) => match?.onCommitMsg(m, from));
  const sendTurn = net.channel<TurnMsg>('trn', (m, from) => {
    if (from === net?.host()) match?.onTurnMsg(m);
  });
  const sendLocks = net.channel<LockMsg>('lok', (m, from) => {
    if (from === net?.host()) match?.onLockMsg(m);
  });
  const sendSync = net.channel<SyncMsg>('sync', (m, from) => {
    if (from === net?.host()) match?.onSyncMsg(m);
  });
  transport = {
    sendCommit,
    sendTurn,
    sendLocks,
    sendSync: (m, to) => sendSync(m, to),
  };

  rounds = createRounds({
    net,
    playerName,
    minPlayers: 2,
    roundOpts: () => ({ mode: modeId }),
    onRound: onNetRound,
    onChange: () => {
      if (isOnResults()) paintResults();
    },
  });

  showLobby();
}

let transport = {
  sendCommit: (_m: CommitMsg) => {},
  sendTurn: (_m: TurnMsg) => {},
  sendLocks: (_m: LockMsg) => {},
  sendSync: (_m: SyncMsg, _to?: string) => {},
};

/** The host's mode, as gossiped — never this peer's own menu setting. */
function hostModeId(): string {
  if (!rounds) return modeId;
  const s = rounds.state();
  if (s.isHost) return modeId;
  const opts = s.hostOpts as { mode?: unknown } | null;
  return opts && opts.mode !== undefined ? modeOf(opts.mode).id : '';
}

function showLobby(): void {
  if (!net || !rounds) return showMenu();
  clearScreen();
  const holder = document.createElement('div');
  holder.className = 'lobby-holder';
  screen.appendChild(holder);

  const picker = document.createElement('div');
  picker.className = 'lobby-modes';
  screen.appendChild(picker);

  const paintPicker = (): void => {
    const amHost = net!.isHost();
    picker.innerHTML = amHost
      ? `<p class="pick-label">Your room, your rules</p>${modePicker(modeId, true)}`
      : '';
    picker.querySelectorAll<HTMLElement>('.mode').forEach((b) => {
      b.addEventListener('click', () => {
        modeId = modeOf(b.dataset.mode).id;
        store.set('mode', modeId);
        sfx.play('select');
        paintPicker();
      });
    });
  };
  paintPicker();
  const pickerPoll = setInterval(paintPicker, 900);

  lobbyView = createLobby({
    container: holder,
    net,
    rounds,
    roomCode,
    minPlayers: 2,
    maxPlayers: MAX_PLAYERS,
    modeLine: () => {
      const id = hostModeId();
      return id ? `Playing ${MODES[id].name} — ${MODES[id].blurb}` : 'Waiting for the host…';
    },
    onCancel: () => void leaveRoom(),
  });

  const wrapped = lobbyView;
  lobbyView = {
    destroy() {
      clearInterval(pickerPoll);
      wrapped.destroy();
    },
  };
}

async function leaveRoom(): Promise<void> {
  clearScreen();
  rounds?.destroy();
  rounds = null;
  match?.destroy();
  match = null;
  const n = net;
  net = null;
  roomCode = '';
  clearRoomInUrl();
  showMenu();
  // Awaited so a later room join can never alias a room still tearing down.
  try {
    await n?.leave();
  } catch {
    /* the room is gone either way */
  }
}

function onNetRound(info: RoundInfo): void {
  const opts = info.opts as { mode?: unknown } | undefined;
  const mode = modeOf(opts?.mode).id;
  const roster: RosterEntry[] = info.players.map((p) => ({ id: p.id, name: p.name }));
  clearScreen();
  const m = new Match({
    seed: info.seed,
    mode,
    roster,
    selfId: net!.selfId,
    isHost: net!.isHost(),
    turnMs: TURN_MS,
    transport,
    onTurn: (log) => view?.animate(log, match?.mySeat ?? 0, sfx),
    onChange: repaint,
    onOver: onRoundOver,
  });
  beginRound(m);
}

// ── a round ─────────────────────────────────────────────────────────────────

function beginRound(m: Match): void {
  match = m;
  selected = null;
  roundLive = false;
  soloContext = net ? null : soloContext;
  document.body.classList.add('playing');

  view = new GameView(screen, {
    onSelectCard: (i) => {
      if (!roundLive || !match || match.committed()) return;
      selected = selected === i ? null : i;
      sfx.play(selected === null ? 'deselect' : 'select');
      repaint();
    },
    onCell: (cell) => {
      if (!roundLive || !match || match.committed() || selected === null) return;
      const me = match.state.players[match.mySeat];
      const kind = me?.hand[selected];
      if (!kind || kind === 'veer') return;
      lockIn({ card: selected, cell });
    },
    onVeer: (dir) => {
      if (!roundLive || !match || match.committed() || selected === null) return;
      lockIn({ card: selected, dir });
    },
    onUncommit: () => {
      match?.uncommit();
      selected = null;
      sfx.play('deselect');
      repaint();
    },
    onMenu: () => showPause(),
  });
  view.mount(viewModel());
  runCountdown(() => {
    roundLive = true;
    repaint();
  });
}

function lockIn(c: Commit): void {
  if (!match) return;
  match.commit(c);
  selected = null;
  sfx.play('commit');
  repaint();
}

function viewModel(): ViewModel {
  const m = match!;
  return {
    state: m.state,
    mySeat: m.mySeat,
    committed: m.committed(),
    lockedSeats: m.lockedSeats(),
    remainingMs: roundLive ? m.remainingMs() : null,
    isBotSeat: (seat) => m.isBotSeat(seat),
    selected,
    notice,
  };
}

function repaint(): void {
  if (view && match) view.update(viewModel());
  else if (isOnResults()) paintResults();
}

/**
 * 3, 2, 1, BLOW.
 *
 * The stale sweep happens BEFORE the new overlay is appended, and it matters: a
 * countdown's cancel() stops its timer but cannot remove an element, and the
 * fade-out removal runs on its own timer — so re-entering this (next round, host
 * takeover, rematch) would otherwise orphan a full-screen dim layer. They are
 * pointer-events:none so taps still land, but stacked they darken the board
 * until the game looks broken. Pinned by tests/source-hygiene.test.ts.
 */
function runCountdown(done: () => void): void {
  screen.querySelectorAll('.countdown').forEach((el) => el.remove());
  const overlay = document.createElement('div');
  overlay.className = 'countdown';
  overlay.setAttribute('aria-hidden', 'true');
  screen.appendChild(overlay);

  countdown = startCountdown({
    from: 3,
    beatMs: 620,
    onBeat: (n) => {
      overlay.textContent = n > 0 ? String(n) : 'BLOW';
      overlay.classList.toggle('go', n === 0);
      overlay.classList.remove('beat');
      void overlay.offsetWidth;
      overlay.classList.add('beat');
      sfx.play(n > 0 ? 'beat' : 'go');
    },
    onDone: () => {
      setTimeout(() => overlay.remove(), 320);
      countdown = null;
      done();
    },
  });
}

function showPause(): void {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `
    <div class="modal-card">
      <h2>Paused</h2>
      <p class="muted">${net ? 'The round keeps running for the others — the Gale does not wait.' : 'Take your time.'}</p>
      <button class="lobby-btn primary" type="button" data-act="resume">Resume</button>
      <button class="lobby-btn" type="button" data-act="how">How to play</button>
      <button class="lobby-btn" type="button" data-act="mute">${sfx.muted() ? 'Sound off' : 'Sound on'}</button>
      <button class="ghost-btn" type="button" data-act="quit">${net ? 'Leave the room' : 'Back to menu'}</button>
    </div>`;
  screen.appendChild(wrap);
  wrap.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'resume') return wrap.remove();
    if (act === 'mute') {
      sfx.setMuted(!sfx.muted());
      store.set('muted', sfx.muted());
      wrap.remove();
      return showPause();
    }
    if (act === 'how') {
      wrap.remove();
      const back = (): void => {
        if (match) beginRound(match);
        else showMenu();
      };
      // Re-entering the round would restart it, so the help screen returns to
      // the results/menu instead of resurrecting a live board.
      return showHowOverlay(back);
    }
    if (act === 'quit') {
      match?.destroy();
      match = null;
      if (net) void leaveRoom();
      else showMenu();
    }
  });
}

function showHowOverlay(back: () => void): void {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="modal-card scrolly">
      <h2>How to play</h2>
      <ul class="cards-help">
        ${(Object.keys(CARD_INFO) as CardKind[])
          .map(
            (k) =>
              `<li class="k-${k}"><span class="card-glyph">${CARD_INFO[k].glyph}</span>
               <span><b>${esc(CARD_INFO[k].name)}</b> ${esc(CARD_INFO[k].help)}</span></li>`,
          )
          .join('')}
      </ul>
      <p class="muted">Frost always advances straight down the wind, and only creeps sideways into a cell that is already half-surrounded.</p>
      <button class="lobby-btn primary" type="button" data-close>Back</button>
    </div>`;
  screen.appendChild(wrap);
  wrap.querySelector('[data-close]')?.addEventListener('click', () => {
    wrap.remove();
    back();
  });
}

// ── results ─────────────────────────────────────────────────────────────────

const isOnResults = (): boolean => !!screen.querySelector('.results');

function onRoundOver(): void {
  if (!match) return;
  for (const seat of match.state.winners) tally[seat] = (tally[seat] ?? 0) + 1;
  sfx.play(match.state.winners.includes(match.mySeat) ? 'win' : 'lose');
  roundLive = false;
  rounds?.finish();
  // Let the last Rime step land before the summary covers it.
  setTimeout(() => {
    if (!match) return;
    clearFx(screen.querySelector('.fx-layer'));
    showResults();
  }, 1200);
}

function showResults(): void {
  clearScreen();
  paintResults();
  if (net) resultsTimer = setInterval(paintResults, 400);
}

function paintResults(): void {
  if (!match) return;
  const s = rounds?.state();
  const actions: { label: string; act: string; primary?: boolean }[] = [];
  let waiting = '';

  if (net && rounds) {
    actions.push({ label: s?.voted ? 'Waiting…' : 'Play again', act: 'again', primary: !s?.voted });
    if (s?.isHost && s.canStart) actions.push({ label: 'Start now', act: 'force' });
    actions.push({ label: 'Back to lobby', act: 'lobby' });
    actions.push({ label: 'Leave the room', act: 'menu' });
    if (s?.voted) {
      const others = s.present.length - s.votes.length;
      waiting =
        s.startsInMs !== null
          ? `Starting in ${Math.ceil(s.startsInMs / 1000)}s without anyone still deciding.`
          : others > 0
            ? `Waiting for ${others} more to tap Play again.`
            : 'Starting…';
    }
  } else {
    actions.push({ label: 'Play again', act: 'again', primary: true });
    actions.push({ label: 'Change mode', act: 'solo' });
    actions.push({ label: 'Menu', act: 'menu' });
  }

  const me = match.state.players[match.mySeat];
  let benchmark: string | undefined;
  if (!net && me) {
    const best = store.get<number>(`best:${match.state.mode.id}`, 0);
    const survived = me.out === null ? match.state.turn : me.out;
    if (survived > best) store.set(`best:${match.state.mode.id}`, survived);
    benchmark = `You lasted ${survived} turns. Your best on ${match.state.mode.name}: ${Math.max(best, survived)}.`;
    if (soloContext?.daily) benchmark += ` · Daily gale for ${soloContext.daily}.`;
  }

  renderResults(screen, {
    state: match.state,
    mySeat: match.mySeat,
    tally,
    actions,
    waiting,
    benchmark,
  });

  if (!net && soloContext) {
    const share = document.createElement('button');
    share.className = 'ghost-btn';
    share.type = 'button';
    share.textContent = 'Share this board';
    share.addEventListener('click', () => void shareSeed());
    screen.querySelector('.res-actions')?.appendChild(share);
  }

  screen.querySelector('.res-actions')?.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    sfx.play('select');
    if (act === 'again') {
      if (net && rounds) {
        if (rounds.state().voted) rounds.unvote();
        else rounds.vote();
        return paintResults();
      }
      return startSolo(newSeed(), null);
    }
    if (act === 'force') return rounds?.go();
    if (act === 'lobby') return showLobby(); // deliberately does NOT leave the room
    if (act === 'solo') return showSolo();
    if (act === 'menu') {
      match?.destroy();
      match = null;
      if (net) return void leaveRoom();
      return showMenu();
    }
  });
}

async function shareSeed(): Promise<void> {
  if (!soloContext || !match) return;
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('seed', String(soloContext.seed));
  url.searchParams.set('m', match.state.mode.id);
  const link = url.toString();
  const me = match.state.players[match.mySeat];
  const survived = me ? (me.out === null ? match.state.turn : me.out) : 0;
  const text = `Frostward · ${match.state.mode.name} · I held ${litCount(me!)} hearths for ${survived} turns on this exact board.`;
  try {
    if (navigator.share) return await navigator.share({ title: 'Frostward', text, url: link });
    await navigator.clipboard.writeText(`${text} ${link}`);
    setNotice('Challenge link copied.');
    paintResults();
  } catch {
    setNotice(link);
    paintResults();
  }
}

// ── boot ────────────────────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  void net?.leave();
});

const params = new URL(location.href).searchParams;
const sharedSeed = Number(params.get('seed'));
if (Number.isFinite(sharedSeed) && sharedSeed > 0) {
  modeId = modeOf(params.get('m')).id;
  store.set('mode', modeId);
  // The challenge link is honoured once; strip it so a reload starts fresh.
  const url = new URL(location.href);
  url.searchParams.delete('seed');
  url.searchParams.delete('m');
  history.replaceState(null, '', url.toString());
  startSolo(sharedSeed >>> 0, null);
} else if (deepLinkRoom) {
  playWithFriends();
} else {
  showMenu();
}

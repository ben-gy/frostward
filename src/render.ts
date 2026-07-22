// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * render.ts — the board, the hand and the HUD, as DOM.
 *
 * DOM rather than canvas because Frostward is a board game: cells are real
 * buttons, so hit-testing, keyboard play and screen readers all come for free,
 * and the layout is responsive without a single resize handler.
 *
 * Two layout decisions are load-bearing on a phone and both are pinned by tests:
 *
 *  - THE GRID HAS NO GAP. Cells sit edge to edge and draw their own inset, so
 *    the BUTTON is the full cell pitch while the visible tile is smaller. On the
 *    13x13 Whiteout board at 375px that is the difference between a 26px target
 *    and a 28px one — hit size is independent of art size, so expand the hit
 *    area rather than the tile.
 *  - THE BOARD IS CAPPED BY VIEWPORT HEIGHT, not just width, so it can never
 *    push the card tray off the bottom of a short screen or balloon on a desktop.
 */

import {
  CARD_INFO,
  DIR_NAMES,
  FROST,
  RIDGE,
  legalTarget,
  litCount,
  threatened,
  type CardKind,
  type State,
  type TurnLog,
} from './game';
import { makeDraggable, type Draggable } from '@ben-gy/game-engine/drag';
import { burst, shake } from './fx';
import type { Sfx, SfxName } from './sound';

export const SEAT_GLYPHS = ['●', '▲', '■', '◆'];

export interface ViewHooks {
  onSelectCard: (handIndex: number) => void;
  onCell: (cell: number) => void;
  onVeer: (dir: number) => void;
  onUncommit: () => void;
  onMenu: () => void;
}

export interface ViewModel {
  state: State;
  mySeat: number;
  committed: boolean;
  lockedSeats: number[];
  remainingMs: number | null;
  isBotSeat: (seat: number) => boolean;
  /** Index into the local player's hand, or null. */
  selected: number | null;
  /** Room/status line under the HUD, e.g. "You are the host now". */
  notice: string;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

export class GameView {
  private readonly root: HTMLElement;
  private readonly hooks: ViewHooks;
  private cells: HTMLButtonElement[] = [];
  private drags: Draggable[] = [];
  private ghost: HTMLElement | null = null;
  private handSig = '';

  constructor(root: HTMLElement, hooks: ViewHooks) {
    this.root = root;
    this.hooks = hooks;
  }

  /** Build the shell once per round. Subsequent updates only touch classes. */
  mount(vm: ViewModel): void {
    const { state } = vm;
    this.root.innerHTML = `
      <div class="game">
        <header class="hud safe-inset">
          <div class="gale" aria-live="polite">
            <span class="gale-dial"><span class="gale-arrow" aria-hidden="true"></span></span>
            <span class="gale-text"><b class="gale-dir"></b><small class="gale-sub">Gale</small></span>
          </div>
          <div class="turnbox"><b class="turn-no"></b><small class="turn-sub">turn</small></div>
          <div class="clockbox"><b class="clock"></b></div>
          <button class="icon-btn menu-btn" type="button" aria-label="Menu">≡</button>
        </header>
        <p class="notice" role="status" aria-live="polite"></p>
        <ul class="seats"></ul>
        <div class="board-wrap">
          <div class="board" role="grid" aria-label="The frost board" style="--n:${state.size}"></div>
          <div class="fx-layer" aria-hidden="true"></div>
        </div>
        <div class="tray">
          <p class="tray-hint"></p>
          <div class="hand" role="group" aria-label="Your hand"></div>
          <div class="veer-pad" hidden>
            <button class="veer-btn" type="button" data-veer="-1" aria-label="Bend the Gale anticlockwise">◀ bend</button>
            <button class="veer-btn" type="button" data-veer="1" aria-label="Bend the Gale clockwise">bend ▶</button>
          </div>
          <button class="ghost-btn change-btn" type="button" hidden>Change my card</button>
        </div>
      </div>`;

    const board = this.q<HTMLElement>('.board')!;
    this.cells = [];
    for (let i = 0; i < state.cells.length; i++) {
      const b = document.createElement('button');
      b.className = 'cell';
      b.type = 'button';
      b.dataset.i = String(i);
      b.tabIndex = -1;
      board.appendChild(b);
      this.cells.push(b);
    }
    board.addEventListener('click', (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.cell');
      if (cell?.dataset.i) this.hooks.onCell(Number(cell.dataset.i));
    });

    this.q('.menu-btn')?.addEventListener('click', () => this.hooks.onMenu());
    this.q('.change-btn')?.addEventListener('click', () => this.hooks.onUncommit());
    this.root.querySelectorAll<HTMLElement>('.veer-btn').forEach((b) => {
      b.addEventListener('click', () => this.hooks.onVeer(Number(b.dataset.veer)));
    });

    this.handSig = '';
    this.update(vm);
  }

  update(vm: ViewModel): void {
    const { state } = vm;
    const me = vm.mySeat >= 0 ? state.players[vm.mySeat] : null;

    // ── HUD
    const arrow = this.q<HTMLElement>('.gale-arrow');
    if (arrow) arrow.style.transform = `rotate(${state.gale * 45}deg)`;
    this.text('.gale-dir', DIR_NAMES[state.gale]);
    this.text('.turn-no', String(state.turn));
    const clock = this.q<HTMLElement>('.clock');
    if (clock) {
      const ms = vm.remainingMs;
      clock.textContent = ms === null ? '' : `${Math.ceil(ms / 1000)}s`;
      clock.classList.toggle('urgent', ms !== null && ms < 6000);
    }
    this.text('.notice', vm.notice);
    this.q('.notice')?.toggleAttribute('hidden', !vm.notice);

    // ── seats: everyone's hearths, and who has locked a card in
    const locked = new Set(vm.lockedSeats);
    const seats = this.q<HTMLElement>('.seats');
    if (seats) {
      seats.innerHTML = state.players
        .map((p) => {
          const pips = p.hearths
            .map((_, j) =>
              !p.lit[j]
                ? '<i class="pip dark" title="dark"></i>'
                : p.guard[j] > 0
                  ? '<i class="pip lit"></i>'
                  : '<i class="pip worn" title="one freeze from going dark"></i>',
            )
            .join('');
          const cls = [
            'seat',
            `s${p.seat}`,
            p.seat === vm.mySeat ? 'is-self' : '',
            p.out !== null ? 'is-out' : '',
            locked.has(p.seat) ? 'is-locked' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const tag = p.out !== null ? 'out' : locked.has(p.seat) ? 'ready' : 'thinking';
          return `<li class="${cls}">
            <span class="seat-glyph">${SEAT_GLYPHS[p.seat % 4]}</span>
            <span class="seat-name">${escapeHtml(p.name)}${vm.isBotSeat(p.seat) ? ' <small>bot</small>' : ''}</span>
            <span class="pips">${pips}</span>
            <span class="seat-tag">${tag}</span>
          </li>`;
        })
        .join('');
    }

    // ── board
    const selKind = me && vm.selected !== null ? me.hand[vm.selected] : null;
    const threat = new Set(threatened(state));
    for (let i = 0; i < this.cells.length; i++) {
      const el = this.cells[i];
      const v = state.cells[i];
      const h = state.hearthAt[i];
      const classes = ['cell'];
      classes.push(v === FROST ? 'frost' : v === RIDGE ? 'ridge' : 'clear');
      if (h >= 0) {
        const seat = (h / 100) | 0;
        const idx = h % 100;
        const p = state.players[seat];
        classes.push('hearth', `s${seat}`);
        if (!p.lit[idx]) classes.push('dark');
        else if (p.guard[idx] === 0) classes.push('worn');
      }
      if (threat.has(i)) classes.push('threat');
      if (state.warm[i] >= state.turn) classes.push('warm');
      const legal = selKind && selKind !== 'veer' && !vm.committed && legalTarget(state, selKind, i);
      if (legal) classes.push('legal');
      el.className = classes.join(' ');
      el.disabled = !legal;
      el.setAttribute('aria-label', this.cellLabel(state, i));
    }
    this.q('.board')?.classList.toggle('picking', !!selKind && selKind !== 'veer');

    // ── hand
    this.renderHand(vm, me?.hand ?? []);

    const veerPad = this.q<HTMLElement>('.veer-pad');
    veerPad?.toggleAttribute('hidden', !(selKind === 'veer' && !vm.committed));
    this.q('.change-btn')?.toggleAttribute('hidden', !vm.committed || state.over);

    const hint = vm.committed
      ? 'Locked in. Waiting for the others…'
      : vm.mySeat < 0
        ? 'Watching this round — you are in for the next one.'
        : me?.out !== null
          ? 'Your hearths are all dark. Watching it out.'
          : selKind === 'veer'
            ? 'Bend the Gale which way?'
            : selKind
              ? `Tap a highlighted cell to ${CARD_INFO[selKind].name.toLowerCase()}.`
              : 'Pick a card — tap it, or drag it onto the board.';
    this.text('.tray-hint', hint);
  }

  private renderHand(vm: ViewModel, hand: CardKind[]): void {
    const wrap = this.q<HTMLElement>('.hand');
    if (!wrap) return;
    const sig = `${hand.join(',')}|${vm.selected}|${vm.committed}|${vm.state.turn}`;
    if (sig === this.handSig) return;
    this.handSig = sig;

    for (const d of this.drags) d.destroy();
    this.drags = [];

    wrap.innerHTML = hand
      .map((kind, i) => {
        const info = CARD_INFO[kind];
        const sel = vm.selected === i ? ' is-selected' : '';
        return `<button class="card k-${kind}${sel}" type="button" data-h="${i}"
            aria-pressed="${vm.selected === i}" ${vm.committed ? 'disabled' : ''}>
          <span class="card-glyph" aria-hidden="true">${info.glyph}</span>
          <span class="card-name">${info.name}</span>
        </button>`;
      })
      .join('');

    if (vm.committed || vm.mySeat < 0) return;

    wrap.querySelectorAll<HTMLElement>('.card').forEach((card) => {
      const index = Number(card.dataset.h);
      this.drags.push(
        makeDraggable(card, {
          onTap: () => this.hooks.onSelectCard(index),
          onDragStart: () => {
            this.hooks.onSelectCard(index);
            card.classList.add('is-dragging');
            this.ghost = card.cloneNode(true) as HTMLElement;
            this.ghost.className = 'card card-ghost';
            document.body.appendChild(this.ghost);
          },
          onDragMove: (_dx, _dy, e) => {
            if (this.ghost) {
              // clientX/Y minus half the ghost, never offsetX — offset scales
              // oddly under DPR and would make the card jump under the finger.
              this.ghost.style.transform = `translate(${e.clientX - 34}px, ${e.clientY - 44}px)`;
            }
          },
          onDrop: (_dx, _dy, e) => {
            this.dropGhost(card);
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const cell = (el as HTMLElement | null)?.closest<HTMLElement>('.cell');
            if (cell?.dataset.i) this.hooks.onCell(Number(cell.dataset.i));
          },
          onSwipe: (_dir, _dx, _dy) => this.dropGhost(card),
          onCancel: () => this.dropGhost(card),
        }),
      );
    });
  }

  private dropGhost(card: HTMLElement): void {
    card.classList.remove('is-dragging');
    this.ghost?.remove();
    this.ghost = null;
  }

  private cellLabel(state: State, i: number): string {
    const h = state.hearthAt[i];
    if (h >= 0) {
      const p = state.players[(h / 100) | 0];
      const lit = p.lit[h % 100];
      return `${p.name}'s hearth, ${lit ? 'lit' : 'dark'}`;
    }
    const v = state.cells[i];
    return v === FROST ? 'frozen' : v === RIDGE ? 'ridge' : 'clear';
  }

  /**
   * Play the turn back: what froze, what melted, what went dark. Purely
   * decorative — the state is already applied, so a dropped animation can never
   * desync anything.
   */
  animate(log: TurnLog, mySeat: number, sfx: Sfx): void {
    const layer = this.q<HTMLElement>('.fx-layer');
    const play = (n: SfxName, rate?: number): void => sfx.play(n, rate);

    for (const c of log.ridged) this.cells[c]?.classList.add('pop');
    for (const c of log.melted) {
      this.cells[c]?.classList.add('melt');
      burst(layer, this.cells[c], { count: 6, color: 'var(--thaw)', spread: 26, ms: 520 });
    }
    for (const c of log.embers) burst(layer, this.cells[c], { count: 8, color: 'var(--frost)', spread: 30 });
    for (const c of log.froze) this.cells[c]?.classList.add('pop');

    if (log.plays.some((p) => p.card === 'veer')) play('veer');
    if (log.ridged.length) play('ridge');
    if (log.melted.length) play('thaw');
    if (log.embers.length) play('ember');
    if (log.froze.length) {
      // The hiss drops in pitch as the step gets bigger, so you hear the size of
      // it before you have finished reading the board.
      play('creep', Math.max(0.55, 1.15 - log.froze.length * 0.035));
    }

    for (const g of log.guarded) {
      play('guard');
      burst(layer, this.cells[g.cell], { count: 8, color: 'var(--thaw)', spread: 30 });
    }
    for (const s of log.snuffed) {
      play('snuff');
      burst(layer, this.cells[s.cell], { count: 16, color: 'var(--frost)', spread: 52, ms: 720 });
      shake(this.q<HTMLElement>('.board-wrap'), s.seat === mySeat ? 1 : 0.35);
    }
    if (log.eliminated.includes(mySeat)) play('out');

    setTimeout(() => {
      for (const el of this.cells) el.classList.remove('pop', 'melt');
    }, 420);
  }

  destroy(): void {
    for (const d of this.drags) d.destroy();
    this.drags = [];
    this.ghost?.remove();
    this.ghost = null;
    this.cells = [];
  }

  private q<T extends HTMLElement>(sel: string): T | null {
    return this.root.querySelector<T>(sel);
  }

  private text(sel: string, value: string): void {
    const el = this.q(sel);
    if (el && el.textContent !== value) el.textContent = value;
  }
}

/** Compact "3 of 3 hearths" summary, used by the results screen. */
export const hearthLine = (state: State, seat: number): string => {
  const p = state.players[seat];
  return `${litCount(p)}/${p.hearths.length} hearths`;
};

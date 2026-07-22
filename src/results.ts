// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * results.ts — EVERYONE's round, not a mirror held up to the local player.
 *
 * The end of a round is the one moment players compare themselves, so the
 * summary shows a per-player breakdown of what each of them actually did — how
 * long they lasted, how many hearths they kept, and the cards they spent — plus
 * the stat that only this game has: how many turns the Gale spent pointing at
 * each player. That number is the story of most matches, and it is invisible
 * while you are playing.
 */

import { standings, type State, type Standing } from './game';
import { SEAT_GLYPHS } from './render';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

const ORDINAL = ['1st', '2nd', '3rd', '4th'];

/** One line describing what a player spent their turns on. */
export function spentLine(row: Standing): string {
  const s = row.stats;
  const bits: string[] = [];
  if (s.veer) bits.push(`${s.veer} veer`);
  if (s.ridge) bits.push(`${s.ridge} ridge`);
  if (s.thaw) bits.push(`${s.thaw} thaw`);
  if (s.ember) bits.push(`${s.ember} ember`);
  if (s.wasted) bits.push(`${s.wasted} burned`);
  return bits.length ? bits.join(' · ') : 'no cards played';
}

export interface ResultsCopy {
  headline: string;
  sub: string;
}

export function headlineFor(state: State, mySeat: number): ResultsCopy {
  const rows = standings(state);
  const winners = rows.filter((r) => r.won);
  const iWon = winners.some((r) => r.seat === mySeat);
  const capped = state.turn >= state.mode.turnCap && winners.length > 0 && rows.some((r) => r.lit > 0);

  if (winners.length > 1) {
    return {
      headline: iWon ? 'A shared dawn' : 'A shared dawn',
      sub: `${winners.map((w) => w.name).join(' and ')} came through together.`,
    };
  }
  const w = winners[0];
  if (!w) return { headline: 'Everything went dark', sub: 'The Rime took every hearth.' };
  if (iWon) {
    return {
      headline: 'Your hearths held',
      sub: capped
        ? 'The Gale blew itself out and you still had the most light.'
        : 'The last light on the board is yours.',
    };
  }
  return {
    headline: mySeat < 0 ? `${w.name} held` : 'Your hearths went dark',
    sub: `${w.name} was the last one still burning.`,
  };
}

export interface ResultsOpts {
  state: State;
  mySeat: number;
  /** Rounds won per seat across this room's session. */
  tally?: Record<number, number>;
  /** Extra buttons, rendered in order. */
  actions: { label: string; act: string; primary?: boolean }[];
  /** Rendered above the actions — e.g. a rematch countdown. */
  waiting?: string;
  /** Solo/daily only: how a strong player did on this exact seed. */
  benchmark?: string;
}

export function renderResults(root: HTMLElement, opts: ResultsOpts): void {
  const { state, mySeat } = opts;
  const rows = standings(state);
  const copy = headlineFor(state, mySeat);
  const maxAimed = Math.max(1, ...rows.map((r) => r.stats.aimed));

  root.innerHTML = `
    <div class="results">
      <div class="res-head">
        <h2 class="res-title">${escapeHtml(copy.headline)}</h2>
        <p class="res-sub">${escapeHtml(copy.sub)}</p>
        <p class="res-meta">${escapeHtml(state.mode.name)} · ${state.turn} turns</p>
      </div>
      <ol class="res-rows">
        ${rows
          .map((r) => {
            const tally = opts.tally?.[r.seat] ?? 0;
            return `<li class="res-row s${r.seat}${r.seat === mySeat ? ' is-self' : ''}${r.won ? ' won' : ''}">
              <span class="res-place">${ORDINAL[Math.min(r.place - 1, 3)]}</span>
              <span class="res-body">
                <span class="res-name">
                  <b class="res-glyph">${SEAT_GLYPHS[r.seat % 4]}</b>
                  ${escapeHtml(r.name)}${r.isBot ? ' <small>bot</small>' : ''}${r.seat === mySeat ? ' <small>(you)</small>' : ''}
                  ${tally ? `<em class="res-tally">${tally} won</em>` : ''}
                </span>
                <span class="res-stats">
                  <span>${r.lit}/${r.hearths} hearths</span>
                  <span>${r.stats.lost ? `${r.stats.lost} snuffed` : 'never snuffed'}</span>
                  <span>lasted ${r.survived} turns</span>
                </span>
                <span class="res-spent">${escapeHtml(spentLine(r))}</span>
                <span class="res-aim" title="Turns the Gale spent pointing into their sector">
                  <span class="aim-bar"><i style="width:${((r.stats.aimed / maxAimed) * 100).toFixed(0)}%"></i></span>
                  <small>${r.stats.aimed} turns under the Gale</small>
                </span>
              </span>
            </li>`;
          })
          .join('')}
      </ol>
      ${opts.benchmark ? `<p class="res-bench">${escapeHtml(opts.benchmark)}</p>` : ''}
      ${opts.waiting ? `<p class="res-waiting"><span class="spinner sm" aria-hidden="true"></span> ${escapeHtml(opts.waiting)}</p>` : ''}
      <div class="res-actions">
        ${opts.actions
          .map(
            (a) =>
              `<button class="lobby-btn${a.primary ? ' primary' : ''}" type="button" data-act="${escapeHtml(a.act)}">${escapeHtml(a.label)}</button>`,
          )
          .join('')}
      </div>
    </div>`;
}

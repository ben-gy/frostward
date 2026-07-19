/**
 * source-hygiene.test.ts — no literal control bytes in source files.
 *
 * This exists because it has already happened twice in this factory. A control
 * character typed straight into a source file compiles and runs perfectly — and
 * then `file` reports it as "data", `git` shows it as binary, `diff` refuses it,
 * and plain `grep` SILENTLY MATCHES NOTHING in it, so an audit that greps the
 * file gets an all-clear it did not earn. Write the escape SEQUENCE instead.
 *
 * It also guards the rules the shipped bundle keeps: no console noise, no
 * analytics beyond the one mandated beacon, and the overlay invariants that a
 * unit test is the only cheap way to hold.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|css|html|json|webmanifest)$/.test(name)) out.push(path);
  }
  return out;
}

function controlBytes(buf: Buffer): number[] {
  const at: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) at.push(i);
  }
  return at;
}

describe('source hygiene', () => {
  it('has no literal control bytes in src/ or tests/', () => {
    const offenders: string[] = [];
    for (const path of [...sourceFiles('src'), ...sourceFiles('tests')]) {
      const at = controlBytes(readFileSync(path));
      if (at.length) offenders.push(`${path} (${at.length} at offset ${at[0]})`);
    }
    expect(offenders, 'write \\x00-style escapes instead of raw control bytes').toEqual([]);
  });

  it('ships no console.log / console.error', () => {
    const offenders = sourceFiles('src').filter((p) =>
      /\bconsole\.(log|error|warn|debug|info)\s*\(/.test(readFileSync(p, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('adds no analytics beyond the one mandated beacon', () => {
    const html = readFileSync('index.html', 'utf8');
    const beacons = html.match(/<script[^>]*src="https?:\/\/[^"]+"/g) ?? [];
    expect(beacons).toHaveLength(1);
    expect(beacons[0]).toContain('static.cloudflareinsights.com');
    for (const bad of ['google-analytics', 'googletagmanager', 'plausible', 'segment', 'hotjar']) {
      expect(html).not.toContain(bad);
    }
  });

  it('loads no third-party fonts or CDN assets', () => {
    for (const path of [...sourceFiles('src'), 'index.html']) {
      const src = readFileSync(path, 'utf8');
      expect(src, `${path} pulls a font from the network`).not.toMatch(/fonts\.(googleapis|gstatic)/);
      expect(src, `${path} imports from a CDN`).not.toMatch(/@import\s+url\(["']?https?:/);
    }
  });

  it('never lets a countdown overlay outlive its countdown', () => {
    // cancel() stops the countdown's timer but cannot remove its element, and
    // the fade-out removal runs on a separate 320ms timer — so re-entering
    // runCountdown (next round, host takeover, rematch) would orphan a
    // full-screen layer. Stacked, they darken the board until the game looks
    // broken. The sweep must happen BEFORE the new overlay is appended, or it
    // removes the one it just created.
    const main = readFileSync('src/main.ts', 'utf8');
    const sweep = main.indexOf(".querySelectorAll('.countdown')");
    const append = main.indexOf("overlay.className = 'countdown'");
    expect(sweep, 'runCountdown must sweep stale .countdown overlays').toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(-1);
    expect(sweep).toBeLessThan(append);
    expect(main.slice(sweep, sweep + 120)).toMatch(/\.remove\(\)/);
  });

  it('keeps the countdown overlay from ever eating a tap', () => {
    const css = readFileSync('src/styles/main.css', 'utf8');
    const block = css.slice(css.indexOf('.countdown {'), css.indexOf('.countdown.go'));
    expect(block).toMatch(/pointer-events:\s*none/);
  });

  it('keeps the [hidden] guard that stops an invisible overlay eating taps', () => {
    expect(existsSync('src/styles/mobile.css'), 'mobile.css is where the guard lives').toBe(true);
    const css = readFileSync('src/styles/mobile.css', 'utf8');
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it('hides the site footer while a round is live, and only then', () => {
    const css = readFileSync('src/styles/mobile.css', 'utf8');
    expect(css).toMatch(/body\.playing \.site-footer\s*\{\s*display:\s*none\s*!important/);
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toContain("classList.add('playing')");
    expect(main).toContain("classList.remove('playing')");
  });

  it('keeps the attribution backlink pointing at the hub', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toContain('https://benrichardson.dev/');
    expect(main).toContain('https://hub.benrichardson.dev');
    // sites.benrichardson.dev is the OLD directory host and 404s the catalog.
    expect(main).not.toContain('sites.benrichardson.dev');
  });

  it('never leaves and rejoins a room — createNet is called exactly once', () => {
    // The structural guard is the engine net's join registry, but keeping the call
    // site singular is what makes the code obviously correct on inspection.
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main.match(/createNet\(/g) ?? []).toHaveLength(1);
    // …and the one leave() we do have is awaited before anything could rejoin.
    expect(main).toMatch(/await n\?\.leave\(\)/);
  });

  it('clears ?room= on the way out so a reload cannot rejoin a dead room', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toContain('clearRoomInUrl()');
    // The deep link is consumed once and nulled, never re-read.
    expect(main).toContain('deepLinkRoom = null');
  });

  it('drives every clock off setInterval, never rAF alone', () => {
    // A backgrounded tab pauses rAF: a host that tabs away would freeze the
    // round clock for everybody else in the room.
    const net = readFileSync('src/net-game.ts', 'utf8');
    expect(net).toContain('setInterval');
    expect(net, 'the turn clock must not depend on rAF').not.toContain('requestAnimationFrame');
    const cd = readFileSync('src/countdown.ts', 'utf8');
    expect(cd).toContain('setInterval');
    expect(cd).not.toContain('requestAnimationFrame');
  });
});

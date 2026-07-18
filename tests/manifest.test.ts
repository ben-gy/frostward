/**
 * manifest.test.ts — the game must install to a home screen and look right there.
 *
 * These are asset facts, and every one is a bug that only shows up on a real
 * phone weeks later: iOS ignoring the manifest entirely, Android cropping the
 * corners off a non-maskable icon, a transparent apple-touch-icon composited
 * onto black.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const bin = (p: string): Buffer => readFileSync(join(ROOT, p));

const manifest = JSON.parse(read('public/manifest.webmanifest'));
const html = read('index.html');

function png(p: string): { w: number; h: number; buf: Buffer } {
  const buf = bin(p);
  expect(buf.subarray(0, 8).toString('hex'), `${p} is not a PNG`).toBe('89504e470d0a1a0a');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), buf };
}

function pixels(p: string): { w: number; h: number; data: Buffer } {
  const { w, h, buf } = png(p);
  let off = 8;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    expect(raw[y * (stride + 1)], 'gen-icons writes filter 0').toBe(0);
    raw.copy(out, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { w, h, data: out };
}

describe('the web manifest', () => {
  it('is a standalone app in the game’s own colours', () => {
    expect(manifest.name).toBe('Frostward');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.background_color).toBe('#0a1622');
    expect(manifest.theme_color).toBe('#0a1622');
  });

  it('ships 192, 512 and a maskable 512', () => {
    const by = (s: string, purpose: string) =>
      manifest.icons.find((i: { sizes: string; purpose: string }) => i.sizes === s && i.purpose === purpose);
    expect(by('192x192', 'any')).toBeTruthy();
    expect(by('512x512', 'any')).toBeTruthy();
    expect(by('512x512', 'maskable')).toBeTruthy();
  });

  it('every icon it names actually exists at the size it claims', () => {
    for (const icon of manifest.icons as { src: string; sizes: string }[]) {
      const [w, h] = icon.sizes.split('x').map(Number);
      const p = png(`public${icon.src}`);
      expect(p.w, icon.src).toBe(w);
      expect(p.h, icon.src).toBe(h);
    }
  });
});

describe('iOS, which ignores the manifest entirely', () => {
  it('gets its own icon and meta in the head', () => {
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('name="apple-mobile-web-app-capable"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
    expect(html).toContain('name="apple-mobile-web-app-title"');
  });

  it('has a 180x180 apple-touch-icon', () => {
    const p = png('public/apple-touch-icon.png');
    expect(p.w).toBe(180);
    expect(p.h).toBe(180);
  });

  it('the apple-touch-icon is FULLY OPAQUE', () => {
    const { data } = pixels('public/apple-touch-icon.png');
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 255) throw new Error(`transparent pixel at byte ${i}: alpha ${data[i]}`);
    }
  });

  it('the maskable icon keeps its art inside the safe zone', () => {
    const { w, h, data } = pixels('public/icon-maskable-512.png');
    const bg = [0x0a, 0x16, 0x22];
    const isBg = (x: number, y: number): boolean => {
      const i = (y * w + x) * 4;
      return (
        Math.abs(data[i] - bg[0]) < 10 &&
        Math.abs(data[i + 1] - bg[1]) < 10 &&
        Math.abs(data[i + 2] - bg[2]) < 10
      );
    };
    for (let x = 0; x < w; x++) {
      expect(isBg(x, 2), `top edge at x=${x}`).toBe(true);
      expect(isBg(x, h - 3), `bottom edge at x=${x}`).toBe(true);
    }
    for (let y = 0; y < h; y++) {
      expect(isBg(2, y), `left edge at y=${y}`).toBe(true);
      expect(isBg(w - 3, y), `right edge at y=${y}`).toBe(true);
    }
  });
});

describe('the page head', () => {
  it('carries the mandatory Cloudflare beacon and nothing else', () => {
    expect(html).toContain('static.cloudflareinsights.com/beacon.min.js');
    expect(html).toContain('ba2bab2193ba42c1bea3d6714fcd0e28');
    for (const tracker of ['google-analytics', 'googletagmanager', 'plausible', 'segment', 'mixpanel']) {
      expect(html.toLowerCase(), tracker).not.toContain(tracker);
    }
  });

  it('has no third-party fonts or CDN assets', () => {
    expect(html).not.toContain('fonts.googleapis');
    expect(html).not.toContain('fonts.gstatic');
    expect(html).not.toMatch(/<link[^>]+href="https:\/\/(?!static\.cloudflareinsights)/);
  });

  it('has Open Graph tags, a description and structured data', () => {
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
    expect(html).toContain('property="og:image"');
    expect(html).toContain('name="description"');
    expect(html).toContain('"@type": "VideoGame"');
  });

  it('links the manifest and a favicon, and never a canonical', () => {
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('rel="icon"');
    expect(html).not.toContain('rel="canonical"');
  });

  it('does not register a service worker anywhere', () => {
    // A stale SW cache would serve players an old build after every deploy, and
    // the bundle is already self-contained and offline-capable without one.
    expect(html).not.toContain('serviceWorker');
    expect(read('src/main.ts')).not.toContain('serviceWorker');
  });

  it('ships the SEO files the head promises', () => {
    expect(read('public/robots.txt')).toContain('frostward.benrichardson.dev/sitemap.xml');
    expect(read('public/sitemap.xml')).toContain('https://frostward.benrichardson.dev/');
    expect(read('public/133936b7b2ab337d2e2288fd7dd7c30f.txt').trim()).toBe(
      '133936b7b2ab337d2e2288fd7dd7c30f',
    );
    expect(png('public/og.png').w).toBe(1200);
    expect(png('public/og.png').h).toBe(630);
  });
});

describe('the anti-zoom contract', () => {
  it('mobile.css carries the [hidden] override', () => {
    const css = read('src/styles/mobile.css');
    expect(css.replace(/\s+/g, ' ')).toContain('[hidden] { display: none !important; }');
  });

  it('the game stylesheet repeats it, belt and braces', () => {
    const css = read('src/styles/main.css');
    expect(css.replace(/\s+/g, ' ')).toContain('[hidden] { display: none !important; }');
  });

  it('main.ts hardens the viewport at boot, before anything renders', () => {
    const main = read('src/main.ts');
    expect(main).toContain('hardenViewport()');
    expect(main).toContain("import './styles/mobile.css'");
    expect(main.indexOf('styles/mobile.css')).toBeLessThan(main.indexOf('styles/main.css'));
  });

  it('mobile.ts blocks the gestures the viewport meta cannot', () => {
    // iOS has ignored user-scalable=no since iOS 10; only cancelling the
    // proprietary gesture* events actually refuses a pinch.
    const src = read('src/engine/mobile.ts');
    expect(src).toContain('gesturestart');
    expect(src).toContain('gesturechange');
    expect(src).toContain('passive: false');
  });

  it('the viewport meta still asks for cover, or every env() inset is 0', () => {
    expect(html).toContain('viewport-fit=cover');
  });

  it('CNAME pins the custom domain', () => {
    expect(read('public/CNAME').trim()).toBe('frostward.benrichardson.dev');
  });
});

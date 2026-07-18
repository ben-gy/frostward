/**
 * gen-icons.mjs — rasterise the Frostward mark into the PNGs a home-screen
 * install needs. Run with `npm run icons`; the output is committed under public/.
 *
 * It carries its own tiny SDF rasteriser and PNG encoder rather than pulling in
 * sharp (a 30MB native binary) to draw nine squares and three dots. ART below is
 * the same mark as favicon.svg — a cone of frost widening toward three warm
 * hearths — so the icons and the favicon cannot drift into two different logos.
 *
 * The four outputs are NOT interchangeable:
 *  - icon-192 / icon-512: the manifest's rounded "any" icons.
 *  - icon-maskable-512: full-bleed with the art shrunk into the centre safe zone,
 *    NOT rounded (Android does the rounding, and crops the corners off anything
 *    that reaches the edge).
 *  - apple-touch-icon: full-bleed and FULLY OPAQUE (iOS composites transparency
 *    onto black), no rounding (iOS masks it itself).
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BG = '#0a1622'; // the winter night
const FROST = '#cfe8f5';
const DEEP = '#8fc4dd';
const HEARTH = '#f59e0b';

const CELL = 8;
const R = 1.8;

/** The Rime, as actual board cells: a cone widening toward the hearths. */
const cone = [];
const COLUMNS = [
  { x: 5, rows: [28], fill: DEEP },
  { x: 16, rows: [18, 28, 38], fill: FROST },
  { x: 27, rows: [7, 18, 28, 38, 49], fill: FROST },
];
for (const col of COLUMNS) {
  for (const y of col.rows) {
    cone.push({ t: 'rect', x: col.x, y: y - CELL / 2, w: CELL, h: CELL, r: R, fill: col.fill });
  }
}

/** The Frostward mark, in 64-unit space. Painter's algorithm, top shape wins. */
const ART = [
  ...cone,
  { t: 'circle', cx: 48, cy: 13, r: 5, fill: HEARTH },
  { t: 'circle', cx: 48, cy: 28, r: 5, fill: HEARTH },
  { t: 'circle', cx: 48, cy: 43, r: 5, fill: HEARTH },
];

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdOf(shape, px, py) {
  switch (shape.t) {
    case 'rect':
      return sdRoundRect(px, py, shape.x, shape.y, shape.w, shape.h, shape.r ?? 0);
    case 'circle':
      return Math.hypot(px - shape.cx, py - shape.cy) - shape.r;
    default:
      throw new Error(`unknown shape ${shape.t}`);
  }
}

const SS = 4;

function render(shapes, size, space) {
  const px = new Uint8Array(size * size * 4);
  const prepared = shapes.map((s) => ({ ...s, rgb: rgb(s.fill), alpha: s.alpha ?? 1 }));
  const scale = space / size;
  const stepv = 1 / SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) * stepv) * scale;
          const uy = (y + (sy + 0.5) * stepv) * scale;
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const s of prepared) {
            const cov = Math.max(0, Math.min(1, 0.5 - sdOf(s, ux, uy) / scale));
            if (cov <= 0) continue;
            const sa = cov * s.alpha;
            const na = sa + ca * (1 - sa);
            if (na <= 0) continue;
            cr = (s.rgb[0] * sa + cr * ca * (1 - sa)) / na;
            cg = (s.rgb[1] * sa + cg * ca * (1 - sa)) / na;
            cb = (s.rgb[2] * sa + cb * ca * (1 - sa)) / na;
            ca = na;
          }
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const aa = a / n;
      px[i] = aa > 0 ? Math.round(r / a) : 0;
      px[i + 1] = aa > 0 ? Math.round(g / a) : 0;
      px[i + 2] = aa > 0 ? Math.round(b / a) : 0;
      px[i + 3] = Math.round(aa * 255);
    }
  }
  return px;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Scale the whole mark toward the centre by `inset` (1 = full 64-space). */
function art(space, inset) {
  const k = (space / 64) * inset;
  const off = (space - 64 * k) / 2;
  const m = (v) => v * k + off;
  return ART.map((s) => {
    if (s.t === 'circle') return { ...s, cx: m(s.cx), cy: m(s.cy), r: s.r * k };
    return { ...s, x: m(s.x), y: m(s.y), w: s.w * k, h: s.h * k, r: (s.r ?? 0) * k };
  });
}

const rounded = (space) => [
  { t: 'rect', x: 0, y: 0, w: space, h: space, r: space * (14 / 64), fill: BG },
  ...art(space, 1),
];

const bleed = (space, inset) => [
  { t: 'rect', x: -2, y: -2, w: space + 4, h: space + 4, r: 0, fill: BG },
  ...art(space, inset),
];

const ICONS = [
  { file: 'icon-192.png', size: 192, shapes: rounded(64) },
  { file: 'icon-512.png', size: 512, shapes: rounded(64) },
  { file: 'icon-maskable-512.png', size: 512, shapes: bleed(64, 0.62) },
  { file: 'apple-touch-icon.png', size: 180, shapes: bleed(64, 0.86) },
];

mkdirSync(OUT, { recursive: true });
for (const { file, size, shapes } of ICONS) {
  const px = render(shapes, size, 64);
  if (file === 'apple-touch-icon.png') {
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] !== 255) throw new Error('apple-touch-icon has transparent pixels');
    }
  }
  writeFileSync(join(OUT, file), encodePng(px, size));
  console.log(`wrote public/${file} (${size}x${size})`);
}

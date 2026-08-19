#!/usr/bin/env node
// Generates the PWA icons from code — no image dependency. Draws an on-brand
// paw (accent #e8a33d ground, ink #14161a mark) and encodes PNGs by hand
// (zlib + CRC32). Re-run after changing the design:  node scripts/gen-pwa-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');

const BG = [232, 163, 61]; // --accent
const INK = [20, 22, 26]; // --accent-ink / --bg

// Paw in normalized [0,1] coords: a pad + four toes.
const PAD = { x: 0.5, y: 0.63, rx: 0.2, ry: 0.17 };
const TOES = [
  { x: 0.27, y: 0.43, r: 0.076 },
  { x: 0.42, y: 0.31, r: 0.088 },
  { x: 0.58, y: 0.31, r: 0.088 },
  { x: 0.73, y: 0.43, r: 0.076 },
];

function inPaw(nx, ny, scale) {
  // Shrink the mark about the centre for maskable/safe-zone variants.
  const px = (nx - 0.5) / scale + 0.5;
  const py = (ny - 0.5) / scale + 0.5;
  const dp = ((px - PAD.x) / PAD.rx) ** 2 + ((py - PAD.y) / PAD.ry) ** 2;
  if (dp <= 1) return true;
  for (const t of TOES) if ((px - t.x) ** 2 + (py - t.y) ** 2 <= t.r ** 2) return true;
  return false;
}

function insideRounded(nx, ny, rr) {
  const qx = Math.abs(nx - 0.5) - (0.5 - rr);
  const qy = Math.abs(ny - 0.5) - (0.5 - rr);
  return Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2 <= rr * rr;
}

/** RGBA buffer for one icon. 2×2 supersampling for smooth edges. */
function render(size, { rounded, scale }) {
  const rr = 0.16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const nx = (x + (sx + 0.5) / 2) / size;
          const ny = (y + (sy + 0.5) / 2) / size;
          if (rounded && !insideRounded(nx, ny, rr)) continue; // transparent outside
          const c = inPaw(nx, ny, scale) ? INK : BG;
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const i = (y * size + x) * 4;
      buf[i] = Math.round(r / 4);
      buf[i + 1] = Math.round(g / 4);
      buf[i + 2] = Math.round(b / 4);
      buf[i + 3] = Math.round(a / 4);
    }
  }
  return buf;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', 192, { rounded: true, scale: 0.9 }],
  ['icon-512.png', 512, { rounded: true, scale: 0.9 }],
  ['icon-maskable-512.png', 512, { rounded: false, scale: 0.72 }],
  ['apple-touch-icon-180.png', 180, { rounded: false, scale: 0.82 }],
];
for (const [name, size, opts] of files) {
  writeFileSync(join(OUT, name), encodePng(size, render(size, opts)));
  console.log('wrote', name);
}

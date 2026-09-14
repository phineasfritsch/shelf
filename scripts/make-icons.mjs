// Writes the PWA icons as PNGs without any image library.
// Run once (npm run icons) and commit the output in public/icons/.
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [0x1d, 0x4e, 0xd8];   // theme blue
const FG = [0xff, 0xff, 0xff];

// Render the icon at size `n`. `pad` = fraction of the canvas kept as safe margin (maskable icons need more).
function render(n, pad, rounded) {
  const px = new Uint8Array(n * n * 4);
  const r = rounded ? n * 0.22 : 0;
  const inside = (x, y) => {
    if (!rounded) return true;
    const cx = Math.min(Math.max(x, r), n - r), cy = Math.min(Math.max(y, r), n - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // Glyph: a tray (open box) with a downward arrow above it — "drop it on the shelf".
  const m = n * pad;                 // margin
  const w = n - 2 * m;               // usable width
  const t = Math.max(2, Math.round(w * 0.085)); // stroke
  const trayTop = m + w * 0.62, trayBot = m + w * 0.92, trayL = m + w * 0.12, trayR = m + w * 0.88;
  const arrowCx = n / 2, shaftTop = m + w * 0.08, shaftBot = m + w * 0.50, headW = w * 0.30;
  const glyph = (x, y) => {
    // tray: bottom bar + two sides
    if (y >= trayBot - t && y <= trayBot && x >= trayL && x <= trayR) return true;
    if (y >= trayTop && y <= trayBot && ((x >= trayL && x <= trayL + t) || (x >= trayR - t && x <= trayR))) return true;
    // arrow shaft
    if (x >= arrowCx - t / 2 && x <= arrowCx + t / 2 && y >= shaftTop && y <= shaftBot - headW * 0.3) return true;
    // arrow head (triangle)
    const hy = y - shaftBot + headW * 0.55;       // triangle spans headW*0.55 tall
    if (hy >= 0 && hy <= headW * 0.55) {
      const half = headW / 2 * (1 - hy / (headW * 0.55));
      if (Math.abs(x - arrowCx) <= half) return true;
    }
    return false;
  };
  const ss = 3; // supersampling
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let a = 0, g = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const fx = x + (sx + 0.5) / ss, fy = y + (sy + 0.5) / ss;
      if (inside(fx, fy)) { a++; if (glyph(fx, fy)) g++; }
    }
    const cov = a / (ss * ss), gl = g / (ss * ss);
    const i = (y * n + x) * 4;
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(BG[c] * (1 - gl) + FG[c] * gl);
    px[i + 3] = Math.round(255 * cov);
  }
  return px;
}

function png(n, px) {
  const raw = Buffer.alloc((n * 4 + 1) * n);
  for (let y = 0; y < n; y++) { raw[y * (n * 4 + 1)] = 0; Buffer.from(px.buffer, y * n * 4, n * 4).copy(raw, y * (n * 4 + 1) + 1); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('public/icons', { recursive: true });
const out = [
  ['icon-192.png', 192, 0.14, true],
  ['icon-512.png', 512, 0.14, true],
  ['apple-touch-icon.png', 180, 0.14, false],   // iOS applies its own mask; square, opaque
  ['icon-maskable-512.png', 512, 0.24, false],  // full-bleed, glyph inside the 80% safe zone
];
for (const [name, n, pad, rounded] of out) {
  writeFileSync(`public/icons/${name}`, png(n, render(n, pad, rounded)));
  console.log('wrote public/icons/' + name);
}

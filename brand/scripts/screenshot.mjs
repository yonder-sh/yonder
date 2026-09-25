// Screenshots preview/index.html with headless Firefox, full page.
//
// Firefox's --screenshot only captures the window, so this renders into a very
// tall window and then crops the PNG to the last row of content (plus margin).
// Needs `firefox` on PATH and network access for Google Fonts.
// Run: pnpm preview:shot  [--width 1400] [--out preview/preview.png]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const width = Number(arg('width', 1400));
const tall = Number(arg('max-height', 9000));
const outFile = path.resolve(root, arg('out', 'preview/preview.png'));
const page = pathToFileURL(path.join(root, 'preview/index.html')).href;

// ---- minimal PNG codec (8-bit RGB/RGBA, non-interlaced: what Firefox writes)
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function decode(buf) {
  let pos = 8;
  let ihdr;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[ihdr.color];
  if (ihdr.depth !== 8 || !bpp || ihdr.interlace) throw new Error(`Unsupported PNG: ${JSON.stringify(ihdr)}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * bpp;
  const px = Buffer.alloc(stride * ihdr.h);
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = up[i];
      const c = i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v & 0xff;
    }
  }
  return { ...ihdr, bpp, stride, px };
}

function encode({ w, h, color, bpp, px }) {
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); // filter 0
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, color, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- capture
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yonder-ff-'));
const tmpShot = path.join(profile, 'tall.png');
try {
  const r = spawnSync(
    'firefox',
    ['--headless', '--no-remote', '--profile', profile, '--screenshot', tmpShot, `--window-size=${width},${tall}`, page],
    { stdio: ['ignore', 'ignore', 'inherit'], timeout: 120_000 },
  );
  if (!fs.existsSync(tmpShot)) {
    console.error('Screenshot failed', r.error ?? r.status);
    process.exit(1);
  }
  const img = decode(fs.readFileSync(tmpShot));
  // The page ground below the document is one flat color; find the last row that isn't.
  const ground = img.px.subarray((img.h - 1) * img.stride, (img.h - 1) * img.stride + img.bpp);
  let last = img.h - 1;
  outer: for (; last > 0; last--) {
    const row = img.px.subarray(last * img.stride, (last + 1) * img.stride);
    for (let i = 0; i < row.length; i += img.bpp) {
      for (let c = 0; c < img.bpp; c++) if (Math.abs(row[i + c] - ground[c]) > 2) break outer;
    }
  }
  if (last >= img.h - 2) console.warn(`Page may be taller than ${tall}px; pass --max-height`);
  const h = Math.min(img.h, last + 1 + 56);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, encode({ ...img, h, px: img.px.subarray(0, h * img.stride) }));
  console.log(`Wrote ${path.relative(root, outFile)} (${width}x${h}, ${fs.statSync(outFile).size} B)`);
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}

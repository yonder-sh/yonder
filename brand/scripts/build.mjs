// Builds every generated brand asset from src/palette.mjs and src/mark.mjs:
//   tokens/theme.css, tokens/tokens.json
//   logo/*.svg          mark, wordmark, lockup (light + dark), single-color mark
//   icons/*.svg|png|ico favicon, PWA any + maskable, apple-touch, manifest
// Run: pnpm build   (Node 22; no network needed, the wordmark font is vendored)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { clampChroma, formatHex, parse } from 'culori';
import * as opentype from 'opentype.js/dist/opentype.mjs';
import { bounds, markElements, pathData, reach, small, standard } from '../src/mark.mjs';
import { basemaps, brand, fonts, mapModes, modes, radius } from '../src/palette.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const written = [];
function out(rel, data) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  written.push(`${rel} (${fs.statSync(p).size} B)`);
}

// SVG consumers (resvg, email, Figma, older browsers) don't all read oklch(),
// so every generated SVG uses the sRGB hex of the palette color.
const hex = (c) => formatHex(clampChroma(parse(c), 'oklch'));
const C = Object.fromEntries(Object.entries(brand).map(([k, v]) => [k, hex(v)]));
const L = modes.light;
const D = modes.dark;
const n = (x) => +x.toFixed(2);

const svgDoc = (w, h, title, body, viewBox = `0 0 ${w} ${h}`) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="${viewBox}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;

// ---------------------------------------------------------------- wordmark
const fontBuf = fs.readFileSync(path.join(root, 'fonts/Parkinsans-600.ttf'));
const font = opentype.parse(fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength));
const WORD = 'yonder';
const TRACKING = -0.012; // em; Parkinsans is set a touch loose for text sizes

/** Outlines `text` at `size` with baseline at y=0 (SVG y-down). */
function outline(text, size) {
  const k = size / font.unitsPerEm;
  let x = 0;
  let prev = null;
  const d = [];
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for (const ch of text) {
    const g = font.charToGlyph(ch);
    if (prev) x += font.getKerningValue(prev, g) * k;
    const p = g.getPath(x, 0, size);
    const b = p.getBoundingBox();
    box.x1 = Math.min(box.x1, b.x1);
    box.y1 = Math.min(box.y1, b.y1);
    box.x2 = Math.max(box.x2, b.x2);
    box.y2 = Math.max(box.y2, b.y2);
    d.push(p.toPathData({ decimalPlaces: 2, flipY: false }));
    x += g.advanceWidth * k + TRACKING * size;
    prev = g;
  }
  return { d: d.join(''), box: { ...box, w: box.x2 - box.x1, h: box.y2 - box.y1 } };
}

const word = outline(WORD, 100);
// Metrics used for alignment: the lowercase ascender (d) and descender (y),
// as positive distances from the baseline. Glyph boxes are in font units, y-up.
const asc = font.charToGlyph('d').getBoundingBox().y2 * (100 / font.unitsPerEm);
const desc = -font.charToGlyph('y').getBoundingBox().y1 * (100 / font.unitsPerEm);

function wordmarkSvg(fill, title) {
  const pad = 0;
  const { x1, y1, w, h } = word.box;
  const vb = `${n(x1 - pad)} ${n(y1 - pad)} ${n(w + 2 * pad)} ${n(h + 2 * pad)}`;
  return svgDoc((w / h) * 64, 64, title, `<path fill="${fill}" d="${word.d}"/>`, vb);
}

// ---------------------------------------------------------------- mark
const mb = bounds(standard);
function markSvg(stroke, dot, title, height = 64) {
  const vb = `${n(mb.x1)} ${n(mb.y1)} ${n(mb.w)} ${n(mb.h)}`;
  return svgDoc((mb.w / mb.h) * height, height, title, markElements(standard, { stroke, dot }), vb);
}

// Lockup: the mark spans the word's ascender-to-descender height and sits a
// fifth of an em to its left, centered on the same band.
function lockupSvg(markStroke, dot, wordFill, title) {
  const band = asc + desc;
  const s = (band * 0.98) / mb.h;
  const bandCenter = (-asc + desc) / 2;
  const gap = 22;
  const markW = mb.w * s;
  const tx = -mb.x1 * s;
  const ty = bandCenter - mb.cy * s;
  const wordX = markW + gap - word.box.x1;
  const top = Math.min(-asc, ty + mb.y1 * s, word.box.y1);
  const bottom = Math.max(desc, ty + mb.y2 * s, word.box.y2);
  const W = wordX + word.box.x2;
  const H = bottom - top;
  const body =
    `<g transform="translate(${n(tx)} ${n(ty)}) scale(${n(s)})">${markElements(standard, { stroke: markStroke, dot })}</g>` +
    `<path transform="translate(${n(wordX)} 0)" fill="${wordFill}" d="${word.d}"/>`;
  return svgDoc((W / H) * 64, 64, title, body, `0 ${n(top)} ${n(W)} ${n(H)}`);
}

out('logo/yonder-mark.svg', markSvg(C.dusk, C.apricot, 'Yonder'));
out('logo/yonder-mark-dark.svg', markSvg(C.periwinkle, hex(D.glow), 'Yonder'));
out('logo/yonder-mark-mono.svg', markSvg('currentColor', 'currentColor', 'Yonder'));
out('logo/yonder-wordmark.svg', wordmarkSvg(C.ink, 'Yonder'));
out('logo/yonder-wordmark-dark.svg', wordmarkSvg(hex(D.foreground), 'Yonder'));
out('logo/yonder-lockup.svg', lockupSvg(C.dusk, C.apricot, C.ink, 'Yonder'));
out('logo/yonder-lockup-dark.svg', lockupSvg(C.periwinkle, hex(D.glow), hex(D.foreground), 'Yonder'));

// ---------------------------------------------------------------- icons
const duskGradient = (id) =>
  `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${C.duskHigh}"/><stop offset="1" stop-color="${C.duskDeep}"/></linearGradient></defs>`;

/**
 * Square icon. `inkHeight` is the mark's ink height as a fraction of the
 * canvas; `fit` alternatively scales the mark so its farthest ink point is
 * `fit` x size from the center (for maskable safe zones).
 */
function iconSvg({ size, rx = 0, gradient = true, g = standard, inkHeight, fit, title = 'Yonder' }) {
  const b = bounds(g);
  const s = fit ? (fit * size) / reach(g, b.cx, b.cy) : (inkHeight * size) / b.h;
  const tx = size / 2 - b.cx * s;
  const ty = size / 2 - b.cy * s;
  const fill = gradient ? 'url(#dusk)' : C.dusk;
  const body =
    (gradient ? duskGradient('dusk') : '') +
    `<rect width="${size}" height="${size}"${rx ? ` rx="${n(rx)}"` : ''} fill="${fill}"/>` +
    `<g transform="translate(${n(tx)} ${n(ty)}) scale(${n(s)})">${markElements(g, { stroke: '#ffffff', dot: C.apricot })}</g>`;
  return svgDoc(size, size, title, body);
}

// Favicon: flat tile, heavy cut, drawn on the 48 grid with no transform so the
// stem stays pixel-aligned at 16px and 32px (see src/mark.mjs).
const favicon = svgDoc(
  32,
  32,
  'Yonder',
  `<rect width="48" height="48" rx="11" fill="${C.dusk}"/>${markElements(small, { stroke: '#ffffff', dot: C.apricot })}`,
  '0 0 48 48',
);

const iconAny = iconSvg({ size: 512, rx: 116, inkHeight: 0.56 });
// Maskable: full bleed; the safe zone is a centered circle of radius 0.4 x size.
// Keep the ink inside 0.34 so it clears circle, squircle and teardrop masks.
const iconMaskable = iconSvg({ size: 512, fit: 0.34 });
// iOS masks the icon itself and shows transparency as black: full bleed, opaque.
const iconApple = iconSvg({ size: 180, inkHeight: 0.56 });

out('icons/favicon.svg', favicon);
out('icons/icon.svg', iconAny);
out('icons/icon-maskable.svg', iconMaskable);
out('icons/apple-touch-icon.svg', iconApple);

const png = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
const pngs = {
  'icons/favicon-16.png': png(favicon, 16),
  'icons/favicon-32.png': png(favicon, 32),
  'icons/favicon-48.png': png(favicon, 48),
  'icons/apple-touch-icon.png': png(iconApple, 180),
  'icons/icon-192.png': png(iconAny, 192),
  'icons/icon-512.png': png(iconAny, 512),
  'icons/icon-maskable-192.png': png(iconMaskable, 192),
  'icons/icon-maskable-512.png': png(iconMaskable, 512),
};
for (const [rel, buf] of Object.entries(pngs)) out(rel, buf);

// favicon.ico with PNG-compressed 16/32/48 entries (supported since Vista and by every browser).
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((im) => im.data)]);
}
out(
  'icons/favicon.ico',
  ico([16, 32, 48].map((size) => ({ size, data: pngs[`icons/favicon-${size}.png`] }))),
);

out(
  'icons/site.webmanifest',
  `${JSON.stringify(
    {
      name: 'Yonder',
      short_name: 'Yonder',
      description: 'Plan trips together.',
      start_url: '/',
      display: 'standalone',
      background_color: hex(L.background),
      theme_color: hex(L.background),
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      ],
    },
    null,
    2,
  )}\n`,
);

// ---------------------------------------------------------------- tokens
const stack = {
  sans: `'${fonts.body.family}', ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'`,
  display: `'${fonts.display.family}', '${fonts.body.family}', ui-sans-serif, system-ui, sans-serif`,
  mono: `'${fonts.mono.family}', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
};
const block = (sel, t, extra) =>
  `${sel} {\n${extra}${Object.entries(t)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join('\n')}\n}\n`;

const colorNames = Object.keys(L);
const theme = `/*
 * Yonder theme for shadcn/ui on Tailwind v4.
 * GENERATED by brand/scripts/build.mjs from brand/src/palette.mjs. Edit the palette, not this file.
 *
 * Use: replace the :root, .dark and @theme inline blocks in src/styles.css with this file
 * (keep \`@import 'tailwindcss'\` and \`@custom-variant dark (&:is(.dark *));\` above it).
 * Fonts are loaded separately: see brand/BRAND.md > Type.
 */

${block(':root', { radius, ...L }, '  color-scheme: light;\n')}
${block('.dark', D, '  color-scheme: dark;\n')}
@theme inline {
  --font-sans: ${stack.sans};
  --font-display: ${stack.display};
  --font-mono: ${stack.mono};
${colorNames.map((k) => `  --color-${k}: var(--${k});`).join('\n')}
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}
`;
out('tokens/theme.css', theme);

const both = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { oklch: v, hex: hex(v) }]));
const tokens = {
  $comment: 'Generated by brand/scripts/build.mjs. Hex values are the sRGB equivalents, for canvases, map styles and anything that cannot parse oklch().',
  brand: both(brand),
  light: both(L),
  dark: both(D),
  map: Object.fromEntries(
    Object.entries(mapModes).map(([mode, m]) => [
      mode,
      { ...m, light: hex(L[m.token]), dark: hex(D[m.token]), casingLight: hex(L['map-casing']), casingDark: hex(D['map-casing']) },
    ]),
  ),
  fonts: { ...fonts, stacks: stack },
  radius,
};
out('tokens/tokens.json', `${JSON.stringify(tokens, null, 2)}\n`);

// Preview data: the preview page is opened from file://, where fetch() of a
// sibling JSON file is blocked, so the same data ships as a script.
const markData = (g) => ({ d: pathData(g), sw: g.sw, dot: g.dot, bounds: bounds(g) });
out(
  'preview/data.js',
  `// Generated by brand/scripts/build.mjs for preview/index.html.\nwindow.BRAND = ${JSON.stringify({ tokens, basemaps, mark: markData(standard) })};\n`,
);

// Keep the token table in BRAND.md in sync with the palette.
const brandMd = path.join(root, 'BRAND.md');
if (fs.existsSync(brandMd)) {
  const start = '<!-- tokens:start (generated by scripts/build.mjs) -->';
  const end = '<!-- tokens:end -->';
  const md = fs.readFileSync(brandMd, 'utf8');
  const a = md.indexOf(start);
  const b = md.indexOf(end);
  if (a > -1 && b > a) {
    const cell = (v) => `\`${v.replace('oklch', '')}\` ${hex(v)}`;
    const rows = colorNames.map((k) => `| \`--${k}\` | ${cell(L[k])} | ${cell(D[k])} |`);
    const table = ['| Token | Light `(L C H)` hex | Dark `(L C H)` hex |', '| --- | --- | --- |', ...rows].join('\n');
    fs.writeFileSync(brandMd, `${md.slice(0, a + start.length)}\n${table}\n${md.slice(b)}`);
    written.push('BRAND.md (token table)');
  }
}

console.log(`Wrote ${written.length} files:\n  ${written.join('\n  ')}`);

// Checks WCAG 2.x contrast for every token pair the UI actually uses.
// Text pairs need 4.5:1, non-text (focus ring, map lines, chart marks) 3:1.
// Exit code 1 if any required pair fails. Run: pnpm check
import { formatHex, interpolate, parse, wcagContrast } from 'culori';
import { basemaps, modes } from '../src/palette.mjs';

// Composite `top` at `alpha` over `under` in sRGB, the way the browser does.
const over = (top, alpha, under) => interpolate([under, top], 'rgb')(alpha);

const TEXT = 4.5;
const UI = 3;

function pairs(t, mode) {
  const text = [
    ['foreground', 'background'],
    ['foreground', 'muted'],
    ['foreground', 'secondary'],
    ['card-foreground', 'card'],
    ['popover-foreground', 'popover'],
    ['muted-foreground', 'background'],
    ['muted-foreground', 'card'],
    ['muted-foreground', 'muted'],
    ['primary', 'background'],
    ['primary', 'card'],
    ['primary-foreground', 'primary'],
    ['secondary-foreground', 'secondary'],
    ['accent-foreground', 'accent'],
    ['foreground', 'accent'],
    ['destructive', 'background'],
    ['destructive', 'card'],
    ['glow-foreground', 'glow'],
    ['sidebar-foreground', 'sidebar'],
    ['sidebar-primary-foreground', 'sidebar-primary'],
    ['sidebar-accent-foreground', 'sidebar-accent'],
  ].map(([fg, bg]) => ({ label: `${fg} on ${bg}`, fg: t[fg], bg: t[bg], min: TEXT }));

  // shadcn's destructive Button/Badge: text-white on bg-destructive, and on
  // bg-destructive/60 over the page in dark mode.
  const destructiveBg = mode === 'dark' ? over(parse(t.destructive), 0.6, parse(t.background)) : t.destructive;
  text.push({ label: `white on destructive${mode === 'dark' ? '/60' : ''} (button)`, fg: '#fff', bg: destructiveBg, min: TEXT });

  const ui = [
    ['ring', 'background'],
    ['ring', 'card'],
    ...[1, 2, 3, 4, 5].map((n) => [`chart-${n}`, 'card']),
  ].map(([fg, bg]) => ({ label: `${fg} on ${bg}`, fg: t[fg], bg: t[bg], min: UI }));

  for (const m of ['map-walk', 'map-transit', 'map-flight']) {
    basemaps[mode].forEach((ground, i) => {
      ui.push({ label: `${m} on basemap ${['land', 'water', 'park'][i]}`, fg: t[m], bg: ground, min: UI });
    });
  }
  return [...text, ...ui];
}

let failures = 0;
for (const [mode, t] of Object.entries(modes)) {
  console.log(`\n${mode.toUpperCase()}`);
  for (const p of pairs(t, mode)) {
    const ratio = wcagContrast(p.fg, p.bg);
    const ok = ratio >= p.min;
    if (!ok) failures++;
    const bg = typeof p.bg === 'string' ? p.bg : formatHex(p.bg);
    console.log(`${ok ? ' ok ' : 'FAIL'}  ${ratio.toFixed(2).padStart(5)} (min ${p.min})  ${p.label.padEnd(44)} ${formatHex(p.fg)} / ${formatHex(bg)}`);
  }
}
console.log(failures ? `\n${failures} pair(s) below target` : '\nAll pairs meet their target.');
process.exit(failures ? 1 : 0);

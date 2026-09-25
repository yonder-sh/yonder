#!/usr/bin/env node
// Screenshot a URL with Playwright (nixpkgs browsers). Run through pw.sh so the env is set:
//   ./pw.sh node shot.mjs <url> <out.png> [--mobile] [--browser chromium|firefox|webkit]
//                         [--full] [--width N --height N] [--wait-for <css>] [--delay ms] [--dark]
import { chromium, firefox, webkit, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const usage = `usage: shot.mjs <url> <out.png> [--mobile] [--browser chromium|firefox|webkit]
                 [--full] [--width N] [--height N] [--wait-for <css>] [--delay ms] [--dark]`;

const args = process.argv.slice(2);
const positional = [];
const opts = { mobile: false, browser: 'chromium', full: false, dark: false, delay: 0 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    const v = args[++i];
    if (v === undefined) { console.error(`${a} needs a value\n${usage}`); process.exit(2); }
    return v;
  };
  if (a === '--mobile') opts.mobile = true;
  else if (a === '--full') opts.full = true;
  else if (a === '--dark') opts.dark = true;
  else if (a === '--browser') opts.browser = next();
  else if (a === '--width') opts.width = Number(next());
  else if (a === '--height') opts.height = Number(next());
  else if (a === '--wait-for') opts.waitFor = next();
  else if (a === '--delay') opts.delay = Number(next());
  else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
  else if (a.startsWith('--')) { console.error(`unknown flag ${a}\n${usage}`); process.exit(2); }
  else positional.push(a);
}
const [url, out] = positional;
if (!url || !out) { console.error(usage); process.exit(2); }

const engines = { chromium, firefox, webkit };
const engine = engines[opts.browser];
if (!engine) { console.error(`unknown browser ${opts.browser}`); process.exit(2); }

// Mobile: Pixel 7 (412x839 @2.625, touch, mobile UA) on chromium; iPhone 15 on webkit.
// Firefox has no isMobile support, so on firefox --mobile just uses a 390x844 viewport.
let contextOptions;
if (opts.mobile) {
  if (opts.browser === 'webkit') contextOptions = { ...devices['iPhone 15'] };
  else if (opts.browser === 'firefox') contextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true };
  else contextOptions = { ...devices['Pixel 7'] };
} else {
  contextOptions = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
}
if (opts.width || opts.height) {
  contextOptions.viewport = {
    width: opts.width ?? contextOptions.viewport.width,
    height: opts.height ?? contextOptions.viewport.height,
  };
}
if (opts.dark) contextOptions.colorScheme = 'dark';

const browser = await engine.launch({ headless: true });
try {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  // 'load' then a bounded networkidle: a Vite dev server (HMR, devtools) may never go fully idle.
  const resp = await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 30_000 });
  if (opts.delay) await page.waitForTimeout(opts.delay);
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: opts.full });
  const vp = page.viewportSize();
  console.log(`${path}  [${opts.browser}${opts.mobile ? ' mobile' : ''} ${vp.width}x${vp.height}${opts.full ? ' full-page' : ''}] HTTP ${resp?.status() ?? '?'}`);
} finally {
  await browser.close();
}

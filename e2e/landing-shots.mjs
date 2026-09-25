#!/usr/bin/env node
// The landing page's product screenshots, raw (PNG). Run by `pnpm landing:shots`
// (scripts/landing/shots.ts), which starts an isolated env with the showcase
// trip, then encodes these into public/landing/. Through pw.sh (nixpkgs browsers):
//
//   ./pw.sh node landing-shots.mjs --base http://localhost:5980 --out <dir> [--only a,b]
//
// Signs in as alex@example.com (the showcase's owner) and maya@example.com
// with the env's fixed code (DEV_FIXED_OTP=000000).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE = opt('base', 'http://localhost:5980');
const OUT = opt('out', 'shots/landing');
const ONLY = opt('only', '')?.split(',').filter(Boolean) ?? [];
const SLUG = opt('slug', 'east-asia');
const OTP = process.env.DEV_FIXED_OTP || '000000';
mkdirSync(OUT, { recursive: true });

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
/** The main pane of the desktop workspace (outline 264 px, map from 784 px). */
const PANE = { x: 264, y: 92, width: 520, height: 325 };
/** Each crop starts below the tab's own toolbar, where its content does. */
const pane = (y) => ({ ...PANE, y });

const browser = await chromium.launch({ headless: true });

async function login(ctx, email) {
  const h = { Origin: BASE, 'Content-Type': 'application/json' };
  const send = await ctx.request.post(`${BASE}/api/auth/email-otp/send-verification-otp`, {
    data: { email, type: 'sign-in' },
    headers: { ...h, 'x-captcha-response': 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  if (!send.ok()) throw new Error(`send-otp ${email}: ${send.status()} ${await send.text()}`);
  const sign = await ctx.request.post(`${BASE}/api/auth/sign-in/email-otp`, { data: { email, otp: OTP }, headers: h });
  if (!sign.ok()) throw new Error(`sign-in ${email}: ${sign.status()} ${await sign.text()}`);
}

async function context(kind, theme, email = 'alex@example.com') {
  const ctx = await browser.newContext({
    ...(kind === 'phone' ? PHONE : DESKTOP),
    // The grid's crops of the main pane: 520 × 325 at 2.4× (encoded at 1200 × 750).
    ...(kind === 'pane' ? { deviceScaleFactor: 2.4 } : {}),
    colorScheme: theme,
    reducedMotion: 'reduce',
    baseURL: BASE,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  });
  await login(ctx, email);
  return ctx;
}

/** Opens a workspace URL and waits until it's live and the map has settled. */
async function openTrip(page, url, { settle = 3500 } = {}) {
  await page.goto(url, { waitUntil: 'load', timeout: 180_000 });
  await page.getByTestId('workspace').waitFor({ state: 'visible', timeout: 90_000 });
  await page
    .waitForFunction(
      () => {
        const pills = [...document.querySelectorAll('[data-testid="connection-pill"]')];
        return pills.length === 0 || pills.some((p) => p.getAttribute('data-status') === 'live');
      },
      null,
      { timeout: 60_000 },
    )
    .catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(settle);
}

async function nodeId(page, name) {
  const id = await page.evaluate((n) => window.__yonder?.graph?.nodes?.find((x) => x.name === n)?.id ?? null, name);
  if (!id) throw new Error(`no node "${name}" (is VITE_E2E=1 on?)`);
  return id;
}

const saved = [];
async function save(page, name, clip) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, ...(clip ? { clip } : {}), animations: 'disabled', caret: 'hide' });
  saved.push(path);
  console.log(`[landing:shots] ${name}`);
}

const want = (name) => ONLY.length === 0 || ONLY.includes(name);
const trip = `/t/${SLUG}`;

const SHOTS = {
  async places(theme) {
    const ctx = await context('desktop', theme);
    const page = await ctx.newPage();
    await openTrip(page, `${trip}?tab=places`);
    // The tab without the outline and top bar: the table reads bigger.
    await save(page, `places-${theme}`, { x: 200, y: 52, width: 1176, height: 735 });
    await ctx.close();
  },
  async rate(theme) {
    if (theme !== 'dark') return;
    const ctx = await context('phone', theme);
    const page = await ctx.newPage();
    await openTrip(page, `${trip}?tab=places`);
    const nara = await nodeId(page, 'Nara Park');
    await openTrip(page, `${trip}/rate?n=${nara}`, { settle: 3000 });
    await save(page, `rate-${theme}`);
    await ctx.close();
  },
  async plan(theme) {
    const ctx = await context('desktop', theme);
    const page = await ctx.newPage();
    await openTrip(page, `${trip}/japan/kyoto?tab=plan&days=2026-10-23`, { settle: 6000 });
    await save(page, `plan-${theme}`);
    await ctx.close();
  },
  async flight(theme) {
    const ctx = await context('phone', theme);
    const page = await ctx.newPage();
    await openTrip(page, `${trip}?tab=plan&days=2026-11-04`, { settle: 4000 });
    // Pull the sheet up to its top snap (vaul follows the pointer).
    const box = await page.getByTestId('mobile-sheet').boundingBox();
    if (box) {
      const x = box.x + box.width / 2;
      await page.mouse.move(x, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(x, box.y - 200, { steps: 6 });
      await page.mouse.move(x, 60, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(1500);
    }
    await save(page, `flight-${theme}`);
    await ctx.close();
  },
  async overview(theme) {
    if (theme !== 'dark') return;
    const ctx = await context('desktop', theme);
    const page = await ctx.newPage();
    await openTrip(page, trip, { settle: 7000 });
    await save(page, `overview-${theme}`);
    await ctx.close();
  },
  async card(theme) {
    if (theme !== 'dark') return;
    const ctx = await context('desktop', theme);
    const res = await ctx.request.get(`${trip}/share-card.png?size=story`);
    if (!res.ok()) throw new Error(`share card: ${res.status()}`);
    const path = join(OUT, 'card-dark.png');
    writeFileSync(path, await res.body());
    saved.push(path);
    console.log('[landing:shots] card-dark');
    await ctx.close();
  },
  async live(theme) {
    const url = `${trip}/japan/kyoto?tab=plan&days=2026-10-23`;
    const a = await context('desktop', theme);
    const m = await context('desktop', theme, 'maya@example.com');
    const pa = await a.newPage();
    const pm = await m.newPage();
    await Promise.all([openTrip(pa, url, { settle: 5000 }), openTrip(pm, url, { settle: 5000 })]);
    // The card in the timeline (not the outline row or the map label).
    let box = null;
    for (const el of await pm.getByText('Fushimi Inari Taisha', { exact: true }).all()) {
      const b = await el.boundingBox();
      if (b && b.x > 300 && b.x < 780) box = b;
    }
    if (!box) throw new Error('no Fushimi card on Maya\'s screen');
    // Maya selects it (Alex sees her ring on it), then points and says something.
    await pm.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await pm.waitForTimeout(1200);
    const x = box.x + box.width * 0.9;
    const y = box.y + box.height * 0.6;
    await pm.mouse.move(x - 40, y + 30);
    await pm.mouse.move(x, y, { steps: 8 });
    await pm.keyboard.press('/');
    await pm.keyboard.type('Sunrise here first? It\'s quiet before 8', { delay: 25 });
    await pa.mouse.move(1100, 620);
    await pa.waitForTimeout(1500);
    await pm.mouse.move(x + 2, y + 1);
    await pa.waitForTimeout(700);
    await save(pa, `live-${theme}`);
    await a.close();
    await m.close();
  },
  async media(theme) {
    const ctx = await context('pane', theme);
    const page = await ctx.newPage();
    await openTrip(page, `${trip}?tab=media`);
    await save(page, `media-${theme}`, pane(196));
    await ctx.close();
  },
  async lists(theme) {
    const ctx = await context('pane', theme);
    const page = await ctx.newPage();
    await openTrip(page, `${trip}?tab=lists`);
    await save(page, `lists-${theme}`, pane(212));
    await ctx.close();
  },
  async notes(theme) {
    const ctx = await context('pane', theme);
    const page = await ctx.newPage();
    await openTrip(page, `${trip}?tab=notes`);
    await save(page, `notes-${theme}`, pane(172));
    await ctx.close();
  },
  async money(theme) {
    const ctx = await context('pane', theme);
    const page = await ctx.newPage();
    await openTrip(page, `${trip}?tab=money`);
    await save(page, `money-${theme}`, pane(98));
    await ctx.close();
  },
  async offline(theme) {
    const ctx = await context('phone', theme);
    const page = await ctx.newPage();
    await page.goto('/dashboard', { waitUntil: 'load', timeout: 180_000 });
    await page.getByTestId('dashboard').waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await save(page, `offline-${theme}`);
    await ctx.close();
  },
};

let failed = 0;
try {
  for (const [name, shoot] of Object.entries(SHOTS)) {
    if (!want(name)) continue;
    for (const theme of ['light', 'dark']) {
      try {
        await shoot(theme);
      } catch (e) {
        failed++;
        console.error(`[landing:shots] ${name}-${theme} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }
} finally {
  await browser.close();
}
writeFileSync(join(OUT, 'shots.json'), JSON.stringify(saved, null, 2));
if (failed) process.exitCode = 1;

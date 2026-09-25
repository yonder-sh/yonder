/**
 * WP-Shell, owner feedback round 1 and the QA round-3 shell bugs
 * (`docs/qa/FEEDBACK-1.md`, `docs/qa/OPEN_BUGS.json`), on the QA seed
 * (`pnpm db:seed:qa`, trip `asia-2027`). Tests on `asia-2027` are READ-ONLY
 * (a what-if draft never leaves the tab; menus and the palette are closed);
 * the empty-trip case creates its own trip.
 *
 * - FB-05: rating is one step away: the top bar's "Rate", the trip menu, ⌘K
 *   "Rate places", and Still to plan's unrated counts all open the Places
 *   tab's Rate view (docs/PLACES.md §1b: the old Rate screen folded in).
 * - PLAN-R3-02 / VIS3-04: Still to plan counts the Places tab's places (an
 *   unaccepted suggestion is not a place to rate).
 * - FB-12: a node with no children offers no "Everything inside / Only …"
 *   choice (the center tabs, the inspector's Media and Lists tabs).
 * - Phone: COLLAB-R3-03 (the what-if chip), VIS3-03 (`?tab=` opens the sheet
 *   at half) and VIS3-09 (a new trip's peek says "Where to first?", and the
 *   map's empty card stays clear of the sheet).
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 N pnpm e2e -- tests/app/shell-feedback-r1.spec.ts
 */
import { expect, type Page, test } from "@playwright/test";
import { PLACES_TAB_TESTID as PT } from "../../../src/features/places/tab/testids";
import { SHELL_TESTID } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath } from "./_helpers/env";

test.describe.configure({ mode: "default" });

const TRIP = "asia-2027";
const DENNIS = { email: "dennis@asia2027.test", first: "Dennis", last: "Tester" };

/** Parallel sign-ins of one QA user race for the one-time code: retry. */
async function signIn(page: Page): Promise<void> {
	for (let i = 0; ; i++) {
		try {
			return await loginViaApi(page.request, DENNIS.email, { first: DENNIS.first, last: DENNIS.last });
		} catch (e) {
			if (i >= 4) throw e;
			await page.waitForTimeout(500 + Math.random() * 1500);
		}
	}
}

async function openTrip(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(() => page.evaluate(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph))
		.toBe(true);
}

type G = {
	me: { memberId: string | null };
	nodes: { id: string; name: string }[];
	members: { id: string; name?: string; displayName?: string }[];
};
async function nodeId(page: Page, name: string): Promise<string> {
	const g = await page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
	const id = g.nodes.find((n) => n.name === name)?.id;
	if (!id) throw new Error(`no node ${name}`);
	return id;
}

const settle = (page: Page) => page.waitForTimeout(400);

/** The Places tab's Rate view is open (its URL and the feed). */
async function expectRateView(page: Page, path: string, extra?: RegExp): Promise<void> {
	await expect(page.getByTestId(PT.feed)).toBeVisible({ timeout: 30_000 });
	const url = new URL(page.url());
	expect(url.pathname).toBe(path);
	expect(url.searchParams.get("tab")).toBe("places");
	expect(url.searchParams.get("pv")).toBe("rate");
	if (extra) expect(url.search).toMatch(extra);
}

/** "rated/total" for a member in the Places tab's progress. */
async function progressOf(page: Page, memberId: string): Promise<[number, number]> {
	const el = page.getByTestId(PT.progress).locator(`[data-member="${memberId}"]`);
	await expect(el).toBeVisible({ timeout: 30_000 });
	const m = /(\d+)\/(\d+)/.exec(await el.innerText());
	return [Number(m?.[1]), Number(m?.[2])];
}

test.describe("desktop", () => {
	test("PLAN-R3-02 / VIS3-04: Still to plan counts the Places tab's places, not an unaccepted suggestion", async ({ page }, info) => {
		test.skip(info.project.name !== "chromium", "chromium project (the viewport is set here)");
		await signIn(page);
		await openTrip(page, `/t/${TRIP}?sel=root`);
		const stp = page.getByTestId(SHELL_TESTID.stillToPlan);
		const head = stp.getByRole("button", { name: /unrated places/ });
		const panelCount = Number(/(\d+)/.exec(await head.innerText())?.[1]);
		await head.click();
		const text = (await stp.innerText()).replace(/\s+/g, " ");
		const me = /You (\d+) of (\d+)/.exec(text);
		const audrey = /Audrey Tester (\d+) of (\d+)/.exec(text);
		expect(me, text).not.toBeNull();
		expect(audrey, text).not.toBeNull();
		const g = await page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
		const audreyId = g.members.find((m) => /Audrey/.test(m.name ?? m.displayName ?? ""))?.id as string;
		expect(audreyId).toBeTruthy();

		// The old Rate screen's link: the Places tab's Rate view, its header has the progress.
		await page.goto(`/t/${TRIP}/rate`);
		const [rated, total] = await progressOf(page, g.me.memberId as string);
		const [audreyRated, audreyTotal] = await progressOf(page, audreyId);
		// Maya's unaccepted Tōfuku-ji is not a place to rate: 47 of 125, not 48 of 126.
		expect(Number(me?.[2])).toBe(total);
		expect(Number(me?.[1])).toBe(total - rated);
		expect(panelCount).toBe(total - rated);
		expect(Number(audrey?.[2])).toBe(audreyTotal);
		expect(Number(audrey?.[1])).toBe(audreyTotal - audreyRated);
	});

	test("FB-05: the Rate view from the top bar, the trip menu, ⌘K and Still to plan", async ({ page }, info) => {
		test.skip(info.project.name !== "chromium", "chromium project (the viewport is set here)");
		await signIn(page);
		await openTrip(page, `/t/${TRIP}?sel=root`);
		const topBar = page.getByTestId(TESTID.topBar);

		// 1. The top bar: a labelled "Rate" next to Share.
		const rate = topBar.getByTestId(SHELL_TESTID.rateButton);
		await expect(rate).toBeVisible();
		await expect(rate).toHaveText(/Rate/);
		await settle(page);
		await topBar.screenshot({ path: shotPath("shell/fb05-topbar-rate.png"), animations: "disabled" });
		await rate.click();
		await expectRateView(page, `/t/${TRIP}`);

		// Inside a scope, it rates that scope's places ("Rate places in Tokyo").
		await openTrip(page, `/t/${TRIP}/japan/tokyo`);
		const bar = page.getByTestId(TESTID.topBar).getByTestId(SHELL_TESTID.rateButton);
		await expect(bar).toHaveAttribute("title", "Rate places in Tokyo");
		await bar.click();
		await expectRateView(page, `/t/${TRIP}/japan/tokyo`);

		// 2. The trip title menu.
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		await page.getByTestId(TESTID.tripMenu).click();
		await expect(page.getByRole("menuitem", { name: /Rate places/ })).toBeVisible();
		await page.keyboard.press("Escape");

		// 3. ⌘K: "Rate places" shows with no query, and for "rate".
		await page.keyboard.press("ControlOrMeta+k");
		const palette = page.getByTestId(TESTID.addPlaceDialog);
		await expect(palette).toBeVisible();
		await expect(palette.getByTestId("places-palette-rate")).toBeVisible();
		await palette.getByTestId("places-palette-input").fill("rate");
		const cmd = palette.getByTestId("places-palette-rate");
		await expect(cmd).toBeVisible();
		await expect(cmd).toContainText("Rate places");
		await settle(page);
		await page.screenshot({ path: shotPath("shell/fb05-palette-rate.png"), animations: "disabled" });
		await cmd.click();
		await expectRateView(page, `/t/${TRIP}`);

		// 4. Still to plan: each member's unrated count opens the Rate view on their unrated places.
		await openTrip(page, `/t/${TRIP}?sel=root`);
		const stp = page.getByTestId(SHELL_TESTID.stillToPlan);
		await stp.getByRole("button", { name: /unrated places/ }).click();
		await settle(page);
		await page.getByTestId(TESTID.inspector).screenshot({ path: shotPath("shell/fb05-still-to-plan-rate.png"), animations: "disabled" });
		const you = stp.getByRole("link", { name: /You \d+ of \d+/ });
		await expect(you).toBeVisible();
		await you.click();
		await expectRateView(page, `/t/${TRIP}`, /f=u(%3A|:)me/);
	});

	test("FB-05: the top bar still fits at 1100 and 900 px with Rate (icon only at md)", async ({ page }, info) => {
		test.skip(info.project.name !== "chromium", "chromium project (the viewport is set here)");
		await signIn(page);
		for (const width of [1280, 1100, 900] as const) {
			await page.setViewportSize({ width, height: 900 });
			await openTrip(page, `/t/${TRIP}/japan/tokyo`);
			const bar = page.getByTestId(TESTID.topBar);
			const rate = bar.getByTestId(SHELL_TESTID.rateButton);
			await expect(rate).toBeInViewport({ ratio: 1 });
			await expect(bar.getByTestId(TESTID.shareButton)).toBeInViewport({ ratio: 1 });
			const fit = await bar.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
			expect(fit.scroll, `top bar at ${width}`).toBeLessThanOrEqual(fit.client);
			if (width === 900) await expect(rate.getByText("Rate")).toHaveClass(/sr-only/);
			await settle(page);
			await bar.screenshot({ path: shotPath(`shell/fb05-topbar-${width}.png`), animations: "disabled" });
		}
	});

	test("FB-12: no 'Everything inside / Only …' choice for a node with no children", async ({ page }, info) => {
		test.skip(info.project.name !== "chromium", "chromium project (the viewport is set here)");
		await signIn(page);
		const include = (p: Page) => p.getByTestId(TESTID.centerPanel).getByLabel("What to include");

		// Center tabs: Tokyo has children, Akihabara (an area) has none.
		await openTrip(page, `/t/${TRIP}/japan/tokyo?tab=lists`);
		await expect(include(page)).toBeVisible();
		await openTrip(page, `/t/${TRIP}/japan/tokyo/akihabara?tab=lists`);
		await expect(page.getByTestId(TESTID.centerPanel).getByRole("tablist", { name: "Views" })).toBeVisible();
		await expect(include(page)).toHaveCount(0);
		await settle(page);
		await page.getByTestId(TESTID.centerPanel).screenshot({ path: shotPath("shell/fb12-center-leaf.png"), animations: "disabled" });
		// A link that says "only" on such a node shows everything instead (nothing to switch back with).
		await openTrip(page, `/t/${TRIP}/japan/tokyo/akihabara?tab=media&only=1`);
		await expect(page).not.toHaveURL(/only=1/);

		// Inspector: Shibuya Sky (a place, no children) vs Shibuya (an area with places).
		await openTrip(page, `/t/${TRIP}/japan/tokyo`);
		const sky = await nodeId(page, "Shibuya Sky");
		const shibuya = await nodeId(page, "Shibuya");
		const tabs = () => page.getByTestId(SHELL_TESTID.inspectorTabs);
		// A click that lands while the inspector is still settling is retried.
		const openTab = (name: RegExp) =>
			expect(async () => {
				await tabs().getByRole("tab", { name }).click();
				await expect(tabs().getByRole("tab", { name })).toHaveAttribute("aria-selected", "true", { timeout: 1_000 });
			}).toPass();
		await openTrip(page, `/t/${TRIP}/japan/tokyo?sel=n.${sky}`);
		await openTab(/Media/);
		await expect(page.getByTestId(TESTID.mediaPanel)).toBeVisible();
		await expect(page.getByTestId("media-scope-toggle")).toHaveCount(0);
		await openTab(/Lists/);
		await expect(page.getByTestId(TESTID.listsPanel)).toBeVisible();
		await expect(page.getByTestId("lists-panel-scope")).toHaveCount(0);
		await settle(page);
		await page.getByTestId(TESTID.inspector).screenshot({ path: shotPath("shell/fb12-inspector-leaf.png"), animations: "disabled" });

		await openTrip(page, `/t/${TRIP}/japan/tokyo?sel=n.${shibuya}`);
		await openTab(/Media/);
		await expect(page.getByTestId("media-scope-toggle")).toBeVisible();
		await openTab(/Lists/);
		await expect(page.getByTestId("lists-panel-scope")).toBeVisible();
	});
});

test.describe("phone 390", () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

	test("COLLAB-R3-03: a kept what-if draft shows the WhatIfChip (Review · ✕)", async ({ page }, info) => {
		test.skip(info.project.name !== "chromium", "chromium project (the viewport is set here)");
		await signIn(page);
		await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-03`);
		await page.getByRole("button", { name: "More" }).first().tap();
		// FB-05 on a phone: the ⋯ menu leads to the Rate screen too.
		await expect(page.getByRole("menuitem", { name: "Rate places in Tokyo" })).toBeVisible();
		await page.getByText("Try other dates…").first().tap();
		const dlg = page.getByTestId(TESTID.shiftTripDialog);
		await dlg.getByTestId("shift-plus").tap();
		await dlg.getByRole("button", { name: /Keep exploring/ }).tap();
		await expect(dlg).toBeHidden();
		const chip = page.getByTestId(TESTID.whatIfChip);
		await expect(chip).toBeVisible({ timeout: 3_000 });
		await expect(chip).toContainText("What-if +1 day");
		// Every control in it is a 44px touch target (MOB-07).
		for (const b of await chip.getByRole("button").all()) {
			const box = await b.evaluate((el) => {
				const r = el.getBoundingClientRect();
				const after = getComputedStyle(el, "::before");
				return { w: r.width, h: r.height, before: after.content !== "none" ? [after.width, after.height] : null };
			});
			const w = Math.max(box.w, Number.parseFloat(box.before?.[0] ?? "0"));
			const h = Math.max(box.h, Number.parseFloat(box.before?.[1] ?? "0"));
			expect(Math.min(w, h), JSON.stringify(box)).toBeGreaterThanOrEqual(44);
		}
		await settle(page);
		await page.screenshot({ path: shotPath("shell/collab-r3-03-phone-whatif.png"), animations: "disabled" });
		await chip.getByRole("button", { name: "Review" }).tap();
		await expect(dlg).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dlg).toBeHidden();
		await page.getByTestId(TESTID.whatIfChip).getByRole("button", { name: /Discard/ }).tap();
		await expect(page.getByTestId(TESTID.whatIfChip)).toHaveCount(0);
	});

	test("VIS3-03: a link with ?tab=lists opens the sheet at half, the Lists tab in view", async ({ page }, info) => {
		test.skip(info.project.name !== "chromium", "chromium project (the viewport is set here)");
		await signIn(page);
		for (const tab of ["lists", "money"] as const) {
			await openTrip(page, `/t/${TRIP}/japan/tokyo?tab=${tab}`);
			const sheet = page.getByTestId(TESTID.mobileSheet);
			await expect
				.poll(() => sheet.evaluate((s) => Math.round(s.getBoundingClientRect().top)), { message: `?tab=${tab}` })
				.toBeLessThan(480);
			const selected = sheet.getByRole("tablist", { name: "Views" }).getByRole("tab", { selected: true });
			await expect(selected).toHaveAttribute("data-tab", tab);
			await expect(selected).toBeInViewport();
		}
		await expect(page.getByTestId(TESTID.mobileSheet).getByRole("tablist", { name: "Views" }).getByRole("tab", { selected: true })).toBeInViewport();
		await settle(page);
		await page.screenshot({ path: shotPath("shell/vis3-03-phone-tab-money.png"), animations: "disabled" });
		await openTrip(page, `/t/${TRIP}/japan/tokyo?tab=lists`);
		// The center Lists tab (the inspector's is "lists-panel").
		await expect(page.getByTestId(TESTID.listsTab)).toBeInViewport();
		await settle(page);
		await page.screenshot({ path: shotPath("shell/vis3-03-phone-tab-lists.png"), animations: "disabled" });
		// The default tab still opens at the peek.
		await openTrip(page, `/t/${TRIP}/japan/tokyo`);
		await settle(page);
		expect(await page.getByTestId(TESTID.mobileSheet).evaluate((s) => Math.round(s.getBoundingClientRect().top))).toBeGreaterThan(700);
	});

	test("VIS3-09: a new trip's peek says 'Where to first?', and the map's empty card stays clear of the sheet", async ({ page }, info) => {
		test.skip(info.project.name !== "chromium", "chromium project (the viewport is set here)");
		await signIn(page);
		await page.goto("/");
		const created = await page.evaluate(async () => {
			const m = await import(/* @vite-ignore */ "/src/functions/trips.functions.ts");
			return JSON.parse(JSON.stringify(await m.createTrip({ data: { name: "Empty trip · shell e2e" } })));
		});
		const slug = (created as { slug: string }).slug;
		await openTrip(page, `/t/${slug}?tab=plan`);
		const peek = page.getByTestId(SHELL_TESTID.mobileEmptyPeek);
		await expect(peek).toBeVisible();
		await expect(peek).toContainText("Where to first?");
		await expect(peek).toBeInViewport();
		const card = page.getByTestId("map-empty");
		await expect(card).toBeVisible();
		const clear = () =>
			page.evaluate(() => {
				const c = document.querySelector('[data-testid="map-empty"]')?.getBoundingClientRect();
				const s = document.querySelector('[data-testid="mobile-sheet"]')?.getBoundingClientRect();
				return c && s ? Math.round(s.top - c.bottom) : null;
			});
		await expect.poll(clear).toBeGreaterThan(0);
		await settle(page);
		await page.screenshot({ path: shotPath("shell/vis3-09-phone-empty-peek.png"), animations: "disabled" });
		// "Search places" opens "Where to first?".
		await peek.getByRole("button", { name: /Search places/ }).tap();
		await expect(page.getByTestId(TESTID.addPlaceDialog)).toBeVisible();
		await expect(page.getByTestId(TESTID.addPlaceDialog)).toContainText("Where to first?");
		await page.keyboard.press("Escape");
		// At half (a tab in the link), the card still sits above the sheet.
		await openTrip(page, `/t/${slug}?tab=lists`);
		await expect
			.poll(() => page.getByTestId(TESTID.mobileSheet).evaluate((s) => Math.round(s.getBoundingClientRect().top)))
			.toBeLessThan(480);
		await expect.poll(clear).toBeGreaterThan(0);
		await settle(page);
		await page.screenshot({ path: shotPath("shell/vis3-09-phone-empty-half.png"), animations: "disabled" });
	});
});

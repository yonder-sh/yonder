/**
 * WP-Home dashboard (DESIGN §10.3, QA DASH-01/02, TRIP-01; ADDENDUM §9
 * "Duplicate…"). Each test clones its own demo trip (SPEC §18.5).
 *
 * - The dashboard lists the cloned trip with its dates, flags, avatars and a
 *   RouteSketch; no sideways scroll; screenshots at 1440×900 and 390×844.
 * - New trip with a Calendar range lands in the workspace with dated days.
 * - "Duplicate…" from a card's ⋯ menu opens the copy, days shifted.
 * - FB-05: "Rate places" from a card's ⋯ menu opens the trip's Rate view
 *   (docs/PLACES.md §1b: its old `/t/<trip>/rate` link redirects to the
 *   Places tab's Rate feed).
 */
import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { PLACES_TAB_TESTID } from "../../../src/features/places/tab/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { shotPath, storageStateOf } from "./_helpers/env";
import {
	collectConsole,
	expectNoHorizontalOverflow,
	hydrated,
} from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

async function settle(page: Page) {
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(400);
}

test("dashboard shows my trips with a route sketch, and fits the screen", async ({
	page,
}, info) => {
	// Its own account (the page shares the context's cookies): the shared
	// `dev` one collects every spec's clones, and a full-page shot of hundreds
	// of cards on a phone is taller than Chromium can capture.
	await loginViaApi(page.request, `dash-${randomBytes(4).toString("hex")}@example.com`, {
		first: "Dash",
		last: "Board",
	});
	const c = await cloneFixtureTrip(page.request);
	const consoleLog = collectConsole(page);
	await page.goto("/dashboard");
	await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
	// A to-do due within the 30-day window (the demo's own is due in 2027).
	const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
	await page.evaluate(
		async ({ tripId, dueDate }) => {
			const m = await import("/src/features/lists/lists.functions.ts");
			await m.createListItem({
				data: { tripId, target: { kind: "trip" }, list: "todo", text: "Renew passport", dueDate },
			});
		},
		{ tripId: c.tripId, dueDate: soon },
	);
	await page.reload();
	await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
	const card = page.locator(
		`[data-testid="${TESTID.tripCard}"][href="/t/${c.slug}"]`,
	);
	await expect(card).toBeVisible();
	// The RouteSketch draws land once the atlas chunk loads.
	await expect(page.locator('svg[data-sketch="drawn"]').first()).toBeVisible({
		timeout: 15_000,
	});
	await expectNoHorizontalOverflow(page);
	await settle(page);
	const mobile = info.project.name === "mobile";
	await page.screenshot({
		path: shotPath(`home/dashboard-${mobile ? "mobile" : "desktop"}.png`),
		animations: "disabled",
		fullPage: true,
	});
	// Upcoming deadlines: mine and unassigned; "Everyone's" adds the rest (E4).
	const deadlines = page.getByTestId(HOME_TESTID.deadlines);
	await expect(deadlines.getByTestId(HOME_TESTID.deadlineRow).first()).toBeVisible();
	const everyone = deadlines.getByTestId(HOME_TESTID.deadlinesEveryone);
	await everyone.click();
	await expect(everyone).toHaveAttribute("aria-pressed", "true");
	await expect(deadlines.getByTestId(HOME_TESTID.deadlineRow).first()).toBeVisible();
	await everyone.click();
	// Clicking a card opens the trip.
	await card.click();
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}`));
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible();
	expect(consoleLog.messages).toEqual([]);
});

test("new trip with a date range lands in the workspace", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	await page.goto("/dashboard");
	await (await hydrated(page.getByTestId(TESTID.newTripButton))).click();
	const name = `Range ${randomBytes(2).toString("hex")}`;
	await page.getByTestId(TESTID.newTripName).fill(name);
	await page.getByTestId(HOME_TESTID.newTripDates).click();
	// Pick the 10th and the 14th of the first month shown.
	const days = page.locator('[data-slot="popover-content"] button[data-day]');
	await days.filter({ hasText: /^10$/ }).first().click();
	await days.filter({ hasText: /^14$/ }).first().click();
	await expect(page.getByTestId(HOME_TESTID.newTripDates)).toContainText(
		"5 days",
	);
	await page.screenshot({
		path: shotPath("home/new-trip-desktop.png"),
		animations: "disabled",
	});
	await page.getByTestId(TESTID.newTripSubmit).click();
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible({
		timeout: 20_000,
	});
	const days5 = await page.evaluate(
		() =>
			(window as unknown as { __yonder?: { graph: { days: unknown[] } } })
				.__yonder?.graph.days.length,
	);
	expect(days5).toBe(5);
});

test("duplicate a trip from its card", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	// Its own account: the shared `dev` one collects every spec's clones, and
	// a dashboard of hundreds of cards is slow to settle in the dev server.
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(ctx.request, `dup-${randomBytes(4).toString("hex")}@example.com`, {
		first: "Dup",
		last: "Licate",
	});
	const page = await ctx.newPage();
	const c = await cloneFixtureTrip(page.request);
	await page.goto("/dashboard");
	// Let the dashboard settle first: the client re-sorts the cards once it
	// knows today's date, which remounts their menus (a heavy test account
	// with hundreds of trips makes that window long).
	await expect(page.locator('svg[data-sketch="drawn"]').first()).toBeVisible({ timeout: 30_000 });
	const menu = page
		.getByRole("button", { name: /More for Demo/ })
		.first();
	await (await hydrated(menu)).click();
	await page.getByRole("menuitem", { name: /Duplicate/ }).click();
	const dialog = page.getByTestId(HOME_TESTID.duplicateDialog);
	await expect(dialog).toBeVisible();
	const name = `Copy ${randomBytes(2).toString("hex")}`;
	await dialog.getByTestId(HOME_TESTID.duplicateName).fill(name);
	await page.screenshot({
		path: shotPath("home/duplicate-desktop.png"),
		animations: "disabled",
	});
	await dialog.getByTestId(HOME_TESTID.duplicateSubmit).click();
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByTestId(TESTID.tripMenu)).toContainText(name);
	expect(new URL(page.url()).pathname).not.toContain(c.slug);
	await ctx.close();
});

test("FB-05: 'Rate places' in a card's ⋯ menu opens the Places tab's Rate view", async ({
	browser,
}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const ctx = await browser.newContext({
		storageState: { cookies: [], origins: [] },
		viewport: { width: 1440, height: 900 },
	});
	await loginViaApi(
		ctx.request,
		`rate-${randomBytes(4).toString("hex")}@example.com`,
		{ first: "Rae", last: "Ting" },
	);
	const page = await ctx.newPage();
	const c = await cloneFixtureTrip(page.request);
	await page.goto("/dashboard");
	// The client re-sorts the cards once it knows today's date (remounting
	// their menus): wait for the sketch first, as in "duplicate".
	await expect(page.locator('svg[data-sketch="drawn"]').first()).toBeVisible({
		timeout: 30_000,
	});
	const menu = page.getByRole("button", { name: /More for Demo/ }).first();
	await (await hydrated(menu)).click();
	const rate = page.getByRole("menuitem", { name: "Rate places" });
	await expect(rate).toBeVisible();
	await expect(page.getByRole("menuitem").first()).toHaveText(/Rate places/);
	await expect(rate).toHaveAttribute("href", `/t/${c.slug}/rate`);
	await page.screenshot({
		path: shotPath("home/fb05-card-menu-rate.png"),
		animations: "disabled",
	});
	// The old Rate screen's link redirects: the whole trip, in the Places tab's Rate view.
	await rate.click();
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}\\?`), { timeout: 30_000 });
	const url = new URL(page.url());
	expect(url.pathname).toBe(`/t/${c.slug}`);
	expect(url.searchParams.get("tab")).toBe("places");
	expect(url.searchParams.get("pv")).toBe("rate");
	await expect(page.getByTestId(PLACES_TAB_TESTID.feed)).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByTestId(PLACES_TAB_TESTID.feedCard).first()).toBeVisible();
	await ctx.close();
});

test("DASH-03: the first paint already shows the real next trip, with an ended one under Past", async ({
	browser,
}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const ctx = await browser.newContext({
		storageState: { cookies: [], origins: [] },
		viewport: { width: 390, height: 844 },
	});
	await loginViaApi(
		ctx.request,
		`dash03-${randomBytes(4).toString("hex")}@example.com`,
		{ first: "Pat", last: "Past" },
	);
	const page = await ctx.newPage();
	await page.goto("/dashboard");
	await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
	await expect(page.getByRole("heading", { level: 1 })).toContainText(
		/^Good /,
		{ timeout: 30_000 },
	);
	const day = (offset: number) =>
		new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
	await page.evaluate(
		async (trips) => {
			const m = await import("/src/functions/trips.functions.ts");
			for (const data of trips) await m.createTrip({ data });
		},
		[
			{ name: "Spring (ended)", startDate: day(-170), endDate: day(-165) },
			{ name: "Winter (upcoming)", startDate: day(70), endDate: day(74) },
		],
	);

	// What a slow phone paints before any script runs: the server's HTML.
	const html = await (await ctx.request.get("/dashboard")).text();
	const at = html.indexOf(`data-testid="${HOME_TESTID.heroCard}"`);
	expect(at).toBeGreaterThan(-1);
	const past = html.indexOf(">Past<", at);
	expect(past).toBeGreaterThan(at);
	const text = (from: number, to: number) =>
		html.slice(from, to).replace(/<[^>]+>/g, " ");
	expect(text(at, past)).toContain("Winter (upcoming)");
	expect(text(at, past)).not.toContain("Spring (ended)");
	expect(text(past, past + 3000)).toContain("Spring (ended)");
	// The account avatar has the viewer's initials, not "Y" for "You".
	expect(html).toContain('aria-label="Account: Pat Past"');

	// In a browser with scripts held back, the first paint is the final one.
	const slow = await ctx.newPage();
	await slow.route("**/*.{js,ts,tsx,mjs}", async (route) => {
		await new Promise((r) => setTimeout(r, 1500));
		await route.continue().catch(() => {});
	});
	await slow.goto("/dashboard", { waitUntil: "commit" });
	const heroCard = slow.getByTestId(HOME_TESTID.heroCard);
	await expect(heroCard).toBeVisible({ timeout: 20_000 });
	const first = await heroCard.innerText();
	await slow.screenshot({
		path: shotPath("home/dash03-first-paint.png"),
		animations: "disabled",
	});
	await slow.unrouteAll({ behavior: "ignoreErrors" });
	// Hydrated: the greeting is client-only ("Welcome back" → "Good …").
	await expect(slow.getByRole("heading", { level: 1 })).toContainText(
		/^Good /,
		{ timeout: 30_000 },
	);
	await slow.waitForTimeout(500);
	expect(first).toContain("Winter (upcoming)");
	expect(await heroCard.innerText()).toBe(first);
	await expect(slow.getByText("Spring (ended)")).toBeVisible();
	await slow.screenshot({
		path: shotPath("home/dash03-hydrated.png"),
		animations: "disabled",
	});
	await ctx.close();
});

test("DASH-HERO-DAY: a trip under way counts up from Day 1 in the hero", async ({
	browser,
}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const ctx = await browser.newContext({
		storageState: { cookies: [], origins: [] },
		viewport: { width: 1440, height: 900 },
	});
	await loginViaApi(
		ctx.request,
		`dashday-${randomBytes(4).toString("hex")}@example.com`,
		{ first: "Rey", last: "Road" },
	);
	const page = await ctx.newPage();
	await page.goto("/dashboard");
	await expect(page.getByRole("heading", { level: 1 })).toContainText(
		/^Good /,
		{ timeout: 30_000 },
	);
	// The QA repro (20–23 Sep opened on 23 Sep), in the browser's own dates:
	// the fourth and last day of the trip is "Day 4", not "Day -2".
	const trip = await page.evaluate(async () => {
		const today = new Intl.DateTimeFormat("en-CA").format(new Date());
		const shift = (d: string, n: number) =>
			new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000)
				.toISOString()
				.slice(0, 10);
		const data = {
			name: "Edge ends today",
			startDate: shift(today, -3),
			endDate: today,
		};
		const m = await import("/src/functions/trips.functions.ts");
		await m.createTrip({ data });
		return data;
	});
	await page.reload();
	await expect(page.getByRole("heading", { level: 1 })).toContainText(
		/^Good /,
		{ timeout: 30_000 },
	);
	const hero = page.getByTestId(HOME_TESTID.heroCard);
	await expect(hero).toContainText(trip.name);
	await expect(hero).toContainText("On the road");
	await expect(page.getByTestId(HOME_TESTID.heroWhen)).toHaveText("Day 4");
	await settle(page);
	await hero.screenshot({
		path: shotPath("home/dash-hero-day.png"),
		animations: "disabled",
	});
	await ctx.close();
});

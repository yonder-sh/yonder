/**
 * WP-Plan, QA round 2 fixes on the QA seed (`pnpm db:seed:qa`, trip
 * `asia-2027`), READ-ONLY (menus are opened and dismissed; nothing is saved):
 * - PLAN-R2-09: the item Overview's Travel row wraps instead of painting the
 *   duration over "to Gotokuji Temple";
 * - COLLAB-R2-11: the Overview's Day select fits the panel (desktop, phone);
 * - VIS2-09: on a phone the area rows keep the place name readable;
 * - VIS2-06 / PLAN-R2-13: a travel day doesn't end before its train or
 *   flight leaves, and the carry row repeats the ticket's ride time;
 * - COLLAB-R2-10: the day Overview repeats the full sun line;
 * - VIS2-14: the card ⋯ menu offers Move up / Move down;
 * - VIS2-12: the trip's countdown counts from the viewer's own date.
 * Two tests write, each on its own clone of the demo trip: Move down from
 * the keyboard (VIS2-14), and Maya's suggested move never drawing a real leg
 * as amber "Unlinked transit" (COLLAB-R2-01).
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 N pnpm e2e tests/app/plan-qa-r2.spec.ts --project chromium
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";

const TRIP = "asia-2027";
const DENNIS = { email: "dennis@asia2027.test", first: "Dennis", last: "Tester" };

type G = {
	trip: { startDate: string | null };
	days: { id: string; date: string }[];
	items: { id: string; dayId: string | null; nodeId: string | null; title: string | null }[];
	nodes: { id: string; name: string }[];
};
const graph = (page: Page) =>
	page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

async function signIn(page: Page): Promise<void> {
	for (let i = 0; ; i++) {
		try {
			return await loginViaApi(page.request, DENNIS.email, { first: DENNIS.first, last: DENNIS.last });
		} catch (e) {
			if (i >= 4) throw e;
			await new Promise((r) => setTimeout(r, 400 + Math.random() * 1200));
		}
	}
}

async function openTrip(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	// The app may still replace the URL (scope canonicalisation) while it boots.
	await expect
		.poll(() =>
			page.evaluate(() => !!(window as unknown as { __yonder?: unknown }).__yonder).catch(() => false),
		)
		.toBe(true);
}

/** An item by its title or its place's name (on a date, when given). */
async function itemId(page: Page, name: string, date?: string): Promise<string> {
	const g = await graph(page);
	const dayId = date ? g.days.find((d) => d.date === date)?.id : undefined;
	const id = g.items.find(
		(i) =>
			(!dayId || i.dayId === dayId) &&
			(i.title === name || (!i.title && g.nodes.find((n) => n.id === i.nodeId)?.name === name)),
	)?.id;
	if (!id) throw new Error(`no item ${name}${date ? ` on ${date}` : ""}`);
	return id;
}

async function phone(browser: Browser, width = 390) {
	const ctx = await browser.newContext({
		viewport: { width, height: 844 },
		isMobile: true,
		hasTouch: true,
		deviceScaleFactor: 3,
	});
	const page = await ctx.newPage();
	await signIn(page);
	return { ctx, page };
}

test.beforeEach(async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "runs its own viewports on the desktop project");
	await signIn(page);
	const res = await page.goto(`/t/${TRIP}?tab=plan`);
	test.skip(!res || res.status() >= 400, "needs the QA seed (pnpm db:seed:qa)");
});

test("PLAN-R2-09: the Travel row's duration never sits on top of the destination", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?days=2027-10-03&lens=place`);
	await page.getByTestId(TESTID.timelineItem).filter({ hasText: "JAL Sky Museum" }).first().click();
	const overview = page.getByTestId(TESTID.itemOverview);
	const to = overview.getByText(/^to Gotokuji Temple$/);
	await expect(to).toBeVisible();
	const r = await to.evaluate((dest) => {
		const row = dest.closest("button") as HTMLElement;
		const d = dest.getBoundingClientRect();
		const leaves = [...row.querySelectorAll("*")].filter(
			(e) => e !== dest && !e.contains(dest) && !dest.contains(e) && e.children.length === 0 && e.textContent?.trim(),
		);
		const panel = row.getBoundingClientRect();
		return {
			overlap: leaves
				.map((e) => ({ t: e.textContent?.trim(), r: e.getBoundingClientRect() }))
				.filter(({ r }) => r.right > d.left + 1 && r.left < d.right - 1 && r.bottom > d.top + 1 && r.top < d.bottom - 1)
				.map(({ t }) => t),
			// Every chip and the minutes stay on one line each, inside the row.
			broken: leaves
				.filter((e) => e.getClientRects().length > 1 || e.getBoundingClientRect().height > 22)
				.map((e) => e.textContent?.trim()),
			outside: leaves
				.filter((e) => e.getBoundingClientRect().right > panel.right + 1)
				.map((e) => e.textContent?.trim()),
		};
	});
	expect(r).toEqual({ overlap: [], broken: [], outside: [] });
});

test("COLLAB-R2-11: the Day select fits the inspector (desktop)", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const lunch = await itemId(page, "Lunch", "2027-10-07");
	await openTrip(page, `/t/${TRIP}?sel=i.${lunch}`);
	const overview = page.getByTestId(TESTID.itemOverview);
	const trigger = page.getByTestId(PLAN_TESTID.overviewDay);
	await expect(trigger).toContainText("Thu 7 Oct");
	const [t, o] = await Promise.all([trigger.boundingBox(), overview.boundingBox()]);
	expect(t && o && t.x + t.width).toBeLessThanOrEqual((o?.x ?? 0) + (o?.width ?? 0) + 1);
	// The label is cut with an ellipsis inside the trigger, not by the panel.
	const clipped = await trigger.evaluate((el) => {
		const span = el.querySelector("[data-slot=select-value] > span") as HTMLElement;
		return { inside: span.getBoundingClientRect().right <= el.getBoundingClientRect().right + 1 };
	});
	expect(clipped.inside).toBe(true);
});

test("COLLAB-R2-11: the Day select fits a 390px phone", async ({ browser }) => {
	const { ctx, page } = await phone(browser);
	try {
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const yodobashi = await itemId(page, "Yodobashi Camera");
		await openTrip(page, `/t/${TRIP}?sel=i.${yodobashi}`);
		const trigger = page.getByTestId(PLAN_TESTID.overviewDay);
		await expect(trigger).toBeVisible({ timeout: 15_000 });
		const box = await trigger.boundingBox();
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
	} finally {
		await ctx.close();
	}
});

for (const width of [390, 412]) {
	test(`VIS2-09: area rows keep the place name readable at ${width}px`, async ({ browser }) => {
		const { ctx, page } = await phone(browser, width);
		try {
			await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05`);
			const names = page.getByTestId(PLAN_TESTID.areaBlock).locator("[data-block-name]");
			await expect(names.first()).toBeAttached({ timeout: 15_000 });
			const sizes = await names.evaluateAll((els) =>
				els.map((el) => ({ name: el.textContent, shown: el.clientWidth, full: el.scrollWidth })),
			);
			expect(sizes.length).toBeGreaterThan(0);
			// A short name ("Shinjuku", "Nakano") shows whole.
			for (const s of sizes.filter((x) => x.full <= 90)) expect(s.shown, JSON.stringify(s)).toBeGreaterThanOrEqual(s.full - 1);
		} finally {
			await ctx.close();
		}
	});
}

test("VIS2-06 / PLAN-R2-13: the night-train day ends when SP3 leaves; the carry row says SP3 7h55", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?days=2027-10-26&lens=place`);
	const header = page.getByTestId(PLAN_TESTID.dayHeader).first();
	await expect(header).toContainText("Tue 26 Oct");
	await expect(header).not.toContainText("ends 09:00");
	await expect(header).toContainText("ends 21:35");
	const carry = page.getByTestId(PLAN_TESTID.ghost).filter({ hasText: "SP3" }).first();
	await expect(carry).toContainText(/SP3 7h55/);
	await expect(carry).not.toContainText("8h05");
});

test("VIS2-06 / PLAN-R2-13: the NH 9 day ends at take-off; the carry row says NH 9 14h", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?days=2027-10-02&lens=place`);
	const header = page.getByTestId(PLAN_TESTID.dayHeader).first();
	await expect(header).toContainText("Sat 2 Oct");
	await expect(header).not.toContainText(/ends 00:00/);
	const carry = page.getByTestId(PLAN_TESTID.ghost).filter({ hasText: "NH 9" }).first();
	await expect(carry).toContainText(/NH 9 14h/);
	await expect(carry).not.toContainText("16h");
});

test("COLLAB-R2-10: the day Overview repeats the full sun line", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const day = (await graph(page)).days.find((d) => d.date === "2027-10-05");
	await openTrip(page, `/t/${TRIP}?days=2027-10-05&sel=d.${day?.id}`);
	const sun = page.getByTestId(TESTID.dayOverview).getByTestId(TESTID.daySun);
	await expect(sun).toHaveText(/^Sunrise \d\d:\d\d · Golden hour \d\d:\d\d · Sunset \d\d:\d\d · \S/);
});

test("VIS2-14: the ⋯ menu offers Move up / Move down", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05&lens=place`);
	const card = page.getByTestId(TESTID.timelineItem).filter({ hasText: "Bic Camera" }).first();
	await card.getByTestId(PLAN_TESTID.itemMenu).click();
	await expect(page.getByRole("menuitem", { name: /Move up/ })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: /Move down/ })).toBeVisible();
	await page.keyboard.press("Escape");
});

test("VIS2-12: the Next strip counts down from the viewer's own date", async ({ browser }) => {
	const ctx = await browser.newContext({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
		timezoneId: "America/New_York",
	});
	const page = await ctx.newPage();
	try {
		await signIn(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const expected = await page.evaluate(() => {
			const y = (window as unknown as { __yonder: { graph: G } }).__yonder;
			const start = y.graph.trip.startDate as string;
			const today = new Intl.DateTimeFormat("en-CA", {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).format(new Date());
			return Math.round((Date.parse(`${start}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
		});
		test.skip(expected <= 0, "the trip has started");
		await expect(page.getByTestId(TESTID.nowNext)).toContainText(`Starts in ${expected} days`, { timeout: 15_000 });
	} finally {
		await ctx.close();
	}
});

test("VIS2-14: Move down from the keyboard reorders the day and keeps the focus on the card (clone)", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await openTrip(page, `/t/${c.slug}?lens=place`);
	const ids = () =>
		page.getByTestId(TESTID.timelineItem).evaluateAll((els) => els.map((e) => e.getAttribute("data-item-id")));
	const before = await ids();
	const menu = page.getByTestId(TESTID.timelineItem).first().getByTestId(PLAN_TESTID.itemMenu);
	await menu.focus();
	await page.keyboard.press("Enter");
	await page.getByRole("menuitem", { name: /Move down/ }).focus();
	await page.keyboard.press("Enter");
	await expect.poll(ids).toEqual([before[1], before[0], ...before.slice(2)]);
	await expect
		.poll(() =>
			page.evaluate(
				() => document.activeElement?.closest('[data-testid="timeline-item"]')?.getAttribute("data-item-id") ?? null,
			),
		)
		.toBe(before[0]);
});

test("COLLAB-R2-01: Maya's suggested move shows its ghost, never an amber 'Unlinked transit' row (clone)", async ({
	page,
}) => {
	const c = await cloneFixtureTrip(page.request, { mayaRole: "suggester", proposals: true });
	await openTrip(page, `/t/${c.slug}?lens=place`);
	// Her move of Itoya Ginza to Day 1 is simulated (the Fuji Excursion loses its pair there)…
	await expect(page.getByTestId(PLAN_TESTID.originRow).first()).toBeVisible({ timeout: 15_000 });
	const simulated = await page.evaluate(
		() =>
			(window as unknown as { __yonder: { model: { detachedLegs: unknown[] } } }).__yonder.model.detachedLegs
				.length,
	);
	expect(simulated).toBeGreaterThan(0);
	// …but the server's leg is intact: nothing offers Relink or Discard on it.
	await expect(page.getByTestId(PLAN_TESTID.unlinked)).toHaveCount(0);
});

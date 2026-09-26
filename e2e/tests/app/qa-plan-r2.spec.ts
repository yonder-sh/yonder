/**
 * I2 verifier "plan" (round 2): guards for the round-1 plan bugs that are now
 * fixed, and the defects still open on the QA seed (`pnpm db:seed:qa`, trip
 * `asia-2027`). Tests titled "DEFECT" encode the expected behaviour of an open
 * bug and fail until it is fixed; the others are passing guards.
 *
 * Tests on `asia-2027` are READ-ONLY (editors are opened and cancelled). The
 * two that write (a rating, a cancelled comment) work on a private copy made
 * with `duplicateTrip`, so the seed is never changed. Desktop project only.
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 N pnpm e2e -- tests/app/qa-plan-r2.spec.ts --project chromium
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";

const TRIP = "asia-2027";
const QA = {
	dennis: { email: "dennis@asia2027.test", first: "Dennis", last: "Tester" },
	audrey: { email: "audrey@asia2027.test", first: "Audrey", last: "Tester" },
	kai: { email: "kai@asia2027.test", first: "Kai", last: "Viewer" },
} as const;

type Y = {
	graph: {
		trip: { id: string; slug: string };
		nodes: { id: string; name: string; lat: number | null }[];
		members?: { displayName?: string; name?: string }[];
	};
};
const y = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: Y }).__yonder.graph);

async function signIn(page: Page, who: keyof typeof QA): Promise<void> {
	const u = QA[who];
	await loginViaApi(page.request, u.email, { first: u.first, last: u.last });
}

async function openTrip(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(() => page.evaluate(() => !!(window as unknown as { __yonder?: unknown }).__yonder))
		.toBe(true);
}

async function nodeId(page: Page, name: string): Promise<string> {
	const id = (await y(page)).nodes.find((n) => n.name === name)?.id;
	if (!id) throw new Error(`no node ${name}`);
	return id;
}

/** The Rate feed's card in view (the Places tab's Rate view: the old Rate screen). */
const activeCard = (page: Page) => page.locator('[data-testid="places-feed-card"][data-active]');

test.beforeEach(async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one desktop run is enough");
	await signIn(page, "dennis");
	const res = await page.goto(`/t/${TRIP}?tab=plan`);
	test.skip(!res || res.status() >= 400, "needs the QA seed (pnpm db:seed:qa)");
});

// ---------------------------------------------------------------------------
// Guards: round-1 bugs verified fixed in round 2
// ---------------------------------------------------------------------------

test("TZ-07 guard: a repeated local time at the DST change asks EDT or EST", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?days=2027-11-05&lens=place`);
	await page.getByText("TK 11", { exact: true }).first().click();
	await page.getByTestId("flight-edit").first().click();
	await page.getByLabel("Arrival date").last().fill("2027-11-07");
	await page.getByLabel("Arrival time").last().fill("01:30");
	await page.keyboard.press("Tab");
	await expect(page.getByTestId("flight-fold")).toHaveText(["01:30 EDT", "01:30 EST"]);
	// Nothing is saved: leave the editor.
	await page.keyboard.press("Escape");
});

test("TZ-08 guard: an editor has a zone picker on a place, a viewer sees it disabled", async ({ page, browser }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const kuro = await nodeId(page, "Bar Kuro");
	await openTrip(page, `/t/${TRIP}?sel=n.${kuro}`);
	await expect(page.getByTestId("places-tz-picker")).toBeEnabled();
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const kai = await ctx.newPage();
	await signIn(kai, "kai");
	await openTrip(kai, `/t/${TRIP}?sel=n.${kuro}`);
	await expect(kai.getByTestId("places-tz-picker")).toBeDisabled();
	await ctx.close();
});

test("Rate guard: the mini-map uses the Yonder style, never the public OpenFreeMap style", async ({ page }) => {
	const styles: string[] = [];
	page.on("request", (r) => {
		if (/openfreemap\.org\/styles\//.test(r.url())) styles.push(r.url());
	});
	await page.goto(`/t/${TRIP}/rate`);
	await expect(activeCard(page)).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(2500);
	expect(styles).toEqual([]);
});

test("Rate guard: every member's progress has the same, rateable-only denominator", async ({ page }) => {
	await page.goto(`/t/${TRIP}/rate`);
	await expect(activeCard(page)).toBeVisible({ timeout: 30_000 });
	const totals = (await page.getByTestId("places-progress").locator("[data-member][data-counted]").allInnerTexts()).map((t) =>
		Number(/\/(\d+)/.exec(t)?.[1]),
	);
	expect(totals.length).toBeGreaterThanOrEqual(3);
	expect(new Set(totals).size).toBe(1);
	// Round 1: 156 (structural wards counted). The seed has about 125 rateable places.
	expect(totals[0]).toBeLessThan(140);
});

test("Deadline guard: every timed deadline chip names its zone", async ({ page }) => {
	// The deadlines live on the Overview page (docs/OVERVIEW.md §7).
	await openTrip(page, `/t/${TRIP}?tab=overview`);
	const text = await page.getByTestId("overview").getByTestId("trip-deadlines").innerText();
	const timed = text.match(/(?:Opens|Due) [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} · \d{2}:\d{2}[^\n]*/g) ?? [];
	expect(timed.length).toBeGreaterThan(0);
	for (const chip of timed) expect(chip, chip).toMatch(/\d{2}:\d{2} [A-Z]{3,4}\b/);
});

// ---------------------------------------------------------------------------
// DEFECTS (read-only on the seed)
// ---------------------------------------------------------------------------

test("DEFECT HIER-12 (WP-Places): pasted coordinates make 'Use this location' the chosen option", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const kuro = await nodeId(page, "Bar Kuro");
	await openTrip(page, `/t/${TRIP}?sel=n.${kuro}`);
	const row = page.getByRole("treeitem", { name: /^Bar Kuro/ }).first();
	await row.scrollIntoViewIfNeeded();
	await row.hover();
	await row.getByTestId("outline-row-menu").click();
	await page.getByRole("menuitem", { name: /location/ }).click();
	const dlg = page.getByRole("dialog").filter({ hasText: /location for Bar Kuro/ });
	// The dialog opens with the node's name as the query and searches it (worldwide).
	await page.waitForTimeout(3000);
	await dlg.getByRole("combobox").first().fill("35.6941, 139.7045");
	await page.waitForTimeout(1500);
	const options = await dlg.getByRole("option").evaluateAll((els) =>
		els.map((e) => ({
			selected: e.getAttribute("aria-selected") === "true",
			coords: e.getAttribute("data-testid") === "places-coords-result",
			text: (e.textContent ?? "").slice(0, 60),
		})),
	);
	await page.keyboard.press("Escape");
	// Today: the stale "Bar Kuro" results (Ningbo, Vancouver, Bordeaux…) stay listed ABOVE
	// "Use this location" and the first is selected, so Enter + "Use this location" saves China.
	expect(options.find((o) => o.selected)?.coords, JSON.stringify(options)).toBe(true);
	expect(options.filter((o) => !o.coords && /China|Canada|France|Argentina/.test(o.text))).toEqual([]);
});

test("DEFECT (F schedule / WP-Plan): a day that ends by boarding a night train doesn't read 'ends 09:00'", async ({ page }) => {
	// Tue 26 Oct: Board SP3 09:00 (0m), SP3 dep 21:35 → 05:30+1. Same on 2 Oct (ends 00:00), 28 Oct, 4 Nov.
	await openTrip(page, `/t/${TRIP}?days=2027-10-26&lens=place`);
	const header = page.getByTestId("plan-day-header").first();
	await expect(header).toContainText("Travel 8h05");
	await expect(header).not.toContainText("ends 09:00");
});

test("DEFECT (WP-Map): known flights draw solid map edges (dashes only for proposals and estimates)", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?lens=country`);
	const flightDash = () =>
		page.evaluate(() => {
			const m = (window as unknown as { __tripMap?: { map?: unknown } }).__tripMap;
			const map = (m?.map ?? m) as
				| { getLayer(id: string): unknown; getPaintProperty(id: string, p: string): unknown }
				| undefined;
			if (!map?.getLayer?.("yonder-edges-flight")) return "no-layer";
			return JSON.stringify(map.getPaintProperty("yonder-edges-flight", "line-dasharray") ?? null);
		});
	await expect.poll(flightDash, { timeout: 20_000 }).not.toBe("no-layer");
	// Today: [2.5,2] (also 'other' [4,2], 'overnight' [2,4], 'stay' [1,2]).
	expect(await flightDash()).toBe("null");
});

test("DEFECT (WP-Shell): 'still to book' rows say what each booking is for", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?sel=root`);
	const stp = page.getByTestId("still-to-plan");
	await stp.getByRole("button", { name: /still to book/ }).click();
	const rows = await stp.getByTestId("still-to-plan-item").allInnerTexts();
	expect(rows.length).toBeGreaterThan(5);
	// Today: 11 of the 30 rows read just "Book ahead" (the to-do text), with no place or day.
	expect(rows.filter((r) => r.trim() === "Book ahead")).toEqual([]);
});

test("DEFECT HIER-10 (WP-Places): searching 'Shinjuku' also lists the Fuji Excursion leg", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	await page.keyboard.press("Control+k");
	const dlg = page.getByRole("dialog");
	await dlg.getByRole("combobox").first().fill("Shinjuku");
	await expect(dlg.getByRole("option").filter({ hasText: /^Shinjuku/ })).toHaveCount(1);
	await expect(dlg.getByRole("option").filter({ hasText: /Fuji Excursion/ })).toHaveCount(1, { timeout: 5_000 });
});

test("DEFECT (WP-Plan): the item overview's Travel row doesn't paint the duration over the destination", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?days=2027-10-03&lens=place`);
	await page.getByTestId("timeline-item").filter({ hasText: "JAL Sky Museum" }).first().click();
	const to = page.getByText("to Gotokuji Temple").last();
	await expect(to).toBeVisible();
	const overlap = await to.evaluate((dest) => {
		const row = dest.parentElement as HTMLElement;
		const d = dest.getBoundingClientRect();
		// Any other text leaf in the same row whose box intersects the destination's.
		return [...row.querySelectorAll("*")]
			.filter((e) => e !== dest && !e.contains(dest) && !dest.contains(e) && e.children.length === 0 && e.textContent?.trim())
			.map((e) => ({ t: e.textContent?.trim(), r: e.getBoundingClientRect() }))
			.filter(({ r }) => r.right > d.left + 1 && r.left < d.right - 1 && r.bottom > d.top + 1 && r.top < d.bottom - 1)
			.map(({ t }) => t);
	});
	// Today: "1h 14m est." wraps onto three lines and sits on top of "to Gotok…".
	expect(overlap).toEqual([]);
});

test("DEFECT (WP-Places/WP-Lists): the Rate comment counter counts what you see, not mention markup", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const sky = await nodeId(page, "Shibuya Sky");
	// Dennis rated it in the seed: the feed's card offers "Add a comment".
	await page.goto(`/t/${TRIP}/rate?n=${sky}`);
	await expect(activeCard(page)).toHaveAttribute("data-place", sky, { timeout: 30_000 });
	await activeCard(page).getByRole("button", { name: "Add a comment" }).click();
	await page.getByLabel("Your comment").click();
	await page.keyboard.type("ask @Audrey");
	await page.getByRole("option", { name: /Audrey Tester/ }).first().click();
	const visible = (await page.getByLabel("Your comment").innerText()).trim();
	const counter = await page.getByText(/^\d+\/280$/).innerText();
	await page.getByRole("button", { name: "Cancel" }).click();
	// Today: "ask @Audrey Tester" (18 visible) reads about 70/280.
	expect(Number(counter.split("/")[0])).toBeLessThanOrEqual(visible.length + 2);
});

// ---------------------------------------------------------------------------
// DEFECTS that write: on a private duplicate of the trip
// ---------------------------------------------------------------------------

test.describe("on a copy of Asia 2027", () => {
	let slug = "";
	test.beforeAll(async ({ browser }: { browser: Browser }) => {
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		await signIn(page, "dennis");
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const res = await page.evaluate(async () => {
			const m = await import("/src/features/home/dashboard.functions.ts");
			const g = (window as unknown as { __yonder: Y }).__yonder.graph;
			return m.duplicateTrip({
				data: {
					tripId: g.trip.id,
					name: `QA plan r2 ${Date.now()}`,
					startDate: "2027-10-02",
					include: { notes: false, lists: false, media: false, budgets: false, placeholders: true },
				},
			});
		});
		slug = res.slug;
		await ctx.close();
	});

	test("DEFECT (WP-Places): after rating, scrolling back up shows the card just rated", async ({ page }) => {
		await page.goto(`/t/${slug}/rate`);
		const card = activeCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		const first = await card.getAttribute("data-place");
		await page.keyboard.press("ArrowDown");
		await expect(card).not.toHaveAttribute("data-place", first as string);
		const rated = (await card.getAttribute("data-place")) as string;
		await page.keyboard.press("4");
		await expect(card).toHaveAttribute("data-rated", "sure_why_not");
		// Rating doesn't move the feed; scroll on, then back up: the card just rated, with its pick.
		await expect(card).toHaveAttribute("data-place", rated);
		await page.keyboard.press("ArrowDown");
		await expect(card).not.toHaveAttribute("data-place", rated);
		await page.keyboard.press("ArrowUp");
		await expect(card).toHaveAttribute("data-place", rated);
		await expect(card.locator('[data-testid="places-feed-button"][data-priority="sure_why_not"]')).toHaveAttribute("aria-pressed", "true");
	});

	test("DEFECT (WP-Lists/F): cancelling a comment doesn't leave the '@new person' it offered", async ({ page }) => {
		await openTrip(page, `/t/${slug}?tab=plan`);
		const sky = await nodeId(page, "Shibuya Sky");
		await page.goto(`/t/${slug}/rate?n=${sky}`);
		const card = activeCard(page);
		await expect(card).toHaveAttribute("data-place", sky, { timeout: 30_000 });
		// A comment goes with a rating (the copy may not carry Dennis's).
		if (!(await card.getAttribute("data-rated"))) await page.keyboard.press("4");
		await expect(card).toHaveAttribute("data-rated", /.+/);
		const name = `Zed${Date.now() % 10000}`;
		await card.locator("button:has(svg.lucide-message-square)").first().click();
		await page.getByLabel("Your comment").click();
		await page.keyboard.type(`ask @${name}`);
		await page.getByRole("option", { name: new RegExp(`Add .*${name}`) }).click();
		await page.getByRole("button", { name: "Cancel" }).click();
		await openTrip(page, `/t/${slug}?sel=root`);
		const people = (await y(page)).members?.map((m) => m.displayName ?? m.name) ?? [];
		// Today: the placeholder is created when the option is picked and stays on the trip.
		expect(people).not.toContain(name);
	});
});

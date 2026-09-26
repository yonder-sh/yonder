/**
 * I2 verifier "plan" (round 3): guards for the round-2 plan bugs that are now
 * fixed, and the defects still open on the QA seed (`pnpm db:seed:qa`, trip
 * `asia-2027`). Tests titled "DEFECT" encode the expected behaviour of an open
 * bug and fail until it is fixed; the others are passing guards.
 *
 * Tests on `asia-2027` are READ-ONLY (menus and inputs are opened and
 * cancelled). Tests that write work on a private copy made with
 * `duplicateTrip`. Desktop project only; the file runs in one worker (mode
 * "default") because parallel API sign-ins of the same QA user race for the
 * one-time code.
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 N pnpm e2e -- tests/app/qa-plan-r3.spec.ts --project chromium
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";

test.describe.configure({ mode: "default" });

const TRIP = "asia-2027";
const QA = {
	dennis: { email: "dennis@asia2027.test", first: "Dennis", last: "Tester" },
} as const;

type G = {
	trip: { id: string; slug: string };
	nodes: { id: string; name: string; lat: number | null; lng: number | null; osmRef: string | null }[];
	items: { id: string; nodeId: string | null; title: string | null; dayId: string | null }[];
	days: { id: string; date: string }[];
	members: { displayName?: string }[];
};
const graph = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

async function signIn(page: Page): Promise<void> {
	await loginViaApi(page.request, QA.dennis.email, { first: QA.dennis.first, last: QA.dennis.last });
}

async function openTrip(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(() => page.evaluate(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph))
		.toBe(true);
}

async function nodeId(page: Page, name: string): Promise<string> {
	const id = (await graph(page)).nodes.find((n) => n.name === name)?.id;
	if (!id) throw new Error(`no node ${name}`);
	return id;
}

/** An item by its title or its place's name, optionally on one date. */
async function itemId(page: Page, name: string, date?: string): Promise<string> {
	const g = await graph(page);
	const names = new Map(g.nodes.map((n) => [n.id, n.name]));
	const day = date ? g.days.find((d) => d.date === date) : undefined;
	const it = g.items.find(
		(i) => (i.title === name || (i.nodeId && names.get(i.nodeId) === name)) && (!day || i.dayId === day.id),
	);
	if (!it) throw new Error(`no item ${name}`);
	return it.id;
}

async function duplicate(page: Page, name: string): Promise<string> {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const res = await page.evaluate(async (name) => {
		const m = await import("/src/features/home/dashboard.functions.ts");
		const g = (window as unknown as { __yonder: { graph: G } }).__yonder.graph;
		return m.duplicateTrip({
			data: {
				tripId: g.trip.id,
				name,
				startDate: "2027-10-02",
				include: { notes: false, lists: true, media: false, budgets: false, placeholders: true },
			},
		});
	}, name);
	return res.slug;
}

test.beforeEach(async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one desktop run is enough");
	await signIn(page);
	const res = await page.goto(`/t/${TRIP}?tab=plan`);
	test.skip(!res || res.status() >= 400, "needs the QA seed (pnpm db:seed:qa)");
});

// ---------------------------------------------------------------------------
// Guards: round-2 bugs verified fixed in round 3 (read-only on the seed)
// ---------------------------------------------------------------------------

test("guard: a day that ends by boarding a night train or flight ends at the departure", async ({ page }) => {
	for (const [date, end] of [
		["2027-10-02", "ends 02:00"],
		["2027-10-26", "ends 21:35"],
		["2027-10-28", "ends 21:10"],
		["2027-11-04", "ends 23:25"],
	] as const) {
		await openTrip(page, `/t/${TRIP}?days=${date}&lens=place`);
		await expect(page.getByTestId("plan-day-header").first()).toContainText(end);
	}
});

test("guard: the carry-over row names the ticket's own duration", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?days=2027-10-26&lens=place`);
	await expect(page.getByText(/to Lào Cai Station · Wed 27 Oct/)).toBeVisible();
	await expect(page.getByTestId("plan-day").first()).toContainText("SP3 7h55");
	await openTrip(page, `/t/${TRIP}?days=2027-10-02&lens=place`);
	await expect(page.getByTestId("plan-day").first()).toContainText(/NH ?9 14h/);
});

test("guard: known flights, transit and 'other' edges are solid on the map; only estimates are dashed", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?lens=country`);
	const dash = (id: string) =>
		page.evaluate((id) => {
			const m = (window as unknown as { __tripMap?: { map?: unknown } }).__tripMap;
			const map = (m?.map ?? m) as
				| { getLayer(id: string): unknown; getPaintProperty(id: string, p: string): unknown }
				| undefined;
			if (!map?.getLayer?.(id)) return "no-layer";
			return JSON.stringify(map.getPaintProperty(id, "line-dasharray") ?? null);
		}, id);
	await expect.poll(() => dash("yonder-edges-flight"), { timeout: 20_000 }).not.toBe("no-layer");
	for (const id of ["yonder-edges-flight", "yonder-edges-transit", "yonder-edges-other"])
		expect(await dash(id), id).toBe("null");
	for (const id of ["yonder-edges-flight-est", "yonder-edges-transit-est", "yonder-edges-other-est"])
		expect(await dash(id), id).not.toBe("null");
});

test("guard: 'still to book' rows say what they are for and open that to-do", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?sel=root`);
	const stp = page.getByTestId("still-to-plan");
	await stp.getByRole("button", { name: /still to book/ }).click();
	const rows = await stp.getByTestId("still-to-plan-item").allInnerTexts();
	expect(rows.filter((r) => r.trim() === "Book ahead")).toEqual([]);
	await stp.getByTestId("still-to-plan-item").first().click();
	await expect(page).toHaveURL(/tab=lists&list=todo&sel=i\./);
});

test("guard HIER-10: 'Shinjuku' finds the ward once and the Fuji Excursion leg, labelled as a leg", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	await page.keyboard.press("Control+k");
	const dlg = page.getByRole("dialog");
	await dlg.getByRole("combobox").first().fill("Shinjuku");
	await expect(dlg.getByRole("option").filter({ hasText: /^Shinjuku\s*Japan › Tokyo/ })).toHaveCount(1);
	await expect(dlg.getByRole("option").filter({ hasText: /Fuji Excursion 7\s*Leg/ })).toHaveCount(1);
	await page.keyboard.press("Escape");
});

test("guard HIER-07: the Cities level says '1 place', not '1 places'", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	await page.getByTestId("outline-header-menu").click();
	await page.getByRole("menuitemradio", { name: /Cities/ }).click();
	const rows = () =>
		page
			.getByTestId("outline")
			.getByRole("treeitem")
			.allInnerTexts()
			.then((r) => r.map((t) => t.replace(/\n/g, " ")));
	await expect.poll(rows).toContain("Uji · 1 place");
	expect((await rows()).join("\n")).not.toMatch(/\b1 places\b/);
});

test("guard: the item overview's Travel row keeps the duration off the destination", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?days=2027-10-03&lens=place`);
	await page.getByTestId("timeline-item").filter({ hasText: "JAL Sky Museum" }).first().click();
	const to = page.getByText("to Gotokuji Temple").last();
	await expect(to).toBeVisible();
	const overlap = await to.evaluate((dest) => {
		const row = dest.parentElement as HTMLElement;
		const d = dest.getBoundingClientRect();
		return [...row.querySelectorAll("*")]
			.filter((e) => e !== dest && !e.contains(dest) && !dest.contains(e) && e.children.length === 0 && e.textContent?.trim())
			.map((e) => ({ t: e.textContent?.trim(), r: e.getBoundingClientRect() }))
			.filter(({ r }) => r.right > d.left + 1 && r.left < d.right - 1 && r.bottom > d.top + 1 && r.top < d.bottom - 1)
			.map(({ t }) => t);
	});
	expect(overlap).toEqual([]);
});

test("guard: the Fuji Excursion 7 route's last step reads 'Taxi'", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const a = await itemId(page, "Breakfast", "2027-10-07");
	const b = await itemId(page, "Drop bags at ryokan", "2027-10-07");
	await openTrip(page, `/t/${TRIP}?days=2027-10-07&lens=place&sel=l.${a}.${b}`);
	const insp = page.getByTestId("inspector");
	await expect(insp).toContainText("Fuji Excursion 7");
	await expect(insp.getByText(/^Taxi$/).first()).toBeVisible();
	await expect(insp.getByText(/^ride$/)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Guards that write: on a private copy of the trip
// ---------------------------------------------------------------------------

test.describe("on a copy of Asia 2027", () => {
	let slug = "";
	test.beforeAll(async ({ browser }: { browser: Browser }) => {
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		await signIn(page);
		slug = await duplicate(page, `QA plan r3 ${Date.now()}`);
		await ctx.close();
	});

	test("guard HIER-12: pasted coordinates save as they are, with no other place's identity", async ({ page }) => {
		await openTrip(page, `/t/${slug}?tab=plan`);
		const kuro = await nodeId(page, "Bar Kuro");
		await openTrip(page, `/t/${slug}?sel=n.${kuro}`);
		const row = page.getByRole("treeitem", { name: /^Bar Kuro/ }).first();
		await row.scrollIntoViewIfNeeded();
		await row.hover();
		await row.getByTestId("outline-row-menu").click();
		await page.getByRole("menuitem", { name: /location/ }).click();
		const dlg = page.getByRole("dialog").filter({ hasText: /location for Bar Kuro/ });
		await page.waitForTimeout(3000); // the name search runs first
		await dlg.getByRole("combobox").first().fill("35.6941, 139.7045");
		await expect(dlg.getByTestId("places-coords-result")).toHaveAttribute("aria-selected", "true");
		await expect(dlg.getByRole("option")).toHaveCount(2); // Use this location, Drop a pin…
		await page.keyboard.press("Enter");
		await page.getByRole("button", { name: "Use this location" }).last().click();
		await expect
			.poll(async () => {
				const n = (await graph(page)).nodes.find((x) => x.id === kuro);
				return n && [n.lat, n.lng, n.osmRef];
			})
			.toEqual([35.6941, 139.7045, null]);
	});

	test("guard: after rating, the feed stays; scrolling back up shows the card just rated", async ({ page }) => {
		// The old Rate screen's link: the Places tab's Rate feed.
		await page.goto(`/t/${slug}/rate`);
		const card = page.locator('[data-testid="places-feed-card"][data-active]');
		await expect(card).toBeVisible({ timeout: 30_000 });
		const first = await card.getAttribute("data-place");
		await page.keyboard.press("ArrowDown");
		await expect(card).not.toHaveAttribute("data-place", first as string);
		const rated = (await card.getAttribute("data-place")) as string;
		await page.keyboard.press("5");
		await expect(card).toHaveAttribute("data-rated", "meh");
		await expect(card).toHaveAttribute("data-place", rated);
		await page.keyboard.press("ArrowDown");
		await expect(card).not.toHaveAttribute("data-place", rated);
		await page.keyboard.press("ArrowUp");
		await expect(card).toHaveAttribute("data-place", rated);
		await expect(card.locator('[data-testid="places-feed-button"][data-priority="meh"]')).toHaveAttribute("aria-pressed", "true");
	});

	test("guard: a reserved departure missed by a day reads in hours, not '1420 min'", async ({ page }) => {
		await openTrip(page, `/t/${slug}?days=2027-10-07&lens=place`);
		await page.getByTestId("plan-day-start").first().click();
		await page.getByRole("dialog").locator("input").first().fill("09:00");
		await page.keyboard.press("Enter");
		const bf = await itemId(page, "Breakfast", "2027-10-07");
		const card = page.locator(`[data-testid="timeline-item"][data-item-id="${bf}"]`).first();
		await expect(card.getByTestId("item-start")).toHaveText("09:00");
		await card.getByTestId("plan-item-menu").click();
		await page.getByRole("menuitem", { name: "Pin start time…" }).click();
		await page.getByLabel("Pinned start").fill("07:30");
		await page.getByRole("button", { name: "Pin", exact: true }).click();
		const leg = page.getByTestId("leg").filter({ hasText: "Fuji Excursion 7" }).first();
		await expect(leg).toContainText(/Misses Fuji Excursion 7 \(dep 08:30\) by 23h 40m/);
		await expect(leg).not.toContainText(/\d{3,} min/);
	});
});

// ---------------------------------------------------------------------------
// DEFECTS (read-only on the seed)
// ---------------------------------------------------------------------------

test("DEFECT (WP-Outline): 'Add inside…' on a node whose children run below the fold opens the new row", async ({
	browser,
}) => {
	// Busan (South Korea) at 1440×900: its last child (PUS) is below the Outline's fold.
	// Today the input mounts, focusing it scrolls the Outline, the closing menu under the
	// pointer takes the focus back, and the empty input's onBlur closes it (~100–300 ms).
	const misses: number[] = [];
	for (let k = 0; k < 3; k++) {
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await ctx.newPage();
		await signIn(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const row = page.getByRole("treeitem", { name: /^Busan\b/ }).first();
		await row.scrollIntoViewIfNeeded();
		await row.hover();
		await row.getByTestId("outline-row-menu").click();
		await page.waitForTimeout(500);
		const bb = await page.getByRole("menuitem", { name: /Add inside/ }).boundingBox();
		if (!bb) throw new Error("no menu item");
		await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 4 });
		await page.mouse.down();
		await page.mouse.up();
		await page.waitForTimeout(1200);
		if ((await page.getByTestId("outline-inline-input").count()) === 0) misses.push(k);
		await ctx.close();
	}
	expect(misses, "attempts where 'Add inside…' opened no input").toEqual([]);
});

test("DEFECT (WP-Shell): Still to plan's unrated count matches the Places tab's progress (no unaccepted suggestions)", async ({
	page,
}) => {
	await openTrip(page, `/t/${TRIP}?sel=root`);
	const stp = page.getByTestId("still-to-plan");
	const head = stp.getByRole("button", { name: /unrated places/ });
	const panelCount = Number(/(\d+)/.exec(await head.innerText())?.[1]);
	await head.click();
	const meRow = (await head.locator("xpath=ancestor::li[1]").innerText()).match(/You\s+(\d+) of (\d+)/);
	const me = await page.evaluate(
		() => (window as unknown as { __yonder: { graph: { me: { memberId: string | null } } } }).__yonder.graph.me.memberId,
	);
	// The old Rate screen's link: the Places tab, whose header has each member's progress.
	await page.goto(`/t/${TRIP}/rate`);
	const mine = page.getByTestId("places-progress").locator(`[data-member="${me}"][data-counted]`);
	await expect(mine).toBeVisible({ timeout: 30_000 });
	const [rated, total] = ((await mine.innerText()).match(/(\d+)\/(\d+)/) ?? []).slice(1).map(Number);
	// Today: "48 unrated · by you", "You 48 of 126" vs Rate "78/125" (47 unrated): Maya's
	// unaccepted Tōfuku-ji suggestion is counted as a place to rate.
	expect(meRow?.slice(1).map(Number)).toEqual([(total as number) - (rated as number), total]);
	expect(panelCount).toBe((total as number) - (rated as number));
});

test("DEFECT TL-03 / F4-b (F schedule): Tue 5 Oct clock times match the fixture", async ({ page }) => {
	// Open since round 1: legs never join unlocated items (Breakfast, Lunch, Dinner), so
	// the fixture's walks to and from them are missing (SPEC §7.8/§8.1 vs QA F4-b).
	await openTrip(page, `/t/${TRIP}?days=2027-10-05&lens=place`);
	const ikedaya = await itemId(page, "Cha no Ikedaya", "2027-10-05");
	const card = page.locator(`[data-testid="timeline-item"][data-item-id="${ikedaya}"]`).first();
	await expect(card.getByTestId("item-start")).toHaveText("09:40");
	await expect(page.getByTestId("plan-day-header").first()).toContainText("Travel 1h20");
});

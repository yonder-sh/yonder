/**
 * WP-Plan, owner feedback round 1 (docs/qa/FEEDBACK-1.md) and the open QA
 * bugs WP-Plan owns (docs/qa/OPEN_BUGS.json), on the QA seed
 * (`pnpm db:seed:qa`, trip `asia-2027`, signed in as Dennis):
 * - FB-07: ⋯ › "Set stay…" on the first day shows the picker for half a
 *   second, then it vanishes. Every Plan menu item that opens another surface
 *   (popover, inline input, confirm row, dialog) keeps it open when the hand
 *   drifts after the click, as a person's does.
 * - FB-08: a click on a day header (or its empty area) never changes the day
 *   filter; the date selects the day; filtering is the explicit toggle.
 * - FB-02: every clickable in the Plan and its Overviews shows the pointer.
 * - BANDLINK: band connection rows give the flight's own time.
 * - GMAPS2: the item Overview's Travel rows link to Google Maps.
 * - VIS3-02: a three-line transit row fits at 1100 px.
 * - COLLAB-R3-02: a pending move's origin row sits at the item's old slot.
 * READ-ONLY on the seed (menus and inputs are opened and dismissed), except
 * COLLAB-R3-02, which makes Maya's suggestion and withdraws it. Desktop only.
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 N pnpm e2e tests/app/plan-feedback-r1.spec.ts --project chromium
 */
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath } from "./_helpers/env";

test.describe.configure({ mode: "default" });

const TRIP = "asia-2027";
const USERS = {
	dennis: { email: "dennis@asia2027.test", first: "Dennis", last: "Tester" },
	maya: { email: "maya@asia2027.test", first: "Maya", last: "Suggester" },
} as const;
const shot = (name: string) => shotPath(`plan-fb/${name}.png`);

type G = {
	trip: { id: string };
	days: { id: string; date: string }[];
	items: { id: string; dayId: string | null; nodeId: string | null; title: string | null }[];
	nodes: { id: string; name: string }[];
};
const graph = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

async function signIn(page: Page, who: keyof typeof USERS = "dennis"): Promise<void> {
	const u = USERS[who];
	for (let i = 0; ; i++) {
		try {
			return await loginViaApi(page.request, u.email, { first: u.first, last: u.last });
		} catch (e) {
			if (i >= 4) throw e;
			await new Promise((r) => setTimeout(r, 400 + Math.random() * 1200));
		}
	}
}

async function openTrip(page: Page, url: string): Promise<void> {
	// The previous page may still be replacing its URL (scope canonicalisation) as we leave it.
	await page.goto(url).catch(async (e: Error) => {
		if (!/ERR_ABORTED|interrupted/.test(e.message)) throw e;
		await page.goto(url);
	});
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(() => page.evaluate(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph).catch(() => false))
		.toBe(true);
}

const search = (page: Page) => new URL(page.url()).searchParams;

/** Clicks a menu item the way a hand does: move there, press, release, then drift a few px. */
async function humanClick(page: Page, item: Locator): Promise<void> {
	await expect(item).toBeVisible();
	const bb = await item.boundingBox();
	if (!bb) throw new Error("no menu item box");
	const x = bb.x + bb.width / 2;
	const y = bb.y + bb.height / 2;
	await page.mouse.move(x, y, { steps: 4 });
	await page.mouse.down();
	await page.mouse.up();
	for (let i = 1; i <= 8; i++) {
		await page.mouse.move(x + i * 3, y + (i % 3) - 1, { steps: 2 });
		await page.waitForTimeout(30);
	}
}

test.beforeEach(async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout; one run is enough");
	await signIn(page);
	const res = await page.goto(`/t/${TRIP}?tab=plan`);
	test.skip(!res || res.status() >= 400, "needs the QA seed (pnpm db:seed:qa)");
});

// ---------------------------------------------------------------------------
// FB-07: menu items that open another surface
// ---------------------------------------------------------------------------

test("FB-07: the first day's ⋯ › Set stay… keeps the stay picker open (Plan tab, whole trip)", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const header = page.getByTestId(PLAN_TESTID.dayHeader).first();
	await expect(header).toContainText("Sat 2 Oct");
	await header.getByTestId(PLAN_TESTID.dayMenu).click();
	await humanClick(page, page.getByRole("menuitem", { name: "Set stay…" }));
	await page.waitForTimeout(1200);
	const input = page.getByPlaceholder("Search places…");
	await expect(input).toBeVisible({ timeout: 100 });
	await expect(input).toBeFocused();
	await expect(page.getByRole("option").first()).toBeVisible();
	await page.screenshot({ path: shot("fb07-set-stay-open") });
	// It takes typing: the list filters.
	await input.pressSequentially("zzqx");
	await expect(page.getByText("No matches.")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(input).toBeHidden();
	// Nothing was saved: the flight day still has no stay chip.
	await expect(header.getByTestId(PLAN_TESTID.dayStay)).toHaveCount(0);
});

type Case = {
	name: string;
	open: (p: Page) => Promise<void>;
	item: string | RegExp;
	surface: (p: Page) => Locator;
	focused?: boolean;
};
const dayMenu = (p: Page) => p.getByTestId(PLAN_TESTID.dayHeader).first().getByTestId(PLAN_TESTID.dayMenu).click();
const itemMenu = (p: Page) => p.getByTestId(PLAN_TESTID.itemMenu).nth(1).click();
const addMenu = (p: Page) => p.getByRole("button", { name: "Add to this day" }).first().click();
const CASES: Case[] = [
	{ name: "day › Set stay…", open: dayMenu, item: "Set stay…", surface: (p) => p.getByPlaceholder("Search places…"), focused: true },
	{ name: "day › title", open: dayMenu, item: /Add a title…|Rename day…/, surface: (p) => p.getByLabel("Day title"), focused: true },
	{ name: "day › Delete day…", open: dayMenu, item: "Delete day…", surface: (p) => p.getByTestId(PLAN_TESTID.dayDeleteConfirm) },
	{ name: "day › Add expense", open: dayMenu, item: "Add expense", surface: (p) => p.getByRole("dialog") },
	{ name: "card › Pin start time…", open: itemMenu, item: /Pin start time…|Pinned at/, surface: (p) => p.getByLabel("Pinned start") },
	{ name: "card › Add expense", open: itemMenu, item: "Add expense", surface: (p) => p.getByRole("dialog") },
	{ name: "+ › Place…", open: addMenu, item: "Place…", surface: (p) => p.getByRole("dialog") },
	{ name: "+ › Flight…", open: addMenu, item: "Flight…", surface: (p) => p.getByRole("dialog") },
	{ name: "+ › Custom…", open: addMenu, item: "Custom…", surface: (p) => p.getByLabel("Block title"), focused: true },
];

for (const c of CASES)
	test(`FB-07 audit: ${c.name} stays open after a real click`, async ({ page }) => {
		await openTrip(page, `/t/${TRIP}?lens=place&days=2027-10-03`);
		await c.open(page);
		await humanClick(page, page.getByRole("menuitem", { name: c.item }));
		await page.waitForTimeout(1200);
		const surface = c.surface(page).first();
		await expect(surface).toBeVisible({ timeout: 100 });
		if (c.focused) await expect(surface).toBeFocused();
		// Dismiss without saving (Escape, or Cancel on the confirm row).
		if (c.name.includes("Delete")) await surface.getByRole("button", { name: "Cancel" }).click();
		else await page.keyboard.press("Escape");
		await expect(c.surface(page)).toHaveCount(0);
	});

// ---------------------------------------------------------------------------
// FB-08: a click on a day never filters
// ---------------------------------------------------------------------------

test("FB-08: clicking a day header or its empty area never filters; the date selects; the toggle filters", async ({
	page,
}) => {
	await openTrip(page, `/t/${TRIP}?lens=place`);
	const sections = page.getByTestId(PLAN_TESTID.daySection);
	const all = await sections.count();
	expect(all).toBeGreaterThan(30);
	const header = page.getByTestId(PLAN_TESTID.dayHeader).nth(1);
	await expect(header).toContainText("Sun 3 Oct");
	const box = await header.boundingBox();
	if (!box) throw new Error("no header box");

	// The empty area of the header (between "Day 2 · Tokyo" and the chips), and the summary line.
	await page.mouse.click(box.x + box.width * 0.6, box.y + 14);
	await page.mouse.click(box.x + box.width * 0.45, box.y + box.height - 10);
	await page.mouse.click(box.x + box.width * 0.6, box.y + 14, { modifiers: ["Shift"] });
	expect(search(page).get("days")).toBeNull();
	await expect(sections).toHaveCount(all);

	// Dismissing a card menu by clicking a day header: the menu closes, nothing filters.
	await page.getByTestId(PLAN_TESTID.itemMenu).nth(2).click();
	await expect(page.getByRole("menu")).toBeVisible();
	await page.mouse.click(box.x + box.width * 0.6, box.y + 14);
	await expect(page.getByRole("menu")).toHaveCount(0);
	expect(search(page).get("days")).toBeNull();

	// The empty space below a day's cards: nothing.
	const add = page.getByRole("button", { name: "Add to this day" }).nth(1);
	const ab = await add.boundingBox();
	if (ab) await page.mouse.click(ab.x + ab.width + 120, ab.y + ab.height / 2);
	expect(search(page).get("days")).toBeNull();

	// The date selects (inspects) the day; the filter stays off.
	await header.locator("[data-day-main]").click();
	await expect(page.getByTestId(TESTID.dayOverview)).toBeVisible();
	expect(search(page).get("sel")).toMatch(/^d\./);
	expect(search(page).get("days")).toBeNull();
	await expect(sections).toHaveCount(all);
	await page.screenshot({ path: shot("fb08-date-selects") });

	// The explicit toggle: shows only that day; pressed again, every day.
	await header.hover();
	const toggle = header.getByTestId(PLAN_TESTID.dayFilter);
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await page.screenshot({ path: shot("fb08-filter-toggle-hover") });
	await toggle.click();
	await expect.poll(() => search(page).get("days")).toBe("2027-10-03");
	await expect(sections).toHaveCount(1);
	const only = page.getByTestId(PLAN_TESTID.dayHeader).first().getByTestId(PLAN_TESTID.dayFilter);
	await expect(only).toHaveAttribute("aria-pressed", "true");
	await page.mouse.move(10, 10);
	await expect(only).toBeVisible();
	await page.screenshot({ path: shot("fb08-filtered") });
	// A click on the filtered day's header area still does nothing.
	const fb = await page.getByTestId(PLAN_TESTID.dayHeader).first().boundingBox();
	if (fb) await page.mouse.click(fb.x + fb.width * 0.6, fb.y + 14);
	expect(search(page).get("days")).toBe("2027-10-03");
	await only.click();
	await expect.poll(() => search(page).get("days")).toBeNull();
	await expect(sections).toHaveCount(all);

	// The ⋯ menu offers the same.
	await page.getByTestId(PLAN_TESTID.dayHeader).nth(1).getByTestId(PLAN_TESTID.dayMenu).click();
	await page.getByTestId(PLAN_TESTID.dayMenuFilter).click();
	await expect.poll(() => search(page).get("days")).toBe("2027-10-03");
});

// ---------------------------------------------------------------------------
// FB-02: the pointer on everything clickable
// ---------------------------------------------------------------------------

/** Elements with a React click handler whose cursor isn't the pointer. */
async function noPointer(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		// Not clickable as such: WP-Insights' sun line is a tooltip; the resize handle drags.
		const allowed = new Set(["day-sun", "plan-item-resize"]);
		const roots = ["plan-tab", "item-overview", "day-overview"]
			.map((id) => document.querySelector(`[data-testid="${id}"]`))
			.filter((e): e is Element => e !== null);
		const out = new Set<string>();
		for (const root of roots)
			for (const el of root.querySelectorAll("*")) {
				const key = Object.keys(el).find((k) => k.startsWith("__reactProps"));
				const props = key ? (el as unknown as Record<string, Record<string, unknown>>)[key] : null;
				if (!props?.onClick) continue;
				if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
				if (allowed.has(el.getAttribute("data-testid") ?? "")) continue;
				const r = el.getBoundingClientRect();
				if (!r.width || !r.height) continue;
				const cursor = getComputedStyle(el).cursor;
				if (cursor !== "pointer")
					out.add(`${cursor} <${el.tagName.toLowerCase()} testid=${el.getAttribute("data-testid")}> ${(el.textContent ?? "").trim().slice(0, 40)}`);
			}
		return [...out];
	});
}

test("FB-02: every clickable in the Plan and its Overviews shows the pointer", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	expect(await noPointer(page), "country lens (bands)").toEqual([]);
	await openTrip(page, `/t/${TRIP}?lens=place&days=2027-10-03`);
	expect(await noPointer(page), "place lens").toEqual([]);
	await page.getByTestId(TESTID.timelineItem).filter({ hasText: "JAL Sky Museum" }).first().click();
	await expect(page.getByTestId(TESTID.itemOverview)).toBeVisible();
	expect(await noPointer(page), "item overview").toEqual([]);
	await page.getByTestId(PLAN_TESTID.dayHeader).first().locator("[data-day-main]").click();
	await expect(page.getByTestId(TESTID.dayOverview)).toBeVisible();
	expect(await noPointer(page), "day overview").toEqual([]);
	// The header's empty area isn't clickable, so it doesn't pretend to be.
	const cursor = await page
		.getByTestId(PLAN_TESTID.dayHeader)
		.first()
		.locator(":scope > div")
		.evaluate((e) => getComputedStyle(e).cursor);
	expect(cursor).not.toBe("pointer");
});

// ---------------------------------------------------------------------------
// Open QA bugs owned by WP-Plan
// ---------------------------------------------------------------------------

test("BANDLINK: the band connection rows give each flight's own time, like its ticket", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const rows = (await page.getByTestId(PLAN_TESTID.bandLink).allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
	for (const want of [
		"JFK → HND · 14h ·",
		"KIX → ICN · 1h55 ·",
		"PUS → SGN · 5h15 ·",
		"HAN → TPE · 2h35 ·",
		"TPE → IST · 13h10 ·",
		"IST → EWR · 10h45 ·",
	])
		expect(rows.some((r) => r.startsWith(want)), `${want} in ${rows.join(" | ")}`).toBe(true);
});

test("GMAPS2: the item Overview's Travel rows open Google Maps (JAL Sky Museum)", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?days=2027-10-03&lens=place`);
	await page.getByTestId(TESTID.timelineItem).filter({ hasText: "JAL Sky Museum" }).first().click();
	const overview = page.getByTestId(TESTID.itemOverview);
	await expect(overview).toBeVisible();
	const links = overview.getByRole("link", { name: /Google Maps/ });
	await expect(links).toHaveCount(2);
	for (const href of await links.evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")))
		expect(href).toMatch(/google\.com\/maps\/dir\/.*travelmode=transit/);
	// The link sits beside the row's button, never inside it; the row still opens the leg.
	expect(await overview.locator("button a").count()).toBe(0);
	await overview.screenshot({ path: shot("gmaps2-overview") });
	await overview.getByRole("button", { name: /from Breakfast/ }).click();
	await expect.poll(() => search(page).get("sel") ?? "").toMatch(/^l\./);
});

test.describe("1100 (lg)", () => {
	test.use({ viewport: { width: 1100, height: 900 } });

	test("VIS3-02: a three-line transit row keeps whole chips, one 'est.', and Google Maps under the chips", async ({
		page,
	}) => {
		await openTrip(page, `/t/${TRIP}?days=2027-10-03&lens=place`);
		const leg = page.getByTestId("plan-tab").getByTestId(TESTID.leg).filter({ hasText: "Odakyu" }).first();
		await leg.scrollIntoViewIfNeeded();
		const r = await leg.evaluate((el) => {
			const chip = (name: string) =>
				[...el.querySelectorAll("span")].find((e) => e.childElementCount === 0 && e.textContent?.trim() === name);
			const chips = ["Tokyo Monorail", "Oedo", "Odakyu Odawara"].map(chip).filter((c): c is HTMLSpanElement => !!c);
			const wrapped = chips
				.filter((c) => c.getBoundingClientRect().height > 20 || c.scrollHeight > c.clientHeight + 1)
				.map((c) => c.textContent);
			const minutes = [...el.querySelectorAll("span")].find((e) => /^1h 14m est\.$/.test(e.textContent?.trim() ?? ""));
			const link = el.querySelector("a[href*='google.com/maps']");
			return {
				chips: chips.length,
				wrapped,
				minutesOneLine: !!minutes && minutes.getBoundingClientRect().height < 20,
				ests: (el.textContent?.match(/est\./g) ?? []).length,
				chipX: Math.round(chips[0]?.getBoundingClientRect().left ?? 0),
				linkX: Math.round(link?.getBoundingClientRect().left ?? -1),
			};
		});
		await leg.screenshot({ path: shot("vis3-02-leg-1100") });
		expect(r.chips).toBe(3);
		expect(r.wrapped).toEqual([]);
		expect(r.minutesOneLine).toBe(true);
		expect(r.ests).toBe(1);
		expect(Math.abs(r.linkX - r.chipX), JSON.stringify(r)).toBeLessThanOrEqual(3);
	});
});

async function contextFor(browser: Browser, who: keyof typeof USERS) {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await signIn(page, who);
	return { ctx, page };
}

test("COLLAB-R3-02: a pending move's origin row sits at the item's old slot, after Cha no Ikedaya", async ({
	page,
	browser,
}) => {
	test.setTimeout(120_000);
	await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05&lens=place`);
	const g = await graph(page);
	const name = (i: G["items"][number]) => i.title ?? g.nodes.find((n) => n.id === i.nodeId)?.name;
	const tue = g.days.find((d) => d.date === "2027-10-05")?.id;
	const wed = g.days.find((d) => d.date === "2027-10-06")?.id;
	const nakano = g.items.find((i) => i.dayId === tue && name(i) === "Nakano Broadway");
	const cha = g.items.find((i) => i.dayId === tue && name(i) === "Cha no Ikedaya");
	if (!nakano || !cha || !wed) throw new Error("fixture: Nakano Broadway / Cha no Ikedaya on Tue 5 Oct");

	const maya = await contextFor(browser, "maya");
	let proposalId: string | undefined;
	try {
		await openTrip(maya.page, `/t/${TRIP}?tab=plan`);
		proposalId = await maya.page.evaluate(
			async ({ itemId, dayId }) => {
				const m = await import(/* @vite-ignore */ "/src/functions/items.functions.ts");
				const r = (await m.moveItem({ data: { itemId, dayId } })) as { proposed?: { id: string } };
				return r.proposed?.id;
			},
			{ itemId: nakano.id, dayId: wed },
		);
		expect(proposalId, "Maya's move became a suggestion").toBeTruthy();
		await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05&lens=place`);
		const origin = page.getByTestId(PLAN_TESTID.originRow).first();
		await expect(origin).toBeVisible({ timeout: 15_000 });
		await expect(origin).toContainText("Nakano Broadway");
		const order = await page.evaluate(
			({ cha, originId, cardId }) =>
				[...document.querySelectorAll(`[data-testid="${cardId}"], [data-testid="${originId}"]`)].map((e) =>
					e.getAttribute("data-testid") === originId ? "ORIGIN" : e.getAttribute("data-item-id") === cha ? "CHA" : "card",
				),
			{ cha: cha.id, originId: PLAN_TESTID.originRow, cardId: TESTID.timelineItem },
		);
		expect(order.indexOf("ORIGIN"), order.join(" ")).toBe(order.indexOf("CHA") + 1);
		await origin.scrollIntoViewIfNeeded();
		await page.screenshot({ path: shot("collab-r3-02-origin-row") });
	} finally {
		if (proposalId)
			await maya.page.evaluate(async (proposalId) => {
				const m = await import(/* @vite-ignore */ "/src/functions/proposals.functions.ts");
				await m.withdrawProposal({ data: { proposalId } });
			}, proposalId);
		await maya.ctx.close();
	}
});

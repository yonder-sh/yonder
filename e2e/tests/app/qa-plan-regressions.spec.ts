/**
 * I2 verifier "plan" (round 1): regressions found on the QA seed (`pnpm db:seed:qa`,
 * trip `asia-2027`, qa/SCENARIOS §1) for HIER / TL / TZ, rating (the old Rate
 * screen, now the Places tab: docs/PLACES.md §1b), the shared filter,
 * free-text people, "Still to plan" and the fewer-badges rule.
 *
 * Every test is READ-ONLY on the seeded trip (editors are opened and cancelled,
 * nothing is saved), so the file can run against any tree that has the QA seed.
 * Tests titled "DEFECT" encode the expected behaviour of an open bug and fail
 * until it is fixed; the others are passing guards. Desktop project only.
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 N pnpm e2e -- tests/app/qa-plan-regressions.spec.ts --project chromium
 */
import { expect, type Page, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";

const TRIP = "asia-2027";
const QA = {
	dennis: { email: "dennis@asia2027.test", first: "Dennis", last: "Tester" },
	audrey: { email: "audrey@asia2027.test", first: "Audrey", last: "Tester" },
} as const;

type Graph = {
	nodes: { id: string; name: string }[];
};

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
	const id = await page.evaluate(
		(n) => (window as unknown as { __yonder: { graph: Graph } }).__yonder.graph.nodes.find((x) => x.name === n)?.id,
		name,
	);
	if (!id) throw new Error(`no node ${name}`);
	return id;
}

const MONTHS: Record<string, number> = { Oct: 10, Nov: 11 };
/** "Sat 2 Oct" → 1002 (sortable within the 2027 trip). */
function dayKey(label: string): number {
	const m = /\b(\d{1,2}) (Oct|Nov)\b/.exec(label);
	if (!m) return Number.NaN;
	return (MONTHS[m[2] as string] as number) * 100 + Number(m[1]);
}

test.beforeEach(async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one desktop run is enough");
	await signIn(page, "dennis");
	const res = await page.goto(`/t/${TRIP}?tab=plan`);
	test.skip(!res || res.status() >= 400, "needs the QA seed (pnpm db:seed:qa)");
});

// ---------------------------------------------------------------------------
// Passing guards
// ---------------------------------------------------------------------------

test("TZ-01: displayed times don't depend on the viewer's time zone", async ({ browser }) => {
	for (const timezoneId of ["America/New_York", "Asia/Tokyo", "Europe/Istanbul", "Pacific/Kiritimati"]) {
		const ctx = await browser.newContext({ timezoneId, viewport: { width: 1440, height: 900 } });
		const page = await ctx.newPage();
		await signIn(page, "dennis");
		await openTrip(page, `/t/${TRIP}?days=2027-10-03&lens=place`);
		const jal = page.getByTestId("timeline-item").filter({ hasText: "JAL Sky Museum" }).first();
		await expect(jal.getByTestId("item-start")).toHaveText("09:30");
		await openTrip(page, `/t/${TRIP}?days=2027-10-05&lens=place`);
		const gg = page.getByTestId("timeline-item").filter({ hasText: "Golden Gai" }).first();
		await expect(gg.getByTestId("item-start")).toHaveText("21:05");
		await ctx.close();
	}
});

test("TZ-05: SP3 overnight train, then the bus and breakfast in Sa Pa", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?days=2027-10-27&lens=place`);
	const bf = page.getByTestId("timeline-item").filter({ hasText: "Breakfast in Sa Pa" }).first();
	await expect(bf.getByTestId("item-start")).toHaveText("06:30");
	await expect(bf.getByTestId("item-end")).toHaveText("07:15");
});

// ---------------------------------------------------------------------------
// DEFECTS
// ---------------------------------------------------------------------------

test("DEFECT TL-01 (WP-Plan): the default country lens lists the days in date order", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const labels = await page
		.getByTestId("plan-day-header")
		.evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.split("\n")[0] ?? ""));
	const keys = labels.map(dayKey).filter((k) => !Number.isNaN(k));
	expect(keys.length).toBeGreaterThanOrEqual(35);
	const outOfOrder = keys.flatMap((k, i) => (i > 0 && k < (keys[i - 1] as number) ? [labels[i]] : []));
	// Today: Thu 14 Oct renders between Fri 8 Oct and Sat 9 Oct (free days are flushed after the band).
	expect(outOfOrder, `days out of order: ${labels.join(" | ")}`).toEqual([]);
});

test("DEFECT TZ-06 (F seed / WP-Plan): the IST layover reads 2h 20m", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?days=2027-11-05&lens=place`);
	await expect(page.getByTestId("plan-layover")).toContainText(/2h\s?20/);
});

test("DEFECT TZ-04 (WP-Plan): a day that changes zone ends in the last stop's local time", async ({ page }) => {
	// Sun 31 Oct: VN 576 lands 18:00 CST (no airport buffers) → the 0-minute TPE stop is 18:00 CST.
	await openTrip(page, `/t/${TRIP}?days=2027-10-31&lens=place`);
	const tpe = page.getByTestId("timeline-item").filter({ hasText: "TPE" }).last();
	await expect(tpe.getByTestId("item-end")).toHaveText("18:00");
	await expect(page.getByTestId("plan-day-header").first()).toContainText("ends 18:00");
});

test("DEFECT HIER-11 (WP-Places): 'daan' finds Da'an District in the palette", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	await page.keyboard.press("Control+k");
	const input = page.getByRole("dialog").getByRole("combobox").first();
	await input.fill("daan");
	await expect(page.getByRole("dialog").getByRole("option").filter({ hasText: /^Da'an District/ })).toHaveCount(1, {
		timeout: 10_000,
	});
});

test("DEFECT Rate (WP-Places): an unaccepted suggestion isn't offered as an ordinary place to rate", async ({ page }) => {
	// The old Rate screen's table link: the Places tab's table.
	await page.goto(`/t/${TRIP}/rate?view=table`);
	await expect(page.getByTestId("places-table")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("places-row").filter({ hasText: "Ghibli Park" })).toHaveCount(1);
	await page.waitForTimeout(1500); // the proposals overlay arrives after the graph
	const row = page.getByTestId("places-row").filter({ hasText: "Tōfuku-ji" });
	// Maya's proposed place: either left out, or clearly marked as a suggestion.
	if ((await row.count()) > 0) await expect(row.first()).toContainText(/Suggest|Maya/);
});

test("DEFECT Still to plan (WP-Shell/WP-Places): header and table agree on unallocated days", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?sel=root`);
	const stp = page.getByTestId("still-to-plan");
	await expect(stp).toBeVisible();
	const header = (await stp.innerText()).match(/(\d+) of \d+ unallocated/)?.[1];
	await stp.getByRole("button", { name: /Days per city/ }).click();
	const table = (await stp.innerText()).match(/Unallocated\s+(\d+)\s+day/)?.[1];
	expect(header, "header count").toBeDefined();
	expect(table, "table count").toBe(header);
});

test("DEFECT Outline (WP-Outline): 'Add inside…' puts the caret in the new row", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const row = page.getByRole("treeitem", { name: /^Nara, / }).first();
	await row.hover();
	await row.getByTestId("outline-row-menu").click();
	await page.getByRole("menuitem", { name: /Add inside/ }).click();
	const input = page.getByTestId("outline-inline-input");
	await expect(input).toBeFocused();
	await page.keyboard.press("Escape");
});

test("DEFECT Rate comments (WP-Places/WP-Lists): the @name suggestion popup is clickable", async ({ page }) => {
	await signIn(page, "audrey");
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const id = await nodeId(page, "Shibuya Sky"); // Audrey rated it in the seed
	// The old Rate screen's link: the Places tab's Rate feed; her card offers "Add a comment".
	await page.goto(`/t/${TRIP}/rate?n=${id}`);
	const card = page.locator('[data-testid="places-feed-card"][data-active]');
	await expect(card).toHaveAttribute("data-place", id, { timeout: 30_000 });
	await card.locator("button:has(svg.lucide-message-square)").first().click();
	const editor = page.getByLabel("Your comment");
	await editor.click();
	await page.keyboard.type("ask @Kenji");
	const add = page.getByRole("option", { name: /Add .*Kenji/ });
	await expect(add).toBeVisible();
	const onTop = await add.evaluate((el) => {
		const r = el.getBoundingClientRect();
		return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
	});
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Cancel" }).click().catch(() => {});
	expect(onTop, "the popup is painted under the comment footer / rating buttons").toBe(true);
});

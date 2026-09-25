/**
 * The Places tab (docs/PLACES.md §1–§3, Round 1): the table's grouping,
 * sort and status filter, the drawer docked beside it (the table still
 * scrolls to its last column), the board sharing the same filters, the map
 * swapping its side panel to the selection, and the Rate feed (rate → the
 * reveal on the card, scroll on, scroll back and change it, a skipped place
 * comes back) reached through the old `/t/<trip>/rate` link.
 */
import { expect, type Page, test } from "@playwright/test";
import { PLACES_TAB_TESTID as T } from "../../../src/features/places/tab/testids";
import { storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";

test.use({ storageState: storageStateOf("dev") });
test.skip(({ isMobile }) => isMobile, "desktop layout (the phone feed is screenshotted)");

type G = {
	nodes: { id: string; priorities: Record<string, string> }[];
};
const ratingOf = (page: Page, nodeId: string, memberId: string) =>
	page.evaluate(
		([n, m]) =>
			(
				window as unknown as { __yonder?: { graph: G } }
			).__yonder?.graph.nodes.find((x) => x.id === n)?.priorities[m as string] ??
			null,
		[nodeId, memberId],
	);

async function openPlaces(page: Page, c: FixtureClone, search = "") {
	await page.goto(`/t/${c.slug}?tab=places${search}`);
	await expect(page.getByTestId(T.tab)).toBeVisible({ timeout: 30_000 });
}

async function pick(page: Page, trigger: string, value: string) {
	await page.getByTestId(trigger).click();
	await page.getByRole("option", { name: value, exact: true }).click();
}

test("table: group, sort and filter; the drawer docks and the table still scrolls to its last column", async ({
	page,
}) => {
	const c = await cloneFixtureTrip(page.request);
	const N = c.ids.nodes;
	await openPlaces(page, c);
	const headers = page.getByTestId(T.groupHeader);
	// City is the default grouping.
	await expect(headers.filter({ hasText: "Tokyo" })).toHaveCount(1);
	await expect(headers.filter({ hasText: "Kyoto" })).toHaveCount(1);

	await pick(page, T.groupBy, "Area");
	await expect(page).toHaveURL(/pg=area/);
	await expect(headers.filter({ hasText: "Shibuya" })).toHaveCount(1);
	// Itoya sits right under Tokyo: its group falls back to the city.
	await expect(
		headers.filter({ hasText: "city-wide" }).filter({ hasText: "Tokyo" }),
	).toHaveCount(1);

	await pick(page, T.sortBy, "Name");
	await expect(page).toHaveURL(/ps=name/);
	const shibuya = headers.filter({ hasText: "Shibuya" });
	const names = await page
		.locator(`[data-testid=${T.row}]`)
		.evaluateAll((rows) => rows.map((r) => r.querySelector("td")?.textContent ?? ""));
	const inShibuya = names.filter((n) => /Hands|Loft|Sky/.test(n));
	expect(inShibuya.map((n) => n.split("Tokyo")[0])).toEqual([
		"Hands Shibuya",
		"Shibuya Loft",
		"Shibuya Sky",
	]);
	await expect(shibuya).toBeVisible();

	// Status pills: every demo place is on a day.
	await page.getByTestId(T.statusPill).and(page.locator("[data-value=scheduled]")).click();
	await expect(page).toHaveURL(/pst=scheduled/);
	const rows = page.getByTestId(T.row);
	await expect(rows.first()).toHaveAttribute("data-status", "scheduled");
	await page.getByTestId(T.statusPill).and(page.locator("[data-value=idea]")).click();
	await expect(page.getByText("No places match these filters.")).toBeVisible();
	await page.getByTestId(T.statusPill).and(page.locator("[data-value=all]")).click();

	// Open Senso-ji: the drawer docks beside the table.
	const senso = page.locator(`[data-testid=${T.row}][data-row-id="${N.sensoji}"]`);
	await senso.click();
	await expect(page).toHaveURL(new RegExp(`sel=n.${N.sensoji}`));
	const drawer = page.getByTestId(T.drawer);
	await expect(drawer).toHaveAttribute("data-place", N.sensoji as string);
	const scroller = page.getByTestId(T.tableScroll);
	await scroller.evaluate((el) => {
		el.scrollLeft = el.scrollWidth;
	});
	const media = page.locator("thead th", { hasText: "Media" });
	await expect(media).toBeInViewport();
	const [m, d] = await Promise.all([media.boundingBox(), drawer.boundingBox()]);
	expect((m?.x ?? 0) + (m?.width ?? 0)).toBeLessThanOrEqual((d?.x ?? 0) + 1);

	// Keys on the focused row: 1 rates it Must (my own rating).
	await senso.focus();
	await page.keyboard.press("1");
	await expect.poll(() => ratingOf(page, N.sensoji as string, c.members.owner)).toBe("must");
	await expect(drawer.getByTestId(T.scoreChip).first()).toHaveAttribute("data-score", "3");
});

test("the board shares the table's grouping and filters", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await openPlaces(page, c, "&pg=area&pst=scheduled");
	const tableRows = await page.getByTestId(T.row).count();
	const tableGroups = await page.getByTestId(T.groupHeader).allTextContents();
	await page.getByTestId(T.viewSwitch).locator("[data-value=board]").click();
	await expect(page).toHaveURL(/pv=board/);
	await expect(page).toHaveURL(/pg=area/);
	await expect(page).toHaveURL(/pst=scheduled/);
	await expect(page.getByTestId(T.board)).toBeVisible();
	await expect(page.getByTestId(T.card)).toHaveCount(tableRows);
	const boardGroups = await page
		.getByTestId(T.board)
		.getByTestId(T.groupHeader)
		.locator("h3")
		.allTextContents();
	expect(boardGroups.length).toBe(tableGroups.length);
	for (const g of boardGroups)
		expect(tableGroups.some((t) => t.includes(g))).toBe(true);
});

test("map: picking a row swaps the side panel to its details, and back", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	const N = c.ids.nodes;
	await openPlaces(page, c, "&pv=map");
	const list = page.getByTestId(T.mapList);
	await expect(list).toBeVisible({ timeout: 30_000 });
	await list.locator(`[data-place="${N.sensoji}"]`).click();
	await expect(page.getByTestId(T.mapDetails)).toBeVisible();
	await expect(page.getByTestId(T.drawer)).toHaveAttribute("data-place", N.sensoji as string);
	await expect(list).toBeHidden();
	// The pin carries the name + score label.
	const pin = page.locator(`[data-testid=${T.mapPin}][data-place="${N.sensoji}"]`);
	await expect(pin).toHaveAttribute("aria-pressed", "true");
	await expect(pin).toContainText("Senso-ji");
	await page.getByTestId(T.mapBack).click();
	await expect(list).toBeVisible();
	await expect(page).not.toHaveURL(/sel=/);
});

test("rate feed from the old /rate link: rate → reveal on the card, scroll on, back to change it, the skipped one comes back", async ({
	page,
}) => {
	const c = await cloneFixtureTrip(page.request);
	const N = c.ids.nodes;
	const me = c.members.owner;
	// Audrey (no account yet) says Must: an editor sets a placeholder's rating in the table.
	await openPlaces(page, c);
	await page
		.locator(
			`[data-testid=${T.row}][data-row-id="${N.sensoji}"] [data-testid=${"places-rating-cell"}][data-member="${c.members.audrey}"] button`,
		)
		.click();
	await page.getByRole("menuitem", { name: /^Must/ }).click();
	await expect.poll(() => ratingOf(page, N.sensoji as string, c.members.audrey)).toBe("must");

	// The old Rate screen's link opens the tab's Rate view on that place.
	await page.goto(`/t/${c.slug}/rate?n=${N.sensoji}`);
	await expect(page).toHaveURL(/tab=places/);
	await expect(page).toHaveURL(/pv=rate/);
	const feed = page.getByTestId(T.feed);
	await expect(feed).toBeVisible({ timeout: 30_000 });
	const cards = page.getByTestId(T.feedCard);
	const active = page.locator(`[data-testid=${T.feedCard}][data-active]`);
	await expect(active).toHaveAttribute("data-place", N.sensoji as string);
	// Others' ratings are hidden until I rate (Peek offers them).
	await expect(active.getByTestId(T.feedPeek)).toContainText("Peek at 1 rating");
	await expect(active.getByTestId(T.feedTag)).toHaveCount(0);

	await page.keyboard.press("1");
	await expect.poll(() => ratingOf(page, N.sensoji as string, me)).toBe("must");
	// The reveal, on the card: Audrey on Must, and the match tag. No moving on.
	const tag = active.getByTestId(T.feedTag);
	await expect(tag).toContainText("Match with Audrey");
	await expect(tag).toContainText("+6");
	await expect(
		active.locator(`[data-testid=${T.feedButton}][data-priority=must]`),
	).toHaveAttribute("data-picked-by", c.members.audrey);
	await expect(active).toHaveAttribute("data-place", N.sensoji as string);

	// Scroll on (↓), skipping the next place.
	const total = await cards.count();
	expect(total).toBeGreaterThan(2);
	await page.keyboard.press("ArrowDown");
	await expect(active).toHaveAttribute("data-key", /.+/);
	await expect(active).not.toHaveAttribute("data-place", N.sensoji as string);
	const skipped = await active.getAttribute("data-place");
	await page.keyboard.press("ArrowDown");
	await expect(active).not.toHaveAttribute("data-place", skipped as string);

	// Back up: Senso-ji still shows my pick; change it.
	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("ArrowUp");
	await expect(active).toHaveAttribute("data-place", N.sensoji as string);
	await expect(
		active.locator(`[data-testid=${T.feedButton}][data-priority=must]`),
	).toHaveAttribute("aria-pressed", "true");
	await active.locator(`[data-testid=${T.feedButton}][data-priority=really_want]`).click();
	await expect.poll(() => ratingOf(page, N.sensoji as string, me)).toBe("really_want");

	// Rate the rest except the skipped one, down to the end of the pile.
	const inView = () =>
		page.evaluate((id) => {
			const a = document.querySelector<HTMLElement>(`[data-testid=${id}][data-active]`);
			return a ? { place: a.dataset.place, rated: a.dataset.rated ?? null } : null;
		}, T.feedCard);
	for (let i = 0; i < total + 3; i++) {
		await page.keyboard.press("ArrowDown");
		await page.waitForTimeout(700);
		if ((await page.getByTestId(T.feedSkipped).count()) > 0) break;
		const card = await inView();
		if (card && card.place !== skipped && !card.rated) await page.keyboard.press("3");
	}
	const again = page.getByTestId(T.feedSkipped);
	await expect(again).toContainText("You skipped 1");
	await expect(
		page.locator(`[data-testid=${T.feedCard}][data-key="${skipped}#2"]`),
	).toHaveCount(1);
	await expect(page.getByTestId(T.feedEnd)).toBeAttached();
});

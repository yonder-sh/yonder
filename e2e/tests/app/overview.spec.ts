/**
 * The trip Overview (docs/OVERVIEW.md), on a cloned demo trip (§18.5):
 * - a bare trip link lands on the Overview (first tab), which takes the map's
 *   space on desktop; `?tab=plan` links keep opening the Plan;
 * - the stats; `?asOf` shows the before / during / after headers;
 * - a stay on the route strip opens its days in the Plan;
 * - a view-link guest lands on it too;
 * - on a phone it is the sheet's first tab, stacked, at full height;
 * - screenshots in `e2e/shots/overview/`.
 */
import { expect, type Page, test } from "@playwright/test";
import { OVERVIEW_TESTID as O } from "../../../src/features/overview/testids";
import { SHELL_TESTID } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";
import { openLink } from "./_helpers/link";

test.use({ storageState: storageStateOf("dev") });

const activeTab = (page: Page) =>
	page.getByTestId(TESTID.centerTabs).locator('[role=tab][aria-selected="true"]');

test("desktop: a trip link lands on the Overview, with the stats and the route", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/t/${c.slug}`);
	await expectLive(page);

	// The first tab, and the selected one; the map's space is the page's.
	const tabs = page.getByTestId(TESTID.centerTabs).getByRole("tab");
	await expect(tabs.first()).toHaveAttribute("data-tab", "overview");
	await expect(activeTab(page)).toHaveAttribute("data-tab", "overview");
	const ov = page.getByTestId(O.page);
	await expect(ov).toBeVisible();
	await expect(ov).toHaveAttribute("data-layout", "wide");
	await expect(page.getByTestId(TESTID.tripMap)).toHaveCount(0);

	// The demo: 5 days, Mt. Fuji the one stay; places and a flight planned.
	const stat = (k: string) => page.locator(`[data-testid=${O.stat}][data-stat=${k}]`);
	await expect(stat("days")).toContainText("5");
	await expect(stat("cities")).toContainText("1");
	await expect(stat("flights")).toContainText(/flights?/);
	await expect(stat("places")).toContainText("places planned");
	await expect(stat("km")).toContainText("km travelled");
	await expect(page.getByTestId(O.title)).toContainText("Demo");
	// The globe draws itself and settles.
	await expect(page.getByTestId(O.globe)).toHaveAttribute("data-drawn", "done", { timeout: 10_000 });
	// The inspector's former sections live here now.
	await expect(page.getByTestId(SHELL_TESTID.stillToPlan)).toBeVisible();
	await page.screenshot({ path: shotPath("overview/desktop.png") });

	// A Plan link still opens the Plan (with the map).
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expect(activeTab(page)).toHaveAttribute("data-tab", "plan");
	await expect(page.getByTestId(TESTID.tripMap)).toBeVisible();
	expect(logs.messages).toEqual([]);
});

test("?asOf shows the header before, during and after the trip", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const c = await cloneFixtureTrip(page.request);
	await page.setViewportSize({ width: 1440, height: 900 });
	const header = page.getByTestId(O.header);

	await page.goto(`/t/${c.slug}?asOf=2027-09-30`);
	await expect(header).toHaveAttribute("data-phase", "before");
	await expect(page.getByTestId(O.chip)).toContainText("Planning · 3 days to go");

	// Day 3 of 5 (5 Oct): the night at Mt. Fuji, pulsing on the globe.
	await page.goto(`/t/${c.slug}?asOf=2027-10-05`);
	await expect(header).toHaveAttribute("data-phase", "during");
	await expect(header).toContainText("Day 3 of 5");
	await expect(page.getByTestId(O.title)).toContainText("Mt. Fuji");
	await expect(page.getByTestId(O.progress)).toHaveAttribute("aria-valuenow", "60");
	await expect(page.getByTestId(O.chip)).toContainText("On the trip");
	await expect(page.locator(`[data-testid=${O.day}][aria-current=date]`)).toHaveAttribute(
		"data-date",
		"2027-10-05",
	);
	await expect(page.getByTestId(O.here)).toBeVisible({ timeout: 10_000 });
	await page.screenshot({ path: shotPath("overview/during.png") });

	await page.goto(`/t/${c.slug}?asOf=2027-12-01`);
	await expect(header).toHaveAttribute("data-phase", "after");
	await expect(header).toContainText("That was");
	await expect(page.getByTestId(O.chip)).toContainText("Back home · Oct 2027");
});

test("a stay on the route strip opens its days in the Plan; a day line opens that day", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/t/${c.slug}`);
	const stay = page.getByTestId(O.strip).getByTestId(O.stay).first();
	await expect(stay).toHaveAttribute("data-days", "2027-10-05");
	// Hovering turns the globe there (the ring marks it); a click opens the Plan.
	await stay.hover();
	await stay.click();
	await expect(page).toHaveURL(/[?&]days=2027-10-05(&|$)/);
	await expect(activeTab(page)).toHaveAttribute("data-tab", "plan");
	await expect(page.getByTestId(TESTID.dayRangeChip)).toBeVisible();

	// Back on the Overview, a day line opens that day in the Plan.
	await page.goBack();
	await expect(activeTab(page)).toHaveAttribute("data-tab", "overview");
	await page.locator(`[data-testid=${O.day}][data-date="2027-10-04"]`).click();
	await expect(page).toHaveURL(/[?&]days=2027-10-04(&|$)/);
	await expect(activeTab(page)).toHaveAttribute("data-tab", "plan");
});

test("a view-link guest lands on the Overview", async ({ browser, page }, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const c = await cloneFixtureTrip(page.request);
	// Signed out: `browser.newContext` would otherwise carry the spec's dev login.
	const guestCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });
	const guest = await guestCtx.newPage();
	await openLink(guest, c.slug, "viewer");
	await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}(\\?|$)`), { timeout: 20_000 });
	await expect(guest.getByTestId(O.page)).toBeVisible();
	await expect(activeTab(guest)).toHaveAttribute("data-tab", "overview");
	await expect(guest.getByTestId(O.header)).toBeVisible();
	await expect(guest.getByTestId(O.globe)).toHaveAttribute("data-drawn", "done", { timeout: 10_000 });
	// A link guest never sees money (EXTENSIONS §1.4): no Money tab.
	const me = await guest.evaluate(
		() => (window as unknown as { __yonder: { graph: { me: { role: string; isGuest: boolean } } } }).__yonder.graph.me,
	);
	console.log("guest me:", JSON.stringify({ role: me.role, isGuest: me.isGuest }));
	expect(me.isGuest).toBe(true);
	await expect(guest.getByTestId(TESTID.centerTabs).locator("[data-tab=money]")).toHaveCount(0);
	await guestCtx.close();
});

test("phone: the Overview is the sheet's first tab, stacked and full height", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "phone layout");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?asOf=2027-10-05`);
	const sheet = page.getByTestId(TESTID.mobileSheet);
	await expect(sheet).toBeVisible();
	const tabs = sheet.getByTestId(TESTID.centerTabs).getByRole("tab");
	await expect(tabs.first()).toHaveAttribute("data-tab", "overview");
	await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
	const ov = page.getByTestId(O.page);
	await expect(ov).toBeVisible();
	await expect(ov).toHaveAttribute("data-layout", "stacked");
	await expect(page.getByTestId(O.header)).toHaveAttribute("data-phase", "during");
	await expect(page.getByTestId(O.globe)).toBeVisible();
	// The strip's bars fit the screen (no sideways scroll).
	const strip = await page.getByTestId(O.strip).boundingBox();
	const vw = page.viewportSize()?.width ?? 0;
	expect((strip?.x ?? 0) + (strip?.width ?? 0)).toBeLessThanOrEqual(vw);
	// The sheet opened high: the header is well up the screen.
	const header = await page.getByTestId(O.header).boundingBox();
	expect(header?.y ?? 9999).toBeLessThan(260);
	await page.waitForTimeout(3500);
	await page.screenshot({ path: shotPath("overview/phone.png") });
});

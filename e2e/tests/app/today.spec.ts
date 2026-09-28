/**
 * Today, on the road (One Yonder phase 5, flow 10), on a cloned demo trip
 * (§18.5) at `?asOf` local times on Sun 3 Oct (Day 1: Hands Shibuya 09:00,
 * Shibuya Loft, Lunch, Meiji Jingu, Shibuya Sky at 17:30):
 * - during the trip the phone opens on Today (no ★ Rate pill), with the
 *   Overview a quiet link away;
 * - Done moves you on and Undo brings the stop back;
 * - a Done late in the day shows the risk to Shibuya Sky with its fixes,
 *   each with Undo;
 * - Address opens "Show this to the driver";
 * - desktop: the same column in the Overview's place.
 * Screenshots in `e2e/shots/today/`.
 */
import { expect, type Page, test } from "@playwright/test";
import { OVERVIEW_TESTID as O } from "../../../src/features/overview/testids";
import { PLACES_TAB_TESTID } from "../../../src/features/places/tab/testids";
import { TODAY_TESTID as T } from "../../../src/features/today/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

/** Hands Shibuya on by the plan at 09:30; its Done read at 14:10 puts Shibuya Sky at risk. */
const MORNING = "2027-10-03T09:30";
const LATE = "2027-10-03T14:10";

const tabs = (page: Page) => page.getByTestId(TESTID.centerTabs).getByRole("tab");
const activeTab = (page: Page) =>
	page.getByTestId(TESTID.centerTabs).locator('[role=tab][aria-selected="true"]');
const toast = (page: Page, text: string) =>
	page.locator("[data-sonner-toast]").filter({ hasText: text });

test("phone: during the trip the app opens on Today", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?asOf=${MORNING}`);
	await expectLive(page);

	const today = page.getByTestId(T.page);
	await expect(today).toBeVisible();
	await expect(today).toHaveAttribute("data-state", "underway");
	await expect(tabs(page).first()).toHaveAttribute("data-tab", "today");
	await expect(activeTab(page)).toHaveAttribute("data-tab", "today");
	await expect(page.getByTestId(TESTID.centerTabs).locator("[data-tab=overview]")).toHaveCount(0);
	await expect(page.getByTestId(T.header)).toContainText("Day 1 of 5 · Sun 3 Oct");
	await expect(page.getByTestId(T.now)).toContainText("Hands Shibuya");
	await expect(page.getByTestId(T.next)).toContainText("Shibuya Loft");
	await expect(page.getByTestId(T.directions)).toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\/dir\//);
	// Planning prompts step back while you travel.
	await expect(page.getByTestId(PLACES_TAB_TESTID.ratePill)).toHaveCount(0);
	await page.waitForTimeout(400);
	await page.screenshot({ path: shotPath("today/phone.png"), animations: "disabled" });
	expect(logs.messages).toEqual([]);

	// The Overview is a quiet link away, under Today.
	await page.getByTestId(T.overviewLink).tap();
	await expect(page).toHaveURL(/[?&]tab=overview(&|$)/);
	await expect(page.getByTestId(O.page)).toBeVisible();
	await expect(activeTab(page)).toHaveAttribute("data-tab", "today");
	await tabs(page).first().tap();
	await expect(page.getByTestId(T.page)).toBeVisible();
});

test("phone: Done moves you on, Undo brings the stop back", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone layout");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?asOf=${MORNING}`);
	await expectLive(page);

	const now = page.getByTestId(T.now);
	await expect(now).toContainText("Hands Shibuya");
	await now.getByTestId(T.done).tap();
	// The quiet row keeps the Done (a stamp from another day reads as now) with its Undo.
	const row = page.getByTestId(T.doneRow);
	await expect(row).toContainText("Hands Shibuya · done 09:30");
	await expect(row).toHaveAttribute("data-item", c.ids.items.hands as string);
	await expect(page.getByTestId(T.now)).toHaveCount(0);
	await expect(page.getByTestId(T.next)).toContainText("Shibuya Loft");
	await page.screenshot({ path: shotPath("today/phone-done.png"), animations: "disabled" });

	// It's shared: the saved graph has it.
	await page.reload();
	await expectLive(page);
	await expect(page.getByTestId(T.doneRow)).toContainText("Hands Shibuya");

	await page.getByTestId(T.undo).tap();
	await expect(page.getByTestId(T.doneRow)).toHaveCount(0);
	await expect(page.getByTestId(T.now)).toContainText("Hands Shibuya");
});

test("a Done late in the day shows the risk and its fixes, each with Undo", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?asOf=${MORNING}`);
	await expectLive(page);
	// No Done yet: the plan by the clock, no pace.
	await expect(page.getByTestId(T.pace)).toHaveCount(0);
	await page.getByTestId(T.now).getByTestId(T.done).click();
	await expect(page.getByTestId(T.doneRow)).toContainText("Hands Shibuya");

	// A stamp from another day reads as now: Hands Shibuya left at 14:10.
	await page.goto(`/t/${c.slug}?asOf=${LATE}`);
	await expectLive(page);
	await expect(page.getByTestId(T.pace)).toHaveAttribute("data-pace", "behind");
	const risk = page.getByTestId(T.risk);
	await expect(risk).toContainText("Tight before Shibuya Sky · 17:30");
	await expect(risk).toContainText("You'd arrive 17:21: 9 min spare");
	const fixes = risk.getByTestId(T.fix);
	await expect(fixes).toHaveText(["Shorten Meiji Jingu to 30 min", "Skip Shibuya Loft"]);
	await page.screenshot({ path: shotPath(`today/late-${test.info().project.name}.png`) });

	// Shorten: the risk goes; Undo brings it back.
	await fixes.filter({ hasText: "Shorten" }).click();
	await expect(page.getByTestId(T.risk)).toHaveCount(0);
	await toast(page, "Meiji Jingu shortened to 30 min").getByRole("button", { name: "Undo" }).click();
	await expect(page.getByTestId(T.risk)).toContainText("Shibuya Sky");

	// Skip: Shibuya Loft goes to Ideas; Undo puts it back next.
	await page.getByTestId(T.fix).filter({ hasText: "Skip Shibuya Loft" }).click();
	await expect(page.getByTestId(T.next)).not.toContainText("Shibuya Loft");
	await toast(page, "Shibuya Loft moved to Ideas").getByRole("button", { name: "Undo" }).click();
	await expect(page.getByTestId(T.next)).toContainText("Shibuya Loft");
});

test("Address opens “Show this to the driver”", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone layout");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?asOf=${MORNING}`);
	await expectLive(page);

	await page.getByTestId(T.next).getByTestId(T.address).tap();
	const sheet = page.getByTestId(T.driver);
	await expect(sheet).toBeVisible();
	await expect(sheet).toContainText("Show this to the driver");
	// The local address when the lookup knows it, else the place's own.
	await expect(sheet.getByTestId(T.driverLocal)).toContainText(/\S/);
	await expect(sheet.getByTestId(T.driverDirections)).toHaveAttribute("href", /destination=35\.6612,139\.6987/);
	await page.screenshot({ path: shotPath("today/driver.png"), animations: "disabled" });
	await sheet.getByRole("button", { name: "Close" }).tap();
	await expect(sheet).toHaveCount(0);
});

test("desktop: Today takes the Overview's place; a stop opens its details over it", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/t/${c.slug}?asOf=${MORNING}`);
	await expectLive(page);

	await expect(tabs(page).first()).toHaveAttribute("data-tab", "today");
	await expect(activeTab(page)).toHaveAttribute("data-tab", "today");
	await expect(page.getByTestId(T.page)).toBeVisible();
	// The readable column, no map beside it.
	await expect(page.getByTestId(TESTID.tripMap)).toHaveCount(0);
	const box = await page.getByTestId(T.page).boundingBox();
	expect(box?.width ?? 0).toBeLessThanOrEqual(600);
	await page.screenshot({ path: shotPath("today/desktop.png") });

	await page.getByTestId(T.restRow).first().click();
	await expect(page.getByTestId(TESTID.inspector)).toBeVisible();
	await expect(page).toHaveURL(/[?&]tab=today(&|$)/);
	await expect(page.getByTestId(T.page)).toBeVisible();
});

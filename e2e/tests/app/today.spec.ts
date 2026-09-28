/**
 * Today, on the road (One Yonder phase 5, flow 10), on a cloned demo trip
 * (§18.5) at `?asOf` local times on Sun 3 Oct (Day 1: Hands Shibuya 09:00,
 * Shibuya Loft, Lunch, Meiji Jingu, Shibuya Sky at 17:30):
 * - during the trip the phone opens on Today (no ★ Rate pill), with the
 *   Overview a quiet link away;
 * - Done records the `asOf` time (09:30) and moves you on; an earlier view
 *   shows the day before it, a later one (14:10) keeps it; Undo brings the
 *   stop back;
 * - with Meiji Jingu stretched to 5 h, "Still at Hands Shibuya?" Done at
 *   10:10 shows the risk to Shibuya Sky with its fixes, each with Undo;
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
import { updateItem } from "./insights-helpers";

test.use({ storageState: storageStateOf("dev") });

/** Hands Shibuya is Now by the plan at 09:30 (09:00–09:45). */
const MORNING = "2027-10-03T09:30";
const EARLIER = "2027-10-03T09:10";
const LATER = "2027-10-03T14:10";
/** Hands Shibuya's time is up (Shibuya Loft is Now): "Still at Hands Shibuya?". */
const LATE = "2027-10-03T10:10";

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

test("phone: Done records the asOf time and moves you on, Undo brings the stop back", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone layout");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?asOf=${MORNING}`);
	await expectLive(page);

	const now = page.getByTestId(T.now);
	await expect(now).toContainText("Hands Shibuya");
	await now.getByTestId(T.done).tap();
	// The quiet row keeps the Done at 09:30 with its Undo; 15 min early, Shibuya Loft comes sooner.
	const row = page.getByTestId(T.doneRow);
	await expect(row).toContainText("Hands Shibuya · done 09:30");
	await expect(row).toHaveAttribute("data-item", c.ids.items.hands as string);
	await expect(page.getByTestId(T.now)).toHaveCount(0);
	const next = page.getByTestId(T.next);
	await expect(next).toContainText("Next · about 09:33");
	await expect(next).toContainText("planned 09:48");
	await expect(next).toContainText("Shibuya Loft");
	await expect(page.getByTestId(T.pace)).toContainText("15 min ahead");
	await page.screenshot({ path: shotPath("today/phone-done.png"), animations: "disabled" });

	// It's shared: the saved graph has it, at 09:30.
	await page.reload();
	await expectLive(page);
	await expect(page.getByTestId(T.doneRow)).toContainText("Hands Shibuya · done 09:30");

	// At 09:10 it isn't done yet: the day as it was.
	await page.goto(`/t/${c.slug}?asOf=${EARLIER}`);
	await expectLive(page);
	await expect(page.getByTestId(T.doneRow)).toHaveCount(0);
	await expect(page.getByTestId(T.now)).toContainText("Now · since 09:00");
	await expect(page.getByTestId(T.now)).toContainText("Hands Shibuya");
	await expect(page.getByTestId(T.pace)).toHaveCount(0);

	// At 14:10 it stays at 09:30: Shibuya Loft ran over long ago, so the day is back on the plan.
	await page.goto(`/t/${c.slug}?asOf=${LATER}`);
	await expectLive(page);
	await expect(page.getByTestId(T.pace)).toHaveCount(0);
	await expect(page.getByTestId(T.risk)).toHaveCount(0);
	await expect(page.getByTestId(T.next)).toContainText("Next · 17:30");
	await expect(page.getByTestId(T.next)).toContainText("Shibuya Sky");
	await expect(page.getByTestId(T.free)).toContainText("3 h 08 free before 17:18");

	await page.goto(`/t/${c.slug}?asOf=${MORNING}`);
	await expectLive(page);
	await page.getByTestId(T.undo).tap();
	await expect(page.getByTestId(T.doneRow)).toHaveCount(0);
	await expect(page.getByTestId(T.now)).toContainText("Hands Shibuya");
});

test("a late Done shows the risk and its fixes, each with Undo", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?asOf=${LATE}`);
	await expectLive(page);
	// A long visit to Meiji Jingu (11:44–16:44) leaves 34 min before Shibuya Sky.
	await updateItem(page, c.ids.items.meiji as string, { durationMin: 300 });
	await page.reload();
	await expectLive(page);
	// No Done yet: the plan by the clock, no pace; Hands Shibuya's time is up.
	await expect(page.getByTestId(T.pace)).toHaveCount(0);
	await expect(page.getByTestId(T.now)).toContainText("Shibuya Loft");
	const ask = page.getByTestId(T.checkIn);
	await expect(ask).toContainText("Still at Hands Shibuya?");
	await ask.getByTestId(T.done).click();
	await expect(page.getByTestId(T.doneRow)).toContainText("Hands Shibuya · done 10:10");

	// Left at 10:10: 25 min behind, and Shibuya Sky is tight.
	await expect(page.getByTestId(T.pace)).toHaveAttribute("data-pace", "behind");
	await expect(page.getByTestId(T.pace)).toContainText("25 min behind");
	await expect(page.getByTestId(T.next)).toContainText("Next · about 10:13");
	const risk = page.getByTestId(T.risk);
	await expect(risk).toContainText("Tight before Shibuya Sky · 17:30");
	await expect(risk).toContainText("You'd arrive 17:21: 9 min spare instead of 34.");
	const fixes = risk.getByTestId(T.fix);
	await expect(fixes).toHaveText(["Shorten Meiji Jingu to 4 h 30", "Skip Shibuya Loft"]);
	await page.screenshot({ path: shotPath(`today/late-${test.info().project.name}.png`) });

	// Shorten: the risk goes; Undo brings it back.
	await fixes.filter({ hasText: "Shorten" }).click();
	await expect(page.getByTestId(T.risk)).toHaveCount(0);
	await toast(page, "Meiji Jingu shortened to 4 h 30").getByRole("button", { name: "Undo" }).click();
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

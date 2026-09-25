/**
 * WP-Insights screenshots at 1440×900 and 390×844 (the orchestrator's review
 * sizes): the plan with hours chips, sun and a day badge; the hours popover;
 * the place inspector (hours table + climate); the hours editor; the shift
 * dialog with its impact; the what-if chip with primary rings.
 */
import { expect, type Page, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { card, INSIGHTS_TESTID as T, openHarness, refreshGraph, setSheetHours, updateItem } from "./insights-helpers";

test.use({ storageState: storageStateOf("dev") });

async function seed(page: Page, c: FixtureClone) {
	await setSheetHours(page, c.ids.nodes.kiyomizu as string, "Earliest tour 9:30–11:40 (reserve); closed Wed & Fri");
	await setSheetHours(page, c.ids.nodes.itoya as string, "10:30–19:00; closed 2nd Tue");
	await setSheetHours(page, c.ids.nodes.knifeShop as string, "shops ~10:00–17:00; many closed Sun");
	await setSheetHours(page, c.ids.nodes.hands as string, "10:00–21:00 daily");
	await updateItem(page, c.ids.items.sky as string, { pinnedStart: "18:30" });
	await updateItem(page, c.ids.items.knives as string, { durationMin: 420 });
	await refreshGraph(page);
}

for (const size of [
	{ name: "1440", width: 1440, height: 900 },
	{ name: "390", width: 390, height: 844 },
] as const) {
	test(`screens at ${size.name}`, async ({ page }, info) => {
		test.skip(info.project.name !== "chromium", "sizes are set here");
		await page.setViewportSize({ width: size.width, height: size.height });
		const c = await cloneFixtureTrip(page.request);
		await openHarness(page, c);
		await seed(page, c);
		const narrow = size.width < 768;
		const shot = (n: string) => page.screenshot({ path: shotPath(`insights/${size.name}-${n}.png`), animations: "disabled" });

		// Plan: day 2–4 in view.
		await page.locator(`[data-testid=harness-day][data-day="${c.ids.days.d2}"]`).scrollIntoViewIfNeeded();
		await expect(card(page, c.ids.items.knives as string).getByTestId(TESTID.hoursChip)).toBeVisible();
		await shot("plan");

		await card(page, c.ids.items.knives as string).getByTestId(TESTID.hoursChip).click();
		await expect(page.getByTestId(T.hoursPopover)).toBeVisible();
		await shot("popover");
		await page.keyboard.press("Escape");

		// The place inspector.
		await card(page, c.ids.items.itoya as string).click();
		if (narrow) await page.getByTestId("harness-tab-inspector").click();
		await expect(page.getByTestId(TESTID.hoursTable)).toBeVisible();
		await expect(page.getByTestId(T.climateLine).first()).toBeVisible({ timeout: 30_000 });
		await page.getByTestId("harness-inspector").scrollIntoViewIfNeeded();
		await shot("inspector");

		await page.getByTestId(T.hoursTableConfirm).click();
		await expect(page.getByTestId(TESTID.hoursEditorDialog)).toBeVisible();
		await shot("editor");
		await page.keyboard.press("Escape");

		// The what-if.
		if (narrow) await page.getByTestId("harness-tab-plan").click();
		await page.getByTestId("harness-try-dates").click();
		const dialog = page.getByTestId(TESTID.shiftTripDialog);
		await dialog.getByTestId(T.shiftPlus).click();
		await dialog.getByTestId(T.shiftPlus).click();
		await expect(dialog.getByTestId(TESTID.dateImpactList)).toBeVisible();
		await shot("shift");
		await dialog.getByRole("button", { name: "Keep exploring" }).click();
		await expect(page.getByTestId(TESTID.whatIfChip).first()).toBeVisible();
		await page.locator(`[data-testid=harness-day][data-day="${c.ids.days.d1}"]`).scrollIntoViewIfNeeded();
		await shot("whatif");

		// Settings (holidays).
		if (narrow) await page.getByTestId("harness-tab-settings").click();
		const settings = page.getByTestId("harness-settings");
		await settings.getByTestId(T.holidayAdd).click();
		await settings.getByTestId(T.holidayRow).last().getByLabel("Holiday date").click();
		await page.getByRole("button", { name: /October 11th, 2027/ }).click();
		await settings.getByTestId(T.holidayRow).last().getByLabel("Holiday name").fill("Sports Day");
		await settings.scrollIntoViewIfNeeded();
		await shot("holidays");
	});
}

/**
 * WP-Insights E1 holidays in the REAL Trip settings dialog (QA COLLAB-R3-01).
 * WP-Home mounts `HolidaysEditor` inside the settings `<form>`, so its
 * buttons must never submit that form: "Add holiday" adds a row and the
 * dialog stays open; Enter in a holiday's name saves the holidays (not the
 * settings); "Save holidays" writes `settings.holidays` and keeps the dialog.
 */
import { expect, type Page, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";
import { INSIGHTS_TESTID as T } from "./insights-helpers";

test.use({ storageState: storageStateOf("dev") });

type Snapshot = { version: number; name: string; settings: Record<string, unknown> };
const tripNow = (page: Page) =>
	page.evaluate(() => {
		const g = (window as unknown as {
			__yonder?: { graph: { trip: { version: number; name: string; settings: Record<string, unknown> } } };
		}).__yonder?.graph.trip;
		return g ? { version: g.version, name: g.name, settings: g.settings } : null;
	}) as Promise<Snapshot | null>;

async function openSettings(page: Page, mobile: boolean) {
	if (mobile) await page.locator('button[aria-label="More"]').click();
	else await page.getByTestId(TESTID.tripMenu).click();
	await page.getByRole("menuitem", { name: "Trip settings" }).click();
	const dialog = page.getByTestId(TESTID.tripSettingsDialog);
	await expect(dialog).toBeVisible();
	return dialog;
}

test("Trip settings: 'Add holiday' adds a row, Enter and 'Save holidays' save them, the dialog stays open (COLLAB-R3-01)", async ({
	page,
	request,
}, info) => {
	const mobile = info.project.name === "mobile";
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const before = await tripNow(page);
	expect(before).not.toBeNull();

	const dialog = await openSettings(page, mobile);
	const editor = dialog.getByTestId(TESTID.holidaysEditor);
	await editor.scrollIntoViewIfNeeded();
	await expect(editor.getByTestId(T.holidayRow)).toHaveCount(0);

	// The click adds a row; nothing is submitted.
	await editor.getByTestId(T.holidayAdd).click();
	await expect(editor.getByTestId(T.holidayRow)).toHaveCount(1);
	await page.waitForTimeout(800);
	await expect(dialog).toBeVisible();
	await expect(page.getByText("Settings saved")).toHaveCount(0);
	// The settings, not the trip's version: the Plan's leg autofill may bump
	// that in the background at any moment.
	expect((await tripNow(page))?.settings, "no settings save").toEqual(before?.settings);

	// Fill it: date from the calendar, name typed; Enter saves the holidays.
	const row = editor.getByTestId(T.holidayRow).first();
	await row.getByLabel("Holiday date").click();
	await page.getByRole("button", { name: /October 4th, 2027/ }).click();
	await expect(row.getByLabel("Holiday date")).toHaveText("Mon 4 Oct 2027");
	await row.getByLabel("Holiday name").fill("Test Day");
	await editor.scrollIntoViewIfNeeded();
	await page.screenshot({ path: shotPath(`insights/settings-holiday-row-${info.project.name}.png`), animations: "disabled" });
	await row.getByLabel("Holiday name").press("Enter");
	await expect(page.getByText("1 holiday saved")).toBeVisible();
	await expect(dialog).toBeVisible();
	await expect(page.getByText("Settings saved")).toHaveCount(0);
	await expect.poll(async () => (await tripNow(page))?.settings.holidays).toEqual([{ date: "2027-10-04", name: "Test Day" }]);

	// A second one through the button.
	await editor.getByTestId(T.holidayAdd).click();
	await expect(editor.getByTestId(T.holidayRow)).toHaveCount(2);
	const second = editor.getByTestId(T.holidayRow).nth(1);
	await second.getByLabel("Holiday date").click();
	await page.getByRole("button", { name: /October 6th, 2027/ }).click();
	await second.getByLabel("Holiday name").fill("Second Day");
	await editor.getByTestId(T.holidaySave).click();
	await expect(page.getByText("2 holidays saved")).toBeVisible();
	await expect(dialog).toBeVisible();
	await expect(editor.getByTestId(T.holidaySave)).toHaveCount(0);
	await editor.scrollIntoViewIfNeeded();
	await page.screenshot({ path: shotPath(`insights/settings-holidays-saved-${info.project.name}.png`), animations: "disabled" });

	const after = await tripNow(page);
	expect(after?.settings.holidays).toEqual([
		{ date: "2027-10-04", name: "Test Day" },
		{ date: "2027-10-06", name: "Second Day" },
	]);
	// Only the holidays were written: the name and the other settings are untouched.
	expect(after?.name).toBe(before?.name);
	expect(after?.settings.currency).toEqual(before?.settings.currency);
	expect(after?.settings.dayCapacityMin).toEqual(before?.settings.dayCapacityMin);
	expect(logs.messages).toEqual([]);
});

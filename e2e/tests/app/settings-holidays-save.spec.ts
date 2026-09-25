/**
 * NEW-V52-01 in the real Trip settings dialog: "Add holiday", fill in the date
 * and name, then the dialog's own Save (the big one at the bottom): the
 * holiday is saved with the other settings and survives a reload. Before, that
 * Save closed the dialog and dropped the holiday without a word. A half-filled
 * holiday keeps the dialog open with the reason.
 */
import { expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";
import { INSIGHTS_TESTID as T } from "./insights-helpers";

test.use({ storageState: storageStateOf("dev") });

const holidaysNow = (page: Page) =>
	page.evaluate(
		() =>
			(window as unknown as { __yonder?: { graph: { trip: { settings: { holidays?: unknown } } } } }).__yonder
				?.graph.trip.settings.holidays ?? null,
	);

async function openSettings(page: Page, mobile: boolean) {
	if (mobile) await page.locator('button[aria-label="More"]').click();
	else await page.getByTestId(TESTID.tripMenu).click();
	await page.getByRole("menuitem", { name: "Trip settings" }).click();
	const dialog = page.getByTestId(TESTID.tripSettingsDialog);
	await expect(dialog).toBeVisible();
	return dialog;
}

test("a holiday filled in and saved with the dialog's Save is kept (NEW-V52-01)", async ({ page, request }, info) => {
	const mobile = info.project.name === "mobile";
	const c = await cloneFixtureTrip(request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	let dialog = await openSettings(page, mobile);
	const editor = dialog.getByTestId(TESTID.holidaysEditor);
	await editor.scrollIntoViewIfNeeded();
	await editor.getByTestId(T.holidayAdd).click();
	const row = editor.getByTestId(T.holidayRow).first();

	// Half-filled: Save says why and keeps the dialog (and the row).
	await row.getByLabel("Holiday date").click();
	await page.getByRole("button", { name: /October 4th, 2027/ }).click();
	await dialog.getByTestId(HOME_TESTID.settingsSave).click();
	await expect(page.getByText("Public holidays: Each holiday needs a name.")).toBeVisible();
	await expect(dialog).toBeVisible();
	await expect(editor.getByTestId(T.holidayRow)).toHaveCount(1);

	// Filled in: the dialog's own Save writes it.
	await row.getByLabel("Holiday name").fill("Sports Day");
	await page.screenshot({ path: shotPath(`insights/settings-holiday-footer-save-${info.project.name}.png`), animations: "disabled" });
	await dialog.getByTestId(HOME_TESTID.settingsSave).click();
	await expect(page.getByText("Settings saved")).toBeVisible();
	await expect(dialog).toBeHidden();
	await expect.poll(() => holidaysNow(page)).toEqual([{ date: "2027-10-04", name: "Sports Day" }]);

	// …and it's there after a reload, in the dialog too.
	await page.reload();
	await expectLive(page);
	expect(await holidaysNow(page)).toEqual([{ date: "2027-10-04", name: "Sports Day" }]);
	dialog = await openSettings(page, mobile);
	const again = dialog.getByTestId(TESTID.holidaysEditor);
	await again.scrollIntoViewIfNeeded();
	await expect(again.getByTestId(T.holidayRow)).toHaveCount(1);
	await expect(again.getByLabel("Holiday name")).toHaveValue("Sports Day");
	await page.screenshot({ path: shotPath(`insights/settings-holiday-kept-${info.project.name}.png`), animations: "disabled" });
});

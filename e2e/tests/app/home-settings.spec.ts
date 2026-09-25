/**
 * WP-Home trip settings and profile (DESIGN §8.5, §8.10; EXTENSIONS §1.4
 * "Home currency", "Try other dates…"; ADDENDUM §7.2 display currency incl.
 * "Local"; QA TRIP-02, AUTH-15). Each test clones its own demo trip.
 */
import { expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import {
	collectConsole,
	expectLive,
	expectNoHorizontalOverflow,
	hydrated,
} from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

async function openMenuItem(page: Page, mobile: boolean, item: string) {
	if (mobile) await page.locator('button[aria-label="More"]').click();
	else await page.getByTestId(TESTID.tripMenu).click();
	await page.getByRole("menuitem", { name: item }).click();
}

test("trip settings: home currency, dates preview, and the owner's tools", async ({
	page,
	request,
}, info) => {
	const mobile = info.project.name === "mobile";
	const c = await cloneFixtureTrip(request);
	const log = collectConsole(page);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await openMenuItem(page, mobile, "Trip settings");
	const dialog = page.getByTestId(TESTID.tripSettingsDialog);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId(HOME_TESTID.settingsName)).toHaveValue(
		"Demo · Japan & Korea",
	);
	// Owner-only: the address, Duplicate… and the Danger zone.
	// The address: only its readable part is edited; the random tail shows beside it.
	await expect(dialog.getByTestId(HOME_TESTID.settingsSlug)).toHaveValue("demo");
	await expect(dialog.getByTestId(HOME_TESTID.settingsSlugTail)).toHaveText(`-${c.slug.slice(-8)}`);
	await expect(dialog.getByTestId(HOME_TESTID.settingsDelete)).toBeVisible();
	// QA HOME-9 / VIS-15: one "Public holidays" heading (the editor's own).
	await expect(dialog.getByText("Public holidays", { exact: true })).toHaveCount(
		1,
	);
	await expectNoHorizontalOverflow(page);
	await page.waitForTimeout(300);
	await page.screenshot({
		path: shotPath(`home/trip-settings-${mobile ? "mobile" : "desktop"}.png`),
		animations: "disabled",
	});
	if (mobile) return;

	// Home currency → JPY, with the re-conversion note, then saved for everyone.
	await dialog.getByTestId(HOME_TESTID.settingsCurrency).click();
	await page.getByRole("option", { name: /JPY/ }).click();
	await expect(dialog).toContainText("Balances, budgets and totals will be in");
	await dialog.getByTestId(HOME_TESTID.settingsSave).click();
	await expect(dialog).toBeHidden();
	const currency = await page.evaluate(
		() =>
			(
				window as unknown as {
					__yonder?: { graph: { trip: { settings: { currency?: string } } } };
				}
			).__yonder?.graph.trip.settings.currency,
	);
	expect(currency).toBe("JPY");

	// Dates: shrinking the end previews what moves to Unscheduled (TRIP-02).
	await openMenuItem(page, false, "Trip settings");
	await dialog.getByTestId(HOME_TESTID.settingsDates).click();
	const days = page.locator('[data-slot="popover-content"] button[data-day]');
	await days.filter({ hasText: /^3$/ }).first().click();
	await days.filter({ hasText: /^4$/ }).first().click();
	await expect(dialog.getByTestId(HOME_TESTID.datesConfirm)).toBeVisible();
	// Either what moves, or why it can't (a flight holds the day).
	await expect(dialog).toContainText(/move to Unscheduled|Nothing moves|holds/);
	await page.screenshot({
		path: shotPath("home/trip-settings-dates-desktop.png"),
		animations: "disabled",
	});
	expect(log.messages).toEqual([]);
});

test("profile: name and display currency (Local)", async ({ page, request }, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	await cloneFixtureTrip(request);
	await page.goto("/dashboard");
	await (await hydrated(page.getByTestId(TESTID.accountMenu))).click();
	await page.getByRole("menuitem", { name: "Profile" }).click();
	const dialog = page.getByTestId(TESTID.profileDialog);
	await expect(dialog.getByTestId(HOME_TESTID.profileFirst)).toHaveValue("Dev");
	await dialog.getByTestId(HOME_TESTID.profileCurrency).click();
	await page.getByRole("option", { name: /Local/ }).click();
	await page.screenshot({
		path: shotPath("home/profile-desktop.png"),
		animations: "disabled",
	});
	await dialog.getByTestId(HOME_TESTID.profileSave).click();
	await expect(dialog).toBeHidden();
	const prefs = await page.evaluate(async () => {
		const m = await import("/src/functions/prefs.functions.ts");
		return (await m.getUserPrefs()) as { displayCurrency?: string | null };
	});
	expect(prefs.displayCurrency).toBe("local");
	// Back to the trip's home currency.
	await page.evaluate(async () => {
		const m = await import("/src/functions/prefs.functions.ts");
		await m.setUserPrefs({ data: { displayCurrency: null } });
	});
});

/**
 * WP-Insights E1: opening hours and closed-day warnings (EXTENSIONS §4, QA
 * HRS-01…09), on a cloned demo trip (Sun 3 – Thu 7 Oct 2027) with the harness
 * mounted over the live workspace.
 */
import { expect, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectNoHorizontalOverflow } from "./_helpers/page";
import {
	callFn,
	card,
	daySection,
	INSIGHTS_TESTID as T,
	openHarness,
	refreshGraph,
	setSheetHours,
	updateItem,
} from "./insights-helpers";

test.use({ storageState: storageStateOf("dev") });

test("a closure shows on the card and the day, and a fix moves the visit (HRS-01, HRS-02)", async ({ page }, info) => {
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await openHarness(page, c);
	// Kiyomizu-dera is on Wed 6 Oct (Day 4); Itoya on Mon 4 Oct (Day 2).
	await setSheetHours(page, c.ids.nodes.kiyomizu as string, "Earliest tour 9:30–11:40 (reserve); closed Wed & Fri");
	await setSheetHours(page, c.ids.nodes.itoya as string, "10:00–20:00; closed Mon");
	await refreshGraph(page);

	const kiyo = card(page, c.ids.items.kiyomizu as string);
	await expect(kiyo.getByTestId(TESTID.hoursChip)).toHaveText("Closed Wed");
	await expect(kiyo.getByTestId(TESTID.hoursChip)).toHaveAttribute("data-severity", "warn");
	await expect(daySection(page, c.ids.days.d4 as string).getByTestId(TESTID.dayHoursBadge)).toHaveText(
		"Kiyomizu-dera closed Wed",
	);
	const itoyaChip = card(page, c.ids.items.itoya as string).getByTestId(TESTID.hoursChip);
	await expect(itoyaChip).toHaveText("Closed Mon");
	if (info.project.name === "chromium")
		await page.screenshot({ path: shotPath("insights/hours-plan-1440.png"), animations: "disabled" });

	// Tap the chip: the reason, the source line and the fixes.
	await itoyaChip.click();
	const pop = page.getByTestId(T.hoursPopover);
	await expect(pop).toContainText("Itoya Ginza is closed on Mondays.");
	await expect(pop.getByTestId(T.hoursSource)).toContainText("From the sheet");
	const move = pop.locator(`[data-testid=${T.hoursFix}][data-fix=move]`);
	await expect(move).toHaveText("Move to Sun 3 Oct");
	await expect(pop.locator(`[data-testid=${T.hoursFix}][data-fix=unschedule]`)).toBeVisible();
	await page.screenshot({ path: shotPath(`insights/hours-popover-${info.project.name}.png`), animations: "disabled" });
	await move.click();
	// Moved to Day 1, where Itoya is open: no chip; the toast offers Undo.
	await expect(daySection(page, c.ids.days.d1 as string).locator(`[data-item="${c.ids.items.itoya}"]`)).toBeVisible();
	await expect(card(page, c.ids.items.itoya as string).getByTestId(TESTID.hoursChip)).toHaveCount(0);
	await expect(page.getByText("Itoya Ginza moved to Sun 3 Oct")).toBeVisible();
	await page.getByRole("button", { name: "Undo" }).click();
	await expect(daySection(page, c.ids.days.d2 as string).locator(`[data-item="${c.ids.items.itoya}"]`)).toBeVisible();
	await expect(card(page, c.ids.items.itoya as string).getByTestId(TESTID.hoursChip)).toHaveText("Closed Mon");
	await expectNoHorizontalOverflow(page);
	expect(logs.messages).toEqual([]);
});

test("sheet hours → Confirm → the editor saves manual hours that win (HRS-03, HRS-09)", async ({ page }, info) => {
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const itoya = c.ids.nodes.itoya as string;
	await openHarness(page, c, { nodeId: itoya, panel: "inspector" });
	await setSheetHours(page, itoya, "10:30–19:00; closed 2nd Tue");
	await refreshGraph(page);

	const table = page.getByTestId(TESTID.hoursTable);
	await expect(table).toHaveAttribute("data-source", "sheet");
	await expect(table.getByTestId(T.hoursRules)).toContainText("Closed 2nd Tue");
	await expect(table.getByTestId(T.hoursSource)).toContainText("10:30–19:00; closed 2nd Tue");
	// Itoya is visited on a Monday: that row is bold.
	await expect(table.locator(`[data-testid=${T.hoursTableRow}][data-day="1"]`)).toHaveAttribute("data-visit", "true");
	await page.screenshot({ path: shotPath(`insights/hours-table-${info.project.name}.png`), animations: "disabled" });

	await table.getByTestId(T.hoursTableConfirm).click();
	const dialog = page.getByTestId(TESTID.hoursEditorDialog);
	await expect(dialog.getByTestId(T.hoursEditorBanner)).toContainText("Parsed from the sheet — confirm or fix");
	await expect(dialog.getByTestId(T.hoursEditorNth)).toHaveCount(1);
	// Change Monday to close later, then save.
	const mon = dialog.locator(`[data-testid=${T.hoursEditorDay}][data-day="1"]`);
	await expect(mon.getByTestId(T.hoursEditorOpen)).toHaveValue("10:30");
	await mon.getByTestId(T.hoursEditorClose).fill("2030");
	await dialog.getByTestId(T.hoursEditorLastEntry).fill("30");
	await page.screenshot({ path: shotPath(`insights/hours-editor-${info.project.name}.png`), animations: "disabled" });
	await dialog.getByTestId(T.hoursEditorSave).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("Hours saved for Itoya Ginza")).toBeVisible();

	await expect(table).toHaveAttribute("data-source", "manual");
	await expect(table.locator(`[data-testid=${T.hoursTableRow}][data-day="1"]`)).toContainText("10:30–20:30");
	await expect(table.getByTestId(T.hoursRules)).toContainText("Closed 2nd Tue · Last entry 30 min before close");
	await expect(table.getByTestId(T.hoursSource)).toContainText("Manual");

	// Reopen: the rule round-tripped.
	await table.getByTestId(T.hoursTableEdit).click();
	await expect(dialog.getByTestId(T.hoursEditorBanner)).toHaveCount(0);
	const nth = dialog.getByTestId(T.hoursEditorNth);
	await expect(nth).toContainText("2nd");
	await expect(nth).toContainText("Tue");
	await expect(dialog.getByTestId(T.hoursEditorLastEntry)).toHaveValue("30");
	await page.keyboard.press("Escape");
	expect(logs.messages).toEqual([]);
});

test("a viewer sees the chips but can't edit (HRS-08)", async ({ page, browser }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const c = await cloneFixtureTrip(page.request);
	await openHarness(page, c);
	await setSheetHours(page, c.ids.nodes.kiyomizu as string, "closed Wed");

	// An anonymous browser (not the file's signed-in storage state).
	const guestCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const guest = await guestCtx.newPage();
	await guest.goto(`/join#t=${c.shareTokens.viewer}`);
	await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 20_000 });
	await openHarness(guest, c, { nodeId: c.ids.nodes.kiyomizu as string });
	const chip = card(guest, c.ids.items.kiyomizu as string).getByTestId(TESTID.hoursChip);
	await expect(chip).toHaveText("Closed Wed");
	await chip.click();
	// Viewers get the reason but no Edit / Confirm at all (QA COLLAB-5).
	await expect(guest.getByTestId(T.hoursPopover)).toContainText("closed on Wednesdays");
	await expect(guest.getByTestId(T.hoursEditHours)).toHaveCount(0);
	await guest.keyboard.press("Escape");
	await expect(guest.getByTestId(TESTID.hoursTable)).toBeVisible();
	await expect(guest.getByTestId(T.hoursTableConfirm)).toHaveCount(0);
	await guestCtx.close();
});

test("a holiday in trip settings switches a place to its holiday hours (HRS-06)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await openHarness(page, c);
	// Itoya on Mon 4 Oct, 18:30–19:30: fine on a Monday, too late on a holiday.
	await setSheetHours(page, c.ids.nodes.itoya as string, "Mon–Sat 10:00–20:00; Sun/hol to 19:00");
	await updateItem(page, c.ids.items.itoya as string, { pinnedStart: "18:30" });
	// A setting the holiday save must leave alone (it sends `{ holidays }` only).
	const cur = await callFn(page, "/src/functions/trips.functions.ts", "updateTrip", {
		tripId: c.tripId,
		settings: { currency: "JPY", dayCapacityMin: 600 },
	});
	if (!cur.ok) throw new Error(cur.error);
	await refreshGraph(page);
	const chip = card(page, c.ids.items.itoya as string).getByTestId(TESTID.hoursChip);
	await expect(chip.and(page.locator("[data-severity=warn]"))).toHaveCount(0);

	const settings = page.getByTestId("harness-settings");
	await settings.getByTestId(T.holidayAdd).click();
	const row = settings.getByTestId(T.holidayRow).last();
	await row.getByLabel("Holiday date").click();
	await page.getByRole("button", { name: /October 4th, 2027/ }).click();
	await expect(row.getByLabel("Holiday date")).toHaveText("Mon 4 Oct 2027");
	await row.getByLabel("Holiday name").fill("Test Day");
	await settings.getByTestId(T.holidaySave).click();
	await expect(page.getByText("1 holiday saved")).toBeVisible();
	await expect(chip).toHaveText("Closes 19:00 · 30m short");
	// The rest of the settings survive the save.
	const settingsNow = await page.evaluate(
		() => (window as unknown as { __yonder?: { graph: { trip: { settings: Record<string, unknown> } } } }).__yonder?.graph.trip.settings,
	);
	expect(settingsNow?.holidays).toEqual([{ date: "2027-10-04", name: "Test Day" }]);
	expect([settingsNow?.currency, settingsNow?.dayCapacityMin]).toEqual(["JPY", 600]);
	expect(logs.messages).toEqual([]);
});

/**
 * WP-Insights E2: the date-shift what-if (EXTENSIONS §5, QA SHIFT-01…06) on
 * a cloned demo trip (Sun 3 – Thu 7 Oct 2027), harness mounted.
 */
import { expect, type Page, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { collectConsole } from "./_helpers/page";
import {
	callFn,
	card,
	INSIGHTS_TESTID as T,
	openHarness,
	refreshGraph,
	setSheetHours,
	updateItem,
} from "./insights-helpers";

test.use({ storageState: storageStateOf("dev") });

const section = (page: Page, id: string) =>
	page.locator(`[data-testid=${T.impactSection}][data-section=${id}]`);

/** Books the flight (a ref) and reserves the Fuji Excursion (fixed times + a booking). */
async function bookThings(page: Page, c: FixtureClone) {
	const flight = await page.evaluate((legId) => {
		const w = window as unknown as {
			__yonder?: { graph: { legs: { id: string; fromItemId: string; toItemId: string; details: { flight: Record<string, unknown> } }[] } };
		};
		return w.__yonder?.graph.legs.find((l) => l.id === legId);
	}, c.ids.legs.flight);
	if (!flight) throw new Error("no flight leg");
	const r1 = await callFn(page, "/src/functions/legs.functions.ts", "setLeg", {
		target: { kind: "pair", fromItemId: flight.fromItemId, toItemId: flight.toItemId },
		patch: { details: { kind: "flight", flight: { ...flight.details.flight, bookingRef: "ZK4P7Q" } } },
	});
	if (!r1.ok) throw new Error(r1.error);
	const r2 = await callFn(page, "/src/functions/legs.functions.ts", "setLeg", {
		target: { kind: "pair", fromItemId: c.ids.items.itoya, toItemId: c.ids.items.dropBags },
		patch: {
			mode: "transit",
			details: {
				kind: "transit",
				route: { id: "fuji-7", source: "manual", durationMin: 116, walkMin: 0, transfers: 0, segments: [], label: "Fuji Excursion 7" },
				fixed: { departLocal: "2027-10-05T08:30", arriveLocal: "2027-10-05T10:26", fromTz: "Asia/Tokyo", toTz: "Asia/Tokyo", accessMin: 10, egressMin: 0 },
				booking: { ref: "E7K2Q9", seats: [] },
			},
		},
	});
	if (!r2.ok) throw new Error(r2.error);
	// A 09:30 tour, pinned but not booked.
	await updateItem(page, c.ids.items.hands as string, { pinnedStart: "09:30" });
}

test("+1 day lists what needs rebooking and what's only timed; Mark booked moves it (SHIFT-01, SHIFT-05)", async ({ page }, info) => {
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await openHarness(page, c);
	await bookThings(page, c);
	await refreshGraph(page);

	await page.getByTestId("harness-try-dates").click();
	const dialog = page.getByTestId(TESTID.shiftTripDialog);
	await expect(dialog.getByTestId(T.shiftSummary)).toContainText("Day 1 is Sun 3 Oct");
	await dialog.getByTestId(T.shiftPlus).click();
	await expect(dialog.getByTestId(T.shiftDelta)).toHaveText("+1 day");
	await expect(dialog.getByTestId(T.shiftSummary)).toContainText("Day 1 becomes Mon 4 Oct");

	const book = section(page, "bookings");
	await expect(book).toContainText("Fuji Excursion 7");
	await expect(book).toContainText("5 Oct → 6 Oct");
	await expect(book).toContainText("ref E7K2Q9");
	await expect(book).toContainText("Flight KE 724");
	await expect(book).toContainText("ref ZK4P7Q");
	const timed = section(page, "timed");
	await expect(timed).toContainText("Hands Shibuya");
	await expect(timed).toContainText("Shibuya Sky");
	await expect(section(page, "stays")).toContainText("Kawaguchiko Ryokan");
	await expect(dialog.getByTestId(T.shiftApply)).toHaveText("Shift by +1 day");
	await page.screenshot({ path: shotPath(`insights/shift-dialog-${info.project.name}.png`), animations: "disabled" });

	// Mark booked: the pinned tour moves to Needs rebooking.
	await timed.locator(`[data-testid=${T.impactRow}]`, { hasText: "Hands Shibuya" }).getByTestId(T.markBooked).click();
	await expect(book).toContainText("Hands Shibuya");
	await expect(timed).not.toContainText("Hands Shibuya");
	// It's stored (`items.fixed_date`): a fresh graph still has it booked.
	await refreshGraph(page);
	await expect
		.poll(() =>
			page.evaluate(
				(id) =>
					(window as unknown as { __yonder?: { graph: { items: { id: string; fixedDate?: boolean }[] } } }).__yonder?.graph.items.find(
						(i) => i.id === id,
					)?.fixedDate,
				c.ids.items.hands as string,
			),
		)
		.toBe(true);
	await expect(book).toContainText("Hands Shibuya");
	await page.keyboard.press("Escape");
	expect(logs.messages).toEqual([]);
});

test("new closures show before committing; the draft survives; apply, then Undo (SHIFT-02, SHIFT-06)", async ({ page }, info) => {
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await openHarness(page, c);
	// Itoya is on Mon 4 Oct; it's closed on Tuesdays.
	await setSheetHours(page, c.ids.nodes.itoya as string, "10:00–20:00; closed Tue");
	await refreshGraph(page);
	const itoya = card(page, c.ids.items.itoya as string);
	await expect(itoya.getByTestId(TESTID.hoursChip)).toHaveCount(0);

	await page.getByTestId("harness-try-dates").click();
	const dialog = page.getByTestId(TESTID.shiftTripDialog);
	await dialog.getByTestId(T.shiftPlus).click();
	const closures = section(page, "closures");
	await expect(closures).toContainText("Itoya Ginza");
	await expect(closures).toContainText("Closed Tue");

	// A row selects its item and closes the dialog; the draft stays (chip + ring).
	await closures.locator(`[data-testid=${T.impactRow}]`, { hasText: "Itoya Ginza" }).locator("button").first().click();
	await expect(dialog).toBeHidden();
	// The merged TopBar mounts the chip too; the harness copy is the one under test.
	const chip = page.getByTestId("insights-harness").getByTestId(TESTID.whatIfChip);
	await expect(chip).toContainText("What-if +1 day");
	await expect(itoya).toHaveAttribute("data-ring", "true");
	await expect(page.getByTestId("harness-inspector")).toContainText("Itoya Ginza");
	await page.screenshot({ path: shotPath(`insights/whatif-chip-${info.project.name}.png`), animations: "disabled" });

	// Review brings back the same draft; apply.
	await chip.getByTestId(T.whatIfReview).click();
	await expect(dialog.getByTestId(T.shiftDelta)).toHaveText("+1 day");
	await dialog.getByTestId(T.shiftApply).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("Trip shifted +1 day")).toBeVisible();
	await expect(chip).toHaveCount(0);
	// The same chip the preview promised.
	await expect(itoya.getByTestId(TESTID.hoursChip)).toHaveText("Closed Tue");
	await expect(page.locator("[data-testid=harness-day] h3").first()).toHaveText("Mon 4 Oct");

	await page.getByRole("button", { name: "Undo" }).click();
	await expect(page.locator("[data-testid=harness-day] h3").first()).toHaveText("Sun 3 Oct");
	await expect(itoya.getByTestId(TESTID.hoursChip)).toHaveCount(0);
	expect(logs.messages).toEqual([]);
});

test("a concurrent edit refuses the shift until it's reviewed again (SHIFT-03)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const logs = collectConsole(page, [/status of 409/]);
	const c = await cloneFixtureTrip(page.request);
	await openHarness(page, c);
	await page.getByTestId("harness-try-dates").click();
	const dialog = page.getByTestId(TESTID.shiftTripDialog);
	await dialog.getByTestId(T.shiftPlus).click();
	// Someone edits meanwhile (this tab never hears its own change, so the version it holds is stale).
	await updateItem(page, c.ids.items.loft as string, { durationMin: 50 });
	await dialog.getByTestId(T.shiftApply).click();
	await expect(dialog.getByTestId(T.shiftConflict)).toBeVisible();
	await expect(dialog).toBeVisible();
	// The graph refetched: shifting again works.
	await dialog.getByTestId(T.shiftApply).click();
	await expect(dialog).toBeHidden();
	await expect(page.locator("[data-testid=harness-day] h3").first()).toHaveText("Mon 4 Oct");
	expect(logs.messages).toEqual([]);
});

test("an edit this tab hears while the dialog is open still refuses the shift (SHIFT-03, live refresh)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const logs = collectConsole(page, [/status of 409/]);
	const c = await cloneFixtureTrip(page.request);
	await openHarness(page, c);
	const version = () =>
		page.evaluate(() => (window as unknown as { __yonder?: { graph: { trip: { version: number } } } }).__yonder?.graph.trip.version ?? 0);
	await page.getByTestId("harness-try-dates").click();
	const dialog = page.getByTestId(TESTID.shiftTripDialog);
	await dialog.getByTestId(T.shiftPlus).click();
	const reviewed = await version();
	// Someone edits, and the graph under the open dialog refreshes (as a live event does).
	await updateItem(page, c.ids.items.loft as string, { durationMin: 50 });
	await refreshGraph(page);
	await expect.poll(version).toBeGreaterThan(reviewed);
	await dialog.getByTestId(T.shiftApply).click();
	await expect(dialog.getByTestId(T.shiftConflict)).toBeVisible();
	await expect(dialog).toBeVisible();
	await expect(page.locator("[data-testid=harness-day] h3").first()).toHaveText("Sun 3 Oct");
	// Reviewed again: now it applies.
	await dialog.getByTestId(T.shiftApply).click();
	await expect(dialog).toBeHidden();
	await expect(page.locator("[data-testid=harness-day] h3").first()).toHaveText("Mon 4 Oct");
	expect(logs.messages).toEqual([]);
});

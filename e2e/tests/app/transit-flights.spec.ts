/**
 * WP-Transit flights and modes (SPEC §18.3; QA FLT-01…05, TR-01, TR-10):
 * - full flight details: airline and airport look-ups, "nh9" → "NH 9", local
 *   times per airport, seats per member, cabin, ref, baggage, aircraft, cost,
 *   points — shown in full after a reload;
 * - inline validation: "Not a flight number", "Unknown airport", "Arrival is
 *   before departure", and nothing is saved (FB-18: the number is optional);
 * - modes per leg: walk with a typed time, transit, other (taxi) — the leg
 *   counts what was entered.
 */
import { expect, type Page, test } from "@playwright/test";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

type Leg = {
	fromItemId: string | null;
	toItemId: string | null;
	mode: string | null;
	durationMin: number | null;
	depAt: string | null;
	arrAt: string | null;
	assigneeIds: string[];
	details: { kind?: string; otherKind?: string; flight?: Record<string, unknown> };
};
type YonderWindow = { __yonder?: { graph: { legs: Leg[] } } };

const legOf = (page: Page, from: string, to: string) =>
	page.evaluate(
		([f, t]) =>
			(window as unknown as YonderWindow).__yonder?.graph.legs.find(
				(l) => l.fromItemId === f && l.toItemId === t,
			) ?? null,
		[from, to] as const,
	);

async function pickSuggestion(page: Page, input: string, typed: string, option: string, text: RegExp | string) {
	const field = page.getByTestId(input);
	await field.fill(typed);
	await page.getByTestId(option).filter({ hasText: text }).first().click();
}

test("full flight details are entered, normalised and kept after a reload", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?sel=l.${I.kix}.${I.icn}`);
	await expectLive(page);
	const overview = page.getByTestId(TESTID.legOverview);
	await overview.getByRole("button", { name: "Edit flight" }).click();
	const form = overview.getByTestId(T.flightForm);
	await pickSuggestion(page, T.flightAirline, "ANA", T.airlineOption, "ANA");
	await form.getByTestId(T.flightNumber).fill("nh9");
	await form.getByTestId(T.flightNumber).blur();
	await expect(form.getByTestId(T.flightNumber)).toHaveValue("NH 9");
	await pickSuggestion(page, T.flightFrom, "jfk", T.airportOption, "JFK");
	await pickSuggestion(page, T.flightTo, "hnd", T.airportOption, "HND");
	await form.getByTestId(T.flightDepDate).fill("2027-10-07");
	await form.getByTestId(T.flightDepTime).fill("02:00");
	await form.getByTestId(T.flightArrDate).fill("2027-10-08");
	await form.getByTestId(T.flightArrTime).fill("05:00");
	// JFK is EDT, HND is JST: 14 h in the air.
	await expect(form.getByTestId(T.flightDuration)).toHaveText("14h flight");
	await form.getByTestId(T.flightFromTerminal).fill("7");
	await form.getByTestId(T.flightToTerminal).fill("3");
	await form.getByTestId(T.flightCabin).click();
	await page.getByRole("option", { name: "Business" }).click();
	await form.getByTestId(T.flightAircraft).fill("Boeing 777-300ER");
	await form.locator(`[data-testid=${T.flightSeat}][data-member="${c.members.owner}"]`).fill("8d");
	await form.locator(`[data-testid=${T.flightSeat}][data-member="${c.members.audrey}"]`).fill("8g");
	await form.getByTestId(T.flightRef).fill("zk4p7q");
	await form.getByTestId(T.flightBaggage).fill("2 × 23 kg");
	await form.getByTestId(T.flightPointsProgram).fill("Aeroplan");
	await form.getByTestId(T.flightPointsAmount).fill("85000");
	await page.screenshot({ path: shotPath("transit/flight-form.png"), animations: "disabled" });
	await form.getByTestId(T.flightSave).click();

	const summary = overview.getByTestId(T.flightSummary);
	await expect(summary).toContainText("ANA NH 9");
	await expect(summary).toContainText("JFK → HND");
	await expect(summary).toContainText("Business");
	await expect(summary).toContainText("14h");
	await expect(summary).toContainText("ZK4P7Q");
	await expect(summary).toContainText("8D");
	await expect(summary).toContainText("Boeing 777-300ER");
	await expect.poll(async () => (await legOf(page, I.kix, I.icn))?.depAt).toBe("2027-10-07T06:00:00.000Z");
	const leg = await legOf(page, I.kix, I.icn);
	expect(leg?.arrAt).toBe("2027-10-07T20:00:00.000Z");
	expect(leg?.details.flight?.flightNumber).toBe("NH9");
	await page.screenshot({ path: shotPath("transit/flight-summary.png"), animations: "disabled" });

	await page.reload();
	await expectLive(page);
	await expect(page.getByTestId(T.flightSummary)).toContainText("ANA NH 9");
	await expect(page.getByTestId(T.flightSummary)).toContainText("Aeroplan");
	expect(logs.messages).toEqual([]);
});

test("flight validation refuses a bad form inline and saves nothing", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?sel=l.${I.kix}.${I.icn}`);
	await expectLive(page);
	const overview = page.getByTestId(TESTID.legOverview);
	await overview.getByRole("button", { name: "Edit flight" }).click();
	const form = overview.getByTestId(T.flightForm);
	// FB-18: the number may be left out, but not written wrong.
	await form.getByTestId(T.flightNumber).fill("hello");
	await form.getByTestId(T.flightFrom).fill("JFKK");
	await form.getByTestId(T.flightArrTime).fill("11:00");
	await form.getByTestId(T.flightSave).click();
	const errors = form.getByTestId(T.flightError);
	await expect(errors.filter({ hasText: "Not a flight number" })).toHaveCount(1);
	await expect(errors.filter({ hasText: "Unknown airport" })).toHaveCount(1);
	// A valid KIX again, arrival before departure in instants.
	await form.getByTestId(T.flightFrom).fill("KIX");
	await form.getByTestId(T.flightNumber).fill("KE 724");
	await form.getByTestId(T.flightArrTime).fill("12:00");
	await form.getByTestId(T.flightSave).click();
	await expect(errors.filter({ hasText: "Arrival is before departure" })).toHaveCount(1);
	const leg = await legOf(page, I.kix, I.icn);
	expect(leg?.arrAt).toBe("2027-10-07T06:05:00.000Z");
});

test("modes per leg: walk with a typed time, then transit, then taxi", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?sel=l.${I.sensoji}.${I.knives}`);
	await expectLive(page);
	const overview = page.getByTestId(TESTID.legOverview);
	const mode = (m: string) => overview.locator(`[data-testid=${T.modeOption}][data-mode=${m}]`);

	await mode("walk").click();
	await expect(overview.getByTestId(T.walkPanel)).toBeVisible();
	await overview.getByTestId(T.walkPanel).getByRole("button", { name: /^\d/ }).first().click();
	await page.getByRole("textbox", { name: "Duration" }).fill("20");
	await page.getByRole("textbox", { name: "Duration" }).press("Enter");
	await expect.poll(async () => (await legOf(page, I.sensoji, I.knives))?.durationMin).toBe(20);
	expect((await legOf(page, I.sensoji, I.knives))?.mode).toBe("walk");
	await expect(overview.getByTestId(T.walkReset)).toBeVisible();

	await mode("transit").click();
	await expect(overview.getByTestId(T.transitPanel)).toBeVisible();
	await expect.poll(async () => (await legOf(page, I.sensoji, I.knives))?.mode).toBe("transit");

	await mode("other").click();
	await overview.locator(`[data-testid=${T.otherKind}][data-kind=taxi]`).click();
	await overview.getByTestId(T.otherMinutes).getByRole("button").click();
	await page.getByRole("textbox", { name: "Duration" }).fill("15");
	await page.getByRole("textbox", { name: "Duration" }).press("Enter");
	await expect.poll(async () => (await legOf(page, I.sensoji, I.knives))?.durationMin).toBe(15);
	const leg = await legOf(page, I.sensoji, I.knives);
	expect(leg?.mode).toBe("other");
	expect(leg?.details.otherKind).toBe("taxi");
	await page.screenshot({ path: shotPath("transit/other-taxi.png"), animations: "disabled" });
	expect(logs.messages).toEqual([]);
});

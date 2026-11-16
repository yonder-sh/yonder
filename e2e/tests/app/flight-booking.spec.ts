/**
 * One booking, one price: a round trip with a connection is added in one go
 * (Add flight → Round trip), with its ref and price asked once. Every flight
 * of the booking shows the same price as the whole booking's, a change on one
 * reaches the others, and "Add as expense" makes a single expense, tied to the
 * booking, that every one of its flights then opens, whatever the price becomes.
 */
import { expect, type Page, test } from "@playwright/test";
import { MONEY_TESTID as M } from "../../../src/features/money/testids";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

type Flight = {
	bookingId?: string;
	bookingRef?: string;
	cost?: { amount: number; currency: string };
	from: { iata: string };
	to: { iata: string };
};
type Leg = { id: string; fromItemId: string | null; toItemId: string | null; details: { flight?: Flight } };
type YonderWindow = { __yonder?: { graph: { legs: Leg[] } } };

/** The booked flights (those with a booking id), in the order they were added. */
const booked = (page: Page) =>
	page.evaluate(() =>
		((window as unknown as YonderWindow).__yonder?.graph.legs ?? []).filter((l) => l.details.flight?.bookingId),
	);

const shot = (page: Page, name: string) => page.screenshot({ path: shotPath(`flight-booking/${name}.png`) });

test("a round trip with a connection is one booking with one price", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	test.setTimeout(120_000);
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?days=2027-10-04`);
	await expectLive(page);
	await page.getByTestId(PLAN_TESTID.addBetween).last().click();
	await page.getByRole("menuitem", { name: /Flight/ }).click();
	const dlg = page.getByTestId(TESTID.addFlightDialog);
	await expect(dlg).toBeVisible();
	await page.waitForTimeout(400); // the dialog's open animation and autofocus

	const pick = async (
		seg: ReturnType<Page["getByTestId"]>,
		field: string,
		typed: string,
	) => {
		const input = seg.getByTestId(field);
		await input.click();
		await input.fill("");
		await input.pressSequentially(typed, { delay: 30 });
		const o = page.getByTestId(T.airportOption).filter({ hasText: typed }).first();
		await expect(o).toBeVisible();
		await page.waitForTimeout(250); // the list's open animation
		await o.click();
	};

	// The way out: HND → KIX → ICN late on Mon 4 Oct.
	const out = (n: number) => dlg.getByTestId(T.flightSegment).nth(n);
	await pick(out(0), T.flightFrom, "HND");
	await pick(out(0), T.flightTo, "KIX");
	await out(0).getByTestId(T.flightDepDate).fill("2027-10-04");
	await out(0).getByTestId(T.flightDepTime).fill("20:00");
	await out(0).getByTestId(T.flightArrTime).fill("21:15");
	await dlg.getByTestId(T.flightAddConnection).click();
	await pick(out(1), T.flightTo, "ICN");
	await out(1).getByTestId(T.flightDepTime).fill("22:00");
	await out(1).getByTestId(T.flightArrTime).fill("23:50");

	// The way back starts where the way out ends, and ends where it began.
	await dlg.getByTestId(T.flightTripKind).getByText("Round trip").click();
	const back = dlg.getByTestId(T.flightReturn);
	await expect(back.getByTestId(T.flightFrom)).toHaveValue("ICN");
	await expect(back.getByTestId(T.flightTo)).toHaveValue("HND");
	await back.getByTestId(T.flightDepDate).fill("2027-10-06");

	// One ref and one price for all of it.
	const booking = dlg.getByTestId(T.flightBooking);
	await expect(booking).toContainText("One ref and one price for all 3 flights.");
	await expect(dlg.getByTestId(T.flightCostAmount)).toHaveCount(1);
	await booking.getByTestId(T.flightRef).fill("zk4p7q");
	await booking.getByTestId(T.flightCostAmount).fill("412.50");
	await booking.scrollIntoViewIfNeeded();
	await shot(page, "01-round-trip-form");
	await dlg.getByTestId(T.flightSave).click();
	await expect(dlg).toBeHidden({ timeout: 15_000 });

	await expect.poll(async () => (await booked(page)).length, { timeout: 15_000 }).toBe(3);
	let legs = await booked(page);
	expect(new Set(legs.map((l) => l.details.flight?.bookingId)).size).toBe(1);
	for (const l of legs) {
		expect(l.details.flight?.bookingRef).toBe("ZK4P7Q");
		expect(l.details.flight?.cost).toEqual({ amount: 412.5, currency: "USD" });
	}
	const legTo = (iata: string) => legs.find((l) => l.details.flight?.to.iata === iata) as Leg;
	const home = legTo("HND");
	const first = legTo("KIX");

	// The way back shows the booking's price, as the whole booking's.
	await page.goto(`/t/${c.slug}?days=2027-10-06&sel=l.${home.fromItemId}.${home.toItemId}`);
	await expectLive(page);
	const lo = page.getByTestId(TESTID.legOverview);
	const summary = lo.getByTestId(T.flightSummary);
	await expect(summary).toContainText("412.50");
	await expect(summary.getByTestId(T.flightBookingScope)).toHaveText(/whole booking, 3 flights/);
	await shot(page, "02-return-flight");

	// A new price on one flight is the booking's new price.
	await lo.getByRole("button", { name: "Edit flight" }).click();
	const form = lo.getByTestId(T.flightForm);
	await expect(form.getByTestId(T.flightBookingNote)).toHaveText(
		"Booked with HND → KIX and KIX → ICN: the ref, price, points, and fees below are for all 3 flights.",
	);
	await shot(page, "03-edit-booked-flight");
	await form.getByTestId(T.flightCostAmount).fill("500");
	await form.getByTestId(T.flightSave).click();
	await expect(summary).toContainText("500", { timeout: 15_000 });
	await expect
		.poll(async () => (await booked(page)).map((l) => l.details.flight?.cost?.amount), { timeout: 15_000 })
		.toEqual([500, 500, 500]);

	// One expense for the booking, from any of its flights.
	await lo.getByTestId(T.legMenu).click();
	await page.getByRole("menuitem", { name: "Add as expense" }).click();
	const exp = page.getByTestId(TESTID.addExpenseDialog);
	await expect(exp).toBeVisible();
	await expect(exp.getByTestId(M.title)).toHaveValue("Flights HND ↔ ICN");
	await expect(exp.getByTestId(M.amount)).toHaveValue(/500/);
	await shot(page, "04-booking-expense");
	await exp.getByTestId(M.save).click();
	await expect(exp).toBeHidden({ timeout: 15_000 });

	// Its other flights open that expense instead of adding another.
	legs = await booked(page);
	await page.goto(`/t/${c.slug}?days=2027-10-04&sel=l.${first.fromItemId}.${first.toItemId}`);
	await expectLive(page);
	await lo.getByTestId(T.legMenu).click();
	await expect(page.getByTestId(T.legViewExpense)).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole("menuitem", { name: "Add as expense" })).toHaveCount(0);
	await page.getByTestId(T.legViewExpense).click();
	await expect(exp).toBeVisible();
	await expect(exp.getByTestId(M.title)).toHaveValue("Flights HND ↔ ICN");
	await page.keyboard.press("Escape");
	await expect(exp).toBeHidden();

	// The expense is tied to the booking, not to its amount: a new price on the
	// booking still finds it, and offers no second one.
	await lo.getByRole("button", { name: "Edit flight" }).click();
	await form.getByTestId(T.flightCostAmount).fill("620");
	await form.getByTestId(T.flightSave).click();
	await expect(summary).toContainText("620", { timeout: 15_000 });
	await lo.getByTestId(T.legMenu).click();
	await expect(page.getByTestId(T.legViewExpense)).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole("menuitem", { name: "Add as expense" })).toHaveCount(0);
	expect(logs.messages).toEqual([]);
});

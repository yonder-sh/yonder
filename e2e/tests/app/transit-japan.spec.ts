/**
 * WP-Transit, Japan (ADDENDUM §5; JAPAN_TRANSIT; SPEC §18.3; QA TR-03/07/11/12):
 * - a Japan transit leg shows 2–3 rail estimates from the N02 network,
 *   fastest first and chosen, each with "Open in Google Maps", the "no
 *   timetables" note and the MLIT attribution;
 * - a custom route works anywhere: a Shinkansen route (2h15) is saved, edited
 *   and deleted; N02 station autocomplete fills the minutes and the track;
 * - a reserved departure (Fuji Excursion 7, 08:30 → 10:26) pins the leg's
 *   times with its booking, and a link guest sees the booking masked.
 */
import { expect, type Page, test } from "@playwright/test";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { APP_URL, shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

type Leg = {
	id: string;
	fromItemId: string | null;
	toItemId: string | null;
	mode: string | null;
	durationMin: number | null;
	source: string;
	depAt: string | null;
	details: {
		kind?: string;
		chosenId?: string;
		route?: { source: string; segments: { geometry?: unknown; lineName?: string }[] };
		booking?: { ref?: string };
	};
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

async function openLeg(page: Page, slug: string, from: string, to: string) {
	await page.goto(`/t/${slug}?sel=l.${from}.${to}`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.legOverview)).toBeVisible();
}

async function chooseMode(page: Page, mode: string) {
	// Across a night with no stay the pair is an overnight connector (SPEC
	// §9.2): the editor offers "Add transit…" first.
	const overnight = page.getByTestId(T.overnightAddTransit);
	if (await overnight.isVisible().catch(() => false)) await overnight.click();
	await page
		.getByTestId(TESTID.legOverview)
		.locator(`[data-testid=${T.modeOption}][data-mode=${mode}]`)
		.click();
}

test("a Japan transit leg shows rail estimates with Open in Google Maps and the N02 attribution", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector; mobile below");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await openLeg(page, c.slug, I.loft, I.meiji);
	await chooseMode(page, "transit");
	const panel = page.getByTestId(T.transitPanel);
	const options = panel.getByTestId(T.transitOption);
	await expect(options.first()).toBeVisible({ timeout: 20_000 });
	const n = await options.count();
	expect(n).toBeGreaterThanOrEqual(2);
	expect(n).toBeLessThanOrEqual(3);
	// Every option: estimate, with its own Google Maps link — transit
	// directions for a ride, walking ones for "walk the whole way" (FB-03).
	for (let i = 0; i < n; i++) {
		const o = options.nth(i);
		await expect(o).toHaveAttribute("data-source", "estimate");
		const mode =
			(await o.getAttribute("data-walk-only")) === "true"
				? "walking"
				: "transit";
		await expect(o.getByTestId(T.googleMapsLink)).toHaveAttribute(
			"href",
			new RegExp(
				`^https://www\\.google\\.com/maps/dir/\\?api=1&origin=[\\d.]+,[\\d.]+&destination=[\\d.]+,[\\d.]+&travelmode=${mode}$`,
			),
		);
	}
	// Fastest first, and chosen.
	await expect(options.first().getByTestId(T.fastestBadge)).toBeVisible();
	await expect(options.first()).toHaveAttribute("data-chosen", "true");
	await expect(panel.getByTestId(T.japanNote)).toContainText(
		"Estimated from the rail network — no timetables.",
	);
	await expect(panel.getByTestId(T.japanNote).getByTestId(T.googleMapsLink)).toContainText(
		"Check times in Google Maps",
	);
	await expect(panel.getByTestId(T.railAttribution)).toContainText("国土数値情報");
	await expect(panel.getByTestId(T.railAttribution)).toContainText("CC BY 4.0");
	await expect
		.poll(async () => (await legOf(page, I.loft, I.meiji))?.source)
		.toBe("estimate");
	const leg = await legOf(page, I.loft, I.meiji);
	expect(leg?.mode).toBe("transit");
	expect(leg?.details.route?.source).toBe("estimate");
	await expectNoHorizontalOverflow(page);
	await page.screenshot({
		path: shotPath(`transit/japan-estimate-${info.project.name}.png`),
		animations: "disabled",
	});
	expect(logs.messages).toEqual([]);
});

test("a custom Shinkansen route (2h15) can be saved, edited and deleted", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await openLeg(page, c.slug, I.sky, I.sensoji);
	await chooseMode(page, "transit");
	const panel = page.getByTestId(T.transitPanel);
	await panel.getByTestId(T.customRouteAdd).click();
	const builder = panel.getByTestId(T.customRoute);
	await builder.getByTestId(T.customRouteLabel).fill("Nozomi 21");
	await builder.getByTestId(T.customRouteStepMode).click();
	await page.getByRole("option", { name: "Shinkansen / high-speed" }).click();
	await builder.getByTestId(T.customRouteStepLine).fill("Tokaido Shinkansen");
	await builder.getByTestId(T.customRouteStepFrom).fill("Tokyo");
	await builder.getByTestId(T.customRouteStepTo).fill("Kyoto");
	await builder.getByTestId(T.customRouteStepMinutes).fill("135");
	await builder.getByTestId(T.customRouteSave).click();
	const manual = panel.locator(`[data-testid=${T.transitOption}][data-source=manual]`);
	await expect(manual).toHaveCount(1);
	await expect(manual).toHaveAttribute("data-chosen", "true");
	await expect.poll(async () => (await legOf(page, I.sky, I.sensoji))?.durationMin).toBe(135);
	expect((await legOf(page, I.sky, I.sensoji))?.source).toBe("manual");

	// Edit: 2h20.
	await manual.getByTestId(T.transitOptionEdit).click();
	await panel.getByTestId(T.customRoute).getByTestId(T.customRouteStepMinutes).fill("140");
	await panel.getByTestId(T.customRouteSave).click();
	await expect.poll(async () => (await legOf(page, I.sky, I.sensoji))?.durationMin).toBe(140);
	await page.screenshot({ path: shotPath("transit/custom-route.png"), animations: "disabled" });

	// Delete: the manual card goes; the leg falls back to an estimate.
	await manual.getByTestId(T.transitOptionDelete).click();
	await expect(manual).toHaveCount(0);
	await expect
		.poll(async () => (await legOf(page, I.sky, I.sensoji))?.details.route?.source ?? "none")
		.not.toBe("manual");
	expect(logs.messages).toEqual([]);
});

test("N02 station autocomplete fills the ride's minutes, line and track", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await openLeg(page, c.slug, I.itoya, I.dropBags);
	await chooseMode(page, "transit");
	const panel = page.getByTestId(T.transitPanel);
	await panel.getByTestId(T.customRouteAdd).click();
	const builder = panel.getByTestId(T.customRoute);
	await builder.getByTestId(T.customRouteStepFrom).fill("Shinjuku");
	await page.getByTestId(T.stationSuggestion).filter({ hasText: "新宿" }).first().click();
	await builder.getByTestId(T.customRouteStepTo).fill("河口湖");
	await page.getByTestId(T.stationSuggestion).filter({ hasText: "河口湖" }).first().click();
	await expect
		.poll(async () => Number(await builder.getByTestId(T.customRouteStepMinutes).inputValue()))
		.toBeGreaterThan(90);
	await expect(builder.getByTestId(T.customRouteStepLine)).not.toHaveValue("");
	await page.screenshot({ path: shotPath("transit/custom-route-n02.png"), animations: "disabled" });
	await builder.getByTestId(T.customRouteSave).click();
	await expect
		.poll(async () => {
			const leg = await legOf(page, I.itoya, I.dropBags);
			return Boolean(leg?.details.route?.segments[0]?.geometry);
		})
		.toBe(true);
});

test("a reserved departure pins the leg; a link guest sees the booking masked", async ({ page, browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await openLeg(page, c.slug, I.itoya, I.dropBags);
	await chooseMode(page, "transit");
	const panel = page.getByTestId(T.transitPanel);
	await panel.getByTestId(T.customRouteAdd).click();
	const b = panel.getByTestId(T.customRoute);
	await b.getByTestId(T.customRouteLabel).fill("Fuji Excursion 7");
	// walk 10 · train · taxi 10
	await b.getByTestId(T.customRouteStepMode).click();
	await page.getByRole("option", { name: "Walk" }).click();
	await b.getByTestId(T.customRouteStepMinutes).fill("10");
	await b.getByTestId(T.customRouteAddStep).click();
	await b.getByTestId(T.customRouteStepLine).fill("Fuji Excursion 7");
	await b.getByTestId(T.customRouteStepFrom).last().fill("Shinjuku");
	await b.getByTestId(T.customRouteStepTo).last().fill("Kawaguchiko");
	await b.getByTestId(T.customRouteAddStep).click();
	await b.getByTestId(T.customRouteStepMode).last().click();
	await page.getByRole("option", { name: "Taxi / car" }).click();
	await b.getByTestId(T.customRouteStepMinutes).last().fill("10");
	// Reserved 08:30 → 10:26 on Tue 5 Oct.
	await b.getByTestId(T.customRouteReserved).click();
	await b.getByTestId(T.customRouteDepartDate).fill("2027-10-05");
	await b.getByTestId(T.customRouteDepartTime).fill("08:30");
	await b.getByTestId(T.customRouteArriveDate).fill("2027-10-05");
	await b.getByTestId(T.customRouteArriveTime).fill("10:26");
	// Booking.
	await b.getByTestId(T.customRouteBooking).click();
	await b.getByTestId(T.bookingRef).fill("e7k2q9");
	await b.getByTestId(T.bookingCar).fill("3");
	await b.locator(`[data-testid=${T.bookingSeat}][data-member="${c.members.owner}"]`).fill("5a");
	await page.screenshot({ path: shotPath("transit/reserved-builder.png"), animations: "disabled" });
	await b.getByTestId(T.customRouteSave).click();

	const booked = panel.getByTestId(T.chosenBooking);
	await expect(booked).toContainText("Reserved");
	await expect(booked).toContainText("dep 08:30 → 10:26");
	await expect(booked).toContainText("E7K2Q9");
	await expect(booked).toContainText("Car 3");
	await expect
		.poll(async () => (await legOf(page, I.itoya, I.dropBags))?.depAt)
		.toBe("2027-10-04T23:30:00.000Z");
	await page.screenshot({ path: shotPath("transit/reserved.png"), animations: "disabled" });

	// A link guest (editor link) opens the same leg: ref and seats masked, never sent.
	// A clean context: the file-level storageState would sign it in as the owner.
	const guestCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const guest = await guestCtx.newPage();
	const bodies: string[] = [];
	guest.on("response", async (r) => {
		if (r.url().includes("/_serverFn/")) bodies.push(await r.text().catch(() => ""));
	});
	await guest.goto(`${APP_URL}/join#t=${c.shareTokens.editor}`);
	await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 20_000 });
	await guest.goto(`/t/${c.slug}?sel=l.${I.itoya}.${I.dropBags}`);
	await expectLive(guest);
	const gPanel = guest.getByTestId(T.transitPanel);
	await expect(gPanel.getByTestId(T.chosenBooking)).toContainText("Reserved");
	await expect(gPanel.getByTestId(T.chosenBooking).getByTestId(T.masked)).toBeVisible();
	await expect(guest.getByTestId(TESTID.legOverview)).not.toContainText("E7K2Q9");
	expect(bodies.join("\n")).not.toContain("E7K2Q9");
	await guest.screenshot({ path: shotPath("transit/guest-masked.png"), animations: "disabled" });
	await guestCtx.close();
});

test("mobile: the leg editor fits the phone and keeps Open in Google Maps", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "mobile layout");
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?sel=l.${I.loft}.${I.meiji}`);
	await expectLive(page);
	const overview = page.getByTestId(TESTID.legOverview).last();
	await expect(overview).toBeVisible({ timeout: 20_000 });
	await overview.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
	await expect(overview.getByTestId(T.transitOption).first()).toBeVisible({ timeout: 20_000 });
	await expect(overview.getByTestId(T.japanNote).getByTestId(T.googleMapsLink)).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("transit/japan-estimate-mobile.png"), animations: "disabled" });
});

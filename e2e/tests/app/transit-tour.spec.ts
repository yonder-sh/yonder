/**
 * WP-Transit visual tour (SPEC §18.5 screenshots; DESIGN §8.2): every leg
 * panel at 1440×900 and 390×844, saved under `e2e/shots/transit/tour/` for a
 * person to look at. Each shot also checks the things that must always be
 * there: "Open in Google Maps" on Japan transit rows (ADDENDUM §5), no
 * sideways scroll, no console errors.
 */
import { expect, type Page, test } from "@playwright/test";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

type Size = "desktop" | "phone";

/** The inspector (desktop) or the sheet (phone) holding the leg editor. */
const overviewOf = (page: Page) => page.getByTestId(TESTID.legOverview).last();

/** Scrolls the leg editor's scroll container so `locator` is at the top. */
async function scrollTo(page: Page, testId: string) {
	await overviewOf(page)
		.getByTestId(testId)
		.first()
		.evaluate((el) => el.scrollIntoView({ block: "start" }));
	await page.waitForTimeout(150);
}

async function shot(page: Page, size: Size, name: string) {
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath(`transit/tour/${size}-${name}.png`), animations: "disabled" });
}

async function openLeg(page: Page, c: FixtureClone, from: string, to: string) {
	await page.goto(`/t/${c.slug}?sel=l.${from}.${to}`);
	await expectLive(page);
	await expect(overviewOf(page)).toBeVisible({ timeout: 20_000 });
}

async function chooseMode(page: Page, mode: string) {
	await overviewOf(page).locator(`[data-testid=${T.modeOption}][data-mode=${mode}]`).click();
}

async function tour(page: Page, size: Size) {
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;

	// 1. A Japan transit leg: rail estimates, the note, Maps links, attribution.
	await openLeg(page, c, I.loft, I.meiji);
	await chooseMode(page, "transit");
	const options = overviewOf(page).getByTestId(T.transitOption);
	await expect(options.first()).toBeVisible({ timeout: 20_000 });
	for (let i = 0; i < (await options.count()); i++)
		await expect(options.nth(i).getByTestId(T.googleMapsLink)).toContainText("Google Maps");
	await shot(page, size, "01-japan-estimate");
	await scrollTo(page, T.railAttribution);
	await shot(page, size, "02-japan-estimate-bottom");

	// 2. The custom route builder, empty, then with a Shinkansen ride.
	await overviewOf(page).getByTestId(T.customRouteAdd).click();
	const b = overviewOf(page).getByTestId(T.customRoute);
	await expect(b).toBeVisible();
	await scrollTo(page, T.customRoute);
	await shot(page, size, "03-custom-route-empty");

	// 2b. The map edge behind it (EdgeOverview): the leg row keeps its Maps link.
	await page.goto(`/t/${c.slug}?lens=area&sel=e.${c.ids.nodes.shibuya}.${c.ids.nodes.harajuku}`);
	await expectLive(page);
	const edge = page.getByTestId(TESTID.edgeOverview).last();
	await expect(edge).toBeVisible({ timeout: 20_000 });
	await expect(edge.getByTestId(T.edgeLeg).first()).toBeVisible();
	await expect(edge.getByTestId(T.googleMapsLink).first()).toContainText("Google Maps");
	await shot(page, size, "03b-edge");

	// 3. The Fuji Excursion leg: minutes set by hand, then reserved and booked.
	await openLeg(page, c, I.itoya, I.dropBags);
	await expect(overviewOf(page).getByTestId(T.transitTime)).toContainText("Set by hand");
	await shot(page, size, "04-fuji-leg");
	await page.evaluate(
		async ({ from, to, owner, audrey }) => {
			const m = await import("/src/features/transit/transit.functions.ts");
			const target = { kind: "pair", fromItemId: from, toItemId: to };
			await m.saveCustomRoute({
				data: {
					target,
					route: {
						id: "m:fuji",
						source: "manual",
						durationMin: 136,
						walkMin: 10,
						transfers: 0,
						label: "Fuji Excursion 7",
						segments: [
							{ mode: "walk", durationMin: 10 },
							{ mode: "train", lineName: "Fuji Excursion 7", from: { name: "Shinjuku" }, to: { name: "Kawaguchiko" }, durationMin: 116 },
							{ mode: "other", vehicleType: "TAXI", durationMin: 10 },
						],
					},
				},
			});
			await m.saveTransitDetails({
				data: {
					target,
					fixed: {
						departLocal: "2027-10-05T08:30",
						arriveLocal: "2027-10-05T10:26",
						fromTz: "Asia/Tokyo",
						toTz: "Asia/Tokyo",
						accessMin: 10,
						egressMin: 10,
					},
					booking: {
						ref: "E7K2Q9",
						trainNumber: "Fuji Excursion 7",
						class: "Reserved",
						car: "3",
						seats: [
							{ memberId: owner, seat: "5A" },
							{ memberId: audrey, seat: "5B" },
						],
					},
				},
			});
		},
		{ from: I.itoya, to: I.dropBags, owner: c.members.owner, audrey: c.members.audrey },
	);
	await openLeg(page, c, I.itoya, I.dropBags);
	await expect(overviewOf(page).getByTestId(T.chosenBooking)).toContainText("Reserved");
	await expect(overviewOf(page).getByTestId(T.transitDoorToDoor)).toContainText("door to door");
	await shot(page, size, "04b-fuji-reserved");

	// 4. Walk.
	await openLeg(page, c, I.hands, I.loft);
	await expect(overviewOf(page).getByTestId(T.walkPanel)).toBeVisible();
	await shot(page, size, "05-walk");

	// 5. Other (taxi).
	await openLeg(page, c, I.meiji, I.sky);
	await chooseMode(page, "other");
	await expect(overviewOf(page).getByTestId(T.otherPanel)).toBeVisible();
	await shot(page, size, "06-other");

	// 6. The flight: summary, then the form.
	await openLeg(page, c, I.kix, I.icn);
	await expect(overviewOf(page).getByTestId(T.flightSummary)).toBeVisible();
	await shot(page, size, "07-flight-summary");
	await overviewOf(page).getByTestId(T.flightEdit).click();
	await expect(overviewOf(page).getByTestId(T.flightForm)).toBeVisible();
	await shot(page, size, "08-flight-form");
	await scrollTo(page, T.flightCabin);
	await shot(page, size, "09-flight-form-details");

	// 7. Add a flight (the dialog the Plan's "+" menu opens).
	await page.evaluate(async () => {
		const m = await import("/src/lib/workspace/ui-store.ts");
		const w = window as unknown as { __yonder?: { graph: { days: { id: string }[] } } };
		m.useUi.getState().openAddFlight({ dayId: w.__yonder?.graph.days.at(-1)?.id });
	});
	await expect(page.getByTestId(TESTID.addFlightDialog)).toBeVisible();
	await shot(page, size, "10-add-flight");
	await page.keyboard.press("Escape");

	expect(logs.messages).toEqual([]);
}

test("tour at 1440×900", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop project");
	await page.setViewportSize({ width: 1440, height: 900 });
	await tour(page, "desktop");
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
	test("tour at 390×844", async ({ page }, info) => {
		test.skip(info.project.name !== "chromium", "one phone size is enough");
		await tour(page, "phone");
	});
});

test("a viewer sees the leg editor read-only (desktop)", async ({ browser, page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop project");
	const c = await cloneFixtureTrip(page.request, { mayaRole: "viewer" });
	const I = c.ids.items;
	const ctx = await browser.newContext({
		storageState: storageStateOf("maya"),
		viewport: { width: 1440, height: 900 },
	});
	const maya = await ctx.newPage();
	const logs = collectConsole(maya);
	await openLeg(maya, c, I.itoya, I.dropBags);
	const overview = overviewOf(maya);
	// Every edit affordance is disabled with its reason; nothing fetches.
	await expect(overview.locator(`[data-testid=${T.modeOption}][data-mode=walk]`)).toBeDisabled();
	await expect(overview.getByTestId(T.customRouteAdd)).toBeDisabled();
	await expect(overview.getByTestId(T.transitOption)).toHaveCount(0);
	await expect(overview.getByTestId(T.japanNote).getByTestId(T.googleMapsLink)).toBeVisible();
	await shot(maya, "desktop", "11-viewer");
	expect(logs.messages).toEqual([]);
	await ctx.close();
});

/**
 * WP-Transit fix round 1 (docs/qa/FEEDBACK-1.md, docs/qa/OPEN_BUGS.json):
 * - FB-03: "Open in Google Maps" on every non-flight leg with two located
 *   ends, in the leg's own travel mode — walking for a walk, driving for a
 *   taxi, transit for a train — in the Plan row and in the leg editor; none
 *   for a flight.
 * - QA MT-06 residual: a measured walk switched to transit drops the walk's
 *   distance (no "10m est. · 2.2 km" on a rail leg).
 * - VIS3-05: the flight editor's summary line gives the flight's own time
 *   (KE 724 KIX→ICN 2h), not the plan total with airport time (5h).
 *
 * Each test signs in a fresh user (no shared storage state) and clones the
 * demo trip.
 */
import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

type Leg = {
	fromItemId: string | null;
	toItemId: string | null;
	mode: string | null;
	distanceM: number | null;
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

const travelModes = (scope: ReturnType<Page["getByTestId"]>) =>
	scope
		.getByTestId(T.googleMapsLink)
		.evaluateAll((els) =>
			els.map((e) =>
				new URL((e as HTMLAnchorElement).href).searchParams.get("travelmode"),
			),
		);

async function openLeg(page: Page, slug: string, from: string, to: string) {
	await page.goto(`/t/${slug}?sel=l.${from}.${to}`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.legOverview)).toBeVisible({
		timeout: 20_000,
	});
}

const chooseMode = (page: Page, mode: string) =>
	page
		.getByTestId(TESTID.legOverview)
		.locator(`[data-testid=${T.modeOption}][data-mode=${mode}]`)
		.click();

/** The Plan's row for a pair ("Travel Hands Shibuya → Shibuya Loft"). */
const planRow = (page: Page, name: string) =>
	page.getByTestId(TESTID.leg).filter({
		has: page.getByRole("button", { name: `Travel ${name}`, exact: true }),
	});

test.beforeEach(async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	await loginViaApi(
		page.request,
		`tr-maps-${randomBytes(4).toString("hex")}@example.com`,
		{ first: "Maps", last: "Tester" },
	);
});

test("FB-03: walks link to walking directions, taxis to driving, flights to nothing", async ({
	page,
}) => {
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;

	// A walk: the Plan row and the walk editor both open walking directions.
	await openLeg(page, c.slug, I.hands, I.loft);
	const row = planRow(page, "Hands Shibuya → Shibuya Loft");
	await expect(row.getByTestId(T.googleMapsLink)).toHaveAttribute(
		"href",
		/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&origin=35\.6617,139\.6989&destination=35\.6612,139\.6987&travelmode=walking$/,
	);
	await expect(row.getByTestId(T.googleMapsLink)).toHaveAccessibleName(
		"Open in Google Maps",
	);
	const walk = page.getByTestId(T.walkPanel);
	await expect(walk.getByTestId(T.googleMapsLink)).toContainText(
		"Open in Google Maps",
	);
	expect(await travelModes(walk)).toEqual(["walking"]);
	await page.screenshot({
		path: shotPath("transit/fb03-walk.png"),
		animations: "disabled",
	});

	// Other (taxi): driving, in the editor and in the Plan row.
	await chooseMode(page, "other");
	const other = page.getByTestId(T.otherPanel);
	await expect(other.getByTestId(T.googleMapsLink)).toHaveAttribute(
		"data-travelmode",
		"driving",
	);
	await expect
		.poll(() => travelModes(row))
		.toEqual(["driving"]);
	await page.screenshot({
		path: shotPath("transit/fb03-taxi.png"),
		animations: "disabled",
	});

	// A Japan transit leg keeps its transit link and copy.
	await openLeg(page, c.slug, I.itoya, I.dropBags);
	await expect
		.poll(() => travelModes(planRow(page, "Itoya Ginza → Drop bags")))
		.toEqual(["transit"]);

	// A flight: no Google Maps link anywhere; the summary gives the flight's
	// own 2h (VIS3-05). Flights have no airport buffers (FEEDBACK-3).
	await openLeg(page, c.slug, I.kix, I.icn);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov.getByTestId(TESTID.leg).first()).toHaveText(
		/KE 724 KIX→ICN\s*2h$/,
	);
	await expect(ov.getByTestId(T.googleMapsLink)).toHaveCount(0);
	await page.screenshot({
		path: shotPath("transit/vis3-05-flight.png"),
		animations: "disabled",
	});
	expect(logs.messages).toEqual([]);
});

test("QA MT-06 residual: a measured walk switched to transit drops the walk's distance", async ({
	page,
}) => {
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await openLeg(page, c.slug, I.loft, I.meiji);
	await chooseMode(page, "walk");
	// The walk chain measures it (OSRM, or the estimate offline): 1.7 km+.
	await expect
		.poll(async () => (await legOf(page, I.loft, I.meiji))?.distanceM ?? 0, {
			timeout: 20_000,
		})
		.toBeGreaterThan(1000);
	await chooseMode(page, "transit");
	// The fastest ride is chosen: its minutes replace the walk's, and the
	// walk's distance goes.
	const fastest = page
		.getByTestId(T.transitPanel)
		.getByTestId(T.transitOption)
		.first();
	await expect(fastest).toHaveAttribute("data-chosen", "true", {
		timeout: 20_000,
	});
	await expect
		.poll(async () => await legOf(page, I.loft, I.meiji))
		.toMatchObject({ mode: "transit", distanceM: null });
	const header = page.getByTestId(TESTID.legOverview).getByTestId(TESTID.leg);
	await expect(header.first()).not.toContainText("km");
	await expect(planRow(page, "Shibuya Loft → Meiji Jingu")).not.toContainText(
		"km",
	);
	await page.screenshot({
		path: shotPath("transit/mt06-walk-to-transit.png"),
		animations: "disabled",
	});
	expect(logs.messages).toEqual([]);
});

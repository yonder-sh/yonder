/**
 * WP-Insights E3: sunrise/sunset on day headers and climate normals
 * (EXTENSIONS §6, QA SUN-01…04, CLIM-01…04), harness mounted on a cloned trip.
 * Climate comes from Open-Meteo on the first open of a cell (then the DB).
 */
import { expect, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectNoHorizontalOverflow } from "./_helpers/page";
import { card, daySection, INSIGHTS_TESTID as T, openHarness, refreshGraph, updateItem } from "./insights-helpers";

test.use({ storageState: storageStateOf("dev") });

test("day headers show the local sunrise and sunset, and a viewpoint after dark gets the info glyph (SUN-01…03)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "the full header is desktop");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await openHarness(page, c);
	// Day 1 is Tokyo, Day 4 is Kyoto (further west: later sunrise and sunset).
	const d1 = daySection(page, c.ids.days.d1 as string).getByTestId(TESTID.daySun).first();
	const d4 = daySection(page, c.ids.days.d4 as string).getByTestId(TESTID.daySun).first();
	// The visible text ends the element (a screen-reader sentence comes first).
	await expect(d1).toHaveText(/Tokyo\s*05:3\d–17:2\d$/);
	await expect(d4).toHaveText(/Kyoto\s*05:5\d–17:3\d$/);
	await d1.hover();
	await expect(page.getByTestId(T.daySunDetail).first()).toContainText(/Sunrise 05:3\d · Golden hour 1\d:\d\d · Sunset 17:2\d · Tokyo/);

	// Shibuya Sky at 18:30 on Sun 3 Oct is after dark: info only, no amber.
	await updateItem(page, c.ids.items.sky as string, { pinnedStart: "18:30" });
	await refreshGraph(page);
	const chip = card(page, c.ids.items.sky as string).getByTestId(TESTID.hoursChip);
	await expect(chip).toHaveAttribute("data-severity", "info");
	await expect(chip).toHaveAttribute("data-kind", "after_dark");
	await expect(daySection(page, c.ids.days.d1 as string).getByTestId(TESTID.dayHoursBadge)).toHaveCount(0);
	expect(logs.messages).toEqual([]);
});

test("at 390px the header shows only the sunset (SUN-04)", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const c = await cloneFixtureTrip(page.request);
	await openHarness(page, c);
	const compact = daySection(page, c.ids.days.d1 as string).locator(`[data-testid=${TESTID.daySun}][data-compact]`);
	await expect(compact).toBeVisible();
	await expect(compact).toContainText(/Sunset 17:2\d/);
	await expectNoHorizontalOverflow(page);
});

test("climate: a city line, a country table in visit order, never for places, with attribution (CLIM-01, 03, 04)", async ({ page }, info) => {
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await openHarness(page, c, { nodeId: c.ids.nodes.itoya as string, panel: "inspector" });
	const inspector = page.getByTestId("harness-inspector");
	const city = inspector.getByTestId(TESTID.climateCard);
	await expect(city.getByTestId(T.climateLine)).toContainText(/Typical October · \d+° \/ \d+°/, { timeout: 30_000 });
	await expect(city.getByTestId(T.climateLine)).toContainText(/\d+ mm · \d+ wet days/);
	await expect(city.getByTestId(T.climateCaption)).toContainText(
		"2016–2025 averages · Weather data by Open-Meteo.com (CC BY 4.0) · ERA5, Copernicus",
	);
	// Places never get a single line.
	await expect(page.getByTestId("harness-place-climate").getByTestId(TESTID.climateCard)).toHaveCount(0);
	// Japan: a table of its cities in visit order, each from its own cell.
	const japan = page.locator(`[data-testid=${TESTID.climateCard}][data-nodeid="${c.ids.nodes.japan}"]`);
	const rows = japan.getByTestId(T.climateRow);
	await expect(rows).toHaveCount(4, { timeout: 30_000 });
	await expect(rows.nth(0)).toContainText("Tokyo");
	await expect(rows.nth(1)).toContainText("Kawaguchiko");
	await expect(rows.nth(2)).toContainText("Kyoto");
	await expect(rows.nth(3)).toContainText("Osaka");
	await expect(rows.nth(0)).toContainText(/Oct\s*\d+°\/\d+°/);
	await page.screenshot({ path: shotPath(`insights/climate-${info.project.name}.png`), animations: "disabled" });
	expect(logs.messages).toEqual([]);
});

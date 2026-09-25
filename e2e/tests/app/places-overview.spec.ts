/**
 * NodeOverview (SPEC §18.3 WP-Places, DESIGN §4.4): priorities persist per
 * member (with rating comments), Tokyo lists its visits and children, and the
 * days-per-city table edits planned days (ADDENDUM §10).
 */
import { expect, type Page, test } from "@playwright/test";
import { PLACES_TESTID as P } from "../../../src/features/places/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

type G = {
	nodes: {
		id: string;
		priorities: Record<string, string>;
		ratingComments: Record<string, string>;
		details: { plannedDays?: number };
	}[];
};
const nodeOf = (page: Page, id: string) =>
	page.evaluate(
		(id) =>
			(window as unknown as { __yonder?: { graph: G } }).__yonder?.graph.nodes.find(
				(n) => n.id === id,
			) ?? null,
		id,
	);

test("priorities persist per member, with a comment", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	// Headless WebGL (MapLibre) logs driver performance notes.
	const logs = collectConsole(page, [/GL Driver Message|WebGL|layers\[[^\]]+\]\.filter/]);
	const c = await cloneFixtureTrip(page.request);
	const itoya = c.ids.nodes.itoya as string;
	await page.goto(`/t/${c.slug}?sel=n.${itoya}`);
	await expectLive(page);
	const overview = page.getByTestId(TESTID.nodeOverview);
	const mine = overview.locator(`[data-testid=${P.priorityRow}][data-member="${c.members.owner}"]`);
	await mine.getByRole("button", { name: /your rating for Itoya Ginza/i }).click();
	await page.getByRole("menuitem", { name: /^Really want/ }).click();
	await mine.getByRole("button", { name: "Add a comment" }).click();
	const editor = mine.getByTestId(P.ratingComment);
	// The comment field is WP-Lists' MentionInput (a plain field or its editor).
	await editor.getByTestId(TESTID.mentionInput).fill("Pens for Mom");
	await editor.getByRole("button", { name: "Save" }).click();
	// Audrey (a placeholder) can be rated by an editor.
	const audrey = overview.locator(`[data-testid=${P.priorityRow}][data-member="${c.members.audrey}"]`);
	await audrey.getByRole("button", { name: /Audrey's rating for Itoya Ginza/ }).click();
	await page.getByRole("menuitem", { name: /^Must/ }).click();

	await expect
		.poll(async () => {
			const n = await nodeOf(page, itoya);
			return [n?.priorities[c.members.owner], n?.priorities[c.members.audrey], n?.ratingComments[c.members.owner]];
		})
		.toEqual(["really_want", "must", "Pens for Mom"]);
	await page.reload();
	await expect(mine).toContainText("Really want");
	await expect(mine).toContainText("Pens for Mom");
	await expect(audrey).toContainText("Must");
	await page.screenshot({ path: shotPath("places/overview-place-1440.png"), animations: "disabled" });
	expect(logs.messages).toEqual([]);
});

test("Tokyo's overview lists its visits and children; Zoom in goes inside", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan?sel=n.${c.ids.nodes.tokyo}`);
	await expectLive(page);
	const overview = page.getByTestId(TESTID.nodeOverview);
	await expect(overview.getByTestId(P.visits)).toContainText("3–4 Oct");
	await expect(overview.getByTestId(P.visits)).toContainText("7 stops");
	for (const name of ["Shibuya", "Harajuku", "Asakusa", "Itoya Ginza"])
		await expect(overview.getByTestId(P.children)).toContainText(name);
	await page.screenshot({ path: shotPath("places/overview-city-1440.png"), animations: "disabled" });
	await overview.getByTestId(P.zoomIn).click();
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}/japan/tokyo`));
});

test("the days-per-city table edits planned days and shows what's unallocated", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const c = await cloneFixtureTrip(page.request);
	const tokyo = c.ids.nodes.tokyo as string;
	await page.goto(`/t/${c.slug}?sel=n.${c.ids.nodes.japan}`);
	await expectLive(page);
	const table = page.getByTestId(P.daysTable);
	const row = table.locator(`[data-testid=${P.daysRow}][data-node="${tokyo}"]`);
	await expect(row).toContainText("Tokyo");
	const input = row.getByTestId(P.daysInput);
	await input.fill("3");
	await input.press("Enter");
	await expect.poll(async () => (await nodeOf(page, tokyo))?.details.plannedDays).toBe(3);
	// Scheduled days come from the plan: Tokyo holds day 1 and day 2.
	await expect(row).toContainText("2");
	await page.screenshot({ path: shotPath("places/overview-country-1440.png"), animations: "disabled" });
	// Emptying the field clears the planned days (the key is deleted, not 0).
	await input.fill("");
	await input.press("Enter");
	await expect.poll(async () => (await nodeOf(page, tokyo))?.details.plannedDays).toBeUndefined();
	await expect(input).toHaveValue("");
});

test("on a phone the overview is a sheet: a place, then a city, without sideways scrolling", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "phone layout");
	const c = await cloneFixtureTrip(page.request);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/t/${c.slug}?sel=n.${c.ids.nodes.sensoji}`);
	await expectLive(page);
	const overview = page.getByTestId(TESTID.nodeOverview);
	await expect(overview).toHaveAttribute("data-type", "place");
	await expect(overview.getByTestId(P.priorityRow).first()).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("places/overview-place-390.png"), animations: "disabled" });

	await page.goto(`/t/${c.slug}?sel=n.${c.ids.nodes.tokyo}`);
	await expect(overview).toHaveAttribute("data-type", "city");
	await expect(overview.getByTestId(P.plannedDays)).toContainText("2 scheduled");
	await expect(overview.getByTestId(P.children)).toContainText("Asakusa");
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("places/overview-city-390.png"), animations: "disabled" });
});

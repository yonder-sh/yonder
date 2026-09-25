/**
 * The planning flow (owner, 2026-09-25): add places → rate places →
 * schedule places. The Places tab's step bar and its counts (and the step it
 * opens on), rating from the Rate step lowering the count, Schedule next
 * putting a shortlisted place on a day, the phone's "★ Rate N" pill opening
 * the feed.
 * Screenshots land in `.data/flow-shots/`.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { PLACES_TAB_TESTID as T } from "../../../src/features/places/tab/testids";
import { REPO_ROOT, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

const shot = (name: string) => path.join(REPO_ROOT, ".data/flow-shots", `${name}.png`);

type G = {
	nodes: { id: string; priorities: Record<string, string> }[];
	items: { id: string; nodeId: string | null; dayId: string | null }[];
	days: { id: string; date: string }[];
};
const graphOf = (page: Page) =>
	page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

/** A place in Tokyo pinned onto the shortlist, not on a day. */
async function addShortlisted(page: Page, c: FixtureClone, name: string): Promise<string> {
	const id = randomUUID();
	await page.evaluate(
		async ({ tripId, parentId, id, name }) => {
			const m = await import(/* @vite-ignore */ "/src/functions/nodes.functions.ts");
			await m.createNode({
				data: { tripId, parentId, id, type: "place", category: "viewpoint", name, lat: 35.6586, lng: 139.7454, timeNeededMin: 60 },
			});
			await m.updateNode({ data: { nodeId: id, patch: { shortlistPin: "pinned" } } });
		},
		{ tripId: c.tripId, parentId: c.ids.nodes.tokyo as string, id, name },
	);
	return id;
}

/**
 * More to schedule, for the screenshots: Yasaka Shrine in a Gion area and a
 * museum closed on the Kyoto day (Wed 6 Oct) in Kyoto, and Nara (no days)
 * with Tōdai-ji rated Must.
 */
async function addMore(page: Page, c: FixtureClone): Promise<void> {
	await page.evaluate(
		async ({ tripId, kyoto, japan, me, ids }) => {
			const m = await import(/* @vite-ignore */ "/src/functions/nodes.functions.ts");
			const hours = {
				source: "manual",
				periods: [0, 1, 2, 4, 5, 6].map((day) => ({ day, open: "09:30", close: "17:00" })),
				closedDays: [3],
				updatedAt: new Date().toISOString(),
			};
			const [gion, yasaka, museum, nara, todaiji] = ids;
			const add = (data: Record<string, unknown>) => m.createNode({ data: { tripId, ...data } });
			await add({ id: gion, parentId: kyoto, type: "area", name: "Gion", lat: 35.0037, lng: 135.7788 });
			await add({ id: yasaka, parentId: gion, type: "place", category: "temple_shrine", name: "Yasaka Shrine", lat: 35.0036, lng: 135.7785, timeNeededMin: 45 });
			await add({ id: museum, parentId: kyoto, type: "place", category: "museum", name: "Kyoto National Museum", lat: 34.9899, lng: 135.7727, timeNeededMin: 120, details: { openingHours: hours } });
			await add({ id: nara, parentId: japan, type: "city", name: "Nara", lat: 34.6851, lng: 135.8048 });
			await add({ id: todaiji, parentId: nara, type: "place", category: "temple_shrine", name: "Tōdai-ji", lat: 34.689, lng: 135.8398, timeNeededMin: 120 });
			for (const id of [yasaka, museum])
				await m.updateNode({ data: { nodeId: id, patch: { shortlistPin: "pinned" } } });
			await m.setNodePriority({ data: { nodeId: todaiji, memberId: me, priority: "must" } });
		},
		{
			tripId: c.tripId,
			kyoto: c.ids.nodes.kyoto as string,
			japan: c.ids.nodes.japan as string,
			me: c.members.owner,
			ids: [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
		},
	);
}

const step = (page: Page, s: string) => page.locator(`[data-testid="${T.step}"][data-step="${s}"]`);
const countOf = (page: Page, s: string) => step(page, s).getByTestId(T.stepCount);

async function toRate(page: Page): Promise<number> {
	const text = (await countOf(page, "rate").textContent()) ?? "";
	const m = /^(\d+) to rate$/.exec(text.trim());
	if (!m) throw new Error(`no "N to rate" count: ${text}`);
	return Number(m[1]);
}

test.describe("desktop", () => {
	test.skip(({ isMobile }) => isMobile, "desktop layout (the phone has its own test)");

	test("the step bar: 1 Rate · 2 Review · 3 Schedule with their counts; Places opens on Rate", async ({ page }) => {
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}?tab=plan`);
		await expectLive(page);
		await addShortlisted(page, c, "Tokyo Tower");
		await addMore(page, c);
		// No step named: you have places to rate, so it's Rate (and the URL says so).
		await page.goto(`/t/${c.slug}?tab=places`);
		await expect(page.getByTestId(T.steps)).toBeVisible({ timeout: 30_000 });
		await expect(page).toHaveURL(/pv=rate/);
		await expect(page.getByTestId(T.steps)).toHaveAttribute("data-step", "rate");
		await expect(page.getByTestId(T.feed)).toBeVisible();
		await expect(countOf(page, "review")).toHaveText(/^\d+ places$/);
		await expect(countOf(page, "rate")).toHaveText(/^\d+ to rate$/);
		// Tokyo Tower, Yasaka Shrine, the museum and Tōdai-ji wait for a day.
		await expect(countOf(page, "schedule")).toHaveText(/^\d+ shortlisted · 4 not on a day$/);
		// Rating is what's waiting for you: the dot.
		await expect(step(page, "rate")).toHaveAttribute("data-next", "true");
		await expect(step(page, "rate").getByTestId(T.stepDot)).toBeVisible();
		// Every place but Tōdai-ji is yours to rate in a fresh clone.
		const ideas = Number(/^\d+/.exec((await countOf(page, "review").textContent()) ?? "")?.[0]);
		expect(await toRate(page)).toBe(ideas - 1);
		await page.waitForTimeout(500);
		await page.screenshot({ path: shot("desktop-2-rate"), animations: "disabled" });

		// "Add a place" sits on the steps' bar, on every step.
		await expect(page.getByTestId(T.steps).getByTestId(T.addPlace)).toBeVisible();

		// Review: the list.
		await step(page, "review").click();
		await expect(page).toHaveURL(/pv=table/);
		await expect(page.getByTestId(T.table)).toBeVisible();
		await page.screenshot({ path: shot("desktop-2b-review"), animations: "disabled" });

		// Schedule: Tokyo Tower in Tokyo's window, Yasaka Shrine under Gion in
		// Kyoto's; the museum (closed on the Kyoto day) and Tōdai-ji (Nara has
		// no days) can't fit; Nara is a city with no days yet.
		await step(page, "schedule").click();
		await expect(page).toHaveURL(/pv=schedule/);
		const rows = page.getByTestId(T.scheduleRow);
		await expect(rows.filter({ hasText: "Tokyo Tower" })).toHaveCount(1);
		await expect(page.getByTestId(T.scheduleWindow).filter({ hasText: "Kyoto" })).toContainText("Gion");
		await expect(rows.filter({ hasText: "Yasaka Shrine" })).toHaveCount(1);
		const cant = page.getByTestId(T.scheduleCantFit);
		await expect(cant).toContainText("Kyoto National Museum");
		await expect(cant).toContainText("Closed every day you're in Kyoto");
		await expect(cant).toContainText("Must, but no days in Nara");
		await expect(page.getByTestId(T.scheduleNoDays)).toContainText("Nara");
		await page.waitForTimeout(300);
		await page.screenshot({ path: shot("desktop-3-schedule"), animations: "disabled" });
	});

	test("rating from the Rate step lowers the count", async ({ page }) => {
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}?tab=places&pv=rate`);
		await expect(page.getByTestId(T.feed)).toBeVisible({ timeout: 30_000 });
		await expectLive(page);
		const before = await toRate(page);
		expect(before).toBeGreaterThan(1);
		const card = page.locator(`[data-testid=${T.feedCard}][data-active]`);
		await expect(card).toBeVisible();
		const placeId = (await card.getAttribute("data-place")) as string;
		await page.keyboard.press("2");
		await expect(card).toHaveAttribute("data-rated", /.+/);
		await expect(countOf(page, "rate")).toHaveText(`${before - 1} to rate`);
		const g = await graphOf(page);
		expect(g.nodes.find((n) => n.id === placeId)?.priorities[c.members.owner]).toBe("really_want");
		// The top bar's Rate says the same.
		await expect(page.getByTestId("rate-button")).toHaveAttribute("data-count", String(before - 1));
	});

	test("Schedule adds a shortlisted place to a day", async ({ page }) => {
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}?tab=plan`);
		await expectLive(page);
		const tower = await addShortlisted(page, c, "Tokyo Tower");
		await page.goto(`/t/${c.slug}?tab=places&pv=schedule`);
		await expect(page.getByTestId(T.schedule)).toBeVisible({ timeout: 30_000 });
		await expectLive(page);
		const row = page.locator(`[data-testid=${T.scheduleRow}][data-place="${tower}"]`);
		// Tokyo's days: its window lists the tower with a hint for each of them.
		await expect(row).toHaveCount(1);
		const window = page.getByTestId(T.scheduleWindow).filter({ has: row });
		await expect(window).toContainText("Tokyo");
		await expect(row.getByTestId(T.scheduleDay).first()).toBeVisible();
		const bestDay = (await row.getAttribute("data-best-day")) as string;
		const add = row.getByTestId(T.scheduleAdd);
		await expect(add).toHaveText(/^Add to \w{3} \d{1,2} \w{3}$/);
		await expect(row).toContainText(/free/);
		await add.click();
		// On the day it named, and off the list.
		await expect
			.poll(async () => (await graphOf(page)).items.find((it) => it.nodeId === tower)?.dayId ?? null, { timeout: 15_000 })
			.toBe(bestDay);
		await expect(row).toHaveCount(0);
		await expect(page.getByTestId(T.scheduleDone)).toBeVisible();
		await expect(countOf(page, "schedule")).toHaveText(/shortlisted · all on a day$/);
	});
});

test("phone: the ★ Rate pill floats above the sheet and opens the feed", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone layout");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const pill = page.getByTestId(T.ratePill);
	await expect(pill).toBeVisible();
	await expect(pill).toContainText(/Rate\s*\d+/);
	// Above the sheet (its top edge), clear of the (+) on the right.
	const sheet = await page.getByTestId("mobile-sheet").boundingBox();
	const box = await pill.boundingBox();
	expect(box && sheet && box.y + box.height <= sheet.y).toBe(true);
	await page.waitForTimeout(400);
	await page.screenshot({ path: shot("phone-pill"), animations: "disabled" });
	await pill.tap();
	await expect(page).toHaveURL(/pv=rate/);
	await expect(page.getByTestId(T.feed)).toBeVisible({ timeout: 20_000 });
	await expect(pill).toHaveCount(0);
	await page.waitForTimeout(400);
	await page.screenshot({ path: shot("phone-feed"), animations: "disabled" });
	// Closing the feed lands on the Places list; the pill is back.
	await page.getByRole("button", { name: "Close the feed" }).tap();
	await expect(page.getByTestId(T.feed)).toHaveCount(0);
	await expect(page.getByTestId(T.ratePill)).toBeVisible();
	await page.screenshot({ path: shot("phone-places-add"), animations: "disabled" });
});

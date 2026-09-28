/**
 * The planning flow (owner, 2026-09-25): add places → rate places → add
 * them to days. The Places tab's step bar and its counts (and the step it
 * opens on), rating from the Rate step lowering the count, the Plan's Fill
 * a day putting a shortlisted place on a day (One Yonder: the Schedule view
 * is gone), the phone's "★ Rate N" pill opening the feed.
 * Screenshots land in `.data/flow-shots/`.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { PLACES_TAB_TESTID as T } from "../../../src/features/places/tab/testids";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
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
/** A view's full count line, from its title ("Rate · 12 to rate"; the control shows "12 left"). */
const countOf = async (page: Page, s: string) =>
	((await step(page, s).getAttribute("title")) ?? "").replace(/^[^·]+· /, "");

async function toRate(page: Page): Promise<number> {
	const text = await countOf(page, "rate");
	const m = /^(\d+) to rate$/.exec(text.trim());
	if (!m) throw new Error(`no "N to rate" count: ${text}`);
	return Number(m[1]);
}

test.describe("desktop", () => {
	test.skip(({ isMobile }) => isMobile, "desktop layout (the phone has its own test)");

	test("the views: All places · Rate · Decide with their counts; Places opens on Rate", async ({ page }) => {
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
		await expect(step(page, "review")).toHaveAttribute("title", /^All places · \d+ places$/);
		await expect(step(page, "rate")).toHaveAttribute("title", /^Rate · \d+ to rate$/);
		await expect(step(page, "decide")).toHaveAttribute("title", /^Decide · /);
		await expect(step(page, "schedule")).toHaveCount(0);
		// Rating is what's waiting for you: the dot.
		await expect(step(page, "rate")).toHaveAttribute("data-next", "true");
		await expect(step(page, "rate").getByTestId(T.stepDot)).toBeVisible();
		// Every place but Tōdai-ji is yours to rate in a fresh clone.
		const ideas = Number(/^\d+/.exec(await countOf(page, "review"))?.[0]);
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

		// Decide: the pinned Tokyo Tower on the shortlist; an old Schedule link lands here.
		await page.goto(`/t/${c.slug}?tab=places&pv=schedule`);
		await expect(page.getByTestId(T.steps)).toHaveAttribute("data-step", "decide", { timeout: 30_000 });
		const shortlist = page.locator(`[data-testid=${T.decideColumn}][data-column="shortlist"]`);
		await expect(shortlist.getByTestId(T.decideCard).filter({ hasText: "Tokyo Tower" })).toHaveCount(1);
		await page.waitForTimeout(300);
		await page.screenshot({ path: shot("desktop-3-decide"), animations: "disabled" });
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
		await expect(step(page, "rate")).toHaveAttribute("title", `Rate · ${before - 1} to rate`);
		const g = await graphOf(page);
		expect(g.nodes.find((n) => n.id === placeId)?.priorities[c.members.owner]).toBe("really_want");
		// The top bar's Rate says the same.
		await expect(page.getByTestId("rate-button")).toHaveAttribute("data-count", String(before - 1));
	});

	test("Fill a day puts a shortlisted place on a day", async ({ page }) => {
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}?tab=plan`);
		await expectLive(page);
		const tower = await addShortlisted(page, c, "Tokyo Tower");
		// Sun 3 Oct: the day's ideas take the map's place.
		await page.goto(`/t/${c.slug}?tab=plan&days=2027-10-03&fill=1`);
		await expect(page.getByTestId(PLAN_TESTID.fillDay)).toBeVisible({ timeout: 30_000 });
		await expectLive(page);
		const row = page.locator(`[data-testid=${PLAN_TESTID.fillIdea}][data-place="${tower}"]`);
		await expect(row).toHaveCount(1);
		await row.getByTestId(PLAN_TESTID.fillAdd).click();
		// On that day, and the row says so.
		const g = await graphOf(page);
		const day = (g as unknown as { days: { id: string; date: string }[] }).days.find((d) => d.date === "2027-10-03");
		await expect
			.poll(async () => (await graphOf(page)).items.find((it) => it.nodeId === tower)?.dayId ?? null, { timeout: 15_000 })
			.toBe(day?.id);
		await expect(row).toContainText("On Sun 3");
		await expect(row.getByTestId(PLAN_TESTID.fillAdd)).toHaveCount(0);
	});
});

test("phone: the ★ Rate pill floats above the tabs and opens the feed", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone layout");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const pill = page.getByTestId(T.ratePill);
	await expect(pill).toBeVisible();
	await expect(pill).toContainText(/Rate\s*\d+/);
	// Above the bottom tabs, clear of the (+) on the right.
	const tabs = await page.getByTestId("center-tabs").boundingBox();
	const box = await pill.boundingBox();
	expect(box && tabs && box.y + box.height <= tabs.y).toBe(true);
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

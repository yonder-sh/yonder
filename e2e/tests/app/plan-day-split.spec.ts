/**
 * How long in each city, at the top of the Plan (owner, 2026-09-25; in
 * nights, 2026-10-07): a new trip with places and nothing on the plan. The
 * Plan shares the trip's nights (7 days: 6, the last day is the day you
 * leave) between the cities from what the shortlist needs (the spare nights
 * shared out) and says who still rates; rating moves it; the stops reorder
 * by drag (the map numbers them in that order); − / + adjust it; Put it on
 * the days sets each city's nights. Then Fill a day puts a shortlisted place
 * on a day, and Change in the Plan: − on a city with a place on its last day
 * confirms in the panel and sends the place back to the list. With no
 * dates: the nights, the day you arrive, then the dates and the nights in
 * one go. The phone gets the same at 390 px (Move up / Move down).
 * Screenshots land in `.data/split-shots/`.
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { MAP_TESTID } from "../../../src/features/map/testids";
import { PLACES_TAB_TESTID as P } from "../../../src/features/places/tab/testids";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { SPLIT_TESTID as T } from "../../../src/features/plan/day-split/testids";
import { REPO_ROOT, storageStateOf } from "./_helpers/env";
import { expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

const shot = (name: string) => path.join(REPO_ROOT, ".data/split-shots", `${name}.png`);

type G = {
	nodes: { id: string; name: string }[];
	items: { id: string; nodeId: string | null; dayId: string | null }[];
	days: { id: string; date: string; nightNodeId: string | null }[];
};
const graphOf = (page: Page) =>
	page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

type Trip = {
	tripId: string;
	slug: string;
	city: Record<"tokyo" | "kyoto" | "osaka", string>;
	place: Record<string, string>;
};

/**
 * Tokyo with three 8-hour places rated Must (2 days), Kyoto with two 5-hour
 * ones (1 day), Osaka with two nobody rated yet. Fri 1 – Thu 7 Oct 2027, or
 * no dates.
 */
async function newTrip(page: Page, dated = true): Promise<Trip> {
	await page.goto("/dashboard");
	return page.evaluate(async (dated) => {
		const trips = await import(/* @vite-ignore */ "/src/functions/trips.functions.ts");
		const nodes = await import(/* @vite-ignore */ "/src/functions/nodes.functions.ts");
		const graphs = await import(/* @vite-ignore */ "/src/functions/graph.functions.ts");
		const { tripId, slug } = await trips.createTrip({
			data: {
				name: "Day split",
				...(dated ? { startDate: "2027-10-01", endDate: "2027-10-07" } : {}),
				defaultTz: "Asia/Tokyo",
			},
		});
		const path = async (chain: unknown[]) =>
			(await nodes.createNodePath({ data: { tripId, chain } as never })).nodeIds as string[];
		const [japan, tokyo] = await path([
			{ type: "country", name: "Japan", countryCode: "JP" },
			{ type: "city", name: "Tokyo", lat: 35.6762, lng: 139.6503 },
		]);
		const [, kyoto] = await path([{ id: japan }, { type: "city", name: "Kyoto", lat: 35.0116, lng: 135.7681 }]);
		const [, osaka] = await path([{ id: japan }, { type: "city", name: "Osaka", lat: 34.6937, lng: 135.5023 }]);
		const place: Record<string, string> = {};
		const add = async (key: string, parentId: string, name: string, lat: number, lng: number, min: number) => {
			const id = crypto.randomUUID();
			await nodes.createNode({
				data: { tripId, parentId, id, type: "place", category: "sight", name, lat, lng, timeNeededMin: min } as never,
			});
			place[key] = id;
		};
		await add("tower", tokyo as string, "Tokyo Tower", 35.6586, 139.7454, 480);
		await add("sensoji", tokyo as string, "Senso-ji", 35.7148, 139.7967, 480);
		await add("meiji", tokyo as string, "Meiji Jingu", 35.6764, 139.6993, 480);
		await add("kiyomizu", kyoto as string, "Kiyomizu-dera", 34.9949, 135.785, 300);
		await add("fushimi", kyoto as string, "Fushimi Inari", 34.9671, 135.7727, 300);
		await add("castle", osaka as string, "Osaka Castle", 34.6873, 135.5262, 180);
		await add("dotonbori", osaka as string, "Dotonbori", 34.6687, 135.5013, 120);
		const g = await graphs.getTripGraph({ data: { tripId } });
		const me = g.me.memberId as string;
		for (const k of ["tower", "sensoji", "meiji", "kiyomizu", "fushimi"])
			await nodes.setNodePriority({ data: { nodeId: place[k], memberId: me, priority: "must" } as never });
		return {
			tripId,
			slug,
			city: { tokyo: tokyo as string, kyoto: kyoto as string, osaka: osaka as string },
			place,
		};
	}, dated);
}

const rowOf = (page: Page, cityId: string) => page.locator(`[data-testid="${T.splitRow}"][data-city="${cityId}"]`);
const step = (page: Page, s: string) => page.locator(`[data-testid="${P.step}"][data-step="${s}"]`);
const order = (page: Page) =>
	page.getByTestId(T.splitRow).evaluateAll((els) => els.map((e) => [e.getAttribute("data-city"), e.getAttribute("data-days")]));
/** The map's numbered stops: "stop:city" in number order. */
const mapStops = (page: Page) =>
	page
		.getByTestId(MAP_TESTID.splitStop)
		.evaluateAll((els) =>
			els
				.map((e) => [Number(e.getAttribute("data-stop")), e.getAttribute("data-city")] as const)
				.sort((a, b) => a[0] - b[0])
				.map(([n, c]) => `${n}:${c}`),
		);

async function openPlan(page: Page, t: Trip) {
	await page.goto(`/t/${t.slug}?tab=plan`);
	await expect(page.getByTestId("plan-tab")).toBeVisible({ timeout: 30_000 });
	await expectLive(page);
}

/** Drags a row by its handle onto another row. */
async function dragRow(page: Page, from: string, to: string) {
	const handle = await rowOf(page, from).getByTestId(T.handle).boundingBox();
	const target = await rowOf(page, to).boundingBox();
	if (!handle || !target) throw new Error("no rows to drag");
	await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
	await page.mouse.down();
	await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 8, { steps: 4 });
	await page.mouse.move(handle.x + handle.width / 2, target.y + target.height * 0.75, { steps: 12 });
	await page.waitForTimeout(150);
	await page.mouse.up();
}

/** No element wider than the page (nothing scrolls sideways at phone width). */
async function expectNoOverflow(page: Page, testid: string) {
	const over = await page.getByTestId(testid).evaluate((root) => {
		const w = document.documentElement.clientWidth;
		return [root, ...root.querySelectorAll("*")]
			.filter((el) => el.getBoundingClientRect().right > w + 1)
			.map((el) => `${el.tagName}.${(el as HTMLElement).className}`.slice(0, 80));
	});
	expect(over).toEqual([]);
}


/**
 * The nights per city, as Cities & nights lists them (One Yonder D05; the
 * Plan's one line "Tokyo 2 days · Osaka 2" went): opens it, checks, closes it.
 */
async function expectNights(page: Page, nights: [string, string][], tap = false) {
	const go = (l: import("@playwright/test").Locator) => (tap ? l.tap() : l.click());
	await go(page.getByTestId(T.splitChange));
	for (const [city, n] of nights) await expect(rowOf(page, city)).toHaveAttribute("data-days", n);
	await go(page.getByRole("radio", { name: "Days" }));
}

test.describe("desktop", () => {
	test.skip(({ isMobile }) => isMobile, "desktop layout (the phone has its own test)");

	test("split the days in the Plan, reorder, use them, add a place, then change them", async ({ page }) => {
		const t = await newTrip(page);
		await openPlan(page, t);

		// 1. Nothing on the plan: how long in each city, at the top of the Plan.
		const split = page.getByTestId(T.split);
		await expect(split).toBeVisible();
		await expect(split.getByRole("heading")).toHaveText("How long in each city?");
		await expect(split).toContainText(
			"Based on your shortlist. Change the nights, reorder the stops, then put them on the days.",
		);
		await expect(split).toContainText("6 nights, Fri 1 – Thu 7 Oct");
		// Tokyo needs 2, Kyoto 1; the 3 spare nights go in turn, Tokyo first.
		expect(await order(page)).toEqual([
			[t.city.tokyo, "4"],
			[t.city.kyoto, "2"],
			[t.city.osaka, "0"],
		]);
		await expect(page.getByTestId(T.heading)).toHaveText(["Japan · 6 nights"]);
		// Each stay from the day you arrive to the day you leave.
		await expect(rowOf(page, t.city.tokyo)).toContainText("Fri 1 – Tue 5 Oct");
		await expect(rowOf(page, t.city.kyoto)).toContainText("Tue 5 – Thu 7 Oct");
		await expect(rowOf(page, t.city.osaka)).toContainText("2 not rated yet");
		await expect(rowOf(page, t.city.osaka)).not.toContainText("0 shortlisted");
		await expect(page.getByTestId(T.splitRate)).toHaveText(/^You have 2 places to rate\. These days will change as you rate\.\s*Rate$/);
		// The map numbers the stops in that order.
		await expect.poll(() => mapStops(page), { timeout: 15_000 }).toEqual([`1:${t.city.tokyo}`, `2:${t.city.kyoto}`]);
		await page.waitForTimeout(300);
		await page.screenshot({ path: shot("desktop-1-plan-split"), animations: "disabled" });

		// 2. Rate: an Osaka place rated Must joins the shortlist; the split follows.
		await page.getByTestId(T.splitRate).getByRole("button", { name: "Rate" }).click();
		await expect(page).toHaveURL(/tab=places/);
		await expect(page).toHaveURL(/pv=rate/);
		const card = page.locator(`[data-testid=${P.feedCard}][data-active]`);
		await expect(card).toBeVisible({ timeout: 20_000 });
		expect([t.place.castle, t.place.dotonbori]).toContain(await card.getAttribute("data-place"));
		await page.keyboard.press("1");
		await expect(card).toHaveAttribute("data-rated", /.+/);
		// Back in the Plan: the split takes the new rating into account.
		await page.goto(`/t/${t.slug}?tab=plan`);
		await expect(split).toBeVisible();
		expect(await order(page)).toEqual([
			[t.city.tokyo, "3"],
			[t.city.kyoto, "2"],
			[t.city.osaka, "1"],
		]);
		await expect(page.getByTestId(T.splitRate)).toContainText("You have 1 place to rate.");

		// 3. Reorder: Kyoto dragged below Osaka; the numbers and the map follow.
		await dragRow(page, t.city.kyoto, t.city.osaka);
		await expect.poll(() => order(page)).toEqual([
			[t.city.tokyo, "3"],
			[t.city.osaka, "1"],
			[t.city.kyoto, "2"],
		]);
		await expect(rowOf(page, t.city.osaka)).toHaveAttribute("data-stop", "2");
		await expect.poll(() => mapStops(page)).toEqual([`1:${t.city.tokyo}`, `2:${t.city.osaka}`, `3:${t.city.kyoto}`]);
		await page.waitForTimeout(300);
		await page.screenshot({ path: shot("desktop-2-reordered"), animations: "disabled" });

		// 4. − on Tokyo leaves a night not placed; + on Kyoto takes it.
		await rowOf(page, t.city.tokyo).getByTestId(T.splitMinus).click();
		await expect(page.getByTestId(T.splitUnused)).toHaveText("1 night not placed yet");
		await rowOf(page, t.city.kyoto).getByTestId(T.splitPlus).click();
		await expect(rowOf(page, t.city.kyoto)).toHaveAttribute("data-days", "3");
		await expect(page.getByTestId(T.splitUnused)).toHaveText("No free nights left. Take one from another city first.");
		await expect(page.getByTestId(T.splitUse)).toHaveText("Put it on the days");
		await page.getByTestId(T.splitUse).click();
		// Thu 7, the day you leave, is a Kyoto day with no night of its own.
		await expect
			.poll(async () => (await graphOf(page)).days.map((d) => d.nightNodeId), { timeout: 15_000 })
			.toEqual([t.city.tokyo, t.city.tokyo, t.city.osaka, t.city.kyoto, t.city.kyoto, t.city.kyoto, null]);

		// 5. Cities & nights says so; the map goes back to normal.
		await expectNights(page, [
			[t.city.tokyo, "2"],
			[t.city.osaka, "1"],
			[t.city.kyoto, "3"],
		]);
		await expect(split).toHaveCount(0);
		await expect(page.getByTestId(MAP_TESTID.splitStop)).toHaveCount(0);
		await page.screenshot({ path: shot("desktop-3-plan-line"), animations: "disabled" });

		// 6. Fill a day: Senso-ji goes on Tokyo's last day (the second).
		const days = await graphOf(page).then((g) => g.days);
		await page.goto(`/t/${t.slug}?tab=plan&days=${days[1]?.date}&fill=1`);
		await expect(page.getByTestId(PLAN_TESTID.fillDay)).toBeVisible({ timeout: 30_000 });
		const sensoji = page.locator(`[data-testid=${PLAN_TESTID.fillIdea}][data-place="${t.place.sensoji}"]`);
		await sensoji.getByTestId(PLAN_TESTID.fillAdd).click();
		await expect
			.poll(async () => (await graphOf(page)).items.find((it) => it.nodeId === t.place.sensoji)?.dayId ?? null, { timeout: 15_000 })
			.toBe(days[1]?.id);
		await expect(sensoji.getByTestId(PLAN_TESTID.fillAdd)).toHaveCount(0);
		await page.waitForTimeout(300);
		await page.screenshot({ path: shot("desktop-4-add-to-days"), animations: "disabled" });

		// 7. Change in the Plan → − on Tokyo: Senso-ji's day becomes Osaka's (the
		// later nights move up, the last one is free); confirm, apply.
		await page.goto(`/t/${t.slug}?tab=plan`);
		await page.getByTestId(T.splitChange).click();
		await expect(rowOf(page, t.city.tokyo)).toHaveAttribute("data-days", "2");
		await expect.poll(() => mapStops(page)).toEqual([`1:${t.city.tokyo}`, `2:${t.city.osaka}`, `3:${t.city.kyoto}`]);
		await rowOf(page, t.city.tokyo).getByTestId(T.splitMinus).click();
		await page.getByTestId(T.splitApply).click();
		const confirm = page.getByTestId(T.splitConfirm);
		await expect(confirm).toContainText(
			"1 place is on a day that moves to another city. It'll go back to your list to schedule again.",
		);
		await page.waitForTimeout(200);
		await page.screenshot({ path: shot("desktop-5-change"), animations: "disabled" });
		await confirm.getByTestId(T.splitApply).click();
		await expect
			.poll(async () => (await graphOf(page)).days.map((d) => d.nightNodeId), { timeout: 15_000 })
			.toEqual([t.city.tokyo, t.city.osaka, t.city.kyoto, t.city.kyoto, t.city.kyoto, null, null]);
		await expect
			.poll(async () => (await graphOf(page)).items.filter((it) => it.nodeId === t.place.sensoji).map((it) => it.dayId), {
				timeout: 15_000,
			})
			.toEqual([null]);
		// The freed night is the last one: not placed yet.
		await expectNights(page, [
			[t.city.tokyo, "1"],
			[t.city.osaka, "1"],
			[t.city.kyoto, "3"],
		]);
		await expect(page.getByTestId(MAP_TESTID.splitStop)).toHaveCount(0);
	});

	test("no dates: the nights, the day you arrive, then the dates and the nights", async ({ page }) => {
		const t = await newTrip(page, false);
		await openPlan(page, t);
		const split = page.getByTestId(T.split);
		await expect(split.getByRole("heading")).toHaveText("How long in each city?");
		// What the shortlist needs, with no cap: one more night in Tokyo.
		expect(await order(page)).toEqual([
			[t.city.tokyo, "2"],
			[t.city.kyoto, "1"],
			[t.city.osaka, "0"],
		]);
		await rowOf(page, t.city.tokyo).getByTestId(T.splitPlus).click();
		await expect(rowOf(page, t.city.tokyo)).toHaveAttribute("data-days", "3");
		await expect(split).toContainText("4 nights");
		await expect(split).toContainText("You arrive on");
		await expect(page.getByTestId(T.splitUse)).toBeDisabled();
		// Starting on the 15th of the month the calendar opens on.
		await page.getByTestId(T.start).click();
		const cal = page.locator('[data-slot="popover-content"]');
		await cal.locator("button[data-day]").filter({ hasText: /^15$/ }).first().click();
		await expect(page.getByTestId(T.start)).toContainText("15");
		await page.waitForTimeout(200);
		await page.screenshot({ path: shot("desktop-6-no-dates"), animations: "disabled" });
		await page.getByTestId(T.splitUse).click();
		await expect
			.poll(async () => (await graphOf(page)).days.map((d) => d.nightNodeId), { timeout: 20_000 })
			.toEqual([t.city.tokyo, t.city.tokyo, t.city.tokyo, t.city.kyoto, null]);
		const dates = (await graphOf(page)).days.map((d) => d.date);
		expect(dates).toHaveLength(5);
		expect(Number(dates[0]?.slice(8))).toBe(15);
		await expectNights(page, [
			[t.city.tokyo, "3"],
			[t.city.kyoto, "1"],
		]);
	});
});

test("phone: the split at 390 px, Move up, Put it on the days, then Cities & nights", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone layout");
	await page.setViewportSize({ width: 390, height: 844 });
	const t = await newTrip(page);
	await page.goto(`/t/${t.slug}?tab=plan`);
	const split = page.getByTestId(T.split);
	await expect(split).toBeVisible({ timeout: 30_000 });
	await expectLive(page);
	await expect(page.getByTestId(T.splitUse)).toBeInViewport();
	await expect(rowOf(page, t.city.tokyo)).toHaveAttribute("data-days", "4");
	await expectNoOverflow(page, T.split);
	await page.waitForTimeout(400);
	await page.screenshot({ path: shot("phone-1-split"), animations: "disabled" });
	// Kyoto first, from its menu.
	await rowOf(page, t.city.kyoto).getByTestId(T.menu).tap();
	await page.getByTestId(T.moveUp).tap();
	await expect.poll(() => order(page)).toEqual([
		[t.city.kyoto, "2"],
		[t.city.tokyo, "4"],
		[t.city.osaka, "0"],
	]);
	await rowOf(page, t.city.tokyo).getByTestId(T.splitMinus).tap();
	await rowOf(page, t.city.osaka).getByTestId(T.splitPlus).tap();
	await expect(rowOf(page, t.city.osaka)).toHaveAttribute("data-days", "1");
	await page.getByTestId(T.splitUse).tap();
	await expect
		.poll(async () => (await graphOf(page)).days.map((d) => d.nightNodeId), { timeout: 15_000 })
		.toEqual([t.city.kyoto, t.city.kyoto, t.city.tokyo, t.city.tokyo, t.city.tokyo, t.city.osaka, null]);
	await expectNights(
		page,
		[
			[t.city.kyoto, "2"],
			[t.city.tokyo, "3"],
			[t.city.osaka, "1"],
		],
		true,
	);
	await page.getByTestId(T.splitChange).tap();
	await expect(page.getByTestId(T.splitRow)).toHaveCount(3);
	await expectNoOverflow(page, "plan-tab");
	await page.waitForTimeout(400);
	await page.screenshot({ path: shot("phone-2-change"), animations: "disabled" });
	// Decide on the phone: its label fits, and the columns.
	await page.goto(`/t/${t.slug}?tab=places&pv=decide`);
	await expect(step(page, "decide")).toContainText("Decide", { timeout: 30_000 });
	// The whole label fits the phone's step bar.
	const label = step(page, "decide").getByText("Decide", { exact: true });
	expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	await expect(page.getByTestId(P.decide)).toBeVisible();
	await expectNoOverflow(page, P.steps);
	await page.screenshot({ path: shot("phone-3-add-to-days"), animations: "disabled" });
});

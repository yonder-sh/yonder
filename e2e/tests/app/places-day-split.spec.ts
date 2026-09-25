/**
 * The day split on the Schedule step (owner, 2026-09-25): a new trip with
 * dates and places but nothing on the plan. Schedule shares the days between
 * the cities from what the shortlist needs (and says who still rates);
 * rating moves it; − / + adjust it; Use these days sets each city's nights.
 * Then the per-city list, "Add to …", and Change: − on a city with a place
 * on its last day confirms in the panel and sends the place back to the
 * list. The phone gets the same at 390 px. Screenshots land in
 * `.data/split-shots/`.
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { PLACES_TAB_TESTID as T } from "../../../src/features/places/tab/testids";
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
 * Fri 1 – Thu 7 Oct 2027, nothing on the plan: Tokyo with three 8-hour
 * places rated Must (2 days), Kyoto with two 5-hour ones (1 day), Osaka with
 * two nobody rated yet.
 */
async function newTrip(page: Page): Promise<Trip> {
	await page.goto("/dashboard");
	return page.evaluate(async () => {
		const trips = await import(/* @vite-ignore */ "/src/functions/trips.functions.ts");
		const nodes = await import(/* @vite-ignore */ "/src/functions/nodes.functions.ts");
		const graphs = await import(/* @vite-ignore */ "/src/functions/graph.functions.ts");
		const { tripId, slug } = await trips.createTrip({
			data: { name: "Day split", startDate: "2027-10-01", endDate: "2027-10-07", defaultTz: "Asia/Tokyo" },
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
	});
}

const rowOf = (page: Page, cityId: string) => page.locator(`[data-testid="${T.splitRow}"][data-city="${cityId}"]`);
const step = (page: Page, s: string) => page.locator(`[data-testid="${T.step}"][data-step="${s}"]`);

async function openSchedule(page: Page, t: Trip) {
	await page.goto(`/t/${t.slug}?tab=places&pv=schedule`);
	await expect(page.getByTestId(T.schedule)).toBeVisible({ timeout: 30_000 });
	await expectLive(page);
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

test.describe("desktop", () => {
	test.skip(({ isMobile }) => isMobile, "desktop layout (the phone has its own test)");

	test("split the days, use them, schedule a place, then change the split", async ({ page }) => {
		const t = await newTrip(page);
		await openSchedule(page, t);

		// 1. Nothing on the plan: the day split.
		const split = page.getByTestId(T.split);
		await expect(split).toBeVisible();
		await expect(page.getByTestId(T.schedule)).toHaveAttribute("data-mode", "split");
		await expect(split.getByRole("heading")).toHaveText("7 days, Fri 1 – Thu 7 Oct");
		await expect(rowOf(page, t.city.tokyo)).toHaveAttribute("data-days", "2");
		await expect(rowOf(page, t.city.kyoto)).toHaveAttribute("data-days", "1");
		await expect(rowOf(page, t.city.osaka)).toHaveAttribute("data-days", "0");
		await expect(rowOf(page, t.city.tokyo)).toContainText("3 shortlisted");
		await expect(rowOf(page, t.city.osaka)).toContainText("0 shortlisted · 2 not rated yet");
		await expect(page.getByTestId(T.splitRate)).toHaveText(
			/^You have 2 places to rate\. These days will change as you rate\.\s*Rate$/,
		);
		await expect(page.getByTestId(T.splitUnused)).toHaveText("4 days not used");
		await page.waitForTimeout(300);
		await page.screenshot({ path: shot("desktop-1-split"), animations: "disabled" });

		// 2. Rate: an Osaka place rated Must joins the shortlist; the split follows.
		await page.getByTestId(T.splitRate).getByRole("button", { name: "Rate" }).click();
		await expect(page).toHaveURL(/pv=rate/);
		const card = page.locator(`[data-testid=${T.feedCard}][data-active]`);
		await expect(card).toBeVisible({ timeout: 20_000 });
		const rated = (await card.getAttribute("data-place")) as string;
		expect([t.place.castle, t.place.dotonbori]).toContain(rated);
		await page.keyboard.press("1");
		await expect(card).toHaveAttribute("data-rated", /.+/);
		await step(page, "schedule").click();
		await expect(rowOf(page, t.city.osaka)).toHaveAttribute("data-days", "1");
		await expect(rowOf(page, t.city.osaka)).toContainText("1 shortlisted · 1 not rated yet");
		await expect(page.getByTestId(T.splitRate)).toContainText("You have 1 place to rate.");
		await expect(page.getByTestId(T.splitUnused)).toHaveText("3 days not used");
		// The route: Tokyo, Kyoto, Osaka.
		expect(await page.getByTestId(T.splitRow).evaluateAll((els) => els.map((e) => e.getAttribute("data-city")))).toEqual([
			t.city.tokyo,
			t.city.kyoto,
			t.city.osaka,
		]);

		// 3. + on Kyoto, then Use these days.
		await rowOf(page, t.city.kyoto).getByTestId(T.splitPlus).click();
		await expect(rowOf(page, t.city.kyoto)).toHaveAttribute("data-days", "2");
		await expect(page.getByTestId(T.splitUnused)).toHaveText("2 days not used");
		await page.getByTestId(T.splitUse).click();
		await expect
			.poll(async () => (await graphOf(page)).days.map((d) => d.nightNodeId), { timeout: 15_000 })
			.toEqual([t.city.tokyo, t.city.tokyo, t.city.kyoto, t.city.kyoto, t.city.osaka, null, null]);

		// 4. The per-city list under the days line.
		await expect(page.getByTestId(T.schedule)).toHaveAttribute("data-mode", "schedule");
		await expect(page.getByTestId(T.splitDays)).toHaveText("Days: Tokyo 2 · Kyoto 2 · Osaka 1 · 2 days not used");
		await expect(page.getByTestId(T.scheduleIntro)).toContainText("Put your shortlist on days");
		await expect(page.getByTestId(T.scheduleIntro)).toContainText(
			"Each place lists the days you're in its city. The button adds it to the best one.",
		);
		const tokyo = page.locator(`[data-testid=${T.scheduleWindow}][data-city="${t.city.tokyo}"]`);
		await expect(tokyo.getByTestId(T.scheduleRow)).toHaveCount(3);
		const days = await graphOf(page).then((g) => g.days.map((d) => d.id));

		// "Add to …" puts Tokyo Tower on its best day; Senso-ji goes on Sat 2 Oct (Tokyo's last day).
		const tower = page.locator(`[data-testid=${T.scheduleRow}][data-place="${t.place.tower}"]`);
		const best = (await tower.getAttribute("data-best-day")) as string;
		await expect(tower.getByTestId(T.scheduleAdd)).toHaveText(/^Add to \w{3} \d{1,2} \w{3}$/);
		await tower.getByTestId(T.scheduleAdd).click();
		await expect
			.poll(async () => (await graphOf(page)).items.find((it) => it.nodeId === t.place.tower)?.dayId ?? null, { timeout: 15_000 })
			.toBe(best);
		await expect(tower).toHaveCount(0);
		const sensoji = page.locator(`[data-testid=${T.scheduleRow}][data-place="${t.place.sensoji}"]`);
		await sensoji.locator(`[data-testid=${T.scheduleDay}][data-day="${days[1]}"]`).click();
		await expect
			.poll(async () => (await graphOf(page)).items.find((it) => it.nodeId === t.place.sensoji)?.dayId ?? null, { timeout: 15_000 })
			.toBe(days[1]);
		await expect(sensoji).toHaveCount(0);
		await page.waitForTimeout(300);
		await page.screenshot({ path: shot("desktop-2-schedule"), animations: "disabled" });

		// 5. Change → − on Tokyo: Senso-ji's day becomes Kyoto's; confirm, apply.
		await page.getByTestId(T.splitChange).click();
		await expect(rowOf(page, t.city.tokyo)).toHaveAttribute("data-days", "2");
		await rowOf(page, t.city.tokyo).getByTestId(T.splitMinus).click();
		await expect(rowOf(page, t.city.tokyo)).toHaveAttribute("data-days", "1");
		await page.getByTestId(T.splitApply).click();
		const confirm = page.getByTestId(T.splitConfirm);
		await expect(confirm).toContainText(
			"1 place is on a day that moves to another city. It'll go back to your list to schedule again.",
		);
		await page.waitForTimeout(200);
		await page.screenshot({ path: shot("desktop-3-change"), animations: "disabled" });
		await confirm.getByTestId(T.splitApply).click();
		await expect
			.poll(async () => (await graphOf(page)).days.map((d) => d.nightNodeId), { timeout: 15_000 })
			.toEqual([t.city.tokyo, t.city.kyoto, t.city.kyoto, t.city.osaka, null, null, null]);
		// Off its day (the stop stays, in Unscheduled).
		await expect
			.poll(async () => (await graphOf(page)).items.filter((it) => it.nodeId === t.place.sensoji).map((it) => it.dayId), {
				timeout: 15_000,
			})
			.toEqual([null]);
		await expect(page.getByTestId(T.splitDays)).toHaveText("Days: Tokyo 1 · Kyoto 2 · Osaka 1 · 3 days not used");
		// Back in the list, on Tokyo's one day; the tower (day 1) stayed.
		await expect(sensoji).toHaveCount(1);
		await expect(sensoji.getByTestId(T.scheduleDay)).toHaveCount(1);
		expect((await graphOf(page)).items.find((it) => it.nodeId === t.place.tower)?.dayId).toBe(best);
		// Adding it again reuses its stop (no second one in Unscheduled).
		await sensoji.getByTestId(T.scheduleAdd).click();
		await expect
			.poll(async () => (await graphOf(page)).items.filter((it) => it.nodeId === t.place.sensoji).map((it) => it.dayId), {
				timeout: 15_000,
			})
			.toEqual([days[0]]);
		await page.waitForTimeout(300);
		await page.screenshot({ path: shot("desktop-4-changed"), animations: "disabled" });
	});

	test("the narrow panel (the map showing) keeps the split readable", async ({ page }) => {
		const t = await newTrip(page);
		await openSchedule(page, t);
		// Wide off: the Places tab shares the screen with the map.
		const wide = page.getByTestId(T.wide);
		if ((await wide.getAttribute("aria-pressed")) === "true") await wide.click();
		await expect(page.getByTestId(T.split)).toBeVisible();
		const box = await page.getByTestId(T.split).boundingBox();
		expect(box && box.width).toBeLessThan(700);
		const cut = await page.getByTestId(T.splitRow).evaluateAll((rows) =>
			rows.flatMap((r) =>
				[...r.querySelectorAll("span")]
					.filter((s) => s.scrollWidth > s.clientWidth + 1)
					.map((s) => s.textContent),
			),
		);
		expect(cut).toEqual([]);
		await page.waitForTimeout(300);
		await page.screenshot({ path: shot("desktop-5-narrow"), animations: "disabled" });
	});
});

/** Phones: pull the sheet up so the Places tab fills the screen (the map is behind it). */
async function pullSheetUp(page: Page) {
	const sheet = page.getByTestId("mobile-sheet");
	const box = await sheet.boundingBox();
	if (!box) throw new Error("no sheet");
	const x = (page.viewportSize()?.width ?? 390) / 2;
	await page.mouse.move(x, box.y + 12);
	await page.mouse.down();
	await page.mouse.move(x, box.y - 250, { steps: 8 });
	await page.mouse.move(x, 60, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(800);
}

test("phone: the split at 390 px, Use these days, then the days line", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone layout");
	await page.setViewportSize({ width: 390, height: 844 });
	const t = await newTrip(page);
	await openSchedule(page, t);
	const split = page.getByTestId(T.split);
	await expect(split).toBeVisible();
	await pullSheetUp(page);
	await expect(page.getByTestId(T.splitUse)).toBeInViewport();
	await expect(rowOf(page, t.city.tokyo)).toHaveAttribute("data-days", "2");
	await expectNoOverflow(page, T.split);
	await page.waitForTimeout(400);
	await page.screenshot({ path: shot("phone-1-split"), animations: "disabled" });
	await rowOf(page, t.city.osaka).getByTestId(T.splitPlus).tap();
	await expect(rowOf(page, t.city.osaka)).toHaveAttribute("data-days", "1");
	await page.getByTestId(T.splitUse).tap();
	await expect
		.poll(async () => (await graphOf(page)).days.map((d) => d.nightNodeId), { timeout: 15_000 })
		.toEqual([t.city.tokyo, t.city.tokyo, t.city.kyoto, t.city.osaka, null, null, null]);
	await expect(page.getByTestId(T.splitDays)).toHaveText("Days: Tokyo 2 · Kyoto 1 · Osaka 1 · 3 days not used");
	await page.getByTestId(T.splitChange).tap();
	await expect(page.getByTestId(T.splitRow)).toHaveCount(3);
	await expectNoOverflow(page, T.schedule);
	await page.waitForTimeout(400);
	await page.screenshot({ path: shot("phone-2-change"), animations: "disabled" });
});

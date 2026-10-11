/**
 * The Plan's map fits the route (walkthrough backlog 1, 2026-10-07): it opens
 * on every stop, a trip that grows refits until you move the map, Japan and
 * Korea are a flat map (not the planet), the Cities & nights badges don't
 * cover each other, and picking a city with nothing in it yet goes there.
 * Screenshots land in `.data/map-fit-shots/`.
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { MAP_TESTID } from "../../../src/features/map/testids";
import { SPLIT_TESTID as T } from "../../../src/features/plan/day-split/testids";
import { REPO_ROOT, storageStateOf } from "./_helpers/env";
import { expectLive, openPhoneMap } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

const shot = (name: string) => path.join(REPO_ROOT, ".data/map-fit-shots", `${name}.png`);

type City = "tokyo" | "kyoto" | "osaka" | "nara" | "busan" | "seoul";
const AT: Record<City, [number, number]> = {
	tokyo: [139.6503, 35.6762],
	kyoto: [135.7681, 35.0116],
	osaka: [135.5023, 34.6937],
	nara: [135.8048, 34.6851],
	busan: [129.0756, 35.1796],
	seoul: [126.978, 37.5665],
};
type Trip = { slug: string; city: Record<City, string> };
type MapWin = {
	__tripMap?: {
		loaded(): boolean;
		isMoving(): boolean;
		getZoom(): number;
		getCenter(): { lng: number; lat: number };
		getProjection(): { type?: unknown } | undefined;
		getContainer(): HTMLElement;
		project(p: number[]): { x: number; y: number };
	};
};

/** 10–24 Oct 2027; nights as `[city, firstDay, lastDay]` (1-based day numbers). */
async function newTrip(page: Page, nights: [City, number, number][]): Promise<Trip> {
	await page.goto("/dashboard");
	return page.evaluate(
		async ({ AT, nights }) => {
			const trips = await import(/* @vite-ignore */ "/src/functions/trips.functions.ts");
			const nodes = await import(/* @vite-ignore */ "/src/functions/nodes.functions.ts");
			const days = await import(/* @vite-ignore */ "/src/functions/days.functions.ts");
			const graphs = await import(/* @vite-ignore */ "/src/functions/graph.functions.ts");
			const { tripId, slug } = await trips.createTrip({
				data: { name: "Map fit", startDate: "2027-10-10", endDate: "2027-10-24", defaultTz: "Asia/Tokyo" },
			});
			const path = async (chain: unknown[]) =>
				(await nodes.createNodePath({ data: { tripId, chain } as never })).nodeIds as string[];
			const city = (name: string, at: [number, number]) => ({ type: "city", name, lng: at[0], lat: at[1] });
			const [japan, tokyo] = await path([{ type: "country", name: "Japan", countryCode: "JP" }, city("Tokyo", AT.tokyo)]);
			const [, kyoto] = await path([{ id: japan }, city("Kyoto", AT.kyoto)]);
			const [, osaka] = await path([{ id: japan }, city("Osaka", AT.osaka)]);
			const [, nara] = await path([{ id: japan }, city("Nara", AT.nara)]);
			const [korea, busan] = await path([
				{ type: "country", name: "South Korea", countryCode: "KR" },
				city("Busan", AT.busan),
			]);
			const [, seoul] = await path([{ id: korea }, city("Seoul", AT.seoul)]);
			const ids = { tokyo, kyoto, osaka, nara, busan, seoul } as Record<string, string>;
			const g = await graphs.getTripGraph({ data: { tripId } });
			const ds = [...g.days].sort((a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date));
			if (nights.length)
				await days.setDayStays({
					data: {
						stays: nights.map(([c, a, b]) => ({ fromDayId: ds[a - 1].id, toDayId: ds[b - 1].id, nodeId: ids[c] })),
					} as never,
				});
			return { slug, city: ids as Trip["city"] };
		},
		{ AT, nights },
	);
}

async function mapSettled(page: Page) {
	await expect(page.getByTestId(MAP_TESTID.canvas)).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(() => page.evaluate(() => {
			const m = (window as unknown as MapWin).__tripMap;
			return !!m && m.loaded() && !m.isMoving();
		}), { timeout: 30_000 })
		.toBe(true);
	await page.waitForTimeout(900);
	await expect.poll(() => page.evaluate(() => !(window as unknown as MapWin).__tripMap?.isMoving())).toBe(true);
}

/** The camera, and where each city lands inside the map (px, the map's own box). */
function camera(page: Page, cities: City[]) {
	return page.evaluate(
		({ pts }) => {
			const m = (window as unknown as MapWin).__tripMap;
			if (!m) throw new Error("no map");
			const box = m.getContainer().getBoundingClientRect();
			return {
				zoom: m.getZoom(),
				center: m.getCenter(),
				projection: String(m.getProjection()?.type ?? "mercator"),
				width: box.width,
				height: box.height,
				at: pts.map(([name, p]) => ({ name, ...m.project(p) })),
			};
		},
		{ pts: cities.map((c) => [c, AT[c]] as const) },
	);
}

function expectInView(cam: Awaited<ReturnType<typeof camera>>) {
	for (const p of cam.at) {
		expect(p.x, `${p.name} x`).toBeGreaterThan(8);
		expect(p.x, `${p.name} x`).toBeLessThan(cam.width - 8);
		expect(p.y, `${p.name} y`).toBeGreaterThan(8);
		expect(p.y, `${p.name} y`).toBeLessThan(cam.height - 8);
	}
}

/** Cities & nights, being changed (it opens so on a trip with nights to place). */
async function openSplit(page: Page) {
	const live = page.locator(`[data-testid="${T.split}"][data-live]`);
	if (!(await live.isVisible())) await page.getByTestId(T.splitChange).click();
	await expect(live).toBeVisible();
}

const JAPAN: City[] = ["tokyo", "kyoto", "osaka"];
const ALL: City[] = [...JAPAN, "busan", "seoul"];

test("opens on the whole route, refits as it grows, and stays put once moved (desktop)", async ({ page, isMobile }) => {
	test.skip(isMobile, "desktop layout");
	const t = await newTrip(page, [["tokyo", 1, 5]]);
	await page.goto(`/t/${t.slug}?tab=plan`);
	await expectLive(page);
	await mapSettled(page);
	const before = await camera(page, ["tokyo"]);
	expectInView(before);

	// Cities & nights: + on Kyoto and Osaka puts them on the route, and the map frames them.
	await openSplit(page);
	const row = (c: City) => page.locator(`[data-testid="${T.splitRow}"][data-city="${t.city[c]}"]`);
	for (const c of ["kyoto", "osaka"] as const) {
		await row(c).getByTestId(T.splitPlus).click();
		await expect(row(c)).toHaveAttribute("data-days", "1");
	}
	await mapSettled(page);
	const grown = await camera(page, JAPAN);
	expectInView(grown);
	expect(grown.zoom).toBeLessThan(before.zoom);
	await page.screenshot({ path: shot("desktop-japan-grown") });

	// Moved by hand: another city on the route doesn't yank the camera (Nara: Korea would change the lens).
	const canvas = page.getByTestId(MAP_TESTID.canvas);
	const b = await canvas.boundingBox();
	if (!b) throw new Error("no map box");
	await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
	await page.mouse.down();
	await page.mouse.move(b.x + b.width / 2 + 120, b.y + b.height / 2 + 60, { steps: 8 });
	await page.mouse.up();
	await mapSettled(page);
	const moved = await camera(page, []);
	await row("nara").getByTestId(T.splitPlus).click();
	await expect(row("nara")).toHaveAttribute("data-days", "1");
	await page.waitForTimeout(1200);
	const after = await camera(page, []);
	expect(after.center.lng).toBeCloseTo(moved.center.lng, 3);
	expect(after.zoom).toBeCloseTo(moved.zoom, 3);
});

test("Japan and Korea: a flat map of the stops, badges clear of each other, a city goes there (desktop)", async ({
	page,
	isMobile,
}) => {
	test.skip(isMobile, "desktop layout");
	const t = await newTrip(page, [
		["tokyo", 1, 4],
		["kyoto", 5, 7],
		["osaka", 8, 9],
		["busan", 10, 11],
		["seoul", 12, 14],
	]);
	await page.goto(`/t/${t.slug}?tab=plan`);
	await expectLive(page);
	await mapSettled(page);
	const cam = await camera(page, ALL);
	expect(cam.projection).toBe("mercator");
	expect(cam.zoom).toBeGreaterThan(4);
	expectInView(cam);
	await page.screenshot({ path: shot("desktop-japan-korea") });

	// Cities & nights: no two full badges overlap (the covered ones show only their number).
	await openSplit(page);
	await expect(page.getByTestId(MAP_TESTID.splitStop)).toHaveCount(5);
	await mapSettled(page);
	await page.waitForTimeout(400);
	const rects = await page.getByTestId(MAP_TESTID.splitStop).evaluateAll((els) =>
		els.map((e) => {
			const r = e.getBoundingClientRect();
			return { full: !e.hasAttribute("data-compact"), l: r.left, t: r.top, r: r.right, b: r.bottom };
		}),
	);
	const full = rects.filter((r) => r.full);
	for (const a of full)
		for (const b of full)
			if (a !== b) expect(a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t, "full badges overlap").toBe(false);
	await page.screenshot({ path: shot("desktop-split-badges") });
	await page.getByTestId(T.done).click();

	// Where: Tokyo (nothing in it yet) moves the map onto Tokyo.
	await page.getByTestId("where-button").click();
	await page.getByRole("option", { name: /^Tokyo/ }).first().click();
	await expect(page).toHaveURL(/\/japan\/tokyo/);
	await mapSettled(page);
	const tokyo = await camera(page, ["tokyo"]);
	expect(tokyo.zoom).toBeGreaterThan(8);
	expect(tokyo.zoom).toBeLessThanOrEqual(12.01);
	expectInView(tokyo);
	await page.screenshot({ path: shot("desktop-scope-tokyo") });
});

test("phone at 390: the map opens on the Japan and Korea stops", async ({ page, isMobile }) => {
	test.skip(!isMobile, "phone layout");
	await page.setViewportSize({ width: 390, height: 844 });
	const t = await newTrip(page, [
		["tokyo", 1, 4],
		["kyoto", 5, 7],
		["osaka", 8, 9],
		["busan", 10, 11],
		["seoul", 12, 14],
	]);
	await page.goto(`/t/${t.slug}?tab=plan`);
	await expectLive(page);
	await openPhoneMap(page);
	await mapSettled(page);
	const cam = await camera(page, ALL);
	expect(cam.projection).toBe("mercator");
	expect(cam.zoom).toBeGreaterThan(3);
	expectInView(cam);
	await page.screenshot({ path: shot("phone-japan-korea") });
});

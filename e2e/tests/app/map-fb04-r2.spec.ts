/**
 * FB-04 re-test (QA 2026-09-23) and the owner's 2026-09-25 change (the map
 * follows the app theme; Satellite is a button on the map):
 *
 * - Defect 2 (WP-Map): switching the basemap on the whole-trip globe moved
 *   the camera off the FB-10 framing. The style reload came up in mercator,
 *   which clamped the camera (centre 63°N → 20°N on a desktop, the USA pin
 *   behind the horizon at opacity 0.2; lat 0 and zoom 0 → 0.72 on a phone).
 *   Every switch (map ↔ satellite) keeps the camera and every pin in front.
 * - The dark app with nothing saved draws a dark map; Satellite on and off
 *   comes back to it, and off saves nothing.
 *
 * Defect 2 runs on the QA seed (`pnpm db:seed:qa`, trip `asia-2027`, six
 * countries, the USA included) and puts the test account's setting back;
 * the dark app case uses a fresh account (nothing saved) on its own clone.
 *
 *   .data/agent-67-e2e.sh tests/app/map-fb04-r2.spec.ts --project chromium
 */
import { expect, type Page, test } from "@playwright/test";
import { MAP_TESTID } from "../../../src/features/map/testids";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";

const QA_TRIP = "asia-2027";
const QA_COUNTRIES = ["USA", "Japan", "South Korea", "Taiwan", "Vietnam", "Türkiye"];
const SHOTS = process.env.E2E_SHOTS_DIR ?? "shots/map-fb04-r2";
type Style = "light" | "dark" | "satellite";

type Pin = { repId: string; name: string; lng: number; lat: number };
type MapWin = {
	__tripMap?: {
		loaded(): boolean;
		isMoving(): boolean;
		isStyleLoaded(): boolean;
		areTilesLoaded(): boolean;
		getCenter(): { lng: number; lat: number };
		getZoom(): number;
		getProjection(): { type?: unknown } | undefined;
		getContainer(): HTMLElement;
		project(p: number[]): { x: number; y: number };
		jumpTo(o: { center: [number, number]; zoom: number }): void;
		__yonder?: { lens: string; pins: Pin[] };
	};
};

// One after another: the globe cases share the QA account (its OTP and its style).
test.describe.configure({ mode: "default" });

// One project is enough: the phone case sets its own viewport.
// biome-ignore lint/correctness/noEmptyPattern: Playwright wants the fixtures pattern
test.beforeEach(async ({}, info) => {
	test.skip(info.project.name !== "chromium", "runs in the chromium project");
});

async function mapReady(page: Page, lens?: string) {
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId(MAP_TESTID.canvas)).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(
			() =>
				page.evaluate((lens) => {
					const m = (window as unknown as MapWin).__tripMap;
					return !!m && m.loaded() && !!m.__yonder && (!lens || m.__yonder.lens === lens) && !m.isMoving();
				}, lens),
			{ timeout: 30_000 },
		)
		.toBe(true);
	await page.waitForTimeout(900);
	await expect.poll(() => page.evaluate(() => !(window as unknown as MapWin).__tripMap?.isMoving())).toBe(true);
}

const drawnStyle = (page: Page) =>
	page.evaluate(() => document.querySelector("[data-testid=map-canvas]")?.getAttribute("data-map-style") ?? null);

async function styleSettled(page: Page, style: Style) {
	await expect.poll(() => drawnStyle(page), { timeout: 15_000 }).toBe(style);
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const m = (window as unknown as MapWin).__tripMap;
					return !!m && m.isStyleLoaded() && m.areTilesLoaded() && !m.isMoving();
				}),
			{ timeout: 30_000 },
		)
		.toBe(true);
	await page.waitForTimeout(600);
}

/** The map's Satellite button, on or off (a no-op when it already is). */
async function setSatellite(page: Page, on: boolean) {
	const button = page.getByTestId(MAP_TESTID.satellite);
	if ((await button.getAttribute("aria-pressed")) !== String(on)) await button.click();
	await expect(button).toHaveAttribute("aria-pressed", String(on));
}

/** The camera and every pin: angle from the centre and marker opacity (MapLibre fades occluded markers to 0.2). */
function readGlobe(page: Page) {
	return page.evaluate(() => {
		const m = (window as unknown as MapWin).__tripMap;
		if (!m?.__yonder) throw new Error("no map");
		const c = m.getCenter();
		const rad = Math.PI / 180;
		return {
			projection: String(m.getProjection()?.type ?? ""),
			center: { lng: c.lng, lat: c.lat },
			zoom: m.getZoom(),
			pins: m.__yonder.pins.map((p) => {
				const el = document
					.querySelector(`[data-testid="pin"][data-rep-id="${p.repId}"]`)
					?.closest(".maplibregl-marker") as HTMLElement | null;
				const cos =
					Math.sin(c.lat * rad) * Math.sin(p.lat * rad) +
					Math.cos(c.lat * rad) * Math.cos(p.lat * rad) * Math.cos((p.lng - c.lng) * rad);
				return {
					name: p.name,
					angle: Math.acos(Math.max(-1, Math.min(1, cos))) / rad,
					opacity: el ? getComputedStyle(el).opacity : "missing",
				};
			}),
		};
	});
}
type Globe = Awaited<ReturnType<typeof readGlobe>>;

function expectAllInFront(g: Globe) {
	expect(g.projection).toBe("globe");
	expect(g.pins.map((p) => p.name).sort()).toEqual([...QA_COUNTRIES].sort());
	for (const p of g.pins) {
		expect(p.angle, `${p.name} angle from the centre`).toBeLessThan(76);
		expect(p.opacity, `${p.name} marker opacity`).toBe("1");
	}
}

/** The same camera: centre within 0.3°, zoom within 0.03. */
function expectSameCamera(g: Globe, want: Pick<Globe, "center" | "zoom">, label: string) {
	const dLng = ((g.center.lng - want.center.lng + 540) % 360) - 180;
	expect(Math.abs(dLng), `${label}: centre longitude ${g.center.lng} vs ${want.center.lng}`).toBeLessThan(0.3);
	expect(Math.abs(g.center.lat - want.center.lat), `${label}: centre latitude ${g.center.lat} vs ${want.center.lat}`).toBeLessThan(0.3);
	expect(Math.abs(g.zoom - want.zoom), `${label}: zoom ${g.zoom} vs ${want.zoom}`).toBeLessThan(0.03);
}

async function globeSurvivesSwitches(page: Page, shot: string) {
	await loginViaApi(page.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	await page.goto(`/t/${QA_TRIP}?tab=plan`);
	await mapReady(page, "country");
	const start = ((await drawnStyle(page)) ?? "light") as Style;
	const wasSatellite = start === "satellite";
	await styleSettled(page, start);
	const framed = await readGlobe(page);
	expectAllInFront(framed);

	// Satellite the other way and back (the light app's map is light).
	for (const on of [!wasSatellite, wasSatellite]) {
		const style: Style = on ? "satellite" : "light";
		await setSatellite(page, on);
		await styleSettled(page, style);
		const g = await readGlobe(page);
		expectSameCamera(g, framed, `after ${style}`);
		expectAllInFront(g);
		await page.screenshot({ path: `${SHOTS}/${shot}-${style}.png` });
	}

	// A camera the person moved stays where it is too (a high latitude, where
	// mercator's clamp moved it most).
	const moved = { center: [120, 58] as [number, number], zoom: 0.4 };
	await page.evaluate((o) => (window as unknown as MapWin).__tripMap?.jumpTo(o), moved);
	await setSatellite(page, !wasSatellite);
	await styleSettled(page, wasSatellite ? "light" : "satellite");
	const g = await readGlobe(page);
	expect(g.projection).toBe("globe");
	expectSameCamera(g, { center: { lng: moved.center[0], lat: moved.center[1] }, zoom: moved.zoom }, "moved, after a switch");

	// The test account as it was.
	await setSatellite(page, wasSatellite);
	await styleSettled(page, start);
}

test("FB-04 defect 2: map ↔ satellite on the whole-trip globe keeps the FB-10 framing (desktop)", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await globeSurvivesSwitches(page, "globe-desk");
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

	test("FB-04 defect 2: a style switch on the phone's globe keeps its camera (no lat 0 / zoom 0.72)", async ({ page }) => {
		await globeSurvivesSwitches(page, "globe-phone");
	});
});

test.describe("dark app, nothing saved", () => {
	test.use({ colorScheme: "dark" });

	test("the dark app draws a dark map; Satellite on and off comes back to it and saves nothing", async ({ page }) => {
		await loginViaApi(page.request, `fb04-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.com`, {
			first: "Night",
			last: "Owl",
		});
		const clone = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${clone.slug}?tab=plan`);
		await mapReady(page);
		const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("yonder:prefs") ?? "{}").mapStyle ?? null);
		// Nothing saved: the map follows the dark app.
		expect(await saved()).toBeNull();
		await styleSettled(page, "dark");
		await expect(page.getByTestId(MAP_TESTID.satellite)).toHaveAttribute("aria-pressed", "false");

		await setSatellite(page, true);
		await styleSettled(page, "satellite");
		expect(await saved()).toBe("satellite");
		await page.screenshot({ path: `${SHOTS}/dark-app-satellite.png` });

		await setSatellite(page, false);
		await styleSettled(page, "dark");
		expect(await saved()).toBeNull();
		await page.screenshot({ path: `${SHOTS}/dark-app-dark-map.png` });
	});
});

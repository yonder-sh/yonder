/**
 * FB-04 re-test (QA 2026-09-23), two defects left after the map style fix:
 *
 * - Defect 2 (WP-Map): switching Light / Dark / Satellite on the whole-trip
 *   globe moved the camera off the FB-10 framing. The style reload came up
 *   in mercator, which clamped the camera (centre 63°N → 20°N on a desktop,
 *   the USA pin behind the horizon at opacity 0.2; lat 0 and zoom 0 → 0.72
 *   on a phone). Every switch now keeps the camera and every pin in front.
 * - Defect 1 (WP-Shell): in the dark app with no saved style, View settings ›
 *   Map marked "Light" while the map was dark, and a click on Light did
 *   nothing. It marks the style the map draws (Dark), like the layer menu,
 *   and Light can be chosen there.
 *
 * Defect 2 runs on the QA seed (`pnpm db:seed:qa`, trip `asia-2027`, six
 * countries, the USA included) and puts the test account's style back;
 * defect 1 uses a fresh account (nothing saved) on its own demo clone.
 *
 *   .data/agent-67-e2e.sh tests/app/map-fb04-r2.spec.ts --project chromium
 */
import { expect, type Page, test } from "@playwright/test";
import { MAP_TESTID } from "../../../src/features/map/testids";
import { SHELL_TESTID } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";

const QA_TRIP = "asia-2027";
const QA_COUNTRIES = ["USA", "Japan", "South Korea", "Taiwan", "Vietnam", "Türkiye"];
const SHOTS = process.env.E2E_SHOTS_DIR ?? "shots/map-fb04-r2";
const STYLES = ["light", "dark", "satellite"] as const;
type Style = (typeof STYLES)[number];

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

async function pickInLayerMenu(page: Page, style: Style) {
	await page.getByTestId(MAP_TESTID.layersButton).click();
	const menu = page.getByTestId(MAP_TESTID.layerMenu);
	await expect(menu).toBeVisible();
	await menu.getByTestId(`${MAP_TESTID.mapStyle}-${style}`).click();
	await expect(menu.getByTestId(`${MAP_TESTID.mapStyle}-${style}`)).toHaveAttribute("data-state", "on");
	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
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

/** Every other style, then back to the one the account had. */
const tour = (start: Style): Style[] => [...STYLES.filter((s) => s !== start), start];

async function globeSurvivesSwitches(page: Page, shot: string) {
	await loginViaApi(page.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	await page.goto(`/t/${QA_TRIP}?tab=plan`);
	await mapReady(page, "country");
	const start = ((await drawnStyle(page)) ?? "light") as Style;
	await styleSettled(page, start);
	const framed = await readGlobe(page);
	expectAllInFront(framed);

	for (const style of tour(start)) {
		await pickInLayerMenu(page, style);
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
	const other = tour(start)[0] as Style;
	await pickInLayerMenu(page, other);
	await styleSettled(page, other);
	const g = await readGlobe(page);
	expect(g.projection).toBe("globe");
	expectSameCamera(g, { center: { lng: moved.center[0], lat: moved.center[1] }, zoom: moved.zoom }, `moved, after ${other}`);

	// The test account as it was.
	await pickInLayerMenu(page, start);
	await styleSettled(page, start);
}

test("FB-04 defect 2: Light, Dark and Satellite on the whole-trip globe keep the FB-10 framing (desktop)", async ({ page }) => {
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

	test("FB-04 defect 1: View settings › Map marks Dark like the map and the layer menu, and Light can be chosen there", async ({
		page,
	}) => {
		await loginViaApi(page.request, `fb04-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.com`, {
			first: "Night",
			last: "Owl",
		});
		const clone = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${clone.slug}?tab=plan`);
		await mapReady(page);
		// Nothing saved: the map follows the dark app.
		expect(await page.evaluate(() => JSON.parse(localStorage.getItem("yonder:prefs") ?? "{}").mapStyle ?? null)).toBeNull();
		await styleSettled(page, "dark");

		// The layer menu marks Dark.
		await page.getByTestId(MAP_TESTID.layersButton).click();
		const menu = page.getByTestId(MAP_TESTID.layerMenu);
		await expect(menu.getByTestId(`${MAP_TESTID.mapStyle}-dark`)).toHaveAttribute("data-state", "on");
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();

		// So does View settings › Map.
		const openSettings = async () => {
			await page.getByTestId(TESTID.tripMenu).click();
			await page.getByTestId(SHELL_TESTID.viewSettingsButton).click();
			const dialog = page.getByTestId(SHELL_TESTID.viewSettingsDialog);
			await expect(dialog).toBeVisible();
			return dialog.locator('[aria-label="Map style"]');
		};
		let seg = await openSettings();
		await expect(seg.getByText("Dark", { exact: true })).toHaveAttribute("data-state", "on");
		await expect(seg.getByText("Light", { exact: true })).toHaveAttribute("data-state", "off");
		await page.screenshot({ path: `${SHOTS}/dark-app-settings-dark.png` });

		// Light from View settings: the map turns light and the choice is saved.
		await seg.getByText("Light", { exact: true }).click();
		await expect(seg.getByText("Light", { exact: true })).toHaveAttribute("data-state", "on");
		await page.keyboard.press("Escape");
		await styleSettled(page, "light");
		expect(await page.evaluate(() => JSON.parse(localStorage.getItem("yonder:prefs") ?? "{}").mapStyle)).toBe("light");
		await page.screenshot({ path: `${SHOTS}/dark-app-light-map.png` });

		// Saved to the account: a reload keeps Light, in both controls.
		await page.waitForTimeout(800); // the 500 ms sync debounce
		await page.reload();
		await mapReady(page);
		await styleSettled(page, "light");
		seg = await openSettings();
		await expect(seg.getByText("Light", { exact: true })).toHaveAttribute("data-state", "on");
		await page.keyboard.press("Escape");
		await page.getByTestId(MAP_TESTID.layersButton).click();
		await expect(menu.getByTestId(`${MAP_TESTID.mapStyle}-light`)).toHaveAttribute("data-state", "on");
		await page.keyboard.press("Escape");
	});
});

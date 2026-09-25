/**
 * WP-Map, owner feedback round 1 (docs/qa/FEEDBACK-1.md) and the QA round-3
 * map bugs, on the QA seed (`pnpm db:seed:qa`, trip `asia-2027`) plus the real
 * sheet import under the QA owner (`pnpm sheet:import --owner
 * dennis@asia2027.test --slug asia-2027-real`: Japan has days, Korea, Taiwan
 * and Vietnam are ideas). READ-ONLY on both trips, except the view prefs of
 * the signed-in test account (map style), which each test puts back.
 *
 * - FB-10 / MAP-01: the whole trip opens on a globe framing every country,
 *   every pin on the visible side of the Earth and clear of the inspector.
 * - PLAN-R3-04: selecting cities with the inspector open on the globe never
 *   throws (MapLibre's globe `cameraForBounds` is never called).
 * - FB-04: the basemap follows the app theme, and the map's Satellite button
 *   switches to imagery (saved to the account's view prefs) that carries its
 *   attribution.
 *
 *   .data/agent-35-e2e.sh tests/app/map-owner-r1.spec.ts --project chromium
 */
import { expect, type Page, test } from "@playwright/test";
import { MAP_TESTID } from "../../../src/features/map/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";

const QA_TRIP = "asia-2027";
const REAL_TRIP = process.env.E2E_REAL_TRIP ?? "asia-2027-real";
const SHOTS = process.env.E2E_SHOTS_DIR ?? "shots/map-owner-r1";

type Pin = { repId: string; name: string; lng: number; lat: number; hollow: boolean };
type MapWin = {
	__tripMap?: {
		loaded(): boolean;
		isMoving(): boolean;
		getCenter(): { lng: number; lat: number };
		getZoom(): number;
		getProjection(): { type?: unknown } | undefined;
		getStyle(): { name?: string; sources: Record<string, { type: string; tiles?: string[]; attribution?: string }> };
		getContainer(): HTMLElement;
		project(p: number[]): { x: number; y: number };
		__yonder?: { lens: string; pins: Pin[] };
	};
	__yonder?: { graph: { nodes: { id: string; name: string; type: string }[] } };
};

test.skip(({ browserName }) => browserName !== "chromium", "one browser is enough");

test.beforeEach(async ({ page }) => {
	await loginViaApi(page.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
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

async function open(page: Page, url: string, lens?: string) {
	await page.goto(url);
	if (url.includes(REAL_TRIP)) {
		const notFound = page.getByText("We couldn't open this trip.");
		await Promise.race([
			page.getByTestId("workspace").waitFor({ timeout: 30_000 }),
			notFound.waitFor({ timeout: 30_000 }),
		]).catch(() => {});
		const missing = await notFound.isVisible();
		test.skip(
			missing,
			`needs the real-trip import: pnpm sheet:import --owner dennis@asia2027.test --slug ${REAL_TRIP} --name "Asia 2027 real"`,
		);
	}
	await mapReady(page, lens);
}

/** The camera and every pin: angle from the centre, screen point, marker opacity. */
function readGlobe(page: Page) {
	return page.evaluate(() => {
		const m = (window as unknown as MapWin).__tripMap;
		if (!m?.__yonder) throw new Error("no map");
		const c = m.getCenter();
		const rad = Math.PI / 180;
		const map = m.getContainer().getBoundingClientRect();
		const inspector = document.querySelector("[data-testid=inspector]")?.getBoundingClientRect();
		const free = inspector && inspector.width > 0 && inspector.left > map.left ? inspector.left - map.left : map.width;
		return {
			projection: String(m.getProjection()?.type ?? ""),
			center: c,
			zoom: m.getZoom(),
			width: map.width,
			height: map.height,
			free,
			pins: m.__yonder.pins.map((p) => {
				const el = document
					.querySelector(`[data-testid="pin"][data-rep-id="${p.repId}"]`)
					?.closest(".maplibregl-marker") as HTMLElement | null;
				const cos =
					Math.sin(c.lat * rad) * Math.sin(p.lat * rad) +
					Math.cos(c.lat * rad) * Math.cos(p.lat * rad) * Math.cos((p.lng - c.lng) * rad);
				const q = m.project([p.lng, p.lat]);
				return {
					name: p.name,
					hollow: p.hollow,
					angle: Math.acos(Math.max(-1, Math.min(1, cos))) / rad,
					x: q.x,
					y: q.y,
					opacity: el ? getComputedStyle(el).opacity : "missing",
				};
			}),
		};
	});
}

/** Every pin on the visible side of the globe (MapLibre fades occluded markers to 0.2) and inside the free map. */
function expectAllOnGlobe(g: Awaited<ReturnType<typeof readGlobe>>, names: string[]) {
	expect(g.projection).toBe("globe");
	expect(g.pins.map((p) => p.name).sort()).toEqual([...names].sort());
	for (const p of g.pins) {
		expect(p.angle, `${p.name} angle from the centre`).toBeLessThan(76);
		expect(p.opacity, `${p.name} marker opacity`).toBe("1");
		// A country pin is ~28px: its whole face is inside the uncovered map.
		expect(p.x, p.name).toBeGreaterThan(14);
		expect(p.x, p.name).toBeLessThan(g.free - 14);
		expect(p.y, p.name).toBeGreaterThan(14);
		expect(p.y, p.name).toBeLessThan(g.height - 14);
	}
}

const QA_COUNTRIES = ["USA", "Japan", "South Korea", "Taiwan", "Vietnam", "Türkiye"];
const REAL_COUNTRIES = ["Japan", "South Korea", "Taiwan", "Vietnam"];

test("FB-10 / MAP-01: the QA trip opens on a globe with all six countries in front, USA and Türkiye included", async ({
	page,
}) => {
	await open(page, `/t/${QA_TRIP}?tab=plan`, "country");
	const g = await readGlobe(page);
	expectAllOnGlobe(g, QA_COUNTRIES);
	// Not the old camera over the Pacific (148°E 28°N), which put USA and Türkiye at the limb.
	expect(g.center.lat).toBeGreaterThan(40);
	await page.screenshot({ path: `${SHOTS}/fb10-qa-globe.png` });
	// The same with `?sel=root` (the trip overview in the inspector).
	await open(page, `/t/${QA_TRIP}?sel=root`, "country");
	expectAllOnGlobe(await readGlobe(page), QA_COUNTRIES);
});

test("FB-10: the real trip (days in Japan, three idea countries) opens on a whole globe framing all four", async ({
	page,
}) => {
	await open(page, `/t/${REAL_TRIP}?tab=plan`, "country");
	const g = await readGlobe(page);
	expectAllOnGlobe(g, REAL_COUNTRIES);
	expect(g.pins.filter((p) => p.hollow).map((p) => p.name).sort()).toEqual(["South Korea", "Taiwan", "Vietnam"]);
	// The planet, not a curved map of Japan (it opened at z≈6 on Japan alone before).
	expect(g.zoom).toBeLessThan(3);
	await page.screenshot({ path: `${SHOTS}/fb10-real-globe.png` });
	// Zooming into a country goes flat (DESIGN §9.1: mercator below the whole trip).
	await page.getByRole("radio", { name: "Region" }).click();
	await mapReady(page, "region");
	expect((await readGlobe(page)).projection).toBe("mercator");
});

test("PLAN-R3-04: selecting cities with the inspector open on the globe never throws, even while the map resizes", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	await open(page, `/t/${QA_TRIP}?tab=plan`, "country");
	// MapLibre's globe `cameraForBounds` (what threw) is never used on the globe.
	await page.evaluate(() => {
		const m = (window as unknown as { __tripMap: Record<string, unknown> & { getProjection(): { type?: string } } })
			.__tripMap;
		const w = window as unknown as { __globeCameraForBounds: number };
		w.__globeCameraForBounds = 0;
		const orig = m.cameraForBounds as (...a: unknown[]) => unknown;
		m.cameraForBounds = function (this: unknown, ...a: unknown[]) {
			if (m.getProjection()?.type === "globe") w.__globeCameraForBounds++;
			return orig.apply(this, a);
		};
	});
	const outline = page.getByTestId(TESTID.outline).first();
	const widths = [1440, 1180, 1440, 1320];
	for (const [i, name] of ["Seoul", "Busan", "Hanoi", "Kyoto"].entries()) {
		const row = outline.getByTestId(TESTID.outlineRow).filter({ hasText: new RegExp(`^\\s*${name}\\b`) }).first();
		if (!(await row.isVisible().catch(() => false))) continue;
		await row.click();
		// Resize while the camera is moving (the QA runs were timing-dependent).
		await page.setViewportSize({ width: widths[i] ?? 1440, height: 900 });
		await page.waitForTimeout(250);
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await mapReady(page, "country");
	await expect(page.getByTestId(TESTID.inspector).first()).toBeVisible();
	await expect(page.getByTestId("workspace")).toBeVisible();
	expect(await page.evaluate(() => (window as unknown as { __globeCameraForBounds: number }).__globeCameraForBounds)).toBe(0);
	expect(errors.filter((e) => /reading 'center'|cameraFor|error boundary|CatchBoundary/i.test(e))).toEqual([]);
	// With the inspector open, every pin is still in front and clear of it.
	expectAllOnGlobe(await readGlobe(page), QA_COUNTRIES);
	await page.screenshot({ path: `${SHOTS}/plan-r3-04-globe-inspector.png` });
});

// ---- FB-04: map style --------------------------------------------------------

/** What the map is drawing: the style's name, its sources, the tone class and the attribution. */
function readStyle(page: Page) {
	return page.evaluate(() => {
		const m = (window as unknown as MapWin).__tripMap;
		if (!m) throw new Error("no map");
		const st = m.getStyle();
		const ground = document.querySelector(".yonder-map-ground");
		return {
			attr: document.querySelector("[data-testid=map-canvas]")?.getAttribute("data-map-style") ?? null,
			name: st.name ?? null,
			sources: Object.fromEntries(
				Object.entries(st.sources).map(([k, v]) => [k, { type: v.type, tiles: v.tiles ?? [], attribution: v.attribution ?? "" }]),
			),
			dark: !!ground?.classList.contains("dark"),
			attribution: document.querySelector(".maplibregl-ctrl-attrib")?.textContent ?? "",
		};
	});
}

async function styleSettled(page: Page, style: string) {
	await expect
		.poll(async () => (await readStyle(page)).attr, { timeout: 15_000 })
		.toBe(style);
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const m = (window as unknown as { __tripMap?: { isStyleLoaded(): boolean; areTilesLoaded(): boolean } })
						.__tripMap;
					return !!m && m.isStyleLoaded() && m.areTilesLoaded();
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

test("FB-04: the map follows the app theme; its Satellite button shows imagery and stays on", async ({
	page,
}) => {
	const blocked: string[] = [];
	const tiles: number[] = [];
	page.on("console", (m) => {
		if (/Content Security Policy|Refused to connect/i.test(m.text())) blocked.push(m.text());
	});
	page.on("response", (r) => {
		if (r.url().startsWith("https://server.arcgisonline.com/")) tiles.push(r.status());
	});
	await open(page, `/t/${QA_TRIP}/japan/tokyo`);
	// Start from the map (the account may have Satellite on from an earlier run).
	await setSatellite(page, false);
	await styleSettled(page, "light");
	expect((await readStyle(page)).name).toBe("Yonder light");

	// The app turns dark: so does the map (nothing to choose).
	await page.emulateMedia({ colorScheme: "dark" });
	await styleSettled(page, "dark");
	let s = await readStyle(page);
	expect(s.name).toBe("Yonder dark");
	expect(s.dark).toBe(true);
	await page.screenshot({ path: `${SHOTS}/fb04-dark.png` });
	await page.emulateMedia({ colorScheme: "light" });
	await styleSettled(page, "light");

	// Satellite from the map's own button: keyless imagery with its attribution.
	await setSatellite(page, true);
	await styleSettled(page, "satellite");
	s = await readStyle(page);
	expect(s.name).toBe("Yonder satellite");
	expect(s.sources.satellite?.type).toBe("raster");
	expect(s.sources.satellite?.tiles[0]).toContain("server.arcgisonline.com");
	expect(s.dark).toBe(true);
	await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("Esri");
	await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("OpenStreetMap");
	await expect(page.getByTestId(MAP_TESTID.tilesError)).toHaveCount(0);
	expect(tiles.length).toBeGreaterThan(0);
	expect(tiles.every((x) => x === 200)).toBe(true);
	expect(blocked).toEqual([]);
	// Our layers came back with the new style: pins and route lines.
	await expect(page.getByTestId(TESTID.pin).first()).toBeVisible();
	expect(await page.evaluate(() => !!(window as unknown as { __tripMap: { getLayer(id: string): unknown } }).__tripMap.getLayer("yonder-edges-walk"))).toBe(true);
	await page.screenshot({ path: `${SHOTS}/fb04-satellite.png` });

	// Saved to the account: a reload keeps Satellite on.
	await page.reload();
	await mapReady(page);
	await styleSettled(page, "satellite");
	await expect(page.getByTestId(MAP_TESTID.satellite)).toHaveAttribute("aria-pressed", "true");

	// Satellite on the whole-trip globe too.
	await open(page, `/t/${QA_TRIP}?tab=plan`, "country");
	await styleSettled(page, "satellite");
	expectAllOnGlobe(await readGlobe(page), QA_COUNTRIES);
	await page.screenshot({ path: `${SHOTS}/fb04-satellite-globe.png` });

	// Back to the map (and the test account as it was).
	await setSatellite(page, false);
	await styleSettled(page, "light");
	expect((await readStyle(page)).dark).toBe(false);
});

test.describe("dark app", () => {
	test.use({ colorScheme: "dark" });

	test("FB-04: the dark app draws a dark map on the app's own tokens", async ({ page }) => {
		await open(page, `/t/${QA_TRIP}/japan/tokyo`);
		await setSatellite(page, false);
		await styleSettled(page, "dark");
		const tokens = () =>
			page.evaluate(() => {
				const ground = document.querySelector(".yonder-map-ground") as HTMLElement;
				const fg = (el: Element) => getComputedStyle(el).getPropertyValue("--foreground").trim();
				return {
					app: fg(document.body),
					ground: fg(ground),
					light: ground.classList.contains("is-light"),
					halo: getComputedStyle(ground).getPropertyValue("--basemap-label-halo").trim(),
				};
			});
		const dark = await tokens();
		expect(dark.light).toBe(false);
		expect(dark.ground).toBe(dark.app);
		await page.screenshot({ path: `${SHOTS}/fb04-dark-app-dark-map.png` });
	});
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

	test("FB-10: the phone opens the real trip on a globe above the sheet", async ({ page }) => {
		await open(page, `/t/${REAL_TRIP}?tab=plan`, "country");
		const g = await readGlobe(page);
		expect(g.projection).toBe("globe");
		const sheetTop = await page.evaluate(() => {
			const s = [...document.querySelectorAll("[data-testid]")].find((e) => /sheet/i.test(e.getAttribute("data-testid") ?? ""));
			return s ? s.getBoundingClientRect().top : window.innerHeight;
		});
		for (const p of g.pins) {
			expect(p.opacity, p.name).toBe("1");
			expect(p.y, p.name).toBeLessThan(sheetTop);
		}
		await page.screenshot({ path: `${SHOTS}/fb10-phone-globe.png` });
	});
});

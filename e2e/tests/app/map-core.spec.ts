/**
 * WP-Map (SPEC §18.3, DESIGN §9, QA MAP/GRAN, ADDENDUM §5/§10, JAPAN_TRANSIT §3).
 * Each test clones its own trip (SPEC §18.5) and reads the map through TI-6:
 * `window.__tripMap` is the MapLibre instance and `__tripMap.__yonder` holds
 * what it drew (pins are DOM markers; edges, ghosts are GeoJSON sources).
 */
import { expect, type Page, test } from "@playwright/test";
import jpRoute from "../../../src/features/map/__tests__/jp-route.json" with { type: "json" };
import { MAP_TESTID } from "../../../src/features/map/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });


type Drawn = {
	lens: string;
	scopeId: string | null;
	pins: { repId: string; hollow: boolean; number: number | null; opacity: number }[];
	visiblePins: string[];
	clusters: { id: number; count: number; repIds: string[] }[];
	edges: { features: { properties: Record<string, unknown>; geometry: { coordinates: number[][] } }[] };
	allEdges: { features: { properties: Record<string, unknown> }[] };
	ghosts: { features: unknown[] };
};
type MapWindow = {
	__tripMap?: {
		loaded(): boolean;
		getZoom(): number;
		jumpTo(o: object): void;
		project(p: number[]): { x: number; y: number };
		getContainer(): HTMLElement;
		__yonder?: Drawn;
	};
	__yonder?: {
		model: {
			pins: { repId: string; hollow: boolean }[];
			edges: { key: string; kind: string }[];
		};
	};
};

async function mapReady(page: Page, lens?: string) {
	await expect(page.getByTestId(MAP_TESTID.canvas)).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(
			() =>
				page.evaluate((lens) => {
					const w = window as unknown as MapWindow;
					const m = w.__tripMap;
					return !!m && m.loaded() && !!m.__yonder && (!lens || m.__yonder.lens === lens);
				}, lens),
			{ timeout: 30_000 },
		)
		.toBe(true);
}

/** Tiles loaded and the camera still: screenshots show a finished map. */
async function settle(page: Page) {
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const m = (window as unknown as { __tripMap?: { loaded(): boolean; areTilesLoaded(): boolean; isMoving(): boolean } }).__tripMap;
					return !!m && m.loaded() && m.areTilesLoaded() && !m.isMoving();
				}),
			{ timeout: 20_000 },
		)
		.toBe(true);
	await page.waitForTimeout(300);
}

const drawn = (page: Page) =>
	page.evaluate(() => (window as unknown as MapWindow).__tripMap?.__yonder as Drawn);

/** The screen point halfway along an edge feature. */
async function edgePoint(page: Page, match: (p: Record<string, unknown>) => boolean) {
	const feats = (await drawn(page)).edges.features;
	const f = feats.find((x) => match(x.properties));
	if (!f) throw new Error("edge not drawn");
	return page.evaluate((coords) => {
		const m = (window as unknown as MapWindow).__tripMap;
		if (!m) throw new Error("no map");
		const c =
			coords.length === 2
				? [(coords[0][0] + coords[1][0]) / 2, (coords[0][1] + coords[1][1]) / 2]
				: coords[Math.floor(coords.length / 2)];
		const p = m.project(c);
		const r = m.getContainer().getBoundingClientRect();
		return { x: r.left + p.x, y: r.top + p.y };
	}, f.geometry.coordinates);
}

test("MapLibre draws the model at every lens (MAP-01, MAP-06, GRAN-01/02/04)", async ({ page }) => {
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	for (const lens of ["country", "city", "area", "place"]) {
		await page.goto(`/t/${c.slug}?lens=${lens}`);
		await mapReady(page, lens);
		// MAP-06: it's MapLibre, with tile attribution.
		await expect(page.locator(".maplibregl-map")).toHaveCount(1);
		await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("OpenStreetMap");
		const d = await drawn(page);
		const model = await page.evaluate(() => (window as unknown as MapWindow).__yonder?.model);
		const modelVisited = new Set(model?.pins.filter((p) => !p.hollow).map((p) => p.repId));
		const mapVisited = new Set(d.pins.filter((p) => !p.hollow).map((p) => p.repId));
		expect([...mapVisited].sort(), `pins at ${lens}`).toEqual([...modelVisited].sort());
		const modelEdges = new Set(model?.edges.map((e) => e.key));
		// Before clustering (which hides edges inside a cluster), every model edge is drawn.
		const mapEdges = new Set(d.allEdges.features.map((f) => f.properties.edgeKey as string));
		expect([...mapEdges].sort(), `edges at ${lens}`).toEqual([...modelEdges].sort());
		for (const f of d.edges.features) expect(modelEdges.has(f.properties.edgeKey as string)).toBe(true);
		// Markers are buttons with numbers in visit order.
		const buttons = page.getByTestId(TESTID.pin);
		expect(await buttons.count()).toBeGreaterThan(0);
	}
	expect(logs.messages).toEqual([]);
});

test("pins select and zoom in; edges select their leg (MAP-03, MAP-04, MAP-09)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "mouse on the desktop layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}/japan?lens=city`);
	await mapReady(page, "city");
	const tokyo = page.locator(`[data-testid="${TESTID.pin}"][data-rep-id="${c.ids.nodes.tokyo}"]`);
	await tokyo.click();
	await expect(page).toHaveURL(new RegExp(`sel=n\\.${c.ids.nodes.tokyo}`));
	await expect(page.getByTestId(TESTID.inspector)).toBeVisible();
	await expect(tokyo).toHaveAttribute("aria-pressed", "true");
	// Click the Tokyo → Mt. Fuji edge: one transition → its pair leg.
	await page.keyboard.press("Escape");
	await expect(page).not.toHaveURL(/sel=/);
	const p = await edgePoint(page, (x) => x.style === "transit");
	await page.mouse.click(p.x, p.y);
	await expect(page).toHaveURL(new RegExp(`sel=l\\.${I.itoya}\\.${I.dropBags}`));
	await settle(page);
	await page.screenshot({ path: shotPath("map/city-edge-selected-1440.png"), animations: "disabled" });
	// An overnight connector selects its pair too (MAP-09), at the place lens.
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place`);
	await mapReady(page, "place");
	const o = await edgePoint(page, (x) => x.style === "overnight");
	await page.mouse.click(o.x, o.y);
	await expect(page).toHaveURL(new RegExp(`sel=l\\.${I.sky}\\.${I.sensoji}`));
	// Double-click a pin zooms in (scope = that node).
	await page.goto(`/t/${c.slug}/japan?lens=city`);
	await mapReady(page, "city");
	await page.locator(`[data-testid="${TESTID.pin}"][data-rep-id="${c.ids.nodes.tokyo}"]`).dblclick();
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}/japan/tokyo`));
	expect(logs.messages).toEqual([]);
});

test("Hands and Loft cluster as 2 at z13 and split when clicked (GRAN-09)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo/shibuya?lens=place`);
	await mapReady(page, "place");
	await page.evaluate(() => {
		const m = (window as unknown as MapWindow).__tripMap;
		m?.jumpTo({ center: [139.6995, 35.6605], zoom: 13 });
	});
	const cluster = page.getByTestId(MAP_TESTID.cluster);
	await expect(cluster.first()).toBeVisible();
	await expect(cluster.first()).toHaveAttribute("data-count", /[23]/);
	const before = await drawn(page);
	const c2 = before.clusters.find((x) => x.repIds.includes(c.ids.nodes.hands));
	expect(c2?.repIds).toContain(c.ids.nodes.loft);
	// The Hands → Loft walk is inside the cluster: not drawn while clustered.
	expect(before.edges.features.some((f) => f.properties.pairKey === `${c.ids.items.hands}>${c.ids.items.loft}`)).toBe(false);
	await cluster.first().click();
	await expect
		.poll(async () => (await drawn(page)).visiblePins.includes(c.ids.nodes.hands), { timeout: 10_000 })
		.toBe(true);
});

test("a Japan estimate follows its N02 rail track, dashed, at every lens (JAPAN_TRANSIT §3)", async ({ page }, info) => {
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}/japan?lens=city`);
	await mapReady(page, "city");
	const res = await page.evaluate(
		async ({ from, to, route }) => {
			const m = await import("/src/functions/legs.functions.ts");
			return m.setLeg({
				data: {
					target: { kind: "pair", fromItemId: from, toItemId: to },
					patch: {
						mode: "transit",
						source: "estimate",
						durationMin: route.durationMin,
						isEdited: false,
						details: { kind: "transit", route },
					},
				},
			});
		},
		{ from: I.itoya, to: I.dropBags, route: jpRoute },
	);
	expect(res).toBeTruthy();
	// This tab skips its own live event; a reload shows what everyone else sees.
	await page.reload();
	await mapReady(page, "city");
	await expect
		.poll(async () => {
			const d = await drawn(page);
			const f = d.edges.features.find((x) => x.properties.style === "transit");
			return f ? { track: f.properties.track, est: f.properties.est, n: f.geometry.coordinates.length > 100 } : null;
		}, { timeout: 15_000 })
		.toEqual({ track: true, est: true, n: true });
	// The N02 attribution appears with the track.
	await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("MLIT N02");
	await settle(page);
	const tag = info.project.name === "chromium" ? "1440" : "mobile";
	await page.screenshot({ path: shotPath(`map/jp-estimate-city-${tag}.png`), animations: "disabled" });
	await page.goto(`/t/${c.slug}/japan?lens=place`);
	await mapReady(page, "place");
	const d = await drawn(page);
	const f = d.edges.features.find((x) => x.properties.pairKey === `${I.itoya}>${I.dropBags}`);
	expect(f?.properties.track).toBe(true);
	expect(f?.geometry.coordinates.length).toBeGreaterThan(100);
	await settle(page);
	await page.screenshot({ path: shotPath(`map/jp-estimate-place-${tag}.png`), animations: "disabled" });
	// Close up: the line follows the Chuo line through Otsuki, not a straight cut.
	await page.evaluate((coords) => {
		const m = (window as unknown as { __tripMap?: { fitBounds(b: number[][], o: object): void } }).__tripMap;
		const xs = coords.map((c) => c[0]);
		const ys = coords.map((c) => c[1]);
		m?.fitBounds(
			[
				[Math.min(...xs), Math.min(...ys)],
				[Math.max(...xs), Math.max(...ys)],
			],
			{ padding: 60, duration: 0 },
		);
	}, f?.geometry.coordinates ?? []);
	await settle(page);
	await page.screenshot({ path: shotPath(`map/jp-estimate-track-${tag}.png`), animations: "disabled" });
	expect(logs.messages).toEqual([]);
});

test("the shared filter lives in the URL and dims what doesn't match (ADDENDUM §10)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop controls");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place`);
	await mapReady(page, "place");
	await page.getByTestId(MAP_TESTID.filterButton).click();
	const menu = page.getByTestId(MAP_TESTID.filterMenu);
	await menu.getByRole("button", { name: "Shopping" }).click();
	await expect(page).toHaveURL(/f=g(%3A|:)shopping/);
	// Only `f` changes: the scope and lens stay.
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}/japan/tokyo\\?.*lens=place`));
	await expect(page.getByTestId(MAP_TESTID.filterChip)).toContainText("4 of 7 places");
	await expect
		.poll(async () => {
			const d = await drawn(page);
			return d.pins.find((p) => p.repId === c.ids.nodes.meijiJingu)?.opacity;
		})
		.toBeLessThan(0.5);
	// Close the menu with its button (Esc would also run the workspace's Esc chain).
	await page.getByTestId(MAP_TESTID.filterButton).click();
	await expect(menu).toHaveCount(0);
	await settle(page);
	await page.screenshot({ path: shotPath("map/filter-1440.png"), animations: "disabled" });
	await page.getByRole("button", { name: "Clear the filter" }).click();
	await expect(page).not.toHaveURL(/f=/);
	await expect(page.getByTestId(MAP_TESTID.filterChip)).toHaveCount(0);
});

test("the layer menu has the legend, Show switches and Selected days (MAP-08, DESIGN §5.1)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop controls");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?lens=city&days=2027-10-03`);
	await mapReady(page, "city");
	// "Only" (default): just that day's pins.
	let d = await drawn(page);
	expect(d.pins.map((p) => p.repId)).toEqual([c.ids.nodes.tokyo]);
	await page.getByTestId(MAP_TESTID.layersButton).click();
	const legend = page.getByTestId(MAP_TESTID.legend);
	for (const label of ["Walk", "Transit", "Flight", "Overnight", "Idea, not scheduled", "Several places"])
		await expect(legend).toContainText(label);
	await settle(page);
	await page.screenshot({ path: shotPath("map/layer-menu-1440.png"), animations: "disabled" });
	// "Dim others" keeps the rest of the trip, faded.
	await page.getByTestId(MAP_TESTID.dayMode).getByText("Dim others").click();
	await expect
		.poll(async () => (await drawn(page)).pins.filter((p) => !p.hollow).length)
		.toBeGreaterThan(1);
	d = await drawn(page);
	expect(d.pins.find((p) => p.repId === c.ids.nodes.kyoto)?.opacity).toBe(0.25);
	await page.getByTestId(MAP_TESTID.dayMode).getByText("Only").click();
	// Show ideas off removes hollow pins.
	await page.goto(`/t/${c.slug}?lens=city`);
	await mapReady(page, "city");
	expect((await drawn(page)).pins.some((p) => p.hollow)).toBe(true);
	await page.getByTestId(MAP_TESTID.layersButton).click();
	await page.getByTestId(MAP_TESTID.showIdeas).click();
	await expect.poll(async () => (await drawn(page)).pins.some((p) => p.hollow)).toBe(false);
	await page.getByTestId(MAP_TESTID.showIdeas).click();
});

test("screens: desktop 1440×900 and phone 390×844", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "viewports set here");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place`);
	await mapReady(page, "place");
	await settle(page);
	await page.screenshot({ path: shotPath("map/tokyo-place-1440.png"), animations: "disabled" });
	await page.goto(`/t/${c.slug}?lens=country`);
	await mapReady(page, "country");
	await settle(page);
	await page.screenshot({ path: shotPath("map/trip-country-1440.png"), animations: "disabled" });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/t/${c.slug}/japan?lens=city`);
	await mapReady(page, "city");
	await settle(page);
	await page.screenshot({ path: shotPath("map/japan-city-390.png"), animations: "disabled" });
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place`);
	await mapReady(page, "place");
	await settle(page);
	await page.screenshot({ path: shotPath("map/tokyo-place-390.png"), animations: "disabled" });
	expect(logs.messages).toEqual([]);
});

test("a view-only link guest gets the same map: selectable, filterable, no suggestion marks", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	const c = await cloneFixtureTrip(owner.request);
	await owner.close();
	const guestCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const guest = await guestCtx.newPage();
	const logs = collectConsole(guest, [/status of 40[13]/]);
	await guest.goto(`/join#t=${c.shareTokens.viewer}`);
	await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 30_000 });
	await guest.goto(`/t/${c.slug}/japan?lens=city`);
	await mapReady(guest, "city");
	const d = await drawn(guest);
	expect(d.pins.length).toBeGreaterThan(0);
	await expect(guest.locator(".yonder-pin.is-proposed")).toHaveCount(0);
	expect(d.edges.features.every((f) => !f.properties.proposed)).toBe(true);
	await guest.locator(`[data-testid="${TESTID.pin}"][data-rep-id="${c.ids.nodes.kyoto}"]`).click();
	await expect(guest).toHaveURL(new RegExp(`sel=n\\.${c.ids.nodes.kyoto}`));
	await guest.getByTestId(MAP_TESTID.filterButton).click();
	await guest.getByTestId(MAP_TESTID.filterMenu).getByRole("button", { name: "Shopping" }).click();
	await expect(guest).toHaveURL(/f=g(%3A|:)shopping/);
	expect(logs.messages).toEqual([]);
	await guestCtx.close();
});

test("zoomed well past the lens, a 'Show areas' chip switches the lens (DESIGN §9.4)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan?lens=city`);
	await mapReady(page, "city");
	await expect(page.getByTestId(MAP_TESTID.finerChip)).toHaveCount(0);
	await page.evaluate(() => {
		(window as unknown as MapWindow).__tripMap?.jumpTo({ center: [139.76, 35.68], zoom: 14.5 });
	});
	const chip = page.getByTestId(MAP_TESTID.finerChip);
	await expect(chip).toHaveText("Show areas");
	await chip.click();
	await expect(page).toHaveURL(/lens=area/);
});

test("on a phone, tapping a pin opens its details and the map stays full-bleed", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "phone layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan?lens=city`);
	await mapReady(page, "city");
	const box = await page.getByTestId(MAP_TESTID.canvas).boundingBox();
	const vp = page.viewportSize();
	expect(Math.round(box?.width ?? 0)).toBe(vp?.width);
	await page.locator(`[data-testid="${TESTID.pin}"][data-rep-id="${c.ids.nodes.kyoto}"]`).tap();
	await expect(page).toHaveURL(new RegExp(`sel=n\\.${c.ids.nodes.kyoto}`));
	await settle(page);
	await page.screenshot({ path: shotPath("map/phone-pin-selected.png"), animations: "disabled" });
	expect(logs.messages).toEqual([]);
});

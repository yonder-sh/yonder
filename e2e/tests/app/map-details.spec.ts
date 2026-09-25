/**
 * WP-Map, round 2: suggestion marks on the map (EXTENSIONS §1.4 WP-Map, E7),
 * the edge tooltip ("via Lunch", QA GRAN-06), the one-pin hint (QA GRAN-10),
 * the filter chip that reopens the shared filter (ADDENDUM §10) and panning
 * with 300 extra pins (SPEC §18.3 WP-Map). Each test clones its own trip
 * (SPEC §18.5) and reads the map through TI-6 (`window.__tripMap`).
 */
import { expect, type Page, test } from "@playwright/test";
import { MAP_TESTID } from "../../../src/features/map/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

type Feature = { properties: Record<string, unknown>; geometry: { coordinates: number[][] } };
type TripMapHandle = {
	loaded(): boolean;
	areTilesLoaded(): boolean;
	isMoving(): boolean;
	project(p: number[]): { x: number; y: number };
	getContainer(): HTMLElement;
	panBy(offset: [number, number], o?: object): void;
	__yonder?: {
		lens: string;
		pins: { repId: string; hollow: boolean; proposal: { name: string; deleted: boolean } | null }[];
		visiblePins: string[];
		edges: { features: Feature[] };
	};
};
type MapWindow = {
	__tripMap?: TripMapHandle;
	__tripMapStress?: (n: number) => void;
};

async function mapReady(page: Page, lens?: string) {
	await expect(page.getByTestId(MAP_TESTID.canvas)).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(
			() =>
				page.evaluate((lens) => {
					const m = (window as unknown as MapWindow).__tripMap;
					return !!m && m.loaded() && !!m.__yonder && (!lens || m.__yonder.lens === lens);
				}, lens),
			{ timeout: 30_000 },
		)
		.toBe(true);
}

async function settle(page: Page) {
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const m = (window as unknown as MapWindow).__tripMap;
					return !!m && m.loaded() && m.areTilesLoaded() && !m.isMoving();
				}),
			{ timeout: 20_000 },
		)
		.toBe(true);
	await page.waitForTimeout(300);
}

const drawn = (page: Page) =>
	page.evaluate(() => (window as unknown as MapWindow).__tripMap?.__yonder as NonNullable<TripMapHandle["__yonder"]>);

test("Maya's suggestions show as dashed rings with her avatar on the owner's map (E7)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request, { mayaRole: "suggester", proposals: true });
	expect(c.proposals?.ids.length ?? 0).toBeGreaterThan(0);
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place`);
	await mapReady(page, "place");
	// Itoya Ginza, moved to Day 1 by Maya: a dashed ring in her colour.
	const itoya = page.locator(`.yonder-pin:has([data-rep-id="${c.ids.nodes.itoya}"])`);
	await expect(itoya).toHaveClass(/is-proposed/);
	await expect(itoya.getByTestId(TESTID.pin)).toHaveAttribute("aria-label", /move suggested by Maya/);
	await settle(page);
	await page.screenshot({ path: shotPath("map/suggestions-tokyo-1440.png"), animations: "disabled" });
	// Shibuya Sky, suggested for removal: struck out, faded, same ring.
	await page.goto(`/t/${c.slug}/japan/tokyo/shibuya?lens=place`);
	await mapReady(page, "place");
	const sky = page.locator(`.yonder-pin:has([data-rep-id="${c.ids.nodes.shibuyaSky}"])`);
	await expect(sky).toHaveClass(/is-proposed-delete/);
	await expect(sky.getByTestId(TESTID.pin)).toHaveAttribute("aria-label", /removal suggested by Maya/);
	// Unmarked places stay plain (fewer badges).
	await expect(page.locator(`.yonder-pin:has([data-rep-id="${c.ids.nodes.hands}"])`)).not.toHaveClass(/is-proposed/);
	// The legend explains the dashed ring.
	await page.getByTestId(MAP_TESTID.layersButton).click();
	await expect(page.getByTestId(MAP_TESTID.legend)).toContainText("Suggested");
	await page.getByTestId(MAP_TESTID.layersButton).click();
	await settle(page);
	await page.screenshot({ path: shotPath("map/suggestions-1440.png"), animations: "disabled" });
	expect(logs.messages).toEqual([]);
});

/** A page point where `match`'s edge is the top hit, scanning along its line. */
async function hoverPointOnEdge(page: Page, match: (p: Record<string, unknown>) => boolean) {
	const f = (await drawn(page)).edges.features.find((x) => match(x.properties));
	if (!f) throw new Error("edge not drawn");
	const fid = f.properties.fid as string;
	return page.evaluate(
		({ coords, fid }) => {
			const m = (window as unknown as MapWindow).__tripMap as TripMapHandle & {
				queryRenderedFeatures(p: [number, number], o: object): { properties: { fid?: string } }[];
			};
			const r = m.getContainer().getBoundingClientRect();
			// Points along every segment: a rail estimate follows its track, and
			// two legs on the same line overlap for a stretch, so only some
			// points have this edge on top.
			const samples: number[][] = [];
			for (let s = 0; s + 1 < coords.length; s++) {
				const a = coords[s] as number[];
				const b = coords[s + 1] as number[];
				const n = coords.length === 2 ? 20 : 6;
				for (let i = 1; i < n; i++)
					samples.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
			}
			for (const c of samples) {
				const p = m.project(c);
				const hits = m.queryRenderedFeatures([p.x, p.y], { layers: ["yonder-edges-hit"] });
				const el = document.elementFromPoint(r.left + p.x, r.top + p.y);
				if (hits[0]?.properties.fid === fid && el?.tagName === "CANVAS")
					return { x: r.left + p.x, y: r.top + p.y };
			}
			return null;
		},
		{ coords: f.geometry.coordinates, fid },
	);
}

test("hovering an edge says what it stands for, 'via Lunch' included (GRAN-06)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "hover needs a mouse");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place`);
	await mapReady(page, "place");
	// Near Shibuya the Loft → Meiji and Meiji → Shibuya Sky lines run close
	// together: frame the Loft → Meiji edge alone. (In the merged app the
	// worker soon fills it with a rail estimate that follows the N02 track, so
	// frame whatever geometry it has once the model has settled.)
	await page.waitForTimeout(2_000);
	await settle(page);
	const loftMeiji = (x: Record<string, unknown>) => x.from === c.ids.nodes.loft && x.to === c.ids.nodes.meijiJingu;
	const coords = (await drawn(page)).edges.features.find((x) => loftMeiji(x.properties))?.geometry.coordinates as
		| number[][]
		| undefined;
	if (coords?.length)
		await page.evaluate((cs) => {
			const lngs = cs.map((p) => p[0] as number);
			const lats = cs.map((p) => p[1] as number);
			(window as unknown as { __tripMap: { fitBounds(b: number[][], o: object): void } }).__tripMap.fitBounds(
				[
					[Math.min(...lngs), Math.min(...lats)],
					[Math.max(...lngs), Math.max(...lats)],
				],
				{ padding: 120, duration: 0, maxZoom: 16 },
			);
		}, coords);
	await settle(page);
	// Shibuya Loft → Meiji Jingu skips the unlocated "Lunch" between them.
	const p = await hoverPointOnEdge(page, loftMeiji);
	expect(p).not.toBeNull();
	if (!p) return;
	await page.mouse.move(p.x, p.y);
	const tip = page.getByTestId(MAP_TESTID.edgeTip);
	await expect(tip).toBeVisible();
	await expect(tip).toContainText("Shibuya Loft → Meiji Jingu");
	await expect(tip).toContainText("via Lunch");
	await page.screenshot({ path: shotPath("map/edge-tooltip-1440.png"), animations: "disabled" });
	// Off the line (and off the map) it goes away.
	await page.mouse.move(5, 5);
	await expect(tip).toHaveCount(0);
	expect(logs.messages).toEqual([]);
});

test("a scope that is all one pin says so, with a finer lens one click away (GRAN-10)", async ({ page }) => {
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/mt-fuji?lens=area`);
	await mapReady(page, "area");
	const hint = page.getByTestId(MAP_TESTID.scopeHint);
	await expect(hint).toContainText("Everything here is in Kawaguchiko");
	await settle(page);
	await page.screenshot({
		path: shotPath(`map/one-pin-hint-${test.info().project.name === "mobile" ? "mobile" : "1440"}.png`),
		animations: "disabled",
	});
	// (On a phone the Plan sheet hides the rest from the accessibility tree.)
	await hint.locator("button", { hasText: "Show places" }).click();
	await expect(page).toHaveURL(/lens=place/);
	await mapReady(page, "place");
	await expect(hint).toHaveCount(0);
	expect(logs.messages).toEqual([]);
});

test("the filter chip names the filter and reopens it", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop controls");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place&f=g%3Ashopping`);
	await mapReady(page, "place");
	const chip = page.getByTestId(MAP_TESTID.filterChip);
	await expect(chip).toContainText("Shopping");
	await expect(chip).toContainText("4 of 7 places");
	await chip.getByRole("button", { name: /Change the filter/ }).click();
	await expect(page.getByTestId(MAP_TESTID.filterMenu)).toBeVisible();
	await page.getByTestId(MAP_TESTID.filterClear).click();
	await expect(page).not.toHaveURL(/f=/);
});

test("panning with 300 more pins keeps its frame rate (SPEC §18.3 WP-Map)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place`);
	await mapReady(page, "place");
	await settle(page);
	/** Frames during a 1.5 s scripted pan, and the slowest frame. */
	const pan = (dx: number) =>
		page.evaluate(
			(dx) =>
				new Promise<{ fps: number; worst: number; frames: number }>((resolve) => {
					const m = (window as unknown as MapWindow).__tripMap;
					if (!m) throw new Error("no map");
					const times: number[] = [];
					const t0 = performance.now();
					const tick = (t: number) => {
						times.push(t);
						if (t - t0 < 1500) requestAnimationFrame(tick);
						else {
							const gaps = times.slice(1).map((x, i) => x - (times[i] as number));
							resolve({
								fps: (times.length - 1) / ((t - (times[0] as number)) / 1000),
								worst: Math.max(...gaps),
								frames: times.length,
							});
						}
					};
					m.panBy([dx, 0], { duration: 1500, easing: (x: number) => x });
					requestAnimationFrame(tick);
				}),
			dx,
		);
	const base = await pan(300);
	await settle(page);
	await page.evaluate(() => (window as unknown as MapWindow).__tripMapStress?.(300));
	await expect.poll(async () => (await drawn(page)).visiblePins.length).toBeGreaterThan(250);
	await settle(page);
	const loaded = await pan(-300);
	info.annotations.push({
		type: "perf",
		description: `pan fps: ${base.fps.toFixed(1)} → ${loaded.fps.toFixed(1)} with 300 pins (worst frame ${base.worst.toFixed(0)} → ${loaded.worst.toFixed(0)} ms)`,
	});
	console.log(info.annotations.at(-1)?.description);
	await page.screenshot({ path: shotPath("map/stress-300-1440.png"), animations: "disabled" });
	// Headless Chromium draws WebGL and pins in software on a shared machine,
	// so absolute fps says little here (measured: ~55 → ~47). The guard is
	// against regressions such as re-rendering React on every frame, which
	// would cost far more than 30% of the frames.
	expect(loaded.fps).toBeGreaterThan(base.fps * 0.7);
});

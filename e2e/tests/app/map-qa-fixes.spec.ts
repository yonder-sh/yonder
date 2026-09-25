/**
 * WP-Map fix round 1 (I2 map-transit findings MT-02/03/12/13, SEC-R1-16),
 * on the QA seed (`pnpm db:seed:qa`, trip `asia-2027`, qa/SCENARIOS §1).
 * READ-ONLY on the seeded trip. Reads the map through TI-6 (`__tripMap`).
 *
 *   E2E_APP_LOG=… N pnpm e2e -- tests/app/map-qa-fixes.spec.ts --project chromium
 */
import { expect, type Page, test } from "@playwright/test";
import { MAP_TESTID } from "../../../src/features/map/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";

const TRIP = "asia-2027";

type TripMapWindow = {
	__tripMap?: {
		loaded(): boolean;
		isMoving(): boolean;
		getCenter(): { lng: number; lat: number };
		getZoom(): number;
		getContainer(): HTMLElement;
		project(p: number[]): { x: number; y: number };
		__yonder?: {
			lens: string;
			pins: { repId: string; name: string; lng: number; lat: number; hollow: boolean; number: number | null }[];
			clusters: { id: number; lng: number; lat: number; count: number; repIds: string[] }[];
			ghosts: { features: { properties: { label: string; fid: string } }[] };
		};
	};
	__yonder?: {
		graph: {
			nodes: { id: string; name: string }[];
			items: { id: string; nodeId: string | null; title: string | null }[];
		};
	};
};

test.skip(({ browserName }) => browserName !== "chromium", "one browser is enough");

test.beforeEach(async ({ page }) => {
	await loginViaApi(page.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
});

async function open(page: Page, url: string, lens?: string) {
	await page.goto(url);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId(MAP_TESTID.canvas)).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(
			() =>
				page.evaluate((lens) => {
					const m = (window as unknown as TripMapWindow).__tripMap;
					return !!m && m.loaded() && !!m.__yonder && (!lens || m.__yonder.lens === lens) && !m.isMoving();
				}, lens),
			{ timeout: 30_000 },
		)
		.toBe(true);
	await page.waitForTimeout(800);
}

const nodeId = (page: Page, name: string) =>
	page.evaluate(
		(n) => (window as unknown as TripMapWindow).__yonder?.graph.nodes.find((x) => x.name === n)?.id ?? null,
		name,
	);

test("MT-02: a click on the centre of the Tokyo pin opens Tokyo, not the idea under it (MAP-03)", async ({ page }) => {
	await open(page, `/t/${TRIP}/japan?lens=city`, "city");
	const tokyo = await nodeId(page, "Tokyo");
	expect(tokyo).toBeTruthy();
	// Every marker's z-index is an integer CSS keeps; visited pins stack over ideas.
	const z = await page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>(".maplibregl-marker")]
			.filter((m) => m.querySelector("[data-testid=pin]"))
			.map((m) => ({
				style: m.style.zIndex,
				computed: getComputedStyle(m).zIndex,
				hollow: !!m.querySelector("[data-hollow]"),
			})),
	);
	expect(z.length).toBeGreaterThan(1);
	for (const m of z) expect(m.computed).toBe(m.style);
	const visited = z.filter((m) => !m.hollow).map((m) => Number(m.computed));
	const ideas = z.filter((m) => m.hollow).map((m) => Number(m.computed));
	if (ideas.length) expect(Math.min(...visited)).toBeGreaterThan(Math.max(...ideas));

	const pin = page.locator(`[data-testid=${TESTID.pin}][data-rep-id="${tokyo}"]`);
	// Retried: a dev-server reload can swallow the click.
	await expect(async () => {
		const b = await pin.locator(".yonder-pin-face").boundingBox();
		if (!b) throw new Error("no Tokyo pin");
		const cx = b.x + b.width / 2;
		const cy = b.y + b.height / 2;
		const hit = await page.evaluate(
			([x, y]) =>
				document.elementFromPoint(x as number, y as number)?.closest("[data-testid=pin]")?.getAttribute("data-rep-id") ??
				null,
			[cx, cy],
		);
		expect(hit).toBe(tokyo);
		await page.mouse.click(cx, cy);
		await expect(page).toHaveURL(new RegExp(`sel=n\\.${tokyo}`), { timeout: 3_000 });
	}).toPass({ timeout: 30_000 });
});

test("MT-03: a leg deep link on the root globe keeps the trip's countries in view, clear of the inspector (MAP-01)", async ({ page }) => {
	await open(page, `/t/${TRIP}?tab=plan`, "country");
	const pair = await page.evaluate(() => {
		const g = (window as unknown as TripMapWindow).__yonder?.graph;
		const byName = (n: string) => g?.items.find((i) => (g.nodes.find((x) => x.id === i.nodeId)?.name ?? "").includes(n));
		const a = byName("Kappabashi");
		const b = byName("Nihonbashi Nishikawa");
		return a && b ? `${a.id}.${b.id}` : null;
	});
	expect(pair).toBeTruthy();
	await open(page, `/t/${TRIP}?sel=l.${pair}`, "country");
	await expect(page.getByTestId(TESTID.inspector).first()).toBeVisible();
	const view = await page.evaluate(() => {
		const m = (window as unknown as TripMapWindow).__tripMap;
		if (!m?.__yonder) return null;
		const W = m.getContainer().clientWidth;
		const inspector = document.querySelector("[data-testid=inspector]")?.getBoundingClientRect();
		const map = m.getContainer().getBoundingClientRect();
		const japan = m.__yonder.pins.find((p) => p.name === "Japan");
		return {
			center: m.getCenter(),
			japan: japan ? m.project([japan.lng, japan.lat]) : null,
			japanLngLat: japan ? [japan.lng, japan.lat] : null,
			uncoveredRight: inspector ? inspector.left - map.left : W,
		};
	});
	expect(view).not.toBeNull();
	if (!view?.japan || !view.japanLngLat) throw new Error("no Japan pin");
	// Looking at Asia and the Pacific, not the far side of the Earth (lng −2.4 before).
	const lng = ((view.center.lng % 360) + 360) % 360;
	expect(lng).toBeGreaterThan(80);
	expect(lng).toBeLessThan(200);
	// Japan is on the visible hemisphere and in the part the inspector doesn't cover.
	const toRad = (d: number) => (d * Math.PI) / 180;
	const [jl, jp] = view.japanLngLat as [number, number];
	const cosD =
		Math.sin(toRad(view.center.lat)) * Math.sin(toRad(jp)) +
		Math.cos(toRad(view.center.lat)) * Math.cos(toRad(jp)) * Math.cos(toRad(jl - view.center.lng));
	expect(cosD).toBeGreaterThan(0.3);
	expect(view.japan.x).toBeGreaterThan(0);
	expect(view.japan.x).toBeLessThan(view.uncoveredRight);
});

test("MT-12: a day-range stub points at the next located stop, not 'to Japan' (GRAN-14)", async ({ page }) => {
	for (const lens of ["area", "place"]) {
		await open(page, `/t/${TRIP}?lens=${lens}&days=2027-10-05`, lens);
		const labels = await page.evaluate(() =>
			((window as unknown as TripMapWindow).__tripMap?.__yonder?.ghosts.features ?? []).map((f) => f.properties.label),
		);
		expect(labels.length).toBeGreaterThan(0);
		expect(labels).not.toContain("to Japan");
		expect(labels.some((l) => l.startsWith("to ") && /Meiji|Harajuku/.test(l))).toBe(true);
	}
});

test("MT-13: cluster chips never overlap at a day's default fit (GRAN-09)", async ({ page }) => {
	await open(page, `/t/${TRIP}?lens=place&days=2027-10-05`, "place");
	const chips = await page.evaluate(() => {
		const m = (window as unknown as TripMapWindow).__tripMap;
		return (m?.__yonder?.clusters ?? []).map((c) => m?.project([c.lng, c.lat]) ?? { x: 0, y: 0 });
	});
	for (let i = 0; i < chips.length; i++)
		for (let j = i + 1; j < chips.length; j++) {
			const a = chips[i] as { x: number; y: number };
			const b = chips[j] as { x: number; y: number };
			expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(26);
		}
});

test("SEC-R1-16 / ERR-06: blocked tiles say 'Map tiles couldn't load', pins stay", async ({ page }) => {
	await page.route(/tiles\.openfreemap\.org/, (r) => r.abort());
	await page.goto(`/t/${TRIP}/japan/tokyo`);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId(MAP_TESTID.tilesError)).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId(MAP_TESTID.tilesError)).toContainText("Map tiles couldn't load");
	await expect(page.getByTestId(TESTID.pin).first()).toBeVisible();
	await page.unroute(/tiles\.openfreemap\.org/);
});

// ---- fix round 2 -------------------------------------------------------------

test("MT-R2-02: with a leg inspector open on the root globe, every located pin clears the inspector (MAP-01)", async ({
	page,
}) => {
	await open(page, `/t/${TRIP}?tab=plan`, "country");
	const pair = await page.evaluate(() => {
		const g = (window as unknown as TripMapWindow).__yonder?.graph;
		const byName = (n: string) => g?.items.find((i) => (g.nodes.find((x) => x.id === i.nodeId)?.name ?? "").includes(n));
		const a = byName("Kappabashi");
		const b = byName("Nihonbashi Nishikawa");
		return a && b ? `${a.id}.${b.id}` : null;
	});
	expect(pair).toBeTruthy();
	await open(page, `/t/${TRIP}?sel=l.${pair}`, "country");
	await expect(page.getByTestId(TESTID.inspector).first()).toBeVisible();
	const view = await page.evaluate(() => {
		const m = (window as unknown as TripMapWindow).__tripMap;
		if (!m?.__yonder) return null;
		const inspector = document.querySelector("[data-testid=inspector]")?.getBoundingClientRect();
		const map = m.getContainer().getBoundingClientRect();
		return {
			free: inspector ? inspector.left - map.left : map.width,
			pins: m.__yonder.pins
				.filter((p) => !p.hollow)
				.map((p) => ({ name: p.name, x: m.project([p.lng, p.lat]).x })),
		};
	});
	expect(view?.pins.map((p) => p.name)).toContain("USA");
	// A country pin is 28px: its whole face sits left of the inspector (USA was at x=225 of 223 free).
	for (const p of view?.pins ?? []) {
		expect(p.x, p.name).toBeGreaterThan(14);
		expect(p.x + 14, p.name).toBeLessThan(view?.free ?? 0);
	}
});

test("PLAN-R2-04 / MT-R2-01 / VIS2-05: known flights and taxi rides draw solid; only estimates and proposals are dashed (ADDENDUM §10)", async ({
	page,
}) => {
	await open(page, `/t/${TRIP}?tab=plan`, "country");
	const paint = await page.evaluate(() => {
		const m = (window as unknown as { __tripMap?: { getPaintProperty(id: string, p: string): unknown } }).__tripMap;
		const get = (id: string, p: string) => JSON.stringify(m?.getPaintProperty(id, p) ?? null);
		return {
			flight: get("yonder-edges-flight", "line-dasharray"),
			flightGap: get("yonder-edges-flight", "line-gap-width"),
			other: get("yonder-edges-other", "line-dasharray"),
			transit: get("yonder-edges-transit", "line-dasharray"),
			stay: get("yonder-edges-stay", "line-dasharray"),
			unset: get("yonder-edges-unset", "line-dasharray"),
			transitEst: get("yonder-edges-transit-est", "line-dasharray"),
		};
	});
	expect(paint.flight).toBe("null");
	expect(paint.flightGap).not.toBe("null");
	expect(paint.other).toBe("null");
	expect(paint.transit).toBe("null");
	// Stays are dots (a zero-length dash with round caps), not dashes.
	expect(JSON.parse(paint.stay)[0]).toBeLessThan(0.1);
	expect(paint.unset).not.toBe("null");
	expect(paint.transitEst).not.toBe("null");

	// The legend matches (VIS2-05), and its popover is a named dialog (VIS2-03, axe aria-dialog-name).
	await page.getByRole("button", { name: "Map layers and legend" }).click();
	const menu = page.getByRole("dialog", { name: "Map layers and legend" });
	await expect(menu).toBeVisible();
	const kind = (label: string) =>
		menu.getByText(label, { exact: true }).locator("xpath=..").locator("svg").getAttribute("data-line");
	expect(await kind("Flight")).toBe("double");
	expect(await kind("Taxi, car, ferry…")).toBe("solid");
	expect(await kind("Estimate (rail network, no timetable)")).toBe("dashed");
});

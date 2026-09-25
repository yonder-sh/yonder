/**
 * WP-Transit with a Routes key (QA TR-02, TR-03, TR-05, TR-06; TI-4). Runs
 * only when the app was started against the Routes stub:
 *
 *   E2E_ROUTES_STUB=1 pnpm e2e -- tests/app/transit-google.spec.ts
 *
 * (the Playwright config starts `e2e/stubs/routes-stub.mjs` on APP_PORT + 3,
 * starts the app with `GOOGLE_MAPS_API_KEY=stub GOOGLE_ROUTES_URL=…` and sets
 * `E2E_ROUTES_STUB_URL`; a dev server that is already running is reused as it
 * is, so start that one with the same two variables).
 *
 * - Seoul transit options come from the stub fastest first (Chuo Rapid 15 min
 *   chosen), the stub got a `departureTime` inside Google's window on the same
 *   weekday and local time (the trip is in 2027), and the UI says "typical";
 *   picking the local makes the leg 19 min.
 * - 429 and 500 answers show a calm message with the manual form ready.
 * - A Tokyo walk is filled from Google WALK (source "Google").
 */
import { expect, type Page, test } from "@playwright/test";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });
// One Routes stub with shared counters and queued failures: run these in order.
test.describe.configure({ mode: "serial" });

const STUB = process.env.E2E_ROUTES_STUB_URL;

type Leg = { fromItemId: string | null; toItemId: string | null; mode: string | null; durationMin: number | null; source: string };
type YonderWindow = { __yonder?: { graph: { legs: Leg[]; nodes: { id: string; name: string }[] } } };

async function callFn(page: Page, module: string, fn: string, data: unknown) {
	return page.evaluate(
		async ({ module, fn, data }) => {
			const m = await import(module);
			return m[fn]({ data });
		},
		{ module, fn, data },
	);
}

/** Two new places in Seoul (unique coordinates so nothing comes from the cache), after ICN on day 5. */
async function seoulPair(page: Page, c: FixtureClone, near = false): Promise<[string, string]> {
	const jitter = () => (Math.random() - 0.5) * 0.002;
	const place = async (name: string, lat: number, lng: number, afterItemId: string) => {
		const { nodeId } = (await callFn(page, "/src/functions/nodes.functions.ts", "createNode", {
			tripId: c.tripId,
			parentId: c.ids.nodes.seoul,
			type: "place",
			category: "sight",
			name,
			lat: lat + jitter(),
			lng: lng + jitter(),
		})) as { nodeId: string };
		const { itemId } = (await callFn(page, "/src/functions/items.functions.ts", "createItem", {
			tripId: c.tripId,
			dayId: c.ids.days.d5,
			nodeId,
			afterItemId,
		})) as { itemId: string };
		return itemId;
	};
	const a = await place("Gyeongbokgung", 37.5796, 126.977, c.ids.items.icn);
	// `near`: a walk suggestion, so the worker's autofill never calls Routes TRANSIT.
	const b = near
		? await place("Gwanghwamun", 37.5759, 126.9768, a)
		: await place("Myeongdong", 37.5636, 126.9869, a);
	return [a, b];
}

const legOf = (page: Page, from: string, to: string) =>
	page.evaluate(
		([f, t]) =>
			(window as unknown as YonderWindow).__yonder?.graph.legs.find((l) => l.fromItemId === f && l.toItemId === t) ?? null,
		[from, to] as const,
	);

test.beforeAll(async ({ request }, info) => {
	test.skip(!STUB, "E2E_ROUTES_STUB_URL not set (the app isn't running against the Routes stub)");
	// Desktop only: a second project resetting the shared stub would race.
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const res = await request.post(`${STUB}/__stub/reset`);
	expect(res.ok()).toBe(true);
});

test("Seoul transit options come from Google, fastest first, on a proxy date (typical schedule)", async ({ page, request }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const [a, b] = await seoulPair(page, c);
	await page.goto(`/t/${c.slug}?sel=l.${a}.${b}`);
	await expectLive(page);
	const overview = page.getByTestId(TESTID.legOverview);
	await overview.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
	const options = overview.getByTestId(T.transitOption);
	await expect(options).toHaveCount(3, { timeout: 20_000 });
	await expect(options.first()).toHaveAttribute("data-source", "google");
	await expect(options.first()).toContainText("Chuo Rapid");
	await expect(options.first()).toHaveAttribute("data-chosen", "true");
	await expect(options.first().getByTestId(T.fastestBadge)).toBeVisible();
	await expect(overview.getByTestId(T.transitPanel)).toContainText("typical");
	await expect.poll(async () => (await legOf(page, a, b))?.durationMin).toBe(15);

	// The stub saw a departure inside [now, now + 95 d], same weekday and local time.
	const calls = (await (await request.get(`${STUB}/__stub/calls`)).json()) as {
		requests: { mode: string; body: { departureTime?: string } }[];
	};
	const transit = calls.requests.filter((r) => r.mode === "TRANSIT").at(-1);
	const sent = Date.parse(transit?.body.departureTime ?? "");
	expect(sent).toBeGreaterThanOrEqual(Date.now() - 60_000);
	expect(sent).toBeLessThanOrEqual(Date.now() + 96 * 86_400_000);
	expect(transit?.body.departureTime?.startsWith("2027")).toBe(false);
	await page.screenshot({ path: shotPath("transit/google-options.png"), animations: "disabled" });

	// Choosing the local: 19 min.
	await options.filter({ hasText: "Chuo-Sobu" }).getByTestId(T.transitOptionChoose).click();
	await expect.poll(async () => (await legOf(page, a, b))?.durationMin).toBe(19);
	await page.reload();
	await expectLive(page);
	await expect(page.getByTestId(T.transitOption).filter({ hasText: "Chuo-Sobu" })).toHaveAttribute("data-chosen", "true");
});

test("Routes errors show a calm message with the manual form ready", async ({ page, request }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const [a, b] = await seoulPair(page, c, true);
	await page.goto(`/t/${c.slug}?sel=l.${a}.${b}`);
	await expectLive(page);
	const overview = page.getByTestId(TESTID.legOverview);
	await request.post(`${STUB}/__stub/next`, { data: { status: 429, times: 1 } });
	await overview.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
	await expect(overview.getByTestId(T.transitError)).toContainText("busy", { timeout: 20_000 });
	await expect(overview.getByTestId(T.customRouteAdd)).toBeEnabled();
	await request.post(`${STUB}/__stub/next`, { data: { status: 500, times: 1 } });
	await overview.getByTestId(T.transitRefresh).click();
	await expect(overview.getByTestId(T.transitError)).toContainText("unavailable");
	await page.screenshot({ path: shotPath("transit/google-error.png"), animations: "disabled" });
});

test("a Tokyo walk is filled from Google WALK", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?sel=l.${I.sensoji}.${I.knives}`);
	await expectLive(page);
	const overview = page.getByTestId(TESTID.legOverview);
	await overview.locator(`[data-testid=${T.modeOption}][data-mode=walk]`).click();
	await expect(overview.getByTestId(T.walkPanel)).toBeVisible();
	// The worker may have filled it already (OSRM before the key): measure again.
	const again = overview.getByRole("button", { name: "Recalculate" });
	if (await again.isVisible()) await again.click();
	await expect(overview.getByTestId(T.walkSource)).toHaveText("Google", { timeout: 20_000 });
	expect((await legOf(page, I.sensoji, I.knives))?.source).toBe("google");
});

/**
 * Owner feedback round 3, flights (docs/qa/FEEDBACK-3.md):
 * - FB-19: add a JFK item, then a Haneda item on the next day → a Flight leg
 *   appears by itself, prefilled with both airports and dates, no times, no
 *   number (FB-18: "~14h 5m est. · times TBD").
 * - Switched to Train it stays Train, also after a reorder.
 * - Adding times later makes it a timed flight.
 * - FB-19a, the owner's test trip: JFK pinned 00:00 for 2 h, then the flight
 *   at 02:00 (Sat 12 Dec 2026) is NOT "Misses … by 2h".
 *
 * Each test makes its own trip through the real server functions (the items
 * are added the way the Plan adds them), then drives the Plan and the leg
 * editor. Screenshots: `e2e/shots/flights/`.
 */
import { expect, type Page, test } from "@playwright/test";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath } from "./_helpers/env";
import { collectConsole, expectLive } from "./_helpers/page";

test.describe.configure({ mode: "default" });

type Leg = {
	fromItemId: string | null;
	toItemId: string | null;
	mode: string | null;
	source: string;
	isEdited: boolean;
	depAt: string | null;
	arrAt: string | null;
	details: { kind?: string; flight?: Record<string, unknown> };
};
type Graph = { legs: Leg[]; days: { id: string; date: string; startTime: string }[] };

const graphOf = (page: Page) =>
	page.evaluate(() => (window as unknown as { __yonder?: { graph: Graph } }).__yonder?.graph ?? null);
const legOf = async (page: Page, from: string, to: string) =>
	(await graphOf(page))?.legs.find((l) => l.fromItemId === from && l.toItemId === to) ?? null;

type TestTrip = { slug: string; tripId: string; jfk: string; hnd: string; shibuya: string };

/**
 * The owner's test trip: Sat 12 – Mon 14 Dec 2026; JFK ("John F. Kennedy
 * International Airport", a place) pinned 00:00 for 2 h on the 12th, then
 * Haneda ("Haneda Airport", an area) and Shibuya on the 13th.
 */
async function ownersTestTrip(page: Page): Promise<TestTrip> {
	await page.goto("/dashboard");
	return page.evaluate(async () => {
		const trips = await import("/src/functions/trips.functions.ts");
		const nodes = await import("/src/functions/nodes.functions.ts");
		const items = await import("/src/functions/items.functions.ts");
		const graphs = await import("/src/functions/graph.functions.ts");
		const { tripId, slug } = await trips.createTrip({
			data: {
				name: "test",
				startDate: "2026-12-12",
				endDate: "2026-12-14",
				defaultTz: "America/New_York",
			},
		});
		const path = async (chain: unknown[]) => (await nodes.createNodePath({ data: { tripId, chain } as never })).nodeIds;
		const [, , jfk] = await path([
			{ type: "country", name: "United States", countryCode: "US" },
			{ type: "city", name: "New York", lat: 40.7128, lng: -74.006 },
			{ type: "place", name: "John F. Kennedy International Airport", lat: 40.6413, lng: -73.7781 },
		]);
		const [, tokyo, hnd] = await path([
			{ type: "country", name: "Japan", countryCode: "JP" },
			{ type: "city", name: "Tokyo", lat: 35.6762, lng: 139.6503 },
			{ type: "area", name: "Haneda Airport", lat: 35.5494, lng: 139.7798 },
		]);
		const [, shibuya] = await path([{ id: tokyo }, { type: "area", name: "Shibuya", lat: 35.6595, lng: 139.7004 }]);
		const g = await graphs.getTripGraph({ data: { tripId } });
		const day = (date: string) => g.days.find((d: { date: string }) => d.date === date)?.id as string;
		const add = async (date: string, nodeId: string, extra: Record<string, unknown> = {}) =>
			(await items.createItem({ data: { tripId, dayId: day(date), nodeId, ...extra } as never })).itemId as string;
		return {
			slug,
			tripId,
			jfk: await add("2026-12-12", jfk as string, { pinnedStart: "00:00", durationMin: 120 }),
			hnd: await add("2026-12-13", hnd as string, { durationMin: 60 }),
			shibuya: await add("2026-12-13", shibuya as string, { durationMin: 90 }),
		};
	});
}

async function moveItem(page: Page, t: TestTrip, itemId: string, where: { afterItemId?: string; beforeItemId?: string }) {
	await page.evaluate(
		async ({ tripId, itemId, where }) => {
			const items = await import("/src/functions/items.functions.ts");
			const graphs = await import("/src/functions/graph.functions.ts");
			const g = await graphs.getTripGraph({ data: { tripId } });
			const dayId = g.items.find((i: { id: string }) => i.id === itemId)?.dayId;
			await items.moveItem({ data: { itemId, dayId, ...where } });
		},
		{ tripId: t.tripId, itemId, where },
	);
}

/** Phones: pull the Plan sheet up so the timeline shows (the map is behind it). */
async function showPlan(page: Page, project: string) {
	if (project !== "mobile") return;
	const sheet = page.getByTestId(TESTID.mobileSheet);
	const box = await sheet.boundingBox();
	if (!box) throw new Error("no sheet");
	const x = (page.viewportSize()?.width ?? 400) / 2;
	await page.mouse.move(x, box.y + 12);
	await page.mouse.down();
	await page.mouse.move(x, box.y - 250, { steps: 8 });
	await page.mouse.move(x, 60, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(800);
}

// One account per test: parallel projects never read each other's OTP, and
// the per-account trip limit (20 an hour) never trips a rerun.
test.beforeEach(async ({ page }, info) => {
	const who = `fb19-${info.project.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	await loginViaApi(page.request, `${who}@example.test`, { first: "Dennis", last: "Tester" });
});

test("FB-19: JFK then Haneda on the next day → a Flight leg, prefilled, no times", async ({ page }, info) => {
	const logs = collectConsole(page);
	const t = await ownersTestTrip(page);
	await page.goto(`/t/${t.slug}?tab=plan`);
	await expectLive(page);

	// The real leg row: a flight nobody chose, both airports and dates, no times.
	await expect.poll(async () => (await legOf(page, t.jfk, t.hnd))?.mode).toBe("flight");
	const leg = await legOf(page, t.jfk, t.hnd);
	expect(leg).toMatchObject({ source: "estimate", isEdited: false, depAt: null, arrAt: null });
	expect(leg?.details.flight).toMatchObject({
		from: { iata: "JFK" },
		to: { iata: "HND" },
		depDate: "2026-12-12",
		arrDate: "2026-12-13",
	});
	expect(leg?.details.flight?.flightNumber).toBeUndefined();

	// The Plan draws it as a flight stub: "Flight · ~14h05 est. · times TBD".
	const stub = page.getByTestId(PLAN_TESTID.flightStub).first();
	await expect(stub).toBeVisible();
	await expect(stub).toContainText("JFK");
	await expect(stub).toContainText("HND");
	await expect(stub).toContainText("~14h05 est.");
	await expect(stub.getByTestId(PLAN_TESTID.flightTbd)).toHaveText("· times TBD");
	await expect(stub).not.toContainText("undefined");
	await expect(page.getByText(/Misses/)).toHaveCount(0);
	await showPlan(page, info.project.name);
	await stub.scrollIntoViewIfNeeded();
	await page.screenshot({ path: shotPath(`flights/fb19-auto-flight-${info.project.name}.png`), fullPage: false });

	if (info.project.name === "chromium") {
		// The leg editor: Flight is chosen, the summary reads the estimate.
		await page.goto(`/t/${t.slug}?sel=l.${t.jfk}.${t.hnd}`);
		await expectLive(page);
		const overview = page.getByTestId(TESTID.legOverview);
		await expect(overview.locator(`[data-testid=${T.modeOption}][data-mode=flight]`)).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(overview.getByTestId(T.flightLine)).toHaveText("Flight · JFK → HND · ~14h 5m est. · times TBD");
		await page.screenshot({ path: shotPath("flights/fb19-leg-editor.png") });
	}
	expect(logs.messages).toEqual([]);
});

test("FB-19: switched to Train it stays Train after a reorder", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const logs = collectConsole(page);
	const t = await ownersTestTrip(page);
	await page.goto(`/t/${t.slug}?sel=l.${t.jfk}.${t.hnd}`);
	await expectLive(page);
	await expect.poll(async () => (await legOf(page, t.jfk, t.hnd))?.mode).toBe("flight");

	const overview = page.getByTestId(TESTID.legOverview);
	await overview.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
	await expect.poll(async () => (await legOf(page, t.jfk, t.hnd))?.mode).toBe("transit");

	// Reorder: Shibuya before Haneda (JFK → HND stops being adjacent), then back.
	await moveItem(page, t, t.shibuya, { beforeItemId: t.hnd });
	// Meanwhile JFK → Shibuya is no default flight (Shibuya isn't an airport).
	await expect.poll(async () => (await legOf(page, t.jfk, t.shibuya))?.mode ?? null).not.toBe("flight");
	await moveItem(page, t, t.shibuya, { afterItemId: t.hnd });
	await page.reload();
	await expectLive(page);
	await expect.poll(async () => (await legOf(page, t.jfk, t.hnd))?.mode).toBe("transit");
	// No flight stub for it any more.
	await expect(page.getByTestId(PLAN_TESTID.flightStub)).toHaveCount(0);
	await expect(
		page.getByTestId(TESTID.legOverview).locator(`[data-testid=${T.modeOption}][data-mode=transit]`),
	).toHaveAttribute("aria-selected", "true");
	await page.screenshot({ path: shotPath("flights/fb19-stays-train.png") });
	expect(logs.messages).toEqual([]);
});

test("FB-18 + FB-19a: times added later make it timed; JFK 00:00 for 2 h then 02:00 isn't missed", async ({
	page,
}, info) => {
	const logs = collectConsole(page);
	const t = await ownersTestTrip(page);
	await page.goto(`/t/${t.slug}?sel=l.${t.jfk}.${t.hnd}`);
	await expectLive(page);
	await expect.poll(async () => (await legOf(page, t.jfk, t.hnd))?.mode).toBe("flight");

	const overview = page.getByTestId(TESTID.legOverview);
	await overview.getByTestId(T.flightEdit).click();
	const form = overview.getByTestId(T.flightForm);
	// Prefilled: both airports and dates, no number, no times.
	await expect(form.getByTestId(T.flightFrom)).toHaveValue("JFK");
	await expect(form.getByTestId(T.flightTo)).toHaveValue("HND");
	await expect(form.getByTestId(T.flightDepDate)).toHaveValue("2026-12-12");
	await expect(form.getByTestId(T.flightArrDate)).toHaveValue("2026-12-13");
	await expect(form.getByTestId(T.flightNumber)).toHaveValue("");
	await form.getByTestId(T.flightNumber).fill("NH 744");
	await form.getByRole("textbox", { name: "Departure time" }).fill("02:00");
	await form.getByRole("textbox", { name: "Arrival time" }).fill("05:25");
	// 02:00 EST (December) → 05:25 JST next day.
	await expect(form.getByTestId(T.flightDuration)).toHaveText("13h 25m flight");
	await form.getByTestId(T.flightSave).click();

	await expect.poll(async () => (await legOf(page, t.jfk, t.hnd))?.depAt).toBe("2026-12-12T07:00:00.000Z");
	const leg = await legOf(page, t.jfk, t.hnd);
	expect(leg).toMatchObject({ source: "manual", isEdited: true, arrAt: "2026-12-12T20:25:00.000Z" });
	const summary = overview.getByTestId(T.flightSummary);
	await expect(summary).toContainText("NH 744");
	await expect(summary).toContainText("EST"); // FB-20: December at JFK
	await expect(summary).toContainText("JST");

	// FB-19a: no "Misses NH 744 by 2h" anywhere, no conflict chip.
	await page.goto(`/t/${t.slug}?tab=plan`);
	await expectLive(page);
	const stub = page.getByTestId(PLAN_TESTID.flightStub).first();
	await expect(stub).toContainText("02:00");
	await expect(stub).toContainText("05:25");
	await expect(stub).toContainText("NH 744");
	await expect(page.getByText(/Misses/)).toHaveCount(0);
	await expect(page.getByTestId(TESTID.conflictBadge)).toHaveCount(0);
	await showPlan(page, info.project.name);
	await stub.scrollIntoViewIfNeeded();
	await page.screenshot({ path: shotPath(`flights/fb19a-no-missed-${info.project.name}.png`) });
	expect(logs.messages).toEqual([]);
});

/**
 * WP-Plan at trip scale (QA PERF-01/04/05, MAP-07; ADDENDUM §10 "PERF-05").
 * The demo clone is grown to the size of Asia 2027 — 35 days, eight stops a
 * day with their legs, and a 40-stop day — straight in its own database rows
 * (the fixture route only clones the 5-day demo). Then:
 * - the first screens render, the rest of the trip is spacers that keep every
 *   day's header, and scrolling to the end renders the last day;
 * - a selection on Day 30 (a deep link, as a map pin would set) renders and
 *   shows its card;
 * - a duration change on the 40-stop day reflows every time there, with the
 *   long tasks recorded. The budgets (LCP < 2.5 s, no long task > 100 ms) are
 *   asserted on a production build (`VITE_E2E=1 pnpm build`); on the dev
 *   server the numbers are only logged as "perf" annotations;
 * - screenshots of the long trip at 1440×900 and 390×844.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import pg from "pg";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

const card = (page: Page, itemId: string): Locator =>
	page.locator(`[data-testid="${TESTID.timelineItem}"][data-item-id="${itemId}"]`).first();

const section = (page: Page, dayId: string): Locator =>
	page.locator(`[data-testid="${PLAN_TESTID.daySection}"][data-day-id="${dayId}"]`).first();

/** "dev" on the Vite dev server, else "production" (SPEC PERF budgets are for the production build). */
const buildOf = (page: Page) =>
	page.evaluate(() =>
		performance.getEntriesByType("resource").some((r) => /\/@vite\/client|\/@react-refresh|\/src\//.test(r.name))
			? "dev"
			: "production",
	);

/** A timing worth reading in the report (and in the list reporter's output). */
function perf(info: import("@playwright/test").TestInfo, description: string) {
	info.annotations.push({ type: "perf", description });
	console.log(`[perf] ${description}`);
}

type Grown = { dayIds: string[]; items: string[][]; busyDayId: string };

/** Adds 30 days after the demo's five (8 stops each; the first new day has 40) with walk legs. */
async function growTo35Days(tripId: string): Promise<Grown> {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL is not set (the Playwright config reads ../.env)");
	const db = new pg.Client({ connectionString: url });
	await db.connect();
	try {
		await db.query("BEGIN");
		const days = (
			await db.query<{ id: string; date: string }>(
				"select id, date::text as date from trip_days where trip_id = $1 order by date",
				[tripId],
			)
		).rows;
		const places = (
			await db.query<{ id: string }>(
				`select id from nodes where trip_id = $1 and type = 'place' and deleted_at is null
				 and (category is null or category not in ('airport', 'lodging')) order by position, id`,
				[tripId],
			)
		).rows.map((r) => r.id);
		const last = days.at(-1)?.date;
		if (!last || places.length === 0) throw new Error("unexpected fixture shape");
		const dayIds = days.map((d) => d.id);
		const items: string[][] = days.map(() => []);
		let p = 0;
		let lastDate = last;
		for (let d = 1; d <= 30; d++) {
			const date = (
				await db.query<{ date: string }>("select ($1::date + $2::int)::text as date", [last, d])
			).rows[0]?.date as string;
			lastDate = date;
			const dayId = (
				await db.query<{ id: string }>(
					"insert into trip_days (id, trip_id, date, start_time) values (gen_random_uuid(), $1, $2, '08:00') returning id",
					[tripId, date],
				)
			).rows[0]?.id as string;
			dayIds.push(dayId);
			const n = d === 1 ? 40 : 8;
			const ids: string[] = [];
			for (let j = 0; j < n; j++) {
				const lunch = j === 3;
				const pos = `a${j.toString(36).padStart(1, "0")}`;
				const position = j < 36 ? pos : `b${(j - 36).toString().padStart(2, "0")}`;
				const id = (
					await db.query<{ id: string }>(
						`insert into items (id, trip_id, day_id, node_id, title, position, duration_min, pinned_start)
						 values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) returning id`,
						[
							tripId,
							dayId,
							lunch ? null : places[p++ % places.length],
							lunch ? "Lunch" : null,
							position,
							d === 1 ? 15 : 45 + ((d + j) % 4) * 15,
							j === 5 && d % 2 === 0 ? "15:30" : null,
						],
					)
				).rows[0]?.id as string;
				ids.push(id);
			}
			// Legs join consecutive located stops (Lunch is a block, so travel skips it).
			const located = ids.filter((_, j) => j !== 3);
			for (let j = 1; j < located.length; j++)
				await db.query(
					`insert into legs (id, trip_id, kind, from_item_id, to_item_id, mode, duration_min, source)
					 values (gen_random_uuid(), $1, 'pair', $2, $3, 'walk', $4, 'manual')`,
					[tripId, located[j - 1], located[j], 5 + ((d + j) % 4) * 5],
				);
			items.push(ids);
		}
		await db.query("update trips set end_date = $2, version = version + 1 where id = $1", [tripId, lastDate]);
		await db.query("COMMIT");
		return { dayIds, items, busyDayId: dayIds[5] as string };
	} catch (e) {
		await db.query("ROLLBACK");
		throw e;
	} finally {
		await db.end();
	}
}

/** Scrolls the Plan's own scroller (not the page) to its end. */
async function scrollPlanToEnd(page: Page) {
	await page.getByTestId(TESTID.planTab).evaluate((root) => {
		let el: HTMLElement | null = root.parentElement;
		while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
		(el ?? document.scrollingElement)?.scrollTo({ top: 1e7 });
	});
}

test("a 35-day trip renders its first screens, keeps every day's header, and renders the rest on scroll", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const g = await growTo35Days(c.tripId);
	await page.setViewportSize({ width: 1440, height: 900 });

	const t0 = Date.now();
	await page.goto(`/t/${c.slug}?lens=place`);
	await expect(card(page, c.ids.items.hands as string)).toBeVisible();
	const firstCardMs = Date.now() - t0;
	await expectLive(page);
	const nav = await page.evaluate(
		() =>
			new Promise<{ dcl: number | null; lcp: number | null }>((resolve) => {
				const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
				new PerformanceObserver((l) => {
					const lcp = l.getEntries().at(-1)?.startTime ?? null;
					resolve({ dcl: n ? Math.round(n.domContentLoadedEventEnd) : null, lcp: lcp && Math.round(lcp) });
				}).observe({ type: "largest-contentful-paint", buffered: true });
			}),
	);
	const build = await buildOf(page);
	perf(info, `first card visible ${firstCardMs} ms after goto; ${JSON.stringify(nav)} (${build} build)`);
	// PERF-01: LCP < 2.5 s on the production build.
	if (build === "production" && nav.lcp !== null) expect(nav.lcp).toBeLessThan(2500);

	await expect(page.getByTestId(PLAN_TESTID.daySection)).toHaveCount(35);
	await expect(page.getByTestId(PLAN_TESTID.dayHeader)).toHaveCount(35);
	const mounted = await page.getByTestId(TESTID.timelineItem).count();
	perf(info, `${mounted} of ${g.items.flat().length} cards mounted at load`);
	expect(mounted).toBeLessThan(120);
	await page.screenshot({ path: shotPath("plan/scale-top-1440.png"), animations: "disabled" });

	const lastDay = g.dayIds.at(-1) as string;
	const lastItem = g.items.at(-1)?.at(-1) as string;
	await scrollPlanToEnd(page);
	await expect(card(page, lastItem)).toBeVisible();
	await expect(section(page, lastDay).getByTestId(TESTID.timelineItem)).toHaveCount(8);
	// The first day went back to a spacer with its measured height.
	await expect(section(page, g.dayIds[0] as string)).toHaveAttribute("data-windowed", "");
	await page.screenshot({ path: shotPath("plan/scale-end-1440.png"), animations: "disabled" });
	await expectNoHorizontalOverflow(page);
	expect(logs.messages).toEqual([]);
});

test("a deep link to a stop on Day 30 renders that day and shows the card (MAP-07)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	const g = await growTo35Days(c.tripId);
	const target = g.items[29]?.[2] as string;
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/t/${c.slug}?lens=place&sel=i.${target}`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.itemOverview)).toBeVisible();
	await expect(card(page, target)).toBeInViewport();
	await page.screenshot({ path: shotPath("plan/scale-deeplink-1440.png"), animations: "disabled" });
});

test("a duration change on a 40-stop day reflows every time there (PERF-04)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	const g = await growTo35Days(c.tripId);
	const busy = g.items[5] as string[];
	const dayDate = await (async () => {
		await page.goto(`/t/${c.slug}?lens=place`);
		await expectLive(page);
		return page.evaluate(
			(id) =>
				(window as unknown as { __yonder: { graph: { days: { id: string; date: string }[] } } }).__yonder.graph.days.find(
					(d) => d.id === id,
				)?.date,
			g.busyDayId,
		);
	})();
	await page.goto(`/t/${c.slug}?lens=place&days=${dayDate}`);
	await expectLive(page);
	const lastStart = card(page, busy.at(-1) as string).getByTestId(TESTID.itemStart);
	await expect(lastStart).toBeVisible();
	const before = await lastStart.textContent();
	await page.evaluate(() => {
		const w = window as unknown as { __longTasks: number[] };
		w.__longTasks = [];
		new PerformanceObserver((l) => {
			for (const e of l.getEntries()) w.__longTasks.push(Math.round(e.duration));
		}).observe({ type: "longtask", buffered: false });
	});
	const t0 = Date.now();
	await card(page, busy[0] as string).getByTestId(PLAN_TESTID.itemDuration).getByRole("button").click();
	await page.getByRole("dialog").getByRole("button", { name: "1h", exact: true }).click();
	await expect(lastStart).not.toHaveText(before ?? "");
	const ms = Date.now() - t0;
	const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
	const build = await buildOf(page);
	perf(info, `40-stop day: last time updated ${ms} ms after the click; long tasks ${JSON.stringify(longTasks)} (${build} build)`);
	// PERF-04: no long task over 100 ms (the budget is the production build's).
	if (build === "production") expect(Math.max(0, ...longTasks)).toBeLessThan(100);
	await page.screenshot({ path: shotPath("plan/scale-busy-1440.png"), animations: "disabled" });
});

test("mobile: the long trip in the sheet at 390×844", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "mobile layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await growTo35Days(c.tripId);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/t/${c.slug}?lens=place`);
	await expectLive(page);
	const sheet = page.getByTestId(TESTID.mobileSheet);
	await expect(sheet.getByTestId(TESTID.dayChips)).toBeVisible();
	const handle = await sheet.boundingBox();
	if (!handle) throw new Error("no sheet");
	await page.mouse.move(195, handle.y + 8);
	await page.mouse.down();
	await page.mouse.move(195, handle.y - 300, { steps: 8 });
	await page.mouse.move(195, 60, { steps: 8 });
	await page.mouse.up();
	await expect(sheet.getByTestId(TESTID.timelineItem).first()).toBeVisible();
	await page.waitForTimeout(400);
	await page.screenshot({ path: shotPath("plan/scale-mobile-390.png"), animations: "disabled" });
	await expectNoHorizontalOverflow(page);
	expect(logs.messages).toEqual([]);
});

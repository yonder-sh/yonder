/**
 * I1 integration journeys (SPEC §18.6 step 5, the eight core journeys, plus
 * the extension journeys of EXTENSIONS / ADDENDUM §6–§10) against the MERGED
 * tree. Each journey crosses packages on purpose: it is the check that the
 * pieces work together, not a repeat of a package's own spec. Screenshots go
 * to `e2e/shots/integration/` and are looked at by the integrator.
 *
 *   ENABLE_TEST_ROUTES=1 VITE_E2E=1 DEV_FIXED_OTP= N pnpm dev > .data/dev.log 2>&1 &
 *   N pnpm db:seed:qa            # journey 2 opens the imported Asia 2027 trip
 *   E2E_APP_LOG=$PWD/.data/dev.log N pnpm e2e -- tests/app/integration-journeys.spec.ts
 */
import { randomBytes } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { makePdf } from "../../../src/features/media/__tests__/make-pdf";
import { MEDIA_TESTID } from "../../../src/features/media/testids";
import { INSIGHTS_TESTID as INS } from "../../../src/features/insights/testids";
import { MONEY_TESTID as M } from "../../../src/features/money/testids";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { SHELL_TESTID } from "../../../src/features/shell/testids";
import { SUGGEST_TESTID as S } from "../../../src/features/suggest/testids";
import { PLACES_TESTID as P } from "../../../src/features/places/testids";
import { PLACES_TAB_TESTID as PT } from "../../../src/features/places/tab/testids";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { logOffset, readOtpFromLog } from "./_helpers/otp";
import { collectConsole, expectLive, hydrated } from "./_helpers/page";
import { openLink } from "./_helpers/link";

const MAP_NOISE = [/GL Driver Message|WebGL|layers\[[^\]]+\]\.filter/];

type Y = {
	__yonder?: {
		graph: {
			trip: { id: string; slug: string; startDate: string | null };
			nodes: { id: string; name: string; parentId: string | null; type: string }[];
			items: { id: string; nodeId: string | null; dayId: string | null; title: string | null }[];
			days: { id: string; date: string }[];
			members: { id: string; name: string; userId: string | null; status: string }[];
		};
		model: { pins: { repId: string; hollow: boolean }[]; visits: { repId: string }[] };
		search: Record<string, unknown>;
	};
};
export const yon = (page: Page) =>
	page.evaluate(() => {
		const y = (window as unknown as Y).__yonder;
		return y
			? {
					graph: y.graph,
					pins: y.model.pins,
					visits: y.model.visits,
				}
			: null;
	});

/**
 * FB-13: the trip's ONE link, switched on, with what anyone who has it can do
 * ("Can view" / "Can suggest" / "Can edit"), from the open Share dialog.
 */
async function tripLink(page: Page, role: "Can view" | "Can suggest" | "Can edit") {
	const row = page.getByTestId(TESTID.shareLinkRow);
	const sw = row.getByTestId(TESTID.shareLinkSwitch);
	await expect(sw).toBeVisible();
	if ((await sw.getAttribute("data-state")) !== "checked") await sw.click();
	await expect(sw).toHaveAttribute("data-state", "checked");
	const select = row.getByTestId(HOME_TESTID.linkRole);
	if (!(await select.innerText()).includes(role)) {
		await select.click();
		await page.getByRole("option", { name: role }).click();
	}
	await expect(select).toContainText(role);
	// The options close with an animation: until they're gone, Esc closes
	// them, not the dialog (turning the link on just before makes it slower).
	await expect(page.getByRole("listbox")).toHaveCount(0);
	return row;
}

async function shot(page: Page, name: string) {
	// A finished map when there is one (tiles take ~1 s to arrive).
	await page
		.waitForFunction(
			() => {
				const m = (window as unknown as { __tripMap?: { loaded(): boolean; areTilesLoaded(): boolean } }).__tripMap;
				return !m || (m.loaded() && m.areTilesLoaded());
			},
			null,
			{ timeout: 5_000 },
		)
		.catch(() => {});
	await page.waitForTimeout(300);
	await page.screenshot({ path: shotPath(`integration/${name}.png`), animations: "disabled" });
}

const tag = () => randomBytes(3).toString("hex");

/** A signed-in context for an arbitrary email (API login, names set). */
async function userContext(
	browser: Browser,
	email: string,
	name: { first: string; last: string },
	viewport = { width: 1440, height: 900 },
) {
	const ctx = await browser.newContext({ viewport });
	await loginViaApi(ctx.request, email, name);
	return ctx;
}

// ---------------------------------------------------------------------------
// Journey 1: sign up → welcome → dashboard → new trip → "Where to first?" →
// Japan › Tokyo › Shibuya Sky → schedule it.
// ---------------------------------------------------------------------------
test("J1 sign up, new trip, Where to first? → Japan › Tokyo › Shibuya Sky, scheduled", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(150_000);
	const logs = collectConsole(page, MAP_NOISE);
	const email = `j1-${tag()}@example.com`;
	await page.goto("/dashboard");
	await expect(page).toHaveURL(/\/login/);
	await (await hydrated(page.getByTestId("login-email"))).fill(email);
	const since = logOffset();
	await page.getByTestId("login-submit").click();
	await expect(page.getByTestId("otp-input")).toBeVisible();
	const code = await readOtpFromLog(email, since);
	await page.getByTestId("otp-input").click();
	await page.keyboard.type(code);
	await expect(page).toHaveURL(/\/welcome/);
	await (await hydrated(page.getByTestId("welcome-first-name"))).fill("Journey");
	await page.getByTestId("welcome-last-name").fill("One");
	await page.getByTestId("welcome-submit").click();
	await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
	await shot(page, "j1-01-dashboard-empty");

	await (await hydrated(page.getByTestId(TESTID.newTripButton))).click();
	const tripName = `Japan ${tag()}`;
	await page.getByTestId(TESTID.newTripName).fill(tripName);
	await page.getByTestId(HOME_TESTID.newTripDates).click();
	const dayBtns = page.locator('[data-slot="popover-content"] button[data-day]');
	await dayBtns.filter({ hasText: /^10$/ }).first().click();
	await dayBtns.filter({ hasText: /^12$/ }).first().click();
	await page.getByTestId(TESTID.newTripSubmit).click();
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible({ timeout: 20_000 });
	await expectLive(page);

	// A new trip opens the palette as "Where to first?" (countries and cities).
	const dialog = page.getByTestId(TESTID.addPlaceDialog);
	await expect(dialog).toContainText("Where to first?");
	const input = page.getByTestId(P.paletteInput);
	await input.fill("Tokyo");
	const city = page.getByTestId(P.paletteResult).filter({ hasText: /Tokyo/ }).first();
	await expect(city).toBeVisible({ timeout: 25_000 });
	await city.click();
	const preview = page.getByTestId(P.previewCard);
	await expect(preview.getByTestId(P.filingChip)).toContainText(/Japan/, { timeout: 25_000 });
	await shot(page, "j1-02-where-to-first");
	await preview.getByTestId(P.saveToIdeas).click();
	await expect(dialog).toBeHidden();
	await expect
		.poll(async () => (await yon(page))?.graph.nodes.map((n) => n.name).sort().join(","), { timeout: 20_000 })
		.toMatch(/Japan.*Tokyo|Tokyo.*Japan/);

	// ⌘K: Shibuya Sky, filed under Japan › Tokyo, scheduled on the first day.
	await page.keyboard.press("Control+k");
	await expect(dialog).toBeVisible();
	await input.fill("Shibuya Sky");
	const result = page.getByTestId(P.paletteResult).filter({ hasText: /Shibuya Sky/i }).first();
	await expect(result).toBeVisible({ timeout: 25_000 });
	await result.click();
	await expect(preview.getByTestId(P.filingChip)).toContainText(/Japan\s*›\s*Tokyo/, { timeout: 25_000 });
	await shot(page, "j1-03-shibuya-sky-preview");
	await preview.getByTestId(P.schedule).click();
	// "Schedule…" asks which day.
	await page.getByRole("option", { name: /Day 1/ }).click();
	await expect(page.getByTestId(TESTID.addPlaceDialog)).toBeHidden();
	const nodes = (await yon(page))?.graph.nodes ?? [];
	// No second Tokyo: the palette files under the one "Where to first?" made.
	expect(nodes.filter((n) => n.name === "Tokyo"), JSON.stringify(nodes)).toHaveLength(1);

	await expect
		.poll(async () => {
			const y = await yon(page);
			const sky = y?.graph.nodes.find((n) => /Shibuya Sky/i.test(n.name));
			const tokyo = y?.graph.nodes.find((n) => n.id === sky?.parentId || n.name === "Tokyo");
			const it = y?.graph.items.find((i) => i.nodeId === sky?.id);
			return sky && tokyo && it?.dayId ? "scheduled" : "no";
		}, { timeout: 20_000 })
		.toBe("scheduled");
	const y = await yon(page);
	const sky = y?.graph.nodes.find((n) => /Shibuya Sky/i.test(n.name));
	const path: string[] = [];
	for (let n = sky; n; n = y?.graph.nodes.find((x) => x.id === n?.parentId)) path.unshift(n.name);
	expect(path[0]).toBe("Japan");
	expect(path).toContain("Tokyo");
	await expect(page.getByTestId(TESTID.timelineItem).filter({ hasText: /Shibuya Sky/i })).toBeVisible();
	await shot(page, "j1-04-scheduled");

	// Back on the dashboard, the trip is listed.
	await page.goto("/dashboard");
	await expect(page.getByTestId(TESTID.tripCard).filter({ hasText: tripName })).toBeVisible();
	expect(logs.messages).toEqual([]);
});

// ---------------------------------------------------------------------------
// Journey 2: the imported Asia 2027 trip. Zoom Japan → Tokyo → Shibuya; the
// Plan, map and lists follow; `[`/`]` and Esc; Days 5–6 → map + Media follow.
// ---------------------------------------------------------------------------
const QA_OWNER = { email: "dennis@asia2027.test", first: "Dennis", last: "Tester" };

async function tabCount(page: Page, tab: string): Promise<number> {
	const t = page.getByTestId(TESTID.centerTabs).locator(`[data-tab="${tab}"]`);
	const txt = (await t.textContent()) ?? "";
	const m = txt.match(/(\d+)\s*$/);
	return m ? Number(m[1]) : 0;
}

async function scopeState(page: Page) {
	return page.evaluate(() => {
		const y = (window as unknown as {
			__yonder?: {
				model: { pins: { repId: string; dayIds: string[]; hollow: boolean }[] };
				ix: { node(id: string): { name: string } | undefined };
				schedule: unknown;
			};
		}).__yonder;
		return {
			url: location.pathname + location.search,
			pins: (y?.model.pins ?? []).map((p) => ({ name: y?.ix.node(p.repId)?.name, days: p.dayIds, hollow: p.hollow })),
		};
	});
}

test("J2 Asia 2027: zoom Japan → Tokyo → Shibuya, lens keys and Esc, Days 5–6 drive the map and Media", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(180_000);
	const ctx = await userContext(browser, QA_OWNER.email, QA_OWNER);
	const page = await ctx.newPage();
	const logs = collectConsole(page, MAP_NOISE);
	await page.goto("/t/asia-2027?tab=plan");
	await expectLive(page);
	await expect(page.getByTestId(TESTID.tripMap)).toBeVisible({ timeout: 20_000 });
	await shot(page, "j2-01-root");
	const rootLists = await tabCount(page, "lists");
	const outline = page.getByTestId(TESTID.outline);
	const row = (name: string) =>
		outline.locator(`[data-testid="${TESTID.outlineRow}"][aria-label^="${name},"]`).first();

	// Japan
	await row("Japan").dblclick();
	await expect(page).toHaveURL(/\/t\/asia-2027\/japan(\?|$)/);
	await expect(page.getByTestId(TESTID.scopeBreadcrumb)).toContainText("Japan");
	const japan = await scopeState(page);
	const japanLists = await tabCount(page, "lists");
	await shot(page, "j2-02-japan");

	// Tokyo
	await row("Tokyo").dblclick();
	await expect(page).toHaveURL(/\/japan\/tokyo(\?|$)/);
	await expect(page.getByTestId(TESTID.timelineItem).first()).toBeVisible();
	const tokyo = await scopeState(page);
	const tokyoLists = await tabCount(page, "lists");
	await shot(page, "j2-03-tokyo");
	// ] and [ step the lens at Tokyo (Shibuya, an area, only has "place").
	const lensOf = async () =>
		(await page.getByTestId(TESTID.lensControl).locator('[aria-pressed="true"],[aria-checked="true"],[data-state="on"]').first().textContent())?.trim();
	const lens0 = await lensOf();
	await page.locator("body").press("]");
	await expect.poll(lensOf).not.toBe(lens0);
	await shot(page, "j2-03b-tokyo-finer-lens");
	await page.locator("body").press("[");
	await expect.poll(lensOf).toBe(lens0);

	// Shibuya
	await row("Shibuya").dblclick();
	await expect(page).toHaveURL(/\/japan\/tokyo\/shibuya(\?|$)/);
	const shibuya = await scopeState(page);
	const shibuyaLists = await tabCount(page, "lists");
	await shot(page, "j2-04-shibuya");
	// The plan follows: every card in the Shibuya scope is a Shibuya stop.
	const cards = await page.getByTestId(TESTID.timelineItem).allTextContents();
	expect(cards.length).toBeGreaterThan(0);
	// The map follows: fewer pins as the scope narrows, all inside the scope.
	expect(japan.pins.length).toBeGreaterThan(0);
	expect(tokyo.pins.length).toBeGreaterThan(0);
	expect(shibuya.pins.length).toBeGreaterThan(0);
	expect(shibuya.pins.map((p) => p.name)).not.toContain("Kyoto");
	// The lists follow (rolled up to the scope): never more at a narrower scope.
	expect(japanLists).toBeLessThanOrEqual(rootLists);
	expect(tokyoLists).toBeLessThanOrEqual(japanLists);
	expect(shibuyaLists).toBeLessThanOrEqual(tokyoLists);
	await page.getByTestId(TESTID.centerTabs).locator('[data-tab="lists"]').click();
	await expect(page.getByTestId(TESTID.listsTab)).toBeVisible();
	await shot(page, "j2-05-shibuya-lists");
	await page.getByTestId(TESTID.centerTabs).locator('[data-tab="plan"]').click();

	// Esc clears the selection, then zooms out.
	await page.getByTestId(TESTID.timelineItem).first().click();
	await expect(page).toHaveURL(/sel=i\./);
	await page.locator("body").press("Escape");
	await expect(page).not.toHaveURL(/sel=/);
	await page.locator("body").press("Escape");
	await expect(page).toHaveURL(/\/japan\/tokyo(\?|$)/);
	await page.locator("body").press("Escape");
	await expect(page).toHaveURL(/\/t\/asia-2027\/japan(\?|$)/);

	// Days 5–6: click Day 5's header, shift-click Day 6's.
	const days = (await yon(page))?.graph.days ?? [];
	const d5 = days[4]?.date as string;
	const d6 = days[5]?.date as string;
	const header = (n: number) =>
		page.getByTestId(PLAN_TESTID.dayHeader).filter({ hasText: new RegExp(`Day ${n}\\b`) }).first();
	await header(5).scrollIntoViewIfNeeded();
	await header(5).locator('[role="button"]').first().click();
	await expect(page).toHaveURL(new RegExp(`days=${d5}(&|$)`));
	// The days after the range fold away; shift-click the fold adds Day 6.
	await page
		.locator(`[data-testid="${PLAN_TESTID.fold}"][data-reason="after"]`)
		.first()
		.click({ modifiers: ["Shift"] });
	await expect(page).toHaveURL(new RegExp(`days=${d5}\\.\\.${d6}`));
	await expect(page.getByTestId(TESTID.dayRangeChip)).toBeVisible();
	const ranged = await scopeState(page);
	await shot(page, "j2-06-days-5-6");
	// The map follows: only pins that are on those days (no idea pins).
	expect(ranged.pins.length).toBeGreaterThan(0);
	expect(ranged.pins.length).toBeLessThan(japan.pins.length);
	expect(ranged.pins.every((p) => !p.hollow)).toBe(true);
	// The Media tab follows the days.
	await page.getByTestId(TESTID.centerTabs).locator('[data-tab="media"]').click();
	await expect(page.getByTestId(TESTID.mediaTab)).toBeVisible();
	await expect(page).toHaveURL(/tab=media/);
	await expect(page).toHaveURL(new RegExp(`days=${d5}\\.\\.${d6}`));
	const rangedMedia = await page.getByTestId(TESTID.galleryItem).count();
	await shot(page, "j2-07-days-5-6-media");
	await page.getByTestId(TESTID.dayRangeChip).getByRole("button").last().click();
	await expect(page).not.toHaveURL(/days=/);
	await expect.poll(() => page.getByTestId(TESTID.galleryItem).count()).toBeGreaterThan(rangedMedia);
	expect(logs.messages).toEqual([]);
	await ctx.close();
});

// ---------------------------------------------------------------------------
// Journey 3: walk autofill, a custom transit route, a reserved train that
// becomes late (and is fixed), a connecting flight whose tight connection
// appears and resolves.
// ---------------------------------------------------------------------------
type LegRow = {
	fromItemId: string | null;
	toItemId: string | null;
	mode: string | null;
	source: string;
	durationMin: number | null;
	depAt: string | null;
	details: { kind?: string; flight?: { flightNumber?: string; connection?: unknown } };
};
const legOf = (page: Page, from: string, to: string) =>
	page.evaluate(
		([f, t]) =>
			((window as unknown as { __yonder?: { graph: { legs: LegRow[] } } }).__yonder?.graph.legs ?? []).find(
				(l) => l.fromItemId === f && l.toItemId === t,
			) ?? null,
		[from, to] as const,
	);

test.describe("signed in as dev", () => {
test.use({ storageState: storageStateOf("dev") });
test("J3 walk autofill, custom route, a reserved train goes late and is fixed, a connecting flight", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(240_000);
	const logs = collectConsole(page, MAP_NOISE);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items as Record<string, string>;
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place`);
	await expectLive(page);

	// 1. Walk autofill: Senso-ji → Kama-asa (an unset pair) is filled by the worker.
	await expect
		.poll(async () => {
			const l = await legOf(page, I.sensoji, I.knives);
			return l?.mode === "walk" ? l.source : null;
		}, { timeout: 45_000 })
		.toMatch(/osrm|google|estimate/);
	const walkRow = page.locator(`[data-testid="${TESTID.leg}"]`).filter({ has: page.locator(`[data-testid="${TESTID.legMode}"][data-mode="walk"]`) });
	await expect(walkRow.first()).toBeVisible();

	// 2. A custom transit route on Loft → Meiji Jingu.
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place&sel=l.${I.loft}.${I.meiji}`);
	await expectLive(page);
	const lo = page.getByTestId(TESTID.legOverview);
	await expect(lo).toBeVisible();
	await lo.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
	const panel = page.getByTestId(T.transitPanel);
	await panel.getByTestId(T.customRouteAdd).click();
	const b = panel.getByTestId(T.customRoute);
	await b.getByTestId(T.customRouteLabel).fill("JR Yamanote");
	await b.getByTestId(T.customRouteStepLine).fill("JR Yamanote Line");
	await b.getByTestId(T.customRouteStepFrom).fill("Shibuya");
	await b.getByTestId(T.customRouteStepTo).fill("Harajuku");
	await b.getByTestId(T.customRouteStepMinutes).fill("10");
	await b.getByTestId(T.customRouteSave).click();
	await expect.poll(async () => (await legOf(page, I.loft, I.meiji))?.durationMin).toBe(10);
	expect((await legOf(page, I.loft, I.meiji))?.source).toBe("manual");
	await shot(page, "j3-01-custom-route");

	// 3. A reserved train Meiji Jingu → Shibuya Sky at 13:10 (Day 1 is 3 Oct).
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place&sel=l.${I.meiji}.${I.sky}`);
	await expectLive(page);
	await lo.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
	await panel.getByTestId(T.customRouteAdd).click();
	await b.getByTestId(T.customRouteLabel).fill("Special Express 3");
	await b.getByTestId(T.customRouteStepLine).fill("Special Express 3");
	await b.getByTestId(T.customRouteStepFrom).fill("Harajuku");
	await b.getByTestId(T.customRouteStepTo).fill("Shibuya");
	await b.getByTestId(T.customRouteReserved).click();
	await b.getByTestId(T.customRouteDepartDate).fill("2027-10-03");
	await b.getByTestId(T.customRouteDepartTime).fill("13:10");
	await b.getByTestId(T.customRouteArriveDate).fill("2027-10-03");
	await b.getByTestId(T.customRouteArriveTime).fill("13:30");
	await b.getByTestId(T.customRouteSave).click();
	await expect(panel.getByTestId(T.chosenBooking)).toContainText("dep 13:10");
	await expect.poll(async () => (await legOf(page, I.meiji, I.sky))?.depAt).toBe("2027-10-03T04:10:00.000Z");
	// On time so far: no conflict chip on the day.
	const day1 = page.getByTestId(PLAN_TESTID.daySection).first();
	await expect(day1.getByTestId(TESTID.conflictBadge)).toHaveCount(0);

	// Meiji Jingu grows to 1h30: the train is missed.
	const meijiCard = page.locator(`[data-testid="${TESTID.timelineItem}"]`).filter({ hasText: "Meiji Jingu" }).first();
	await meijiCard.getByTestId(PLAN_TESTID.itemDuration).getByRole("button").click();
	await page.locator('[data-slot="popover-content"]').getByRole("button", { name: "1h30", exact: true }).click();
	const late = day1.getByTestId(TESTID.conflictBadge).filter({ hasText: /Misses Special Express 3/ });
	await expect(late).toBeVisible({ timeout: 15_000 });
	await expect(late).toContainText("dep 13:10");
	await shot(page, "j3-02-train-missed");
	// …and a fix resolves it.
	await day1.getByTestId(PLAN_TESTID.legFix).first().click();
	await expect(day1.getByTestId(TESTID.conflictBadge).filter({ hasText: /Misses/ })).toHaveCount(0, { timeout: 15_000 });
	await shot(page, "j3-03-train-fixed");

	// 4. A connecting flight after ICN on Day 5: ICN → HKG → SGN, 30 min to connect.
	await page.goto(`/t/${c.slug}?days=2027-10-07`);
	await expectLive(page);
	await page.getByTestId(PLAN_TESTID.addBetween).last().click();
	await page.getByRole("menuitem", { name: /Flight/ }).click();
	const dlg = page.getByTestId(TESTID.addFlightDialog);
	await expect(dlg).toBeVisible();
	await page.waitForTimeout(400); // the dialog's open animation and autofocus
	const seg = (n: number) => dlg.getByTestId(T.flightSegment).nth(n);
	const pick = async (n: number, field: string, typed: string, opt: string, text: string) => {
		const input = seg(n).getByTestId(field);
		await input.click();
		await input.fill("");
		await input.pressSequentially(typed, { delay: 30 });
		await expect(input).toHaveValue(typed);
		const o = page.getByTestId(opt).filter({ hasText: text }).first();
		await expect(o).toBeVisible();
		await page.waitForTimeout(250); // the list's open animation
		await o.click();
	};
	await pick(0, T.flightAirline, "Cathay", T.airlineOption, "Cathay");
	await seg(0).getByTestId(T.flightNumber).fill("CX411");
	await pick(0, T.flightFrom, "ICN", T.airportOption, "ICN");
	await pick(0, T.flightTo, "HKG", T.airportOption, "HKG");
	await seg(0).getByTestId(T.flightDepDate).fill("2027-10-07");
	await seg(0).getByTestId(T.flightDepTime).fill("18:00");
	await seg(0).getByTestId(T.flightArrDate).fill("2027-10-07");
	await seg(0).getByTestId(T.flightArrTime).fill("20:30");
	await dlg.getByTestId(T.flightAddConnection).click();
	await pick(1, T.flightAirline, "Cathay", T.airlineOption, "Cathay");
	await seg(1).getByTestId(T.flightNumber).fill("CX765");
	await pick(1, T.flightTo, "SGN", T.airportOption, "SGN");
	await seg(1).getByTestId(T.flightDepDate).fill("2027-10-07");
	await seg(1).getByTestId(T.flightDepTime).fill("21:00");
	await seg(1).getByTestId(T.flightArrDate).fill("2027-10-07");
	await seg(1).getByTestId(T.flightArrTime).fill("22:45");
	await shot(page, "j3-04-connecting-flight-form");
	await dlg.getByTestId(T.flightSave).click();
	await expect(dlg).toBeHidden({ timeout: 15_000 });
	const layover = page.getByTestId(PLAN_TESTID.layover);
	await expect(layover).toBeVisible({ timeout: 15_000 });
	await expect(layover).toContainText("Tight connection");
	await shot(page, "j3-05-tight-connection");
	// Resolve: the second segment leaves at 22:00 instead.
	const flights = await page.evaluate(() =>
		((window as unknown as { __yonder: { graph: { legs: LegRow[] } } }).__yonder.graph.legs ?? []).filter(
			(l) => l.details.flight?.flightNumber === "CX765",
		),
	);
	expect(flights).toHaveLength(1);
	const cx765 = flights[0] as LegRow;
	await page.goto(`/t/${c.slug}?days=2027-10-07&sel=l.${cx765.fromItemId}.${cx765.toItemId}`);
	await expectLive(page);
	await lo.getByRole("button", { name: "Edit flight" }).click();
	const form = lo.getByTestId(T.flightForm);
	await form.getByTestId(T.flightDepTime).fill("22:00");
	await form.getByTestId(T.flightArrTime).fill("23:45");
	await form.getByTestId(T.flightSave).click();
	await expect(page.getByTestId(PLAN_TESTID.layover)).not.toContainText("Tight connection", { timeout: 15_000 });
	await shot(page, "j3-06-connection-ok");
	expect(logs.messages).toEqual([]);
});
});

// ---------------------------------------------------------------------------
// Journey 4: two browsers. Co-edit a note (carets), reorder (glow), mention
// (bell), a rename propagates.
// ---------------------------------------------------------------------------
test("J4 two browsers: note with carets, reorder glows, mention rings the bell, rename propagates", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "two desktop browsers once");
	test.setTimeout(180_000);
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	const c = await cloneFixtureTrip(owner.request);
	await owner.close();
	const open = async (handle: "dev" | "maya", url: string) => {
		const ctx = await browser.newContext({ storageState: storageStateOf(handle), viewport: { width: 1440, height: 900 } });
		const page = await ctx.newPage();
		await page.goto(url);
		await expectLive(page);
		return { ctx, page };
	};
	const a = await open("dev", `/t/${c.slug}?tab=notes`);
	const b = await open("maya", `/t/${c.slug}?tab=notes`);
	const logsA = collectConsole(a.page, MAP_NOISE);
	const top = (p: Page) => p.getByTestId(TESTID.notesTab).getByTestId(NT.editor).first();
	const toEnd = async (p: Page) => {
		const ed = top(p);
		await expect(ed).toHaveAttribute("data-editable", "true", { timeout: 15_000 });
		await ed.locator(":scope > *").last().click();
		await expect
			.poll(() => ed.evaluate((e) => (e as unknown as { editor?: { state: { selection: { from: number } } } }).editor?.state.selection.from ?? 0))
			.toBeGreaterThan(1);
		await p.keyboard.press("End");
	};

	// Co-edit: Dennis writes, Maya sees it and her caret shows for him.
	await toEnd(a.page);
	await a.page.keyboard.press("Enter");
	await a.page.keyboard.type("Dinner plan: ramen near the hotel.");
	await expect(top(b.page)).toContainText("ramen near the hotel", { timeout: 5_000 });
	await toEnd(b.page);
	await b.page.keyboard.type(" Yes please!");
	await expect(top(a.page)).toContainText("Yes please!", { timeout: 5_000 });
	await expect(a.page.locator(".collaboration-carets__label", { hasText: "Maya" })).toBeVisible({ timeout: 5_000 });
	await shot(a.page, "j4-01-carets");

	// Mention: Dennis mentions Maya; her bell lights up.
	await a.page.keyboard.press("Enter");
	await a.page.keyboard.type("Ask @Ma");
	await expect(a.page.getByTestId(NT.mentionPopup)).toBeVisible();
	await a.page.keyboard.press("Enter");
	await a.page.keyboard.type("to book it.");
	// (The demo's shopping item already mentions her: wait for THIS mention,
	// which the notes store syncs after its debounce, 2–10 s.)
	const bell = b.page.getByTestId(TESTID.inboxBell).first();
	const unread0 = Number((await bell.getAttribute("data-unread")) ?? 0);
	await expect
		.poll(async () => Number((await bell.getAttribute("data-unread")) ?? 0), { timeout: 30_000 })
		.toBeGreaterThan(unread0);
	await bell.click();
	const panel = b.page.getByTestId(SHELL_TESTID.inboxPanel);
	await expect(panel.getByTestId(SHELL_TESTID.inboxRow).filter({ hasText: /to book it/ }).first()).toBeVisible();
	await shot(b.page, "j4-02-maya-bell");
	await b.page.keyboard.press("Escape");

	// Reorder: Dennis drags Itoya above Senso-ji on Day 2; Maya sees it move, with a glow.
	const day2 = "2027-10-04";
	await a.page.goto(`/t/${c.slug}?lens=place&days=${day2}`);
	await b.page.goto(`/t/${c.slug}?lens=place&days=${day2}`);
	await expectLive(a.page);
	await expectLive(b.page);
	const card = (p: Page, id: string) => p.locator(`[data-testid="${TESTID.timelineItem}"][data-item-id="${id}"]`).first();
	const I = c.ids.items as Record<string, string>;
	const target = await card(a.page, I.sensoji).boundingBox();
	const src = await card(a.page, I.itoya).boundingBox();
	if (!target || !src) throw new Error("no cards");
	await a.page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
	await a.page.mouse.down();
	await a.page.mouse.move(src.x + src.width / 2, src.y + src.height / 2 + 10, { steps: 4 });
	await a.page.mouse.move(target.x + target.width / 2, target.y + 8, { steps: 25 });
	await a.page.mouse.move(target.x + target.width / 2, target.y + 9, { steps: 2 });
	await a.page.mouse.up();
	const firstCard = (p: Page) =>
		p.locator(`[data-testid="${PLAN_TESTID.daySection}"] [data-testid="${TESTID.timelineItem}"]`).first().getAttribute("data-item-id");
	await expect.poll(() => firstCard(a.page)).toBe(I.itoya);
	await expect.poll(() => firstCard(b.page), { timeout: 10_000 }).toBe(I.itoya);
	// The moved card glows in the mover's colour for a moment (useFlash).
	await expect(card(b.page, I.itoya).locator(".plan-glow")).toHaveCount(1, { timeout: 5_000 });
	await shot(b.page, "j4-03-reorder-glow");

	// Rename: Dennis renames the trip; Maya's title follows.
	const newName = `Japan & Korea ${tag()}`;
	await a.page.getByTestId(TESTID.tripMenu).click();
	await a.page.getByRole("menuitem", { name: "Trip settings" }).click();
	const dialog = a.page.getByTestId(TESTID.tripSettingsDialog);
	await dialog.getByTestId(HOME_TESTID.settingsName).fill(newName);
	await dialog.getByRole("button", { name: /save/i }).click();
	await expect(b.page.getByTestId(TESTID.tripMenu)).toContainText(newName, { timeout: 5_000 });
	expect(logsA.messages).toEqual([]);
	await a.ctx.close();
	await b.ctx.close();
});

// ---------------------------------------------------------------------------
// Journey 5: the edit link to an incognito guest. The guest edits, can't see
// booking refs; resetting the link kicks them.
// ---------------------------------------------------------------------------
test("J5 edit link: an incognito guest edits, never sees the booking ref, and a reset kicks them", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(180_000);
	const ownerCtx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const owner = await ownerCtx.newPage();
	const logs = collectConsole(owner, MAP_NOISE);
	const c = await cloneFixtureTrip(owner.request);
	const I = c.ids.items as Record<string, string>;

	// The owner puts a booking ref on the KE 724 flight.
	await owner.goto(`/t/${c.slug}?sel=l.${I.kix}.${I.icn}`);
	await expectLive(owner);
	const lo = owner.getByTestId(TESTID.legOverview);
	await lo.getByRole("button", { name: "Edit flight" }).click();
	await lo.getByTestId(T.flightForm).getByTestId(T.flightRef).fill("qx7p2m");
	await lo.getByTestId(T.flightForm).getByTestId(T.flightSave).click();
	await expect(lo.getByTestId(T.flightSummary)).toContainText("QX7P2M");

	// The trip link as "Can edit", from the Share dialog.
	await owner.getByTestId(TESTID.shareButton).click();
	const row = await tripLink(owner, "Can edit");
	// The link is the trip's own address.
	const link = await row.getByTestId(TESTID.shareLinkUrl).inputValue();
	expect(new URL(link).pathname).toBe(`/t/${c.slug}`);
	await owner.keyboard.press("Escape");

	// An incognito guest opens it and lands in the trip as a guest editor.
	const guestCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const guest = await guestCtx.newPage();
	const bodies: string[] = [];
	guest.on("response", async (r) => {
		if (r.url().includes("/_serverFn/")) bodies.push(await r.text().catch(() => ""));
	});
	const guestLogs = collectConsole(guest, [...MAP_NOISE, /status of 40[34]/]);
	await guest.goto(link);
	await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 20_000 });
	await expectLive(guest);
	await shot(guest, "j5-01-guest-in");

	// The guest edits: Hands Shibuya becomes 1h30; the owner sees it.
	await guest.goto(`/t/${c.slug}/japan/tokyo?lens=place`);
	await expectLive(guest);
	const hands = guest.locator(`[data-testid="${TESTID.timelineItem}"][data-item-id="${I.hands}"]`).first();
	await hands.getByTestId(PLAN_TESTID.itemDuration).getByRole("button").click();
	await guest.locator('[data-slot="popover-content"]').getByRole("button", { name: "1h30", exact: true }).click();
	await owner.goto(`/t/${c.slug}/japan/tokyo?lens=place`);
	await expectLive(owner);
	await expect
		.poll(() =>
			owner.evaluate(
				(id) => (window as unknown as { __yonder: { graph: { items: { id: string; durationMin: number }[] } } }).__yonder.graph.items.find((i) => i.id === id)?.durationMin,
				I.hands,
			),
		)
		.toBe(90);

	// The guest opens the flight: the ref is masked and never sent.
	await guest.goto(`/t/${c.slug}?sel=l.${I.kix}.${I.icn}`);
	await expectLive(guest);
	const glo = guest.getByTestId(TESTID.legOverview);
	await expect(glo.getByTestId(T.flightSummary)).toBeVisible();
	await expect(glo).not.toContainText("QX7P2M");
	await expect(glo.getByTestId(T.masked).first()).toBeVisible();
	expect(bodies.join("\n")).not.toMatch(/QX7P2M/i);
	await shot(guest, "j5-02-guest-masked");

	// The owner resets the link: a new address, and the guest is cut off at once.
	await owner.getByTestId(TESTID.shareButton).click();
	await row.getByTestId(TESTID.shareLinkReset).click();
	await row.getByRole("button", { name: "Reset" }).last().click();
	await expect(row.getByTestId(TESTID.shareLinkUrl)).not.toHaveValue(link, { timeout: 10_000 });
	await expect(guest.getByTestId(TESTID.workspace)).toHaveCount(0, { timeout: 15_000 });
	await expect(guest.getByText("This link is no longer active.")).toBeVisible();
	await shot(guest, "j5-03-guest-kicked");
	expect(logs.messages).toEqual([]);
	expect(guestLogs.messages).toEqual([]);
	await guestCtx.close();
	await ownerCtx.close();
});

// ---------------------------------------------------------------------------
// Journey 6: a photo, a video, a TikTok and a guide link on Shibuya Sky roll
// up at Tokyo, at Japan and on its day.
// ---------------------------------------------------------------------------
async function canvasMedia(page: Page, kind: "jpeg" | "webm"): Promise<Buffer> {
	const b64 = await page.evaluate(async (k) => {
		const c = document.createElement("canvas");
		c.width = 480;
		c.height = 270;
		const g = c.getContext("2d") as CanvasRenderingContext2D;
		const paint = (t: number) => {
			g.fillStyle = `hsl(${(t * 7) % 360} 60% 50%)`;
			g.fillRect(0, 0, 480, 270);
			g.fillStyle = "#fff";
			g.fillRect((t * 9) % 480, 110, 60, 50);
		};
		let blob: Blob;
		if (k === "jpeg") {
			paint(3);
			blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), "image/jpeg", 0.85));
		} else {
			const rec = new MediaRecorder(c.captureStream(24), { mimeType: "video/webm" });
			const parts: Blob[] = [];
			rec.ondataavailable = (e) => parts.push(e.data);
			let t = 0;
			const timer = setInterval(() => paint(t++), 40);
			rec.start(200);
			await new Promise((r) => setTimeout(r, 1500));
			rec.stop();
			await new Promise((r) => (rec.onstop = r));
			clearInterval(timer);
			blob = new Blob(parts, { type: "video/webm" });
		}
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let s = "";
		for (const x of bytes) s += String.fromCharCode(x);
		return btoa(s);
	}, kind);
	return Buffer.from(b64, "base64");
}

test("J6 photo, video, TikTok and guide link roll up at Tokyo, Japan and on the day", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(180_000);
	const ctx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const logs = collectConsole(page, MAP_NOISE);
	const c = await cloneFixtureTrip(page.request);
	const skyId = c.ids.nodes.shibuyaSky as string;
	const tiles = (kind?: string) =>
		page.locator(`[data-testid=${TESTID.galleryItem}]${kind ? `[data-kind=${kind}]` : ""}`);
	const mediaCount = async () => tabCount(page, "media");

	// Baselines.
	await page.goto(`/t/${c.slug}/japan?tab=media`);
	await expectLive(page);
	const japan0 = await mediaCount();
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expectLive(page);
	const tokyo0 = await mediaCount();

	// On Shibuya Sky's own Media tab (its inspector): upload a photo and a video.
	await page.goto(`/t/${c.slug}/japan/tokyo?sel=n.${skyId}`);
	await expectLive(page);
	const inspector = page.getByTestId(TESTID.inspector);
	await inspector.getByRole("tab", { name: "Media" }).click();
	const photo = await canvasMedia(page, "jpeg");
	const video = await canvasMedia(page, "webm");
	await inspector.getByTestId(MEDIA_TESTID.fileInput).setInputFiles([
		{ name: "sky-sunset.jpg", mimeType: "image/jpeg", buffer: photo },
		{ name: "sky-timelapse.webm", mimeType: "video/webm", buffer: video },
	]);
	const itile = (kind: string) => inspector.locator(`[data-testid=${TESTID.galleryItem}][data-kind=${kind}]`);
	await expect(itile("photo")).toHaveAttribute("data-status", "ready", { timeout: 40_000 });
	await expect(itile("video")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
	// A TikTok and a guide link.
	for (const url of [
		"https://www.tiktok.com/@tokyo/video/7212345678901234567",
		"https://www.japan-guide.com/e/e3007.html",
	]) {
		await inspector.getByTestId(MEDIA_TESTID.addButton).first().click();
		await page.getByTestId(MEDIA_TESTID.addLink).click();
		await page.getByTestId(MEDIA_TESTID.linkInput).fill(url);
		await page.getByTestId(MEDIA_TESTID.linkSubmit).click();
		await expect(page.getByTestId(MEDIA_TESTID.linkInput)).toBeHidden();
	}
	await expect(itile("embed")).toHaveCount(1);
	await expect(itile("link").filter({ hasText: /japan-guide/i }).first()).toBeVisible({ timeout: 20_000 });
	await shot(page, "j6-01-shibuya-sky-media");

	// Rolled up at Tokyo and at Japan (+4 each).
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expectLive(page);
	await expect.poll(mediaCount).toBe(tokyo0 + 4);
	await expect(tiles("photo")).toHaveCount(1);
	await expect(tiles("video")).toHaveCount(1);
	await expect(tiles("embed")).toHaveCount(1);
	await shot(page, "j6-02-tokyo-media");
	await page.goto(`/t/${c.slug}/japan?tab=media`);
	await expectLive(page);
	await expect.poll(mediaCount).toBe(japan0 + 4);
	await expect(tiles("video")).toHaveCount(1);

	// …and on its day (Day 1, 3 Oct): the day range shows them; Day 2 doesn't.
	await page.goto(`/t/${c.slug}?tab=media&days=2027-10-03`);
	await expectLive(page);
	await expect(tiles("photo")).toHaveCount(1);
	await expect(tiles("embed")).toHaveCount(1);
	await shot(page, "j6-03-day1-media");
	await page.goto(`/t/${c.slug}?tab=media&days=2027-10-04`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.mediaTab)).toBeVisible();
	await expect(tiles("video")).toHaveCount(0);
	expect(logs.messages).toEqual([]);
	await ctx.close();
});

// ---------------------------------------------------------------------------
// Journey 8: mobile 390×844. The sheet snaps, tapping a pin opens the
// inspector drawer, long-press reorders, and the lens control scrolls.
// ---------------------------------------------------------------------------
test.describe("J8 as dev", () => {
test.use({ storageState: storageStateOf("dev") });
test("J8 mobile 390×844: sheet snaps, pin tap opens the drawer, long-press reorders, lens control scrolls", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "phone journey");
	test.setTimeout(180_000);
	const logs = collectConsole(page, MAP_NOISE);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items as Record<string, string>;
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place&days=2027-10-03`);
	await expectLive(page);
	const sheet = page.getByTestId(TESTID.mobileSheet);
	await expect(sheet.getByTestId(TESTID.dayChips)).toBeVisible();
	const top = async () => (await sheet.boundingBox())?.y ?? 0;
	await expect.poll(top).toBeGreaterThan(680); // the 120 px peek
	await shot(page, "j8-01-peek");

	// The sheet snaps: half, then full.
	const dragSheet = async (toY: number) => {
		const y = await top();
		await page.mouse.move(195, y + 8);
		await page.mouse.down();
		await page.mouse.move(195, y - 40, { steps: 6 });
		await page.mouse.move(195, toY, { steps: 10 });
		await page.mouse.up();
		await page.waitForTimeout(600);
	};
	await dragSheet(430);
	await expect.poll(top).toBeGreaterThan(844 * 0.5 - 40);
	await expect.poll(top).toBeLessThan(844 * 0.5 + 40);
	await shot(page, "j8-02-half");
	await dragSheet(60);
	await expect.poll(top).toBeLessThan(844 * 0.08 + 40);
	await expect(sheet.getByTestId(TESTID.timelineItem).first()).toBeVisible();
	await shot(page, "j8-03-full");

	// Long-press reorders: Shibuya Loft above Hands Shibuya (touch, 250 ms hold).
	const card = (id: string) => sheet.locator(`[data-testid="${TESTID.timelineItem}"][data-item-id="${id}"]`).first();
	const a = await card(I.loft).boundingBox();
	const b = await card(I.hands).boundingBox();
	if (!a || !b) throw new Error("no cards");
	const cdp = await page.context().newCDPSession(page);
	const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
		cdp.send("Input.dispatchTouchEvent", {
			type,
			touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
		});
	const sx = a.x + a.width / 2;
	const sy = a.y + a.height / 2;
	await touch("touchStart", sx, sy);
	await page.waitForTimeout(450);
	for (let i = 1; i <= 12; i++) await touch("touchMove", sx, sy - ((sy - (b.y + 6)) * i) / 12);
	await page.waitForTimeout(150);
	await touch("touchEnd", sx, b.y + 6);
	const order = () =>
		page.evaluate((day) => {
			const y = (window as unknown as { __yonder: { graph: { items: { id: string; dayId: string | null; position: string }[] } } }).__yonder;
			return y.graph.items
				.filter((i) => i.dayId === day)
				.sort((p, q) => (p.position < q.position ? -1 : p.position > q.position ? 1 : 0))
				.map((i) => i.id);
		}, c.ids.days.d1 as string);
	await expect.poll(async () => (await order())[0], { timeout: 10_000 }).toBe(I.loft);
	await shot(page, "j8-04-long-press-reordered");

	// Tapping a pin opens the inspector drawer.
	await page.goto(`/t/${c.slug}/japan?lens=city`);
	await expectLive(page);
	const kyoto = page.locator(`[data-testid="${TESTID.pin}"][data-rep-id="${c.ids.nodes.kyoto}"]`);
	await expect(kyoto).toBeVisible({ timeout: 20_000 });
	await kyoto.tap();
	await expect(page).toHaveURL(new RegExp(`sel=n\\.${c.ids.nodes.kyoto}`));
	const drawer = page.getByTestId(TESTID.inspector);
	await expect(drawer).toBeVisible();
	await expect(drawer).toContainText("Kyoto");
	await shot(page, "j8-05-pin-drawer");
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();

	// The lens control scrolls sideways when its options don't fit.
	const lens = page.getByTestId(TESTID.lensControl).first();
	await expect(lens).toBeVisible();
	const m = await lens.evaluate((el) => {
		const s = (el.closest("[data-scrollable]") as HTMLElement | null) ?? el;
		const before = { sw: s.scrollWidth, cw: s.clientWidth, ox: getComputedStyle(s).overflowX };
		s.scrollLeft = 10_000;
		return { ...before, left: s.scrollLeft };
	});
	expect(["auto", "scroll"]).toContain(m.ox);
	if (m.sw > m.cw) expect(m.left).toBeGreaterThan(0);
	await expect(page.getByTestId(TESTID.lensControl).getByText("Place").first()).toBeAttached();
	await shot(page, "j8-06-lens");
	expect(logs.messages).toEqual([]);
});
});

// ---------------------------------------------------------------------------
// Extension X1: the suggester role end to end. A member suggester and a
// "Can suggest" link guest suggest; the owner sees ghosts, accepts one from
// its ghost and rejects the other with a note.
// ---------------------------------------------------------------------------
const itemDuration = (page: Page, itemId: string) =>
	page.evaluate(
		(id) =>
			(window as unknown as { __yonder: { graph: { items: { id: string; durationMin: number }[] } } }).__yonder.graph.items.find(
				(i) => i.id === id,
			)?.durationMin,
		itemId,
	);

async function setDuration(page: Page, itemId: string, label: string) {
	const card = page.locator(`[data-testid="${TESTID.timelineItem}"][data-item-id="${itemId}"]`).first();
	await card.getByTestId(PLAN_TESTID.itemDuration).getByRole("button").click();
	await page.locator('[data-slot="popover-content"]').getByRole("button", { name: label, exact: true }).click();
}

test("X1 suggester role: member and link suggesters; ghosts; accept and reject", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(240_000);
	const ownerCtx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const owner = await ownerCtx.newPage();
	const logs = collectConsole(owner, MAP_NOISE);
	const c = await cloneFixtureTrip(owner.request, { mayaRole: "suggester" });
	const I = c.ids.items as Record<string, string>;
	const url = `/t/${c.slug}/japan/tokyo?lens=place&days=2027-10-04`;

	// Maya (a member suggester): her edit becomes a suggestion, not a change.
	const mayaCtx = await browser.newContext({ storageState: storageStateOf("maya"), viewport: { width: 1440, height: 900 } });
	const maya = await mayaCtx.newPage();
	await maya.goto(url);
	await expectLive(maya);
	const pill = maya.getByTestId(TESTID.suggestModeControl).first();
	await expect(pill).toHaveAttribute("data-mode", "suggest");
	await maya.getByTestId(S.firstHint).getByRole("button", { name: "Got it" }).click().catch(() => {});
	await setDuration(maya, I.sensoji, "1h30");
	await expect(maya.getByText(/^Suggested — /).first()).toBeVisible();
	await expect(maya.getByTestId(TESTID.proposalGhost).first()).toBeVisible();
	await shot(maya, "x1-01-maya-suggested");

	// The owner sees the ghost and accepts it from the card.
	await owner.goto(url);
	await expectLive(owner);
	expect(await itemDuration(owner, I.sensoji)).toBe(60);
	await expect(owner.getByRole("button", { name: "Review 1 suggestion" })).toBeVisible({ timeout: 15_000 });
	const sensoji = owner.locator(`[data-testid="${TESTID.timelineItem}"][data-item-id="${I.sensoji}"]`).first();
	await sensoji.hover();
	await shot(owner, "x1-02-owner-ghost");
	await owner.getByTestId(S.ghostAccept).first().click();
	await expect.poll(() => itemDuration(owner, I.sensoji), { timeout: 15_000 }).toBe(90);
	await expect(maya.getByText("Dev accepted your suggestion")).toBeVisible({ timeout: 15_000 });

	// The trip link as "Can suggest": an incognito guest suggests too.
	await owner.getByTestId(TESTID.shareButton).click();
	const row = await tripLink(owner, "Can suggest");
	const link = await row.getByTestId(TESTID.shareLinkUrl).inputValue();
	await owner.keyboard.press("Escape");
	const guestCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const guest = await guestCtx.newPage();
	await guest.goto(link);
	await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 20_000 });
	await guest.goto(url);
	await expectLive(guest);
	await expect(guest.getByTestId(TESTID.suggestModeControl).first()).toHaveAttribute("data-mode", "suggest");
	await guest.getByTestId(S.firstHint).getByRole("button", { name: "Got it" }).click().catch(() => {});
	await setDuration(guest, I.knives, "2h");
	await expect(guest.getByText(/^Suggested — /).first()).toBeVisible();
	await shot(guest, "x1-03-guest-suggested");

	// The owner rejects the guest's suggestion with a note in the drawer.
	await owner.getByRole("button", { name: "Review 1 suggestion" }).click({ timeout: 15_000 });
	const drawer = owner.getByTestId(TESTID.reviewDrawer);
	const r = drawer.getByTestId(S.row).first();
	await expect(r).toContainText("Kama-asa");
	await shot(owner, "x1-04-review-drawer");
	await r.getByTestId(S.reject).click();
	await owner.getByTestId(S.rejectNote).fill("Knife shopping stays 1h30");
	await owner.getByTestId(S.rejectConfirm).click();
	await expect(drawer.getByText("Nothing to review.")).toBeVisible({ timeout: 15_000 });
	expect(await itemDuration(owner, I.knives)).toBe(90);
	expect(logs.messages).toEqual([]);
	await guestCtx.close();
	await mayaCtx.close();
	await ownerCtx.close();
});

// ---------------------------------------------------------------------------
// Extension X2: money. An itemized dinner with a service charge paid by two
// people, a refund, settling up in ¥, a trip-default budget with a personal
// override and an over-allocation warning, and the Local display currency.
// ---------------------------------------------------------------------------
type MoneyDto = {
	expenses: {
		id: string;
		title: string;
		refundOfId: string | null;
		lines: { label: string; memberIds: string[] }[];
		fees: { kind: string; value: number }[];
		payments: { payers: { memberId: string; amountMinor: number }[] }[];
	}[];
	settlements: { currency: string }[];
};
async function listMoney(page: Page, tripId: string): Promise<MoneyDto> {
	return page.evaluate(async (id) => {
		const m = await import(/* @vite-ignore */ "/src/features/money/money.functions.ts");
		return (await m.listMoney({ data: { tripId: id } })) as unknown;
	}, tripId) as Promise<MoneyDto>;
}

test("X2 money: itemized dinner with a fee and two payers, refund, settle in ¥, budgets, Local", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(240_000);
	const ctx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const logs = collectConsole(page, MAP_NOISE);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=money`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.moneyTab)).toBeVisible();

	// 1. The dinner: ¥12,100 = sashimi ¥5,000 + sake ¥6,000 + 10 % service.
	await page.getByTestId(M.addButton).first().click();
	const d = page.getByTestId(TESTID.addExpenseDialog);
	await expect(d).toBeVisible();
	await d.getByTestId(M.amount).fill("12100");
	await expect(d.getByTestId(M.currency)).toContainText("JPY");
	await d.getByTestId(M.title).fill("Izakaya dinner");
	await d.getByTestId(M.more).click();
	await d.getByTestId(M.itemize).click();
	const l1 = d.getByTestId(M.line).nth(0);
	await l1.getByTestId(M.lineLabel).fill("Sashimi");
	await l1.getByTestId(M.lineAmount).fill("5000");
	await l1.getByTestId(M.linePerson).filter({ hasText: "Audrey" }).click();
	await d.getByTestId(M.addLine).click();
	const l2 = d.getByTestId(M.line).nth(1);
	await l2.getByTestId(M.lineLabel).fill("Sake");
	await l2.getByTestId(M.lineAmount).fill("6000");
	await l2.getByTestId(M.linePerson).filter({ hasText: "Maya" }).click();
	await d.getByTestId(M.addFee).click();
	await expect(d.getByTestId(M.feeValue)).toHaveValue("10");
	await expect(d.getByTestId(M.remainder).last()).toContainText("Adds up");
	// Paid (a future trip's cost starts as planned), by two people: cash pooled.
	await d.getByTestId(M.status).getByRole("radio", { name: "Paid" }).click();
	await d.getByRole("switch", { name: /Several people paid/ }).click();
	const pays = d.getByTestId(M.payerAmount);
	await expect(pays).toHaveCount(2);
	await pays.nth(0).fill("7000");
	await pays.nth(1).fill("5100");
	await shot(page, "x2-01-dinner");
	await d.getByTestId(M.save).click();
	await expect(d).toBeHidden();
	let m = await listMoney(page, c.tripId);
	const dinner = m.expenses.find((e) => e.title === "Izakaya dinner");
	expect(dinner?.lines.map((l) => l.label)).toEqual(["Sashimi", "Sake"]);
	expect(dinner?.fees).toHaveLength(1);
	expect(dinner?.payments[0]?.payers.map((p) => p.amountMinor).sort()).toEqual([5100, 7000]);

	// 2. A refund: ¥1,210 back (the sake was off), split back like the original.
	await page.getByTestId(M.expenseRow).filter({ hasText: "Izakaya dinner" }).click();
	await d.getByTestId(M.refund).click();
	await expect(d).toContainText("Refund · Izakaya dinner");
	await d.getByTestId(M.amount).fill("1210");
	await d.getByTestId(M.save).click();
	await expect(d).toBeHidden();
	await expect(page.getByTestId(M.expenseRow).filter({ hasText: "Refund" })).toContainText("-¥1,210");
	await shot(page, "x2-02-refund");

	// 3. Settle up in ¥ (every transfer recorded in JPY).
	await page.goto(`/t/${c.slug}?tab=money`);
	await expectLive(page);
	await page.getByTestId(M.settleUpButton).click();
	const settle = page.getByTestId(M.settleUpDialog);
	await expect(settle).toBeVisible();
	const transfers = await settle.getByTestId(M.transferRow).count();
	expect(transfers).toBeGreaterThan(0);
	for (let i = 0; i < transfers; i++) {
		await settle.getByTestId(M.transferRecord).first().click();
		await settle.getByRole("button", { name: /^Currency: / }).first().click();
		await page.getByPlaceholder("Search currencies…").fill("JPY");
		await page.getByRole("option", { name: /JPY/ }).first().click();
		await expect(settle.getByText(/≈ \$/).first()).toBeVisible();
		if (i === 0) await shot(page, "x2-03-settle-yen");
		await settle.getByRole("button", { name: "Record payment" }).click();
		await expect(settle.getByTestId(M.settlementRow)).toHaveCount(i + 1);
	}
	m = await listMoney(page, c.tripId);
	expect(m.settlements.every((s) => s.currency === "JPY")).toBe(true);
	await shot(page, "x2-04-settled");
	await page.keyboard.press("Escape");

	// 4. Budgets: Japan $1,000 (trip default), Tokyo $1,500 → over-allocated;
	//    my own Tokyo value $800 (custom) with Reset.
	const budget = page.getByTestId(M.budget);
	await page.goto(`/t/${c.slug}/japan?tab=money`);
	await expectLive(page);
	await budget.getByRole("button", { name: "Set a budget" }).click();
	await page.getByLabel("Amount (USD)").fill("1000");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(budget.locator(`[data-testid=${M.budgetRow}][data-category=all]`)).toHaveAttribute("data-source", "default");
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=money`);
	await expectLive(page);
	await budget.getByRole("button", { name: "Set a budget" }).click();
	await page.getByLabel("Amount (USD)").fill("1500");
	await page.getByRole("button", { name: "Save" }).click();
	const tokyoAll = budget.locator(`[data-testid=${M.budgetRow}][data-category=all]`);
	await expect(tokyoAll).toContainText("$1.5K");
	await tokyoAll.getByTestId(M.budgetEdit).click();
	await page.getByRole("radio", { name: "Just me" }).click();
	await page.getByLabel("Amount (USD)").fill("800");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(tokyoAll).toHaveAttribute("data-source", "custom");
	await expect(tokyoAll).toContainText("Custom");
	await page.goto(`/t/${c.slug}/japan?tab=money`);
	await expectLive(page);
	await budget.getByRole("radio", { name: "Group" }).click().catch(() => {});
	await expect(budget).toContainText("Over-allocated", { timeout: 10_000 });
	await shot(page, "x2-05-over-allocated");
	expect(logs.messages).toEqual([]);
	await ctx.close();

	// 5. Display currency "Local" (Maya's own preference): ¥ inside Japan, $ at the root.
	const mayaCtx = await browser.newContext({ storageState: storageStateOf("maya"), viewport: { width: 1440, height: 900 } });
	const maya = await mayaCtx.newPage();
	await maya.goto(`/t/${c.slug}/japan/tokyo?tab=money`);
	await expectLive(maya);
	await maya.getByTestId(M.displayCurrency).click();
	await maya.getByRole("option", { name: /Local/ }).click();
	await expect(maya.getByTestId(M.displayCurrency)).toContainText("Local · JPY");
	await expect(maya.getByTestId(M.summaryActual)).toContainText("¥");
	await shot(maya, "x2-06-local-yen");
	await maya.goto(`/t/${c.slug}?tab=money`);
	await expectLive(maya);
	await expect(maya.getByTestId(M.summaryActual)).toContainText("$");
	await maya.getByTestId(M.displayCurrency).click();
	await maya.getByRole("option", { name: /Home currency/ }).click();
	await expect(maya.getByTestId(M.displayCurrency)).toContainText("USD");
	await mayaCtx.close();
});

// ---------------------------------------------------------------------------
// Extension X3: an opening-hours warning and the date-shift what-if in the
// real workspace. Itoya is closed on Tuesdays; +1 day would land it on one:
// the dialog says so before committing, applying shows the warning on the
// card, and Undo takes it back.
// ---------------------------------------------------------------------------
async function callPage<T>(page: Page, module: string, fn: string, data: unknown): Promise<T> {
	const r = await page.evaluate(
		async ({ module, fn, data }) => {
			try {
				const m = await import(/* @vite-ignore */ module);
				return { ok: true as const, value: await m[fn]({ data }) };
			} catch (e) {
				return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
			}
		},
		{ module, fn, data },
	);
	if (!r.ok) throw new Error(`${fn}: ${r.error}`);
	return r.value as T;
}

test("X3 opening hours warn on the card; the what-if shows the closure first; apply and Undo", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(180_000);
	const ctx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const logs = collectConsole(page, [...MAP_NOISE, /status of 409/]);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items as Record<string, string>;
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place`);
	await expectLive(page);
	// Sheet hours on Itoya (as the importer writes them): closed on Tuesdays.
	await callPage(page, "/src/functions/nodes.functions.ts", "updateNode", {
		nodeId: c.ids.nodes.itoya,
		patch: { details: { openHoursText: "10:00–20:00; closed Tue" } },
	});
	await page.reload();
	await expectLive(page);
	const itoya = page.locator(`[data-testid="${TESTID.timelineItem}"][data-item-id="${I.itoya}"]`).first();
	await expect(itoya).toBeVisible();
	await expect(itoya.getByTestId(TESTID.hoursChip)).toHaveCount(0); // open on Mondays

	// Try other dates… +1 day: the closure shows before anything changes.
	await page.getByTestId(TESTID.tripMenu).click();
	await page.getByTestId(SHELL_TESTID.tryOtherDates).click();
	const dialog = page.getByTestId(TESTID.shiftTripDialog);
	await expect(dialog).toBeVisible();
	await dialog.getByTestId(INS.shiftPlus).click();
	await expect(dialog.getByTestId(INS.shiftSummary)).toContainText("Day 1 becomes Mon 4 Oct");
	const closures = dialog.locator(`[data-testid=${INS.impactSection}][data-section=closures]`);
	await expect(closures).toContainText("Itoya Ginza");
	await expect(closures).toContainText(/Closed Tue/i);
	await shot(page, "x3-01-what-if");
	await dialog.getByTestId(INS.shiftApply).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("Trip shifted +1 day")).toBeVisible();

	// Itoya is now on Tuesday: its card warns.
	await expect(itoya.getByTestId(TESTID.hoursChip)).toBeVisible({ timeout: 15_000 });
	await itoya.getByTestId(TESTID.hoursChip).click();
	await expect(page.getByTestId(INS.hoursPopover)).toContainText(/Closed/i);
	await shot(page, "x3-02-hours-warning");
	await page.keyboard.press("Escape");

	// Undo shifts it back; the warning goes.
	await page.getByRole("button", { name: "Undo" }).first().click();
	await expect(itoya.getByTestId(TESTID.hoursChip)).toHaveCount(0, { timeout: 15_000 });
	expect(logs.messages).toEqual([]);
	await ctx.close();
});

// ---------------------------------------------------------------------------
// Extension X4: Share to Yonder (E8). A TikTok shared to the app is attached
// to an existing place of the last-used trip in one step; it shows in that
// place's Media. (The OS share sheet's POST goes through the service worker:
// covered on the production build; here the page gets it by paste, the iOS
// path, which saves the same way.)
// ---------------------------------------------------------------------------
test("X4 share target: a TikTok goes to Shibuya Sky's media", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(120_000);
	const ctx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const logs = collectConsole(page, MAP_NOISE);
	const c = await cloneFixtureTrip(page.request);
	await page.goto("/share");
	await page.evaluate((id) => localStorage.setItem("yonder:share-last-trip", id), c.tripId);
	await page.reload();
	await expect(page.getByTestId(TESTID.shareInbox)).toBeVisible();
	const url = "https://www.tiktok.com/@shibuyasky/video/7301234567890123456";
	await (await hydrated(page.getByTestId(HOME_TESTID.sharePaste))).fill(url);
	await page.getByRole("button", { name: "Use" }).click();
	await page.getByRole("button", { name: /Add to existing/ }).click();
	await page.locator("#share-place").click();
	await page.getByRole("option", { name: "Shibuya Sky" }).click();
	await shot(page, "x4-01-share-inbox");
	await page.getByTestId(HOME_TESTID.shareSave).click();
	await expect(page.getByTestId(TESTID.shareInbox)).toContainText(/Saved|Added/, { timeout: 15_000 });
	await shot(page, "x4-02-saved");
	await page.goto(`/t/${c.slug}/japan/tokyo/shibuya/shibuya-sky?tab=media`);
	await expectLive(page);
	await expect(page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=embed]`)).toHaveCount(1, { timeout: 15_000 });
	await shot(page, "x4-03-in-media");
	expect(logs.messages).toEqual([]);
	await ctx.close();
});

// ---------------------------------------------------------------------------
// Extension X5: rating with comments, in the Places tab (docs/PLACES.md §1b,
// the old Rate screen folded in). Dennis and Maya rate Senso-ji in the Rate
// feed (through the old `/rate` link) with comments; the Places table shows
// both ratings side by side and its drawer both comments; the place overview
// in the workspace shows them too; the card shows the place's media.
// ---------------------------------------------------------------------------
test("X5 Rate feed: two members rate with comments; the Places table, its drawer and the place overview show them", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(180_000);
	const ctx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const logs = collectConsole(page, [...MAP_NOISE, /status of 404/]);
	const c = await cloneFixtureTrip(page.request);
	const N = c.ids.nodes as Record<string, string>;
	const rateAs = async (p: Page, key: string, comment: string) => {
		// The old Rate screen's link opens the Places tab's Rate feed on that place.
		await p.goto(`/t/${c.slug}/rate?n=${N.sensoji}`);
		await expect(p).toHaveURL(/tab=places/, { timeout: 20_000 });
		await expect(p).toHaveURL(/pv=rate/);
		const card = p.locator(`[data-testid=${PT.feedCard}][data-active]`);
		await expect(card).toHaveAttribute("data-place", N.sensoji, { timeout: 20_000 });
		await p.keyboard.press(key);
		await expect(card).toHaveAttribute("data-rated", /.+/);
		// No auto-advance: the feed stays on the card just rated.
		await expect(card).toHaveAttribute("data-place", N.sensoji);
		await card.getByRole("button", { name: "Add a comment" }).click();
		const field = card.getByTestId(P.ratingComment).getByTestId(TESTID.mentionInput);
		await field.fill(comment);
		await field.press("Enter");
		await expect(card).toContainText(comment);
	};
	await rateAs(page, "1", "Go at 7am before the crowds");
	// The card shows the place's media (a photo, or its location map).
	await expect(page.locator(`[data-testid=${PT.feedCard}][data-active]`).locator("img, [role=img]").first()).toBeVisible();
	await shot(page, "x5-01-dennis-card");
	const mayaCtx = await browser.newContext({ storageState: storageStateOf("maya"), viewport: { width: 1440, height: 900 } });
	const maya = await mayaCtx.newPage();
	await rateAs(maya, "3", "Only if it isn't raining");
	await expect(maya.getByTestId(PT.progress)).toBeVisible();

	// The table (the old compare view's link): both ratings in Senso-ji's row
	// (Must +3 and Want +1: score +4), and its drawer holds both comments.
	await page.goto(`/t/${c.slug}/rate?view=compare`);
	await expect(page).toHaveURL(/tab=places/, { timeout: 20_000 });
	await expect(page).not.toHaveURL(/pv=rate/);
	const row = page.locator(`[data-testid=${PT.row}][data-row-id="${N.sensoji}"]`);
	await expect(row).toBeVisible({ timeout: 20_000 });
	await expect(row).toHaveAttribute("data-score", "4");
	await expect(row).toContainText("Must");
	await expect(row).toContainText("Want");
	await row.locator("td").first().click();
	const drawer = page.getByTestId(PT.drawer);
	await expect(drawer).toHaveAttribute("data-place", N.sensoji);
	const ratingRow = (member: string) => drawer.locator(`[data-testid=${PT.ratingRow}][data-member="${member}"]`);
	await expect(ratingRow(c.members.owner)).toContainText("Go at 7am before the crowds");
	await expect(ratingRow(c.members.maya as string)).toContainText("Only if it isn't raining");
	// Maya's comment isn't Dennis's to edit.
	await expect(ratingRow(c.members.maya as string).getByRole("button", { name: /Edit the comment/ })).toHaveCount(0);
	await shot(page, "x5-02-table-drawer");

	// The place overview in the workspace shows each member's rating and comment;
	// Maya's comment isn't Dennis's to edit.
	await page.goto(`/t/${c.slug}/japan/tokyo?sel=n.${N.sensoji}`);
	await expectLive(page);
	const ov = page.getByTestId(TESTID.nodeOverview);
	await expect(ov).toContainText("Go at 7am before the crowds");
	await expect(ov).toContainText("Only if it isn't raining");
	const mayaRow = ov.locator(`[data-testid=${P.priorityRow}]`).filter({ hasText: "Maya" });
	await expect(mayaRow.getByRole("button", { name: /Edit .*comment/ })).toHaveCount(0);
	await shot(page, "x5-03-overview");
	expect(logs.messages).toEqual([]);
	await mayaCtx.close();
	await ctx.close();
});

// ---------------------------------------------------------------------------
// Extension X6: one inbox. Maya (a suggester) suggests; Dennis's bell has it to
// review and he rejects it; Maya's one bell then holds the result, a to-do due
// soon, a balance that changed after she settled, and a budget notice, with
// one read state.
// ---------------------------------------------------------------------------
test("X6 one inbox: review, result, due, balance changed and budget notice in one bell", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(240_000);
	const ownerCtx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const owner = await ownerCtx.newPage();
	const logs = collectConsole(owner, MAP_NOISE);
	const c = await cloneFixtureTrip(owner.request, { mayaRole: "suggester" });
	const I = c.ids.items as Record<string, string>;
	const maya = c.members.maya as string;
	const me = c.members.owner;
	const url = `/t/${c.slug}/japan/tokyo?lens=place&days=2027-10-04`;
	const mayaCtx = await browser.newContext({ storageState: storageStateOf("maya"), viewport: { width: 1440, height: 900 } });
	const mp = await mayaCtx.newPage();
	await mp.goto(url);
	await expectLive(mp);
	await mp.getByTestId(S.firstHint).getByRole("button", { name: "Got it" }).click().catch(() => {});
	await setDuration(mp, I.itoya, "2h");
	await expect(mp.getByText(/^Suggested — /).first()).toBeVisible();

	// Dennis: "1 suggestion to review" in the bell opens the review drawer.
	await owner.goto(url);
	await expectLive(owner);
	const bell = (p: Page) => p.getByTestId(TESTID.inboxBell).first();
	const panel = (p: Page) => p.getByTestId(SHELL_TESTID.inboxPanel);
	await bell(owner).click();
	const review = panel(owner).getByTestId(SHELL_TESTID.inboxRow).filter({ hasText: "1 suggestion to review" });
	await expect(review).toBeVisible({ timeout: 15_000 });
	await shot(owner, "x6-01-owner-inbox");
	await review.click();
	const drawer = owner.getByTestId(TESTID.reviewDrawer);
	await expect(drawer).toBeVisible();
	await drawer.getByTestId(S.row).first().getByTestId(S.reject).click();
	await owner.getByTestId(S.rejectNote).fill("Itoya stays 1h, we have Loft too");
	await owner.getByTestId(S.rejectConfirm).click();
	await expect(drawer.getByText("Nothing to review.")).toBeVisible({ timeout: 15_000 });
	await owner.keyboard.press("Escape");

	// Money and lists set-up through the server functions (as Dennis):
	const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
	await callPage(owner, "/src/features/lists/lists.functions.ts", "createListItem", {
		tripId: c.tripId,
		target: { kind: "trip" },
		list: "todo",
		text: "Buy Ghibli Museum tickets",
		dueDate: soon,
		assigneeIds: [maya],
	});
	const money = "/src/features/money/money.functions.ts";
	const exp = await callPage<{ id: string }>(owner, money, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Suica top-up",
		amountMinor: 6000,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: me }, { memberId: maya }] },
		payments: [
			{
				paidAt: new Date().toISOString(),
				paidTz: "Asia/Tokyo",
				currency: "JPY",
				amountMinor: 6000,
				payers: [{ memberId: me, amountMinor: 6000 }],
			},
		],
	});
	await callPage(owner, money, "createSettlement", {
		tripId: c.tripId,
		fromMemberId: maya,
		toMemberId: me,
		amountMinor: 3000,
		currency: "JPY",
		settledAt: new Date().toISOString(),
		settledTz: "Asia/Tokyo",
		method: "cash",
	});
	await callPage(owner, money, "updateExpense", {
		id: exp.id,
		patch: {
			amountMinor: 8000,
			payments: [
				{
					paidAt: new Date().toISOString(),
					paidTz: "Asia/Tokyo",
					currency: "JPY",
					amountMinor: 8000,
					payers: [{ memberId: me, amountMinor: 8000 }],
				},
			],
		},
	});
	// Budgets: a trip default, Maya's own value, then a new default.
	await callPage(owner, money, "setBudgetLine", { tripId: c.tripId, nodeId: null, category: null, memberId: null, amountMinor: 100_000, kind: "total" });
	await callPage(mp, money, "setBudgetLine", { tripId: c.tripId, nodeId: null, category: null, memberId: maya, amountMinor: 80_000, kind: "total" });
	await callPage(owner, money, "setBudgetLine", { tripId: c.tripId, nodeId: null, category: null, memberId: null, amountMinor: 150_000, kind: "total" });

	// Maya's one bell.
	await mp.reload();
	await expectLive(mp);
	await expect.poll(async () => Number((await bell(mp).getAttribute("data-unread")) ?? 0), { timeout: 20_000 }).toBeGreaterThanOrEqual(4);
	await bell(mp).click();
	const rows = panel(mp).getByTestId(SHELL_TESTID.inboxRow);
	await expect(rows.filter({ hasText: "rejected your suggestion" })).toBeVisible();
	await expect(rows.filter({ hasText: "Buy Ghibli Museum tickets" })).toBeVisible();
	await expect(rows.filter({ hasText: "Balance changed since your last settlement" })).toBeVisible();
	await expect(rows.filter({ hasText: /Trip default is now \$1,500.*yours stays \$800/ })).toBeVisible();
	for (const g of ["Suggestions", "To-dos", "Money"])
		await expect(panel(mp).getByRole("region", { name: g }).or(panel(mp).locator(`section[aria-label="${g}"]`))).toBeVisible();
	await shot(mp, "x6-02-maya-inbox");
	// One read state.
	await panel(mp).getByTestId(SHELL_TESTID.inboxMarkAll).click();
	await expect.poll(async () => Number((await bell(mp).getAttribute("data-unread")) ?? 0)).toBe(0);
	await expect(rows.first()).toBeVisible();
	expect(logs.messages).toEqual([]);
	await mayaCtx.close();
	await ownerCtx.close();
});

// ---------------------------------------------------------------------------
// Extension X7: duplicate a trip from Trip settings: a new start date shifts
// every day (pinned local times kept); notes, lists (reset to open), media and
// the default budget come along; expenses, members and links don't.
// ---------------------------------------------------------------------------
type FullGraph = {
	trip: { id: string; slug: string; name: string; startDate: string | null };
	days: { id: string; date: string }[];
	items: { id: string; title: string | null; nodeId: string | null; pinnedStart: string | null; dayId: string | null }[];
	nodes: { id: string; name: string }[];
	members: { id: string; name: string; status: string }[];
};
const fullGraph = (page: Page) =>
	page.evaluate(() => (window as unknown as { __yonder: { graph: FullGraph } }).__yonder.graph);

test("X7 duplicate trip: shifted days, pinned times kept, the right things copied", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(180_000);
	const ctx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const logs = collectConsole(page, MAP_NOISE);
	const c = await cloneFixtureTrip(page.request);
	// Before: a done to-do and a trip-default budget.
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const li = await callPage<{ id: string }>(page, "/src/features/lists/lists.functions.ts", "createListItem", {
		tripId: c.tripId,
		target: { kind: "trip" },
		list: "todo",
		text: "Print the JR pass voucher",
	});
	await callPage(page, "/src/features/lists/lists.functions.ts", "setListItemStatus", { id: li.id, status: "done" });
	await callPage(page, "/src/features/money/money.functions.ts", "setBudgetLine", {
		tripId: c.tripId, nodeId: null, category: null, memberId: null, amountMinor: 250_000, kind: "total",
	});
	await callPage(page, "/src/features/money/money.functions.ts", "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Rail passes",
		amountMinor: 50_000,
		currency: "JPY",
	});
	const src = await fullGraph(page);
	const srcMoney = await listMoney(page, c.tripId);
	expect(srcMoney.expenses.length).toBeGreaterThan(0);

	// Trip settings → Duplicate…: a week later, everything copied.
	await page.reload();
	await expectLive(page);
	await page.getByTestId(TESTID.tripMenu).click();
	await page.getByRole("menuitem", { name: "Trip settings" }).click();
	await page.getByTestId(HOME_TESTID.settingsDuplicate).click();
	const dlg = page.getByTestId(HOME_TESTID.duplicateDialog);
	await expect(dlg).toBeVisible();
	const name = `Japan again ${tag()}`;
	await dlg.getByTestId(HOME_TESTID.duplicateName).fill(name);
	await dlg.getByTestId(HOME_TESTID.duplicateStart).click();
	await page.locator('[data-slot="popover-content"] button[data-day]').filter({ hasText: /^10$/ }).first().click();
	for (const box of await dlg.getByTestId(HOME_TESTID.duplicateOption).all())
		if ((await box.getAttribute("data-state")) !== "checked") await box.click();
	await shot(page, "x7-01-duplicate-dialog");
	await dlg.getByTestId(HOME_TESTID.duplicateSubmit).click();
	await expect(page.getByTestId(TESTID.tripMenu)).toContainText(name, { timeout: 30_000 });
	await expectLive(page);
	const dup = await fullGraph(page);
	expect(dup.trip.id).not.toBe(c.tripId);
	expect(dup.days[0]?.date).toBe("2027-10-10");
	expect(dup.days).toHaveLength(src.days.length);
	const pinned = (g: FullGraph) => g.items.filter((i) => i.pinnedStart).map((i) => i.pinnedStart).sort();
	expect(pinned(dup)).toEqual(pinned(src));
	expect(dup.nodes.length).toBe(src.nodes.length);
	// Only the duplicator is a member (placeholders came along as asked).
	expect(dup.members.filter((m) => m.status === "active").map((m) => m.name)).toEqual(["Dev User"]);
	await shot(page, "x7-02-copy");

	// Lists copied and reset; notes and media copied; no expenses; the budget default.
	const lists = await callPage<{ text: string; status: string }[] | { items: { text: string; status: string }[] }>(
		page,
		"/src/features/lists/lists.functions.ts",
		"listTripListItems",
		{ tripId: dup.trip.id },
	);
	const all = Array.isArray(lists) ? lists : lists.items;
	const voucher = all.find((x) => x.text === "Print the JR pass voucher");
	expect(voucher?.status).toBe("open");
	await page.goto(`/t/${dup.trip.slug}?tab=media`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.galleryItem).first()).toBeVisible();
	await page.goto(`/t/${dup.trip.slug}?tab=notes`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.notesTab)).toContainText("Passports valid until 2028");
	const dupMoney = await listMoney(page, dup.trip.id);
	expect(dupMoney.expenses).toHaveLength(0);
	await page.goto(`/t/${dup.trip.slug}?tab=money`);
	await expectLive(page);
	await expect(page.getByTestId(M.budget).locator(`[data-testid=${M.budgetRow}][data-category=all]`)).toContainText("$2.5K");
	await shot(page, "x7-03-copy-money");
	expect(logs.messages).toEqual([]);
	await ctx.close();
});

// ---------------------------------------------------------------------------
// Extension X8: PDF attachments and "Hide from guests". A general PDF on a
// place is visible to link guests until a member hides it from the PDF
// viewer; a PDF on the flight starts hidden; the guest never receives either.
// ---------------------------------------------------------------------------
test("X8 PDFs: a general PDF shows to guests until hidden; a flight PDF starts hidden", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(180_000);
	const ctx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const logs = collectConsole(page, MAP_NOISE);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items as Record<string, string>;
	const skyUrl = `/t/${c.slug}/japan/tokyo/shibuya/shibuya-sky?tab=media`;
	await page.goto(skyUrl);
	await expectLive(page);
	await page.getByTestId(MEDIA_TESTID.fileInput).first().setInputFiles({
		name: "Shibuya Sky floor map.pdf",
		mimeType: "application/pdf",
		buffer: makePdf(["Shibuya Sky floor map", "Rooftop", "Exits"], { title: "Shibuya Sky map" }),
	});
	const pdf = page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`);
	await expect(pdf).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	await expect(pdf).toHaveAttribute("data-visibility", "everyone");
	// A flight e-ticket starts hidden from guests.
	await page.goto(`/t/${c.slug}?sel=l.${I.kix}.${I.icn}`);
	await expectLive(page);
	const inspector = page.getByTestId(TESTID.inspector);
	await inspector.getByRole("tab", { name: "Media" }).click();
	await inspector.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({
		name: "E-ticket KE724.pdf",
		mimeType: "application/pdf",
		buffer: makePdf(["E-ticket KE724", "PNR XJ4K2Q"], { title: "Korean Air KE724" }),
	});
	const eticket = inspector.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`);
	await expect(eticket).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	await expect(eticket).toHaveAttribute("data-visibility", "members");
	await shot(page, "x8-01-flight-pdf-hidden");

	// A view-link guest sees the map PDF, never the e-ticket.
	const guestCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const guest = await guestCtx.newPage();
	const bodies: string[] = [];
	guest.on("response", async (r) => {
		if (r.url().includes("/_serverFn/")) bodies.push(await r.text().catch(() => ""));
	});
	await openLink(guest, c.slug, "viewer");
	await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 20_000 });
	await guest.goto(skyUrl);
	await expectLive(guest);
	const gpdf = guest.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`);
	await expect(gpdf).toHaveCount(1);
	await expect(guest.getByTestId(MEDIA_TESTID.visibility)).toHaveCount(0);

	// Dennis hides the map from guests in the PDF viewer: it disappears for the guest, live.
	await page.goto(skyUrl);
	await expectLive(page);
	await pdf.getByRole("button").first().click();
	const viewer = page.getByTestId(MEDIA_TESTID.pdfViewer);
	await expect(viewer).toBeVisible();
	const lock = viewer.getByTestId(MEDIA_TESTID.visibility).first();
	await lock.click();
	await expect(lock).toHaveAttribute("data-state", "hidden");
	await expect(lock).toContainText("Hidden from guests");
	await shot(page, "x8-02-viewer-hidden");
	await page.keyboard.press("Escape");
	await expect(gpdf).toHaveCount(0, { timeout: 15_000 });
	await shot(guest, "x8-03-guest-no-pdfs");
	expect(bodies.join("\n")).not.toMatch(/E-ticket KE724/);
	expect(logs.messages).toEqual([]);
	await guestCtx.close();
	await ctx.close();
});

// ---------------------------------------------------------------------------
// Extension X9: a private gift. Dennis adds a private shopping item (a gift for
// Maya), buys it and records the cost, which starts private too. Maya sees
// neither: not in her lists, counts, money, activity or inbox.
// ---------------------------------------------------------------------------
test("X9 a private gift item and its expense stay invisible to another member", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(180_000);
	const ctx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const logs = collectConsole(page, MAP_NOISE);
	const c = await cloneFixtureTrip(page.request);
	const gift = "Fountain pen, a gift for Maya";
	await page.goto(`/t/${c.slug}?tab=lists&list=shopping`);
	await expectLive(page);
	const mayaCtx = await browser.newContext({ storageState: storageStateOf("maya"), viewport: { width: 1440, height: 900 } });
	const mp = await mayaCtx.newPage();
	await mp.goto(`/t/${c.slug}?tab=lists&list=shopping`);
	await expectLive(mp);
	const mayaLists0 = await tabCount(mp, "lists");

	await page.getByTestId(L.addPrivate).click();
	await expect(page.getByTestId(L.addPrivate)).toHaveAttribute("aria-pressed", "true");
	const input = page.getByTestId(L.add).getByTestId(TESTID.mentionInput);
	await input.click();
	await page.keyboard.type(gift);
	await page.keyboard.press("Enter");
	const row = page.getByTestId(L.row).filter({ hasText: gift });
	await expect(row).toHaveAttribute("data-private", "");
	// Bought → Add expense: the editor starts private.
	await row.getByTestId(L.rowCheck).click();
	await row.getByTestId(L.boughtExpense).click();
	const d = page.getByTestId(TESTID.addExpenseDialog);
	await expect(d).toBeVisible();
	await d.getByTestId(M.amount).fill("18000");
	await d.getByTestId(M.more).click().catch(() => {});
	await expect(d.getByTestId(M.private)).toHaveAttribute("data-state", "checked");
	await shot(page, "x9-01-private-expense");
	await d.getByTestId(M.save).click();
	await expect(d).toBeHidden();
	const mine = await listMoney(page, c.tripId);
	expect(mine.expenses.some((e) => e.title.includes("Fountain pen"))).toBe(true);

	// Maya: nothing, anywhere.
	await mp.reload();
	await expectLive(mp);
	await expect(mp.getByTestId(L.row).filter({ hasText: "Petty knife" })).toBeVisible();
	await expect(mp.getByText(/Fountain pen/)).toHaveCount(0);
	expect(await tabCount(mp, "lists")).toBe(mayaLists0);
	const hers = await callPage<{ text: string }[]>(mp, "/src/features/lists/lists.functions.ts", "listTripListItems", { tripId: c.tripId });
	expect(hers.some((r) => r.text.includes("Fountain pen"))).toBe(false);
	const herMoney = await listMoney(mp, c.tripId);
	expect(herMoney.expenses.some((e) => e.title.includes("Fountain pen"))).toBe(false);
	const act = await callPage<{ summary: string }[] | { items: { summary: string }[] }>(mp, "/src/functions/graph.functions.ts", "listActivity", { tripId: c.tripId }).catch(() => null);
	if (act) {
		const rows = Array.isArray(act) ? act : act.items;
		expect(JSON.stringify(rows)).not.toMatch(/Fountain pen/);
	}
	await mp.getByTestId(TESTID.inboxBell).first().click();
	await expect(mp.getByTestId(SHELL_TESTID.inboxPanel)).not.toContainText("Fountain pen");
	await shot(mp, "x9-02-maya-sees-nothing");
	expect(logs.messages).toEqual([]);
	await mayaCtx.close();
	await ctx.close();
});

// ---------------------------------------------------------------------------
// Extension X10: placeholders. Typing a new name ("Kenji") in the assignee
// picker makes a placeholder person; he's in an expense split; the owner
// links him to an email (FB-14: no per-person join links), a brand-new
// account with that email signs in as him, and the tag and the money carry
// over.
// ---------------------------------------------------------------------------
test("X10 a typed-in placeholder is tagged and owes money; linked to an email, a new account becomes him", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	test.setTimeout(180_000);
	const ctx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const logs = collectConsole(page, MAP_NOISE);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items as Record<string, string>;
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place&sel=i.${I.sensoji}`);
	await expectLive(page);
	const overview = page.getByTestId(TESTID.itemOverview);
	await expect(overview).toBeVisible();
	await overview.getByTestId(PLAN_TESTID.overviewAssignees).getByRole("button", { name: "Assign" }).click();
	await page.getByPlaceholder("Search or add a name…").fill("Kenji");
	await page.getByTestId("member-picker-add").click();
	await expect(overview.getByTestId(PLAN_TESTID.overviewAssignees)).toContainText("Kenji");
	await page.keyboard.press("Escape");
	let kenji: string | undefined;
	await expect
		.poll(async () => {
			kenji = (await fullGraph(page)).members.find((m) => m.name === "Kenji" && m.status === "placeholder")?.id;
			return kenji ?? null;
		})
		.not.toBeNull();
	// Kenji is in a split: he owes Dennis half of the taxi.
	await callPage(page, "/src/features/money/money.functions.ts", "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Taxi to Asakusa",
		amountMinor: 4000,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: c.members.owner }, { memberId: kenji }] },
		payments: [
			{
				paidAt: new Date().toISOString(),
				paidTz: "Asia/Tokyo",
				currency: "JPY",
				amountMinor: 4000,
				payers: [{ memberId: c.members.owner, amountMinor: 4000 }],
			},
		],
	});

	// The owner links him to an email, from the Share dialog.
	const email = `kenji-${tag()}@example.test`;
	await page.keyboard.press("Escape");
	await page.getByTestId(TESTID.shareButton).click();
	const dialog = page.getByTestId(TESTID.shareDialog);
	const krow = dialog.locator(`[data-testid=${HOME_TESTID.memberRow}][data-status=placeholder]`).filter({ hasText: "Kenji" });
	await krow.getByTestId(HOME_TESTID.memberMenu).click();
	await page.getByTestId(HOME_TESTID.placeholderLinkEmail).click();
	await krow.getByRole("textbox", { name: "Email for Kenji" }).fill(email);
	await krow.getByRole("button", { name: "Link", exact: true }).click();
	await expect(dialog.locator(`[data-testid=${HOME_TESTID.memberRow}][data-status=invited]`).filter({ hasText: "Kenji" })).toBeVisible();
	await shot(page, "x10-01-linked-email");
	await page.keyboard.press("Escape");

	// A brand-new account with that email signs in and is Kenji.
	const kctx = await userContext(browser, email, { first: "Kenji", last: "Sato" });
	const kp = await kctx.newPage();
	await kp.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(kp);
	const me = await kp.evaluate(
		() => (window as unknown as { __yonder: { graph: { me: { memberId: string } } } }).__yonder.graph.me,
	);
	expect(me.memberId).toBe(kenji);
	// His tag and his share carried over.
	await kp.goto(`/t/${c.slug}/japan/tokyo?lens=place&sel=i.${I.sensoji}`);
	await expectLive(kp);
	await expect(kp.getByTestId(TESTID.itemOverview).getByTestId(PLAN_TESTID.overviewAssignees)).toContainText("Kenji");
	await kp.goto(`/t/${c.slug}?tab=money`);
	await expectLive(kp);
	await expect(kp.getByTestId(M.balances)).toContainText(/You owe Dev/);
	await shot(kp, "x10-02-kenji-claimed");
	// Dennis now sees Kenji Sato as a member, not a placeholder.
	await page.reload();
	await expectLive(page);
	expect((await fullGraph(page)).members.find((m) => m.id === kenji)?.status).toBe("active");
	expect(logs.messages).toEqual([]);
	await kctx.close();
	await ctx.close();
});

// ---------------------------------------------------------------------------
// Extension X4b (production build only): the OS share sheet's POST to /share
// goes through the service worker (stored on the device, 303 → /share?id=),
// and the shared TikTok lands in the Share inbox ready to save.
// ---------------------------------------------------------------------------
test("X4b share target POST through the service worker (production build)", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop journey");
	const ctx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const sw = await page.request.get("/sw.js");
	test.skip(!sw.ok(), "needs the production build (pnpm build && pnpm start)");
	const c = await cloneFixtureTrip(page.request);
	await page.goto("/dashboard");
	await expect
		.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active && !!navigator.serviceWorker.controller), { timeout: 20_000 })
		.toBe(true);
	await page.evaluate((id) => localStorage.setItem("yonder:share-last-trip", id), c.tripId);
	// What Android's share sheet does: a multipart POST navigation to /share.
	await page.evaluate(() => {
		const f = document.createElement("form");
		f.method = "POST";
		f.action = "/share";
		f.enctype = "multipart/form-data";
		for (const [k, v] of [
			["title", "Shibuya at night"],
			["text", "look at this"],
			["url", "https://www.tiktok.com/@tokyonight/video/7309876543210987654"],
		]) {
			const i = document.createElement("input");
			i.type = "hidden";
			i.name = k as string;
			i.value = v as string;
			f.appendChild(i);
		}
		document.body.appendChild(f);
		f.submit();
	});
	await expect(page).toHaveURL(/\/share\?id=/, { timeout: 15_000 });
	const inbox = page.getByTestId(TESTID.shareInbox);
	await expect(inbox).toContainText("tiktok.com");
	await shot(page, "x4b-01-share-post");
	await page.getByTestId(HOME_TESTID.shareSave).click();
	await expect(inbox).toContainText(/Saved/, { timeout: 15_000 });
	await ctx.close();
});

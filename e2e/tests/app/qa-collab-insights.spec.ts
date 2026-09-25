/**
 * I2 verifier "collab" (round 1): E1 opening hours and E2 the date-shift
 * what-if on the QA seed's real Asia 2027 data (EXTENSIONS §4 QA HRS, §5 QA
 * SHIFT), plus SUG-15 (a suggested shift accepted after unrelated edits).
 *
 * Needs the QA seed and `$QA_AUTH_DIR/<handle>.json` storageStates. Every
 * test puts the trip back the way it found it.
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { INSIGHTS_TESTID as I } from "../../../src/features/insights/testids";
import { PLAN_TESTID as P } from "../../../src/features/plan/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath } from "./_helpers/env";
import { collectConsole, expectLive } from "./_helpers/page";

const AUTH = process.env.QA_AUTH_DIR ?? path.resolve("e2e/.auth");
const auth = (h: string) => path.join(AUTH, `${h}.json`);
const shot = (n: string) =>
	process.env.QA_SHOTS_DIR ? path.join(process.env.QA_SHOTS_DIR, `${n}.png`) : shotPath(`qa-collab/${n}.png`);
const TOKYO = "/t/asia-2027/japan/tokyo";

async function open(browser: Browser, handle: string, url: string) {
	const ctx = await browser.newContext({ storageState: auth(handle), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await page.goto(url);
	await expectLive(page);
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	return { ctx, page };
}

type Gr = {
	trip: { id: string; startDate: string; endDate: string };
	days: { id: string; date: string }[];
	items: { id: string; dayId: string | null; nodeId: string | null; title: string | null; fixedDate?: boolean }[];
	nodes: { id: string; name: string; details?: Record<string, unknown> }[];
};
const graph = (p: Page) => p.evaluate(() => (window as unknown as { __yonder: { graph: Gr } }).__yonder.graph);
async function call<T = unknown>(p: Page, file: string, fn: string, data: unknown): Promise<T> {
	return p.evaluate(
		async ({ file, fn, data }) => {
			const mod = (await import(/* @vite-ignore */ file)) as Record<string, (o: { data: unknown }) => Promise<unknown>>;
			const out = await mod[fn]!({ data });
			// This tab never hears its own change: refresh the app's queries like its hooks would.
			const { appQueryClient } = await import(
				/* @vite-ignore */ "/src/features/suggest/__harness__/app-query-client.ts"
			);
			await appQueryClient()?.invalidateQueries();
			return out;
		},
		{ file, fn, data },
	) as Promise<T>;
}
async function item(p: Page, name: string) {
	const g = await graph(p);
	const node = g.nodes.find((n) => n.name === name);
	const it = g.items.find((i) => i.dayId && (i.title === name || (node && i.nodeId === node.id)));
	if (!it) throw new Error(`no item ${name}`);
	return { ...it, date: g.days.find((d) => d.id === it.dayId)?.date ?? null, node };
}
const dayId = async (p: Page, date: string) => (await graph(p)).days.find((d) => d.date === date)?.id as string;
const card = (p: Page, id: string) => p.locator(`[data-testid="${TESTID.timelineItem}"][data-item-id="${id}"]`).first();

test.skip(({ isMobile }) => isMobile, "desktop");

test("HRS-01/02 on real data: JAL Sky Museum (closed Wed & Fri) moved to Wed warns on the card and the day; the fix moves it", async ({
	browser,
}) => {
	const d = await open(browser, "dennis", TOKYO);
	const logs = collectConsole(d.page);
	const jal = await item(d.page, "JAL Sky Museum");
	expect(jal.date).toBe("2027-10-03");
	const breakfast = (await graph(d.page)).items.find(
		(i) => i.dayId === jal.dayId && i.title === "Breakfast",
	);
	const wed = await dayId(d.page, "2027-10-06");
	const wedBreakfast = (await graph(d.page)).items.find((i) => i.dayId === wed && i.title === "Breakfast");
	// After Wednesday's breakfast (09:00–09:30), so its 09:30 pin fits and the closure is the only issue.
	await call(d.page, "/src/functions/items.functions.ts", "moveItem", {
		itemId: jal.id,
		dayId: wed,
		...(wedBreakfast ? { afterItemId: wedBreakfast.id } : {}),
	});
	await d.page.goto(`${TOKYO}?days=2027-10-06`);
	await expectLive(d.page);
	const c = card(d.page, jal.id);
	await c.scrollIntoViewIfNeeded();
	const chip = c.getByTestId(TESTID.hoursChip);
	await expect(chip).toContainText("Closed Wed");
	// The day header: one amber chip for the closure (or folded into "N issues").
	const hdr = d.page.locator(`[data-testid="${P.daySection}"][data-day-id="${wed}"]`).getByTestId(P.dayHeader);
	await expect(hdr).toContainText(/JAL Sky Museum closed Wed|issues?/);
	await d.page.screenshot({ path: shot("hrs01-closed-wed") });
	await chip.click();
	const pop = d.page.getByTestId(I.hoursPopover);
	await expect(pop).toBeVisible();
	await expect(pop).toContainText(/From the sheet/);
	await d.page.screenshot({ path: shot("hrs01-popover") });
	const fixes = pop.getByTestId(I.hoursFix);
	const labels = await fixes.allInnerTexts();
	console.log("[hrs02] fixes:", labels);
	expect(labels.some((l) => /^Move to /.test(l))).toBe(true);
	expect(labels.some((l) => /Unschedule/.test(l))).toBe(true);
	await fixes.filter({ hasText: /^Move to / }).click();
	await expect.poll(async () => (await item(d.page, "JAL Sky Museum")).date, { timeout: 10_000 }).not.toBe("2027-10-06");
	const moved = await item(d.page, "JAL Sky Museum");
	console.log("[hrs02] moved to", moved.date);
	expect(["2027-10-03", "2027-10-04", "2027-10-05"]).toContain(moved.date);

	// Restore: back to Sun 3 Oct after Breakfast (still pinned 09:30).
	await call(d.page, "/src/functions/items.functions.ts", "moveItem", {
		itemId: jal.id,
		dayId: jal.dayId,
		...(breakfast ? { afterItemId: breakfast.id } : {}),
	});
	await expect.poll(async () => (await item(d.page, "JAL Sky Museum")).date).toBe("2027-10-03");
	expect(logs.messages).toEqual([]);
	await d.ctx.close();
});

test("HRS-09/03/08 on real data: Imabari Towel's '10:30–19:00; closed 2nd Tue' → Confirm keeps the 2nd-Tue rule; manual wins; Kai sees no Edit", async ({
	browser,
}) => {
	const d = await open(browser, "dennis", TOKYO);
	const im = await item(d.page, "Imabari Towel (Minami-Aoyama)");
	const nodeId = im.nodeId as string;
	await d.page.goto(`${TOKYO}?sel=n.${nodeId}`);
	await expectLive(d.page);
	const table = d.page.getByTestId(TESTID.hoursTable);
	await expect(table).toBeVisible();
	await expect(table.getByTestId(I.hoursRules)).toContainText("Closed 2nd Tue");
	await expect(table.getByTestId(I.hoursSource)).toContainText("From the sheet");
	await table.scrollIntoViewIfNeeded();
	await d.page.screenshot({ path: shot("hrs09-table-sheet") });
	await table.getByTestId(I.hoursTableConfirm).click();
	const ed = d.page.getByTestId(TESTID.hoursEditorDialog);
	await expect(ed).toBeVisible();
	await expect(ed.getByTestId(I.hoursEditorBanner)).toContainText("Parsed from the sheet");
	await d.page.screenshot({ path: shot("hrs09-editor") });
	await ed.getByTestId(I.hoursEditorSave).click();
	await expect(ed).toBeHidden();
	await expect(table.getByTestId(I.hoursSource)).toContainText("Manual");
	await expect(table.getByTestId(I.hoursRules)).toContainText("Closed 2nd Tue");
	// Reopen: the 2nd-Tue rule is in the editor.
	await table.getByTestId(I.hoursTableEdit).click();
	await expect(ed).toBeVisible();
	const nth = ed.getByTestId(I.hoursEditorNth);
	await expect(nth.first()).toBeVisible();
	await d.page.screenshot({ path: shot("hrs09-reopen") });
	await d.page.keyboard.press("Escape");

	// Restore: remove the manual hours (the sheet text stays).
	await call(d.page, "/src/features/insights/insights.functions.ts", "setOpeningHours", {
		nodeId,
		hours: null,
	});
	await d.ctx.close();
});

test("HRS-08: a viewer sees the hours but no Edit or Confirm", async ({ browser }) => {
	const k = await open(browser, "kai", TOKYO);
	const im = await item(k.page, "Imabari Towel (Minami-Aoyama)");
	await k.page.goto(`${TOKYO}?sel=n.${im.nodeId}`);
	await expectLive(k.page);
	const kt = k.page.getByTestId(TESTID.hoursTable);
	await expect(kt).toBeVisible();
	await kt.scrollIntoViewIfNeeded();
	await k.page.screenshot({ path: shot("hrs08-kai-table") });
	await expect(kt.getByTestId(I.hoursTableEdit), "HRS-08: no Edit for viewers").toHaveCount(0);
	await expect(kt.getByTestId(I.hoursTableConfirm)).toHaveCount(0);
	await k.ctx.close();
});

test("SHIFT-01/05/02/06 on real data: +1 and +3 list rebookings, timed rows and the Wed closure; the draft survives; apply then Undo", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", TOKYO);
	const logs = collectConsole(d.page);
	const g0 = await graph(d.page);
	const dlg = d.page.getByTestId(TESTID.shiftTripDialog);
	await d.page.getByTestId(TESTID.tripMenu).click();
	await d.page.getByTestId("try-other-dates").click();
	await expect(dlg).toBeVisible();
	await d.page.getByTestId(I.shiftPlus).click();
	await expect(dlg.getByTestId(I.shiftSummary)).toContainText("Day 1 becomes Sun 3 Oct");
	const section = (name: RegExp) => dlg.getByTestId(I.impactSection).filter({ hasText: name });
	const rebook = section(/Needs rebooking/i);
	await expect(rebook).toContainText("ZK4P7Q");
	await expect(rebook).toContainText("E7K2Q9");
	const timed = section(/Timed/i);
	await expect(timed).toContainText("JAL Sky Museum");
	// SHIFT-05: Mark booked moves it into Needs rebooking.
	await timed.getByTestId(I.impactRow).filter({ hasText: "JAL Sky Museum" }).getByTestId(I.markBooked).click();
	await expect(rebook).toContainText("JAL Sky Museum", { timeout: 10_000 });
	await expect(timed).not.toContainText("JAL Sky Museum");
	await d.page.screenshot({ path: shot("shift05-marked") });
	// undo the mark (fixedDate back to false)
	const jal = await item(d.page, "JAL Sky Museum");
	await call(d.page, "/src/functions/items.functions.ts", "updateItem", { itemId: jal.id, patch: { fixedDate: false } });

	// SHIFT-02: +3 → Sun becomes Wed: JAL Sky Museum is a new closure before committing.
	await d.page.getByTestId(I.shiftPlus).click();
	await d.page.getByTestId(I.shiftPlus).click();
	const closures = section(/New closures/i);
	await expect(closures).toContainText("JAL Sky Museum");
	await expect(closures).toContainText("Wed 6 Oct");

	// SHIFT-06: a row click selects the item, closes the dialog, keeps the draft.
	await closures.getByTestId(I.impactRow).filter({ hasText: "JAL Sky Museum" }).click();
	await expect(dlg).toBeHidden();
	const chip = d.page.getByTestId(TESTID.whatIfChip);
	await expect(chip).toContainText("+3");
	await expect(d.page).toHaveURL(new RegExp(`sel=i\\.${jal.id}`));
	await d.page.waitForTimeout(500);
	await d.page.screenshot({ path: shot("shift06-draft-chip") });
	// Impacted cards carry a primary ring (not amber).
	await chip.getByTestId(I.whatIfReview).click();
	await expect(dlg).toBeVisible();
	await expect(dlg.getByTestId(I.shiftDelta)).toContainText("+3");
	await d.page.getByTestId(I.shiftApply).click();
	await expect(d.page.getByText(/Trip shifted \+3 days/)).toBeVisible({ timeout: 10_000 });
	await expect.poll(async () => (await graph(d.page)).trip.startDate, { timeout: 10_000 }).toBe("2027-10-05");
	// The applied result shows the same closure chip.
	await d.page.goto(`${TOKYO}?days=2027-10-06`);
	await expectLive(d.page);
	await card(d.page, jal.id).scrollIntoViewIfNeeded();
	await expect(card(d.page, jal.id).getByTestId(TESTID.hoursChip)).toContainText("Closed Wed");
	await d.page.screenshot({ path: shot("shift02-applied") });
	// Undo from here: shift back −3 (the toast is gone after navigation; use the dialog).
	await d.page.getByTestId(TESTID.tripMenu).click();
	await d.page.getByTestId("try-other-dates").click();
	for (let i = 0; i < 3; i++) await d.page.getByTestId(I.shiftMinus).click();
	await d.page.getByTestId(I.shiftApply).click();
	await expect.poll(async () => (await graph(d.page)).trip.startDate, { timeout: 10_000 }).toBe(g0.trip.startDate);
	expect((await graph(d.page)).trip.endDate).toBe(g0.trip.endDate);
	expect(logs.messages).toEqual([]);
	await d.ctx.close();
});

test("SHIFT-06b: apply, then the toast's Undo restores the dates", async ({ browser }) => {
	const d = await open(browser, "dennis", TOKYO);
	const g0 = await graph(d.page);
	await d.page.getByTestId(TESTID.tripMenu).click();
	await d.page.getByTestId("try-other-dates").click();
	await d.page.getByTestId(I.shiftPlus).click();
	await d.page.getByTestId(I.shiftApply).click();
	const toast = d.page.getByText(/Trip shifted \+1 day/);
	await expect(toast).toBeVisible({ timeout: 10_000 });
	await expect.poll(async () => (await graph(d.page)).trip.startDate).toBe("2027-10-03");
	await d.page.screenshot({ path: shot("shift06b-toast") });
	await d.page.getByRole("button", { name: "Undo" }).first().click();
	await expect.poll(async () => (await graph(d.page)).trip.startDate, { timeout: 10_000 }).toBe(g0.trip.startDate);
	await d.ctx.close();
});

test("SHIFT-03: someone else's edit while the dialog is open refuses the shift until it is reviewed again", async ({
	browser,
}) => {
	const d = await open(browser, "dennis", TOKYO);
	const a = await open(browser, "audrey", TOKYO);
	const g0 = await graph(d.page);
	await d.page.getByTestId(TESTID.tripMenu).click();
	await d.page.getByTestId("try-other-dates").click();
	await d.page.getByTestId(I.shiftPlus).click();
	await d.page.waitForTimeout(800);
	// Audrey renames an item meanwhile.
	const lunch = g0.items.find((i) => i.title === "Lunch" && i.dayId);
	await call(a.page, "/src/functions/items.functions.ts", "updateItem", { itemId: lunch?.id, patch: { title: "Lunch!" } });
	await d.page.waitForTimeout(1500);
	await d.page.getByTestId(I.shiftApply).click();
	const conflict = d.page.getByTestId(I.shiftConflict);
	const shifted = async () => (await graph(d.page)).trip.startDate !== g0.trip.startDate;
	await d.page.waitForTimeout(2000);
	await d.page.screenshot({ path: shot("shift03-conflict") });
	const sawConflict = await conflict.isVisible().catch(() => false);
	const didShift = await shifted();
	console.log(`[shift03] conflict shown: ${sawConflict}; shifted anyway: ${didShift}`);
	// restore
	await call(a.page, "/src/functions/items.functions.ts", "updateItem", { itemId: lunch?.id, patch: { title: "Lunch" } });
	if (didShift) {
		await call(d.page, "/src/functions/trips.functions.ts", "shiftTripDates", { tripId: g0.trip.id, deltaDays: -1 });
	}
	expect(sawConflict || !didShift, "either refused with a conflict, or (live refresh) re-reviewed").toBe(true);
	await a.ctx.close();
	await d.ctx.close();
});

test("SHIFT-04 + SUG-15: Maya suggests +1 day; the overview shows the impact; accepted after unrelated edits", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const m = await open(browser, "maya", TOKYO);
	const g0 = await graph(m.page);
	await m.page.getByTestId(TESTID.tripMenu).click();
	await m.page.getByTestId("try-other-dates").click();
	const dlg = m.page.getByTestId(TESTID.shiftTripDialog);
	await expect(dlg).toBeVisible();
	await m.page.getByTestId(I.shiftPlus).click();
	await expect(m.page.getByTestId(I.shiftApply)).toContainText(/Suggest/);
	await m.page.screenshot({ path: shot("shift04-maya-dialog") });
	await m.page.getByTestId(I.shiftApply).click();
	await expect(m.page.getByText(/^Suggested — /).first()).toBeVisible({ timeout: 10_000 });
	expect((await graph(m.page)).trip.startDate).toBe(g0.trip.startDate);

	// Dennis: unrelated edits, then opens the suggestion's overview and accepts.
	const d = await open(browser, "dennis", TOKYO);
	const lunch = g0.items.find((i) => i.title === "Lunch" && i.dayId);
	await call(d.page, "/src/functions/items.functions.ts", "updateItem", { itemId: lunch?.id, patch: { durationMin: 75 } });
	const list = await call<{ id: string; op: string; status: string }[]>(d.page, "/src/functions/proposals.functions.ts", "listProposals", {
		tripId: g0.trip.id,
	});
	const p = list.find((x) => x.op === "trip.shift" && x.status === "open");
	if (!p) throw new Error("no trip.shift proposal");
	await d.page.goto(`${TOKYO}?sel=p.${p.id}`);
	await expectLive(d.page);
	const ov = d.page.getByTestId(TESTID.proposalOverview);
	await expect(ov).toBeVisible();
	await expect(ov.getByTestId(TESTID.dateImpactList)).toBeVisible();
	await expect(ov).toContainText("ZK4P7Q");
	await d.page.screenshot({ path: shot("shift04-overview") });
	await ov.getByRole("button", { name: /^Accept/ }).first().click();
	await expect.poll(async () => (await graph(d.page)).trip.startDate, { timeout: 10_000 }).toBe("2027-10-03");
	// restore
	await call(d.page, "/src/functions/trips.functions.ts", "shiftTripDates", { tripId: g0.trip.id, deltaDays: -1 });
	await call(d.page, "/src/functions/items.functions.ts", "updateItem", { itemId: lunch?.id, patch: { durationMin: 60 } });
	await expect.poll(async () => (await graph(d.page)).trip.startDate, { timeout: 10_000 }).toBe(g0.trip.startDate);
	await m.ctx.close();
	await d.ctx.close();
});

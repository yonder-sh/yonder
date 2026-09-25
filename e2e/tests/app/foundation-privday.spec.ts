/**
 * Private day notes on a day that goes away (ADDENDUM §7.2; QA R3 P1,
 * P2 "Day 1 has a note", SEC-R3-02):
 *  - the text moved into the owner's private trip note shows in that note
 *    while it is open, and survives more typing there;
 *  - an editor still open on the removed day stops taking typing ("This was
 *    removed…") and what was typed before the removal is kept;
 *  - the owner's own private day note never blocks their own date change,
 *    nor an accepted suggestion (so no suggester learns about it).
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureOptions } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "one desktop run covers the server paths");

type G = {
	trip: { id: string; version: number };
	days: { id: string; date: string }[];
	me: { userId: string } | null;
};
const graphOf = (p: Page) => p.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

async function setDates(p: Page, tripId: string, start: string, end: string, v?: number) {
	return p.evaluate(
		async ({ tripId, start, end, v }) => {
			const t = await import("/src/functions/trips.functions.ts");
			try {
				return await t.setTripDates({
					data: { tripId, startDate: start, endDate: end, ...(v === undefined ? {} : { expectedVersion: v }) },
				});
			} catch (e) {
				return { __error: (e as Error).message };
			}
		},
		{ tripId, start, end, v },
	);
}

async function openPrivateNote(p: Page, url: string) {
	await p.goto(url);
	await expectLive(p);
	await p.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
	const panel = p.getByTestId(TESTID.notesPanel);
	await panel.getByTestId(NT.privateToggle).getByRole("button", { name: /Only me/ }).click();
	const ed = panel.getByTestId(NT.editor);
	await expect(ed).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
	return { panel, ed };
}

/** Dev's clone with an extra empty day in front, holding Dev's private day note. */
async function setup(browser: Browser, text: string, opts: FixtureOptions = {}) {
	const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(dctx.request, "dev@example.com", { first: "Dev", last: "User" });
	const d = await dctx.newPage();
	const c = await cloneFixtureTrip(d.request, opts);
	await d.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(d);
	const g0 = await graphOf(d);
	const days0 = [...g0.days].sort((a, b) => a.date.localeCompare(b.date));
	const firstDate = days0[0]?.date as string;
	const lastDate = days0[days0.length - 1]?.date as string;
	const prev = new Date(`${firstDate}T12:00:00Z`);
	prev.setUTCDate(prev.getUTCDate() - 1);
	expect(JSON.stringify(await setDates(d, c.tripId, prev.toISOString().slice(0, 10), lastDate))).not.toContain("__error");
	await d.reload();
	await expectLive(d);
	const g = await graphOf(d);
	const newDay = [...g.days].sort((a, b) => a.date.localeCompare(b.date))[0] as { id: string };
	const day = await openPrivateNote(d, `/t/${c.slug}?sel=d.${newDay.id}`);
	await day.ed.click();
	await d.keyboard.type(text);
	await d.waitForTimeout(3500); // stored (debounce 2 s)
	const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(mctx.request, "maya@example.com", { first: "Maya", last: "Chen" });
	const m = await mctx.newPage();
	await m.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(m);
	return { dctx, d, mctx, m, c, firstDate, lastDate, day, dayId: newDay.id };
}

test("the moved text shows in Dev's open private trip note and survives his typing", async ({ browser }) => {
	test.setTimeout(150_000);
	const T = `PRIVDAY-LIVE-${Date.now() % 100000}`;
	const s = await setup(browser, T);
	const root = await openPrivateNote(s.d, `/t/${s.c.slug}?sel=root`);
	await root.ed.click();
	await s.d.keyboard.type("ROOT PRIVATE A");
	await s.d.waitForTimeout(3500);
	// Maya (who can't see Dev's note) removes the day.
	const res = await setDates(s.m, s.c.tripId, s.firstDate, s.lastDate);
	expect(JSON.stringify(res)).not.toContain("__error");
	// Dev's open editor shows the moved text without a reload.
	await expect(root.ed).toContainText(T, { timeout: 10_000 });
	await root.ed.click();
	await s.d.keyboard.press("Control+End");
	await s.d.keyboard.type(" + B");
	await s.d.waitForTimeout(3500);
	await s.d.reload();
	await expectLive(s.d);
	const again = await openPrivateNote(s.d, `/t/${s.c.slug}?sel=root`);
	await expect(again.ed).toContainText(T);
	await expect(again.ed).toContainText("ROOT PRIVATE A");
	await expect(again.ed).toContainText("+ B");
	await s.d.screenshot({ path: shotPath("foundation/privday-root-after-reload.png") });
	await s.dctx.close();
	await s.mctx.close();
});

test("an editor open on the removed day stops taking typing; its text is kept", async ({ browser }) => {
	test.setTimeout(150_000);
	const T = `PRIVDAY-OPEN-${Date.now() % 100000}`;
	const s = await setup(browser, T);
	// Typed just before the removal, maybe not stored yet.
	await s.day.ed.click();
	await s.d.keyboard.press("Control+End");
	await s.d.keyboard.type(" LATE");
	const res = await setDates(s.m, s.c.tripId, s.firstDate, s.lastDate);
	expect(JSON.stringify(res)).not.toContain("__error");
	const panel = s.d.getByTestId(TESTID.notesPanel);
	await expect(panel.getByTestId(NT.readOnlyNote)).toContainText("This was removed", { timeout: 15_000 });
	await expect(panel.locator(`[data-testid="${NT.editor}"][contenteditable="true"]`)).toHaveCount(0);
	await s.d.screenshot({ path: shotPath("foundation/privday-open-day-removed.png") });
	const root = await openPrivateNote(s.d, `/t/${s.c.slug}?sel=root`);
	await expect(root.ed).toContainText(T);
	await expect(root.ed).toContainText("LATE");
	await s.dctx.close();
	await s.mctx.close();
});

test("Dev's own private day note never blocks his own date change (QA R3 P2)", async ({ browser }) => {
	test.setTimeout(120_000);
	const T = `PRIVDAY-OWN-${Date.now() % 100000}`;
	const s = await setup(browser, T);
	const preview = await s.d.evaluate(
		async ({ tripId, startDate, endDate }) => {
			const t = await import("/src/functions/trips.functions.ts");
			return t.previewTripDates({ data: { tripId, startDate, endDate } });
		},
		{ tripId: s.c.tripId, startDate: s.firstDate, endDate: s.lastDate },
	);
	expect(preview.blockedBy).toBeUndefined();
	const res = await setDates(s.d, s.c.tripId, s.firstDate, s.lastDate);
	expect(JSON.stringify(res)).not.toContain("__error");
	const root = await openPrivateNote(s.d, `/t/${s.c.slug}?sel=root`);
	await expect(root.ed).toContainText(T);
	await s.dctx.close();
	await s.mctx.close();
});

test("accepting a suggested date change never tells the suggester about the owner's private note (SEC-R3-02)", async ({ browser }) => {
	test.setTimeout(150_000);
	const T = `PRIVDAY-SUG-${Date.now() % 100000}`;
	const s = await setup(browser, T, { mayaRole: "suggester" });
	const proposed = (await setDates(s.m, s.c.tripId, s.firstDate, s.lastDate)) as { proposed?: { id: string } };
	expect(proposed.proposed?.id).toBeTruthy();
	const accepted = await s.d.evaluate(async (proposalId) => {
		const p = await import("/src/functions/proposals.functions.ts");
		return p.resolveProposal({ data: { proposalId, decision: "accept" } });
	}, proposed.proposed?.id as string);
	expect(JSON.stringify(accepted)).not.toMatch(/has a note|conflict/i);
	const mine = await s.m.evaluate(async (tripId) => {
		const p = await import("/src/functions/proposals.functions.ts");
		return p.listProposals({ data: { tripId } });
	}, s.c.tripId);
	expect(JSON.stringify(mine)).not.toMatch(/has a note/);
	const root = await openPrivateNote(s.d, `/t/${s.c.slug}?sel=root`);
	await expect(root.ed).toContainText(T);
	await s.dctx.close();
	await s.mctx.close();
});

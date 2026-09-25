/**
 * I2 "content" verifier, round 3: re-checks of round-2 reports and new probes.
 *  - A member's private day note on a day another member removes is moved to
 *    the author's private trip note (ADDENDUM §7.2) — also while the author has
 *    that trip note open live.
 *  - "Overdue 1h" reads the same on the dashboard and in Lists.
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";
import { psql } from "./_helpers/psql";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");
const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const state = (h: string) => path.join(AUTH, `${h}.json`);

type G = {
	trip: { id: string; version: number };
	days: { id: string; date: string }[];
	items: { id: string; dayId: string | null }[];
	me: { userId: string } | null;
};
const graphOf = (p: Page) => p.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

async function setDates(p: Page, tripId: string, start: string, end: string, v: number) {
	return p.evaluate(
		async ({ tripId, start, end, v }) => {
			const t = await import("/src/functions/trips.functions.ts");
			try {
				return await t.setTripDates({ data: { tripId, startDate: start, endDate: end, expectedVersion: v } });
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
async function setupPrivateDayNote(browser: Browser, text: string) {
	const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(dctx.request, "dev@example.com", { first: "Dev", last: "User" });
	const d = await dctx.newPage();
	const c = await cloneFixtureTrip(d.request);
	await d.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(d);
	const g0 = await graphOf(d);
	const days0 = [...g0.days].sort((a, b) => a.date.localeCompare(b.date));
	const prev = new Date(`${days0[0]?.date}T12:00:00Z`);
	prev.setUTCDate(prev.getUTCDate() - 1);
	const firstDate = days0[0]?.date as string;
	const lastDate = days0[days0.length - 1]?.date as string;
	console.log("extend", JSON.stringify(await setDates(d, c.tripId, prev.toISOString().slice(0, 10), lastDate, g0.trip.version)));
	await d.reload();
	await expectLive(d);
	const g = await graphOf(d);
	const newDay = [...g.days].sort((a, b) => a.date.localeCompare(b.date))[0];
	const { ed } = await openPrivateNote(d, `/t/${c.slug}?sel=d.${newDay?.id}`);
	await ed.click();
	await d.keyboard.type(text);
	await d.waitForTimeout(4000);
	const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(mctx.request, "maya@example.com", { first: "Maya", last: "Chen" });
	const m = await mctx.newPage();
	return { dctx, d, mctx, m, c, firstDate, lastDate, devUserId: g.me?.userId ?? "" };
}

test("private day note: Maya's date change moves it to Dev's private trip note, never to Maya", async ({ browser }) => {
	test.setTimeout(150_000);
	const T = `PRIVDAY-R3-${Date.now() % 100000}`;
	const s = await setupPrivateDayNote(browser, T);
	await s.m.goto(`/t/${s.c.slug}?tab=plan`);
	await expectLive(s.m);
	const mg = await graphOf(s.m);
	const res = await setDates(s.m, s.c.tripId, s.firstDate, s.lastDate, mg.trip.version);
	console.log("maya setTripDates:", JSON.stringify(res));
	expect(JSON.stringify(res)).not.toMatch(/__error/);
	console.log("DB rows with the text:", psql(`select name || ' | owner=' || coalesce(owner_user_id,'-') || ' | day=' || coalesce(day_id::text,'-') from yjs_documents where plain_text like '%${T}%'`));
	// Dev sees it in the private trip note.
	const { panel } = await openPrivateNote(s.d, `/t/${s.c.slug}?sel=root`);
	await expect(panel.getByTestId(NT.editor)).toContainText(T, { timeout: 15_000 });
	await shot(s.d, "40-dev-private-trip-note-after-rehome");
	// Maya: not in her shared or private trip note, not in listTripNotes.
	const mp = await openPrivateNote(s.m, `/t/${s.c.slug}?sel=root`);
	await s.m.waitForTimeout(1500);
	expect(await mp.panel.innerText()).not.toContain(T);
	await mp.panel.getByTestId(NT.privateToggle).getByRole("button", { name: /Shared/ }).click();
	await s.m.waitForTimeout(1500);
	expect(await mp.panel.innerText()).not.toContain(T);
	const notes = await s.m.evaluate(async (tripId) => {
		const n = await import("/src/features/notes/notes.functions.ts");
		return n.listTripNotes({ data: { tripId } });
	}, s.c.tripId);
	expect(JSON.stringify(notes)).not.toContain(T);
	const act = await s.m.evaluate(async (tripId) => {
		const n = await import("/src/functions/graph.functions.ts");
		return n.listActivity({ data: { tripId } });
	}, s.c.tripId);
	expect(JSON.stringify(act)).not.toContain(T);
	await s.dctx.close();
	await s.mctx.close();
});

test("private day note: the rehomed text survives when Dev has the private trip note open and keeps typing", async ({ browser }) => {
	test.setTimeout(150_000);
	const T = `PRIVDAY-LIVE-${Date.now() % 100000}`;
	const s = await setupPrivateDayNote(browser, T);
	// Dev now works in his private trip note and leaves it open.
	const root = await openPrivateNote(s.d, `/t/${s.c.slug}?sel=root`);
	await root.ed.click();
	await s.d.keyboard.type("ROOT PRIVATE A");
	await s.d.waitForTimeout(4000);
	// Maya removes the day (she can't see Dev's note on it).
	await s.m.goto(`/t/${s.c.slug}?tab=plan`);
	await expectLive(s.m);
	const mg = await graphOf(s.m);
	console.log("maya setTripDates:", JSON.stringify(await setDates(s.m, s.c.tripId, s.firstDate, s.lastDate, mg.trip.version)));
	console.log("DB right after:", psql(`select name || ' | ' || replace(plain_text, chr(10), ' / ') from yjs_documents where trip_id = '${s.c.tripId}' and owner_user_id is not null`));
	await s.d.waitForTimeout(2000);
	console.log("Dev's open editor right after:", JSON.stringify(await root.ed.innerText()));
	// Dev keeps typing in the same open editor.
	await root.ed.click();
	await s.d.keyboard.press("End");
	await s.d.keyboard.type(" + B");
	await s.d.waitForTimeout(5000);
	const db = psql(`select replace(plain_text, chr(10), ' / ') from yjs_documents where trip_id = '${s.c.tripId}' and owner_user_id = '${s.devUserId}' and node_id is null and day_id is null and item_id is null and leg_id is null`);
	console.log("DB private trip note after Dev typed:", db);
	await s.d.reload();
	await expectLive(s.d);
	const again = await openPrivateNote(s.d, `/t/${s.c.slug}?sel=root`);
	await s.d.waitForTimeout(1500);
	const text = await again.ed.innerText();
	console.log("Dev's private trip note after reload:", JSON.stringify(text));
	await shot(s.d, "40-dev-private-trip-note-live-race");
	expect(text).toContain("ROOT PRIVATE A");
	expect(text).toContain(T);
	await s.dctx.close();
	await s.mctx.close();
});

test("an hour overdue reads 'Overdue 1h' on the dashboard and in Lists", async ({ browser }) => {
	const ctx = await browser.newContext({ storageState: state("dennis"), viewport: { width: 1440, height: 900 }, timezoneId: "America/New_York" });
	const p = await ctx.newPage();
	await p.goto("/t/asia-2027?tab=lists");
	await expectLive(p);
	const g = await graphOf(p);
	const now = new Date(Date.now() - 65 * 60_000);
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
			.formatToParts(now)
			.map((x) => [x.type, x.value]),
	);
	const dueDate = `${parts.year}-${parts.month}-${parts.day}`;
	const dueTime = `${parts.hour}:${parts.minute}`;
	const text = `QA r3 an hour late ${Date.now() % 10000}`;
	const made = await p.evaluate(
		async ({ tripId, text, dueDate, dueTime }) => {
			const m = await import("/src/features/lists/lists.functions.ts");
			return m.createListItem({ data: { tripId, target: { kind: "trip" }, list: "todo", text, dueDate, dueTime, dueTz: "America/New_York" } });
		},
		{ tripId: g.trip.id, text, dueDate, dueTime },
	);
	console.log("made", JSON.stringify(made), dueDate, dueTime);
	await p.reload();
	await expectLive(p);
	const r = p.getByTestId(TESTID.listsTab).getByTestId(L.row).filter({ hasText: text });
	const listsChip = (await r.getByTestId(L.dueChip).innerText()).replace(/\n/g, " ");
	console.log("Lists chip:", listsChip);
	await p.goto("/");
	const box = p.getByTestId(HOME_TESTID.deadlines);
	await expect(box).toBeVisible({ timeout: 20_000 });
	const dash = box.getByTestId(HOME_TESTID.deadlineRow).filter({ hasText: text });
	const dashText = (await dash.innerText()).replace(/\n/g, " | ");
	console.log("Dashboard row:", dashText);
	await shot(p, "40-overdue-1h-dashboard");
	await p.evaluate(async (id) => {
		const m = await import("/src/features/lists/lists.functions.ts");
		return m.deleteListItem({ data: { id } }).catch((e: Error) => e.message);
	}, (made as { id: string }).id);
	expect(listsChip).toMatch(/Overdue 1h/);
	expect(dashText).toMatch(/Overdue 1h/);
	await ctx.close();
});

test("private day note: the author's own date change names it as their private note", async ({ browser }) => {
	test.setTimeout(120_000);
	const s = await setupPrivateDayNote(browser, `OWN-PRIV-${Date.now() % 100000}`);
	await s.d.goto(`/t/${s.c.slug}?tab=plan`);
	await expectLive(s.d);
	const g = await graphOf(s.d);
	const res = await setDates(s.d, s.c.tripId, s.firstDate, s.lastDate, g.trip.version);
	console.log("author's own setTripDates:", JSON.stringify(res));
	const prev = await s.d.evaluate(
		async ({ tripId, start, end }) => {
			const t = await import("/src/functions/trips.functions.ts");
			return (t as unknown as { previewTripDates: (a: unknown) => Promise<unknown> }).previewTripDates({ data: { tripId, startDate: start, endDate: end } }).catch((e: Error) => ({ __error: e.message }));
		},
		{ tripId: s.c.tripId, start: s.firstDate, end: s.lastDate },
	);
	console.log("author's preview:", JSON.stringify(prev));
	// Trip settings → dates, through the UI.
	await s.d.goto(`/t/${s.c.slug}?sel=root`);
	await expectLive(s.d);
	await s.dctx.close();
	await s.mctx.close();
	// Today: "CONFLICT: Day 1 has a note" — the same words as for a shared note, while the
	// day's Shared note is empty; the author isn't told it's their own private note.
	expect(JSON.stringify(res)).not.toMatch(/Day 1 has a note"/);
});

test("private day note: Dev keeps typing in the day's private note while Maya removes the day", async ({ browser }) => {
	test.setTimeout(150_000);
	const T = `PRIVDAY-OPEN-${Date.now() % 100000}`;
	const s = await setupPrivateDayNote(browser, T);
	// The day's private note is still open in Dev's tab (setup typed into it).
	await s.m.goto(`/t/${s.c.slug}?tab=plan`);
	await expectLive(s.m);
	const mg = await graphOf(s.m);
	console.log("maya setTripDates:", JSON.stringify(await setDates(s.m, s.c.tripId, s.firstDate, s.lastDate, mg.trip.version)));
	await s.d.waitForTimeout(2500);
	const ed = s.d.getByTestId(TESTID.notesPanel).getByTestId(NT.editor);
	console.log("Dev's day editor still shown:", await ed.isVisible().catch(() => false), "| url:", s.d.url());
	if (await ed.isVisible().catch(() => false)) {
		await ed.click().catch(() => {});
		await s.d.keyboard.press("End");
		await s.d.keyboard.type(" MORE-AFTER-REMOVAL");
		await s.d.waitForTimeout(5000);
	}
	console.log("DB private rows:", psql(`select name || ' | day=' || coalesce(day_id::text,'-') || ' | ' || replace(plain_text, chr(10), ' / ') from yjs_documents where trip_id = '${s.c.tripId}' and owner_user_id is not null`));
	await shot(s.d, "40-dev-day-note-open-during-removal");
	const again = await openPrivateNote(s.d, `/t/${s.c.slug}?sel=root`);
	await s.d.waitForTimeout(1500);
	const text = await again.ed.innerText();
	console.log("Dev's private trip note:", JSON.stringify(text));
	expect(text).toContain(T);
	await s.dctx.close();
	await s.mctx.close();
});

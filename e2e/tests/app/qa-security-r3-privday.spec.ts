/**
 * QA security verifier (I2 round 3): re-check of "another member's private
 * day note blocks a date change and reveals that it exists" (ADDENDUM §7.2),
 * directly and through the suggestion path (a suggester proposes the change,
 * the note's author accepts it), plus LINK-07 in the UI (a guest opening a
 * trip their link doesn't cover keeps the link they have).
 * Writes JSON + screenshots to QA_SEC_DIR.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";
import { call, MOD } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";

type G = { trip: { id: string; version: number }; days: { id: string; date: string }[]; me: unknown };

async function user(browser: Browser, email: string, first: string, last: string) {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(ctx.request, email, { first, last });
	const page = await ctx.newPage();
	return { ctx, page };
}

async function graph(p: Page, tripId: string): Promise<G> {
	const g = await call(p, MOD.graph, "getTripGraph", { tripId });
	if (!g.ok) throw new Error(g.err);
	return g.r as G;
}

const sorted = (g: G) => [...g.days].sort((a, b) => a.date.localeCompare(b.date));
const dayBefore = (iso: string) => {
	const d = new Date(`${iso}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString().slice(0, 10);
};

/** Owner: add an empty day before the trip and keep an "Only me" note on it. */
async function privateNoteOnNewFirstDay(p: Page, c: FixtureClone, text: string, stayOpen = false) {
	let res: unknown;
	for (let i = 0; i < 4; i++) {
		const g = await graph(p, c.tripId);
		const days = sorted(g);
		res = await call(p, MOD.trips, "setTripDates", {
			tripId: c.tripId,
			startDate: dayBefore(days[0]?.date as string),
			endDate: days[days.length - 1]?.date as string,
			expectedVersion: g.trip.version,
		});
		if ((res as { ok: boolean }).ok) break;
		await p.waitForTimeout(1500);
	}
	const g = await graph(p, c.tripId);
	const first = sorted(g)[0] as { id: string; date: string };
	await p.goto(`/t/${c.slug}?sel=d.${first.id}`);
	await expectLive(p);
	await p.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
	const panel = p.getByTestId(TESTID.notesPanel);
	await panel.getByTestId(NT.privateToggle).getByRole("button", { name: /Only me/ }).click();
	const ed = panel.getByTestId(NT.editor);
	await expect(ed).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
	await ed.click();
	await p.keyboard.type(text);
	// Wait until the private note is stored (the author's own notes list shows it).
	await expect
		.poll(async () => {
			const n = await call(p, MOD.notes, "listTripNotes", { tripId: c.tripId });
			return n.ok ? JSON.stringify(n.r).includes(text) : false;
		}, { timeout: 20_000 })
		.toBe(true);
	// Leave the day so the editor is closed before anyone removes it.
	if (!stayOpen) {
		await p.goto(`/t/${c.slug}?tab=plan`);
		await expectLive(p);
	}
	return { extend: res, first };
}

test("a private day note never blocks or names itself to another member (direct)", async ({ browser }) => {
	test.setTimeout(240_000);
	const stamp = Date.now().toString(36);
	const text = `PRIVDAY-R3-${stamp}`;
	const out: Record<string, unknown> = {};
	const o = await user(browser, `qa-sec-r3-pd-${stamp}@example.com`, "Olga", "Owner");
	const c = await cloneFixtureTrip(o.page.request, { mayaRole: "editor" });
	await o.page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(o.page);
	const { extend, first } = await privateNoteOnNewFirstDay(o.page, c, text);
	out.extend = (extend as { ok: boolean }).ok ? "OK" : extend;
	await o.page.screenshot({ path: path.join(DIR, "r3-privday-owner.png") });

	const m = await user(browser, "maya@example.com", "Maya", "Chen");
	await m.page.goto(`/t/${c.slug}?sel=d.${first.id}`);
	await expectLive(m.page);
	await m.page.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
	await m.page.waitForTimeout(1500);
	out.mayaDayNotes = (await m.page.getByTestId(TESTID.notesPanel).innerText()).slice(0, 200);
	await m.page.screenshot({ path: path.join(DIR, "r3-privday-maya-day.png") });
	const mg = await graph(m.page, c.tripId);
	const days = sorted(mg);
	const range = { startDate: days[1]?.date as string, endDate: days[days.length - 1]?.date as string };
	const preview = await call(m.page, MOD.trips, "previewTripDates", { tripId: c.tripId, ...range });
	out.mayaPreview = preview.ok ? preview.r : preview.err;
	const del = await call(m.page, MOD.trips, "setTripDates", { tripId: c.tripId, ...range, expectedVersion: mg.trip.version });
	out.mayaSetTripDates = del.ok ? "OK" : del.err;
	const mNotes = await call(m.page, MOD.notes, "listTripNotes", { tripId: c.tripId });
	out.mayaSeesText = JSON.stringify(mNotes).includes(text);
	const act = await call(m.page, MOD.graph, "listActivity", { tripId: c.tripId });
	out.mayaActivityHasText = JSON.stringify(act).includes(text);
	const oNotes = await call(o.page, MOD.notes, "listTripNotes", { tripId: c.tripId });
	const kept = (oNotes.ok ? (oNotes.r as { name: string; ownerUserId: string | null; dayId: string | null; nodeId: string | null; plainText: string | null }[]) : []).filter((n) => (n.plainText ?? "").includes(text));
	out.ownerKeeps = kept.map((n) => ({ name: n.name.replace(c.tripId, "<trip>"), private: !!n.ownerUserId, dayId: n.dayId, nodeId: n.nodeId }));
	// The owner's trip Notes (root) show it as their private note.
	await o.page.goto(`/t/${c.slug}?sel=root`);
	await expectLive(o.page);
	const notesTab = o.page.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ });
	if (await notesTab.count()) {
		await notesTab.first().click();
		await o.page.waitForTimeout(2000);
		out.ownerRootNotesShowsText = (await o.page.getByTestId(TESTID.notesPanel).innerText().catch(() => "")).includes(text);
		await o.page.screenshot({ path: path.join(DIR, "r3-privday-owner-root.png") });
	}
	writeFileSync(path.join(DIR, "r3-privday.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await o.ctx.close();
	await m.ctx.close();
	expect(String(out.mayaSetTripDates)).toBe("OK");
	expect(JSON.stringify(out.mayaPreview)).not.toMatch(/note/i);
	expect(out.mayaSeesText).toBe(false);
	expect((out.ownerKeeps as unknown[]).length).toBe(1);
});

test("a suggested date change: what the suggester learns when the note's author accepts it", async ({ browser }) => {
	test.setTimeout(240_000);
	const stamp = Date.now().toString(36);
	const text = `PRIVDAY-SUG-R3-${stamp}`;
	const out: Record<string, unknown> = {};
	const o = await user(browser, `qa-sec-r3-ps-${stamp}@example.com`, "Olga", "Owner");
	const c = await cloneFixtureTrip(o.page.request, { mayaRole: "suggester" });
	await o.page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(o.page);
	await privateNoteOnNewFirstDay(o.page, c, text);

	const m = await user(browser, "maya@example.com", "Maya", "Chen");
	await m.page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(m.page);
	const mg = await graph(m.page, c.tripId);
	const days = sorted(mg);
	const prop = await call(m.page, MOD.trips, "setTripDates", {
		tripId: c.tripId,
		startDate: days[1]?.date as string,
		endDate: days[days.length - 1]?.date as string,
	});
	out.mayaProposes = prop.ok ? prop.r : prop.err;
	const pid = prop.ok ? (prop.r as { proposed?: { id: string } }).proposed?.id : undefined;
	if (pid) {
		const acc = await call(o.page, MOD.proposals, "resolveProposal", { proposalId: pid, decision: "accept" });
		out.ownerAccepts = acc.ok ? acc.r : acc.err;
		await m.page.waitForTimeout(2000);
		const lp = await call(m.page, MOD.proposals, "listProposals", { tripId: c.tripId });
		const mine = lp.ok ? (lp.r as { proposals?: { id: string; status: string; lastError: unknown }[] }).proposals ?? (lp.r as { id: string; status: string; lastError: unknown }[]) : [];
		out.mayaSeesProposal = Array.isArray(mine) ? mine.filter((x) => x.id === pid).map((x) => ({ status: x.status, lastError: x.lastError })) : lp;
		const inbox = await call(m.page, MOD.inbox, "listInbox", {});
		out.mayaInboxMentionsNote = /has a note/i.test(JSON.stringify(inbox));
		out.mayaProposalsMentionNote = /has a note/i.test(JSON.stringify(lp));
		const act = await call(m.page, MOD.graph, "listActivity", { tripId: c.tripId });
		out.mayaActivityMentionsNote = /has a note/i.test(JSON.stringify(act));
		await m.page.goto(`/t/${c.slug}?sel=root`);
		await expectLive(m.page);
		await m.page.waitForTimeout(2000);
		out.mayaUiMentionsNote = /has a note/i.test(await m.page.locator("body").innerText());
		await m.page.screenshot({ path: path.join(DIR, "r3-privday-sug-maya.png") });
	}
	writeFileSync(path.join(DIR, "r3-privday-sug.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await o.ctx.close();
	await m.ctx.close();
});

test("LINK-07: a guest who opens a trip their link doesn't cover keeps their own link", async ({ browser }) => {
	test.setTimeout(120_000);
	const out: Record<string, unknown> = {};
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const p = await ctx.newPage();
	await p.goto("/join#t=qa-share-token-editor-asia-2027");
	await p.waitForURL(/\/t\/asia-2027/, { timeout: 30_000 });
	await expectLive(p);
	out.grantsBefore = await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("yonder:grants") ?? "{}")));
	for (const slug of ["phu-quoc-detour", "delete-me", "no-such-trip-r3"]) {
		await p.goto(`/t/${slug}?tab=plan`);
		await p.waitForTimeout(4000);
		out[`open:${slug}`] = (await p.locator("body").innerText()).slice(0, 120).replace(/\s+/g, " ");
		await p.screenshot({ path: path.join(DIR, `r3-link07-${slug}.png`) });
	}
	out.grantsAfter = await p.evaluate(() => ({
		grants: Object.keys(JSON.parse(localStorage.getItem("yonder:grants") ?? "{}")),
		gone: localStorage.getItem("yonder:grants-gone"),
	}));
	await p.goto("/t/asia-2027?tab=plan");
	await p.waitForTimeout(3000);
	out.backToAsia = { url: p.url(), workspace: await p.getByTestId("workspace").count() };
	await p.reload();
	await p.waitForTimeout(4000);
	out.afterReload = { url: p.url(), workspace: await p.getByTestId("workspace").count() };
	writeFileSync(path.join(DIR, "r3-link07.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
	expect(String(out["open:phu-quoc-detour"])).toMatch(/doesn't exist or you don't have access/);
	expect(out.backToAsia).toMatchObject({ workspace: 1 });
});

test("the author keeps typing in the private day note while another member removes the day", async ({ browser }) => {
	test.setTimeout(240_000);
	const stamp = Date.now().toString(36);
	const text = `OPENDAY-R3-${stamp}`;
	const out: Record<string, unknown> = {};
	const o = await user(browser, `qa-sec-r3-po-${stamp}@example.com`, "Olga", "Owner");
	const c = await cloneFixtureTrip(o.page.request, { mayaRole: "editor" });
	await o.page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(o.page);
	// Olga already has a private TRIP note (the merge path).
	await o.page.goto(`/t/${c.slug}?sel=root`);
	await expectLive(o.page);
	await o.page.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
	const rootPanel = o.page.getByTestId(TESTID.notesPanel);
	await rootPanel.getByTestId(NT.privateToggle).getByRole("button", { name: /Only me/ }).click();
	const rootEd = rootPanel.getByTestId(NT.editor);
	await expect(rootEd).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
	await rootEd.click();
	await o.page.keyboard.type(`ROOTNOTE-${stamp}`);
	await o.page.waitForTimeout(4000);
	await privateNoteOnNewFirstDay(o.page, c, text, true);
	const m = await user(browser, "maya@example.com", "Maya", "Chen");
	await m.page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(m.page);
	const mg = await graph(m.page, c.tripId);
	const days = sorted(mg);
	const del = await call(m.page, MOD.trips, "setTripDates", { tripId: c.tripId, startDate: days[1]?.date as string, endDate: days[days.length - 1]?.date as string, expectedVersion: mg.trip.version });
	out.mayaSetTripDates = del.ok ? "OK" : del.err;
	await o.page.waitForTimeout(2000);
	// Olga's editor on the removed day: is it still there? Type into it.
	const ed = o.page.getByTestId(TESTID.notesPanel).getByTestId(NT.editor);
	out.editorStillOpen = await ed.count();
	out.olgaPage = (await o.page.locator("body").innerText()).slice(0, 200).replace(/\s+/g, " ");
	if (out.editorStillOpen) {
		await ed.first().click().catch(() => undefined);
		await o.page.keyboard.type(` AFTERDEL-${stamp}`).catch(() => undefined);
	}
	await o.page.waitForTimeout(6000);
	await o.page.screenshot({ path: path.join(DIR, "r3-privday-open-olga.png") });
	const oNotes = await call(o.page, MOD.notes, "listTripNotes", { tripId: c.tripId });
	const mine = (oNotes.ok ? (oNotes.r as { name: string; ownerUserId: string | null; dayId: string | null; plainText: string | null }[]) : []).filter((n) => n.ownerUserId);
	out.olgaPrivateNotes = mine.map((n) => ({ name: n.name.replace(c.tripId, "<trip>").replace(/\/u\/.*/, "/u/<olga>"), dayId: n.dayId, text: (n.plainText ?? "").slice(0, 120) }));
	// A reload later: what survives?
	await o.page.goto(`/t/${c.slug}?sel=root`);
	await expectLive(o.page);
	await o.page.waitForTimeout(3000);
	const oNotes2 = await call(o.page, MOD.notes, "listTripNotes", { tripId: c.tripId });
	out.afterReload = (oNotes2.ok ? (oNotes2.r as { ownerUserId: string | null; dayId: string | null; plainText: string | null }[]) : []).filter((n) => n.ownerUserId).map((n) => ({ dayId: n.dayId, text: (n.plainText ?? "").slice(0, 160) }));
	writeFileSync(path.join(DIR, "r3-privday-open.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await o.ctx.close();
	await m.ctx.close();
});

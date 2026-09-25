/**
 * I2 verifier "collab" (round 3): re-checks the round-2 collab findings and
 * drives what rounds 1–2 left out, on the QA seed's Asia 2027 (EXTENSIONS
 * §3 SUG, §4 HRS, §5 SHIFT, §6 SUN/CLIM, §9 one inbox; qa/SCENARIOS RT).
 *
 * Needs the QA seed and `$QA_AUTH_DIR/<handle>.json` storageStates for
 * dennis, audrey, maya, kai. Every test puts the trip back the way it found it.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { INSIGHTS_TESTID as I } from "../../../src/features/insights/testids";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { PLAN_TESTID as P } from "../../../src/features/plan/testids";
import { SHELL_TESTID as SH } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath } from "./_helpers/env";
import { expectLive } from "./_helpers/page";

const AUTH = process.env.QA_AUTH_DIR ?? path.resolve("e2e/.auth");
const auth = (h: string) => path.join(AUTH, `${h}.json`);
const shot = (n: string) =>
	process.env.QA_SHOTS_DIR ? path.join(process.env.QA_SHOTS_DIR, `${n}.png`) : shotPath(`qa-collab/${n}.png`);
const TOKYO = "/t/asia-2027/japan/tokyo";
const GG = "/t/asia-2027/japan/tokyo/shinjuku/golden-gai";
const MF = "/src/features/money/money.functions.ts";
const LF = "/src/features/lists/lists.functions.ts";
const INF = "/src/functions/inbox.functions.ts";
const PF = "/src/functions/proposals.functions.ts";
const ITF = "/src/functions/items.functions.ts";
const TF = "/src/functions/trips.functions.ts";

async function open(browser: Browser, handle: string | null, url: string, opts: { token?: string } = {}) {
	const ctx = await browser.newContext({
		...(handle ? { storageState: auth(handle) } : {}),
		viewport: { width: 1440, height: 900 },
	});
	const page = await ctx.newPage();
	if (opts.token) {
		await page.goto(`/join#t=${opts.token}`);
		await expect(page).toHaveURL(/\/t\//, { timeout: 20_000 });
	}
	await page.goto(url);
	await expectLive(page);
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	return { ctx, page };
}

type Gr = {
	trip: { id: string; startDate: string; endDate: string; version?: number };
	days: { id: string; date: string }[];
	items: { id: string; dayId: string | null; nodeId: string | null; title: string | null; durationMin: number }[];
	nodes: { id: string; name: string; type: string }[];
	members: { id: string; name: string; userId: string | null }[];
	legs: { id: string; fromItemId: string; toItemId: string }[];
};
const graph = (p: Page) => p.evaluate(() => (window as unknown as { __yonder: { graph: Gr } }).__yonder.graph);

type R<T> = { ok: true; v: T } | { ok: false; e: string };
/** Calls a server function in the page and refreshes the app's queries; never throws. */
async function call<T = unknown>(p: Page, file: string, fn: string, data: unknown): Promise<R<T>> {
	return p.evaluate(
		async ({ file, fn, data }) => {
			const mod = (await import(/* @vite-ignore */ file)) as Record<string, (o: { data: unknown }) => Promise<unknown>>;
			let out: { ok: boolean; v?: unknown; e?: string };
			try {
				out = { ok: true, v: await mod[fn]!({ data }) };
			} catch (e) {
				out = { ok: false, e: e instanceof Error ? e.message : String(e) };
			}
			const { appQueryClient } = await import(
				/* @vite-ignore */ "/src/features/suggest/__harness__/app-query-client.ts"
			);
			await appQueryClient()?.invalidateQueries();
			return out;
		},
		{ file, fn, data },
	) as Promise<R<T>>;
}
const must = <T>(r: R<T>, what: string): T => {
	if (!r.ok) throw new Error(`${what}: ${r.e}`);
	return r.v;
};
type InboxItem = { kind: string; key: string; title: string; read: boolean; link: Record<string, string> };
const inbox = async (p: Page, tripId: string) =>
	must(await call<{ items: InboxItem[]; unread: number }>(p, INF, "listInbox", { tripId }), "listInbox");

async function itemNamed(p: Page, name: string) {
	const g = await graph(p);
	const node = g.nodes.find((n) => n.name === name);
	const it = g.items.find((i) => i.dayId && (i.title === name || (node && i.nodeId === node.id)));
	if (!it) throw new Error(`no item ${name}`);
	return { ...it, date: g.days.find((d) => d.id === it.dayId)?.date ?? null };
}
const card = (p: Page, id: string) => p.locator(`[data-testid="${TESTID.timelineItem}"][data-item-id="${id}"]`).first();
const snap = (p: Page, n: string) => p.screenshot({ path: shot(n), timeout: 20_000 }).catch((e) => console.log(`[shot] ${n}: ${e}`));
const text = async (l: ReturnType<Page["locator"]>) =>
	(await l.count()) ? ((await l.first().innerText({ timeout: 5_000 }).catch(() => "")) || "").replace(/\s+/g, " ").trim() : "";

test.skip(({ isMobile }) => isMobile, "desktop; phone checks open their own contexts");

// ---------------------------------------------------------------------------
// Round-2 re-check
// ---------------------------------------------------------------------------
test("COLLAB-R2-01 re-check: Maya's pending move of Nakano Broadway leaves the reviewer an origin row and a ghost, never an amber 'Unlinked transit' row with a destructive Discard", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", `${TOKYO}?days=2027-10-05..2027-10-06`);
	const m = await open(browser, "maya", TOKYO);
	const g0 = await graph(d.page);
	const nb = await itemNamed(d.page, "Nakano Broadway");
	const cha = await itemNamed(d.page, "Cha no Ikedaya");
	const d6 = g0.days.find((x) => x.date === "2027-10-06")?.id;
	const jr = g0.legs.find((l) => l.fromItemId === cha.id && l.toItemId === nb.id);
	expect(jr, "fixture: the Cha no Ikedaya → Nakano Broadway leg").toBeTruthy();
	let pid: string | undefined;
	try {
		const r = must(await call<{ proposed?: { id: string } }>(m.page, ITF, "moveItem", { itemId: nb.id, dayId: d6 }), "moveItem");
		pid = r.proposed?.id;
		expect(pid).toBeTruthy();
		// Dennis: a ghost for the move and no amber row.
		await expect(d.page.locator(`[data-testid="${TESTID.proposalGhost}"][data-proposal-id="${pid}"]`).first()).toBeVisible({
			timeout: 10_000,
		});
		await d.page.waitForTimeout(1_000);
		expect(await d.page.getByTestId(P.unlinked).count(), "no 'Unlinked transit' row for a hypothetical move").toBe(0);
		const origin = d.page.getByText(/Nakano Broadway\s*→/).first();
		console.log(`[r2-01] origin row: ${await text(origin)}`);
		await snap(d.page, "r3-overlay-no-unlinked");
		// The real leg is untouched.
		expect((await graph(d.page)).legs.some((l) => l.id === jr?.id)).toBe(true);
	} finally {
		if (pid) await call(m.page, PF, "withdrawProposal", { proposalId: pid });
		await m.ctx.close();
		await d.ctx.close();
	}
});

// ---------------------------------------------------------------------------
// One inbox (ADDENDUM §10, EXTENSIONS §9)
// ---------------------------------------------------------------------------
test("ONE inbox money: a settlement then Audrey's expense → 'Balance changed' (her edit re-notifies), a changed trip default → 'budget notice'; a row opens Money and marks read; Kai gets none", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", "/t/asia-2027?tab=plan");
	const a = await open(browser, "audrey", "/t/asia-2027?tab=plan");
	const k = await open(browser, "kai", "/t/asia-2027?tab=plan");
	const g = await graph(d.page);
	const T = g.trip.id;
	const D = g.members.find((x) => x.name.startsWith("Dennis"))?.id as string;
	const A = g.members.find((x) => x.name.startsWith("Audrey"))?.id as string;
	const now = new Date().toISOString();
	const made: { s?: string; e?: string; b1?: string; b2?: string } = {};
	const pay = (amt: number) => [{ paidAt: now, paidTz: "Asia/Tokyo", currency: "JPY", amountMinor: amt, payers: [{ memberId: A, amountMinor: amt }] }];
	try {
		made.s = must(
			await call<{ id: string }>(d.page, MF, "createSettlement", {
				tripId: T,
				fromMemberId: D,
				toMemberId: A,
				amountMinor: 1000,
				currency: "USD",
				settledAt: now,
				settledTz: "America/New_York",
			}),
			"settle",
		).id;
		expect((await inbox(d.page, T)).items.filter((i) => i.kind === "balance_changed")).toHaveLength(0);
		made.e = must(
			await call<{ id: string }>(a.page, MF, "createExpense", {
				tripId: T,
				target: { kind: "trip" },
				title: "Ramen r3",
				category: "food_drink",
				amountMinor: 3000,
				currency: "JPY",
				payments: pay(3000),
				split: { mode: "equal", shares: [{ memberId: D }, { memberId: A }] },
			}),
			"expense",
		).id;
		const b1 = (await inbox(d.page, T)).items.find((i) => i.kind === "balance_changed");
		console.log(`[inbox-money] ${b1?.title}`);
		expect(b1?.title).toMatch(/Balance changed since your last settlement: −\$[\d.]+ \(Audrey added an expense: Ramen r3\)/);
		expect(must(await call<{ updated: number }>(d.page, INF, "markInboxRead", { keys: [b1?.key] }), "mark").updated).toBe(1);
		must(await call(a.page, MF, "updateExpense", { id: made.e, patch: { amountMinor: 4000, payments: pay(4000) } }), "update");
		const b2 = (await inbox(d.page, T)).items.find((i) => i.kind === "balance_changed");
		expect(b2?.key, "a new delta is a new key").not.toBe(b1?.key);
		expect(b2?.read).toBe(false);
		expect(b2?.title).toContain("Audrey edited Ramen r3");
		// Budgets: a trip default, Dennis's own line, then Audrey raises the default.
		made.b1 = must(
			await call<{ id: string }>(a.page, MF, "setBudgetLine", { tripId: T, nodeId: null, category: null, memberId: null, amountMinor: 500000, kind: "total" }),
			"default",
		).id;
		made.b2 = must(
			await call<{ id: string }>(d.page, MF, "setBudgetLine", { tripId: T, nodeId: null, category: null, memberId: D, amountMinor: 400000, kind: "total" }),
			"mine",
		).id;
		expect((await inbox(d.page, T)).items.some((i) => i.kind === "budget_notice")).toBe(false);
		must(
			await call(a.page, MF, "setBudgetLine", { tripId: T, nodeId: null, category: null, memberId: null, amountMinor: 600000, kind: "total" }),
			"default 2",
		);
		const bn = (await inbox(d.page, T)).items.find((i) => i.kind === "budget_notice");
		expect(bn?.title).toBe("Trip default is now $6,000.00; yours stays $4,000.00");
		// UI: the bell lists both under Money; a row opens the Money tab and marks read.
		await d.page.reload();
		await expectLive(d.page);
		await d.page.getByTestId(TESTID.inboxBell).first().click();
		const panel = d.page.getByTestId(SH.inboxPanel).first();
		await expect(panel).toContainText("Trip default is now $6,000.00");
		await snap(d.page, "r3-inbox-money");
		await panel.getByTestId(SH.inboxRow).filter({ hasText: "Balance changed" }).first().click();
		await expect(d.page).toHaveURL(/tab=money/);
		await expect.poll(async () => (await inbox(d.page, T)).items.find((i) => i.key === b2?.key)?.read).toBe(true);
		// Kai (viewer) has no money notices.
		expect((await inbox(k.page, T)).items.filter((i) => /balance|budget/.test(i.kind))).toHaveLength(0);
	} finally {
		if (made.e) await call(a.page, MF, "deleteExpense", { id: made.e });
		if (made.s) await call(d.page, MF, "deleteSettlement", { id: made.s });
		if (made.b2) await call(d.page, MF, "deleteBudgetLine", { id: made.b2 });
		if (made.b1) await call(a.page, MF, "deleteBudgetLine", { id: made.b1 });
		await k.ctx.close();
		await a.ctx.close();
		await d.ctx.close();
	}
});

test("ONE inbox: a booking window relative to Day 1's check-in (372 days before at 09:00 JST) is 'soon'; shifting the trip +1 in the what-if moves it and it notifies again; Undo puts it back", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", TOKYO);
	const g = await graph(d.page);
	const T = g.trip.id;
	const day1 = g.days.find((x) => x.date === g.trip.startDate)?.id;
	const checkIn = g.items.find((i) => i.dayId === day1 && /Check in/.test(i.title ?? ""));
	expect(checkIn, "fixture: Check in (JFK T7) on Day 1").toBeTruthy();
	const tag = randomBytes(2).toString("hex");
	let id: string | undefined;
	let shifted = false;
	try {
		id = must(
			await call<{ id: string }>(d.page, LF, "createListItem", {
				tripId: T,
				target: { kind: "item", itemId: checkIn?.id },
				list: "todo",
				text: `ANA seats open ${tag}`,
				dueKind: "opens",
				dueRule: { kind: "days", itemId: checkIn?.id, days: 372, time: "09:00", tz: "Asia/Tokyo" },
			}),
			"create",
		).id;
		const i1 = (await inbox(d.page, T)).items.find((i) => i.kind === "due" && i.title.includes(tag));
		console.log(`[due-rule] before: ${i1?.title} ${i1?.key}`);
		expect(i1, "a relative window in the next 7 days reaches the bell").toBeTruthy();
		must(await call(d.page, INF, "markInboxRead", { keys: [i1?.key] }), "mark");
		// Shift +1 in the UI.
		await d.page.reload();
		await expectLive(d.page);
		await d.page.getByTestId(TESTID.tripMenu).click();
		await d.page.getByTestId("try-other-dates").click();
		await d.page.getByTestId(I.shiftPlus).click();
		await d.page.getByTestId(I.shiftApply).click();
		await expect(d.page.getByText(/Trip shifted \+1 day/)).toBeVisible({ timeout: 10_000 });
		shifted = true;
		const i2 = (await inbox(d.page, T)).items.find((i) => i.kind === "due" && i.title.includes(tag));
		console.log(`[due-rule] after: ${i2?.title} ${i2?.key} read=${i2?.read}`);
		expect(i2?.key, "the window moved with Day 1").not.toBe(i1?.key);
		expect(i2?.read, "a moved window notifies again").toBe(false);
		await d.page.getByRole("button", { name: "Undo" }).first().click();
		await expect.poll(async () => (await graph(d.page)).trip.startDate, { timeout: 10_000 }).toBe(g.trip.startDate);
		shifted = false;
		const i3 = (await inbox(d.page, T)).items.find((i) => i.kind === "due" && i.title.includes(tag));
		expect(i3?.key).toBe(i1?.key);
	} finally {
		if (shifted) await call(d.page, TF, "shiftTripDates", { tripId: T, deltaDays: -1 });
		if (id) await call(d.page, LF, "deleteListItem", { id });
		await d.ctx.close();
	}
});

test("ONE inbox review item: Maya's first suggestion is '1 suggestion to review'; after Dennis reads it, her second makes it unread again with the new count; guests have no inbox; Kai can't mark Dennis's keys", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const d = await open(browser, "dennis", "/t/asia-2027?tab=plan");
	const m = await open(browser, "maya", TOKYO);
	const k = await open(browser, "kai", "/t/asia-2027?tab=plan");
	const guest = await open(browser, null, "/t/asia-2027?tab=plan", { token: "qa-share-token-editor-asia-2027" });
	const g = await graph(d.page);
	const T = g.trip.id;
	const lunch = g.items.find((i) => i.title === "Lunch" && i.dayId);
	const bf = g.items.find((i) => i.title === "Breakfast" && i.dayId);
	const pids: string[] = [];
	try {
		const r1 = must(await call<{ proposed?: { id: string } }>(m.page, ITF, "updateItem", { itemId: lunch?.id, patch: { durationMin: 75 } }), "p1");
		pids.push(r1.proposed?.id as string);
		const rv1 = (await inbox(d.page, T)).items.find((i) => i.kind === "review");
		expect(rv1?.title).toMatch(/^1 suggestion to review/);
		must(await call(d.page, INF, "markInboxRead", { keys: [rv1?.key] }), "mark");
		// Kai tries to write Dennis's read state for the same key: nothing happens.
		const kr = must(await call<{ updated: number }>(k.page, INF, "markInboxRead", { keys: [rv1?.key] }), "kai mark");
		expect(kr.updated).toBe(0);
		const r2 = must(await call<{ proposed?: { id: string } }>(m.page, ITF, "updateItem", { itemId: bf?.id, patch: { durationMin: 45 } }), "p2");
		pids.push(r2.proposed?.id as string);
		const rv2 = (await inbox(d.page, T)).items.find((i) => i.kind === "review");
		console.log(`[review] ${rv1?.title} → ${rv2?.title} read=${rv2?.read}`);
		expect(rv2?.title).toMatch(/^2 suggestions to review/);
		expect(rv2?.read).toBe(false);
		// Link guest: no bell, and listInbox refuses.
		expect(await guest.page.getByTestId(TESTID.inboxBell).count()).toBe(0);
		const gi = await call(guest.page, INF, "listInbox", { tripId: T });
		console.log(`[review] guest listInbox: ${JSON.stringify(gi).slice(0, 120)}`);
		expect(gi.ok).toBe(false);
	} finally {
		for (const id of pids) if (id) await call(m.page, PF, "withdrawProposal", { proposalId: id });
		await guest.ctx.close();
		await k.ctx.close();
		await m.ctx.close();
		await d.ctx.close();
	}
});

// ---------------------------------------------------------------------------
// E2 what-if: deadlines, a Day 1 in the past
// ---------------------------------------------------------------------------
test("SHIFT deadlines: −1 lists a to-do due the day before its item under Deadlines; a Day 1 picked in the past warns and lists a Day-1 deadline as now past; nothing is applied", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const d = await open(browser, "dennis", "/t/asia-2027?tab=plan");
	const g = await graph(d.page);
	const T = g.trip.id;
	const mon4 = g.days.find((x) => x.date === "2027-10-04")?.id;
	const it4 = g.items.find((i) => i.dayId === mon4);
	const day1 = g.days.find((x) => x.date === g.trip.startDate)?.id;
	const tag = randomBytes(2).toString("hex");
	const ids: string[] = [];
	try {
		ids.push(
			must(
				await call<{ id: string }>(d.page, LF, "createListItem", {
					tripId: T,
					target: { kind: "item", itemId: it4?.id },
					list: "todo",
					text: `Reserve r3 ${tag}`,
					dueDate: "2027-10-03",
					dueTime: "10:00",
					dueTz: "Asia/Tokyo",
				}),
				"li1",
			).id,
		);
		ids.push(
			must(
				await call<{ id: string }>(d.page, LF, "createListItem", { tripId: T, target: { kind: "trip" }, list: "todo", text: `Pack r3 ${tag}`, dueDayId: day1 }),
				"li2",
			).id,
		);
		await d.page.reload();
		await expectLive(d.page);
		await d.page.getByTestId(TESTID.tripMenu).click();
		await d.page.getByTestId("try-other-dates").click();
		const dlg = d.page.getByTestId(TESTID.shiftTripDialog);
		await dlg.getByTestId(I.shiftMinus).click();
		const dl = dlg.getByTestId(I.impactSection).filter({ hasText: /Deadlines/i });
		await expect(dl).toContainText(`Reserve r3 ${tag}`, { timeout: 5_000 });
		console.log(`[shift-dl] −1: ${await text(dl)}`);
		await snap(d.page, "r3-shift-deadlines");
		// Shift so Day 1 is… 1 Sep 2026 (the past).
		await dlg.getByTestId(I.shiftDay1).click();
		const cal = d.page.locator('[data-slot="popover-content"]').last();
		for (let i = 0; i < 14 && !(await text(cal)).includes("September 2026"); i++)
			await cal.getByRole("button", { name: /previous/i }).first().click();
		await cal.locator("button", { hasText: /^1$/ }).first().click();
		await expect(dlg.getByTestId(I.shiftSummary)).toContainText("before today");
		await expect(dl).toContainText(`Pack r3 ${tag}`);
		console.log(`[shift-dl] past: ${await text(dlg.getByTestId(I.shiftSummary))} | ${await text(dl)}`);
		await dlg.getByTestId(I.shiftDiscard).click();
		expect((await graph(d.page)).trip.startDate).toBe(g.trip.startDate);
	} finally {
		for (const id of ids) await call(d.page, LF, "deleteListItem", { id });
		await d.ctx.close();
	}
});

// ---------------------------------------------------------------------------
// E1 hours: past midnight and hedged labels
// ---------------------------------------------------------------------------
test("HRS-05: Bar Centifolia ('18:00–03:00 (some sources list closed Wed — confirm)') open until 02:00 isn't flagged; stretched past 03:00 it warns with the hedged close", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const bc = await (async () => {
		const d0 = await open(browser, "dennis", TOKYO);
		const it = await itemNamed(d0.page, "Bar Centifolia");
		await d0.ctx.close();
		return it;
	})();
	const d = await open(browser, "dennis", `${TOKYO}?days=${bc.date}`);
	const c = card(d.page, bc.id);
	await expect(c).toBeVisible();
	const times = (await text(c)).match(/(\d\d):(\d\d)/);
	const startMin = times ? Number(times[1]) * 60 + Number(times[2]) : 0;
	console.log(`[hrs05] ${bc.date} card: ${await text(c)}`);
	// The seed has it in the early hours (00:28 +1, inside Monday's 18:00–03:00): no chip at all.
	const chip0 = await text(c.getByTestId(TESTID.hoursChip));
	console.log(`[hrs05] as seeded → chip "${chip0}"`);
	expect(chip0).not.toMatch(/Clos|short|late/i);
	try {
		// End at 02:00 (after midnight).
		const to2 = (startMin < 12 * 60 ? 0 : 24 * 60) + 120 - startMin;
		must(await call(d.page, ITF, "updateItem", { itemId: bc.id, patch: { durationMin: to2 } }), "dur1");
		await d.page.waitForTimeout(1_000);
		const chip1 = await text(c.getByTestId(TESTID.hoursChip));
		console.log(`[hrs05] ends 02:00 → chip "${chip1}"`);
		expect(chip1, "open past midnight: no warning").not.toMatch(/Clos|short|late/i);
		// End at 04:00.
		must(await call(d.page, ITF, "updateItem", { itemId: bc.id, patch: { durationMin: to2 + 120 } }), "dur2");
		await expect(c.getByTestId(TESTID.hoursChip)).toContainText(/03:00/, { timeout: 8_000 });
		const chip2 = await text(c.getByTestId(TESTID.hoursChip));
		console.log(`[hrs05] ends 04:00 → chip "${chip2}"`);
		expect(chip2).toMatch(/~03:00/);
		await snap(d.page, "r3-hrs05-past-close");
	} finally {
		await call(d.page, ITF, "updateItem", { itemId: bc.id, patch: { durationMin: bc.durationMin } });
		await d.ctx.close();
	}
});

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------
const topEditor = (p: Page) => p.getByTestId(TESTID.notesTab).getByTestId(NT.editor).first();
type Ed = {
	editor?: {
		state: { doc: { textBetween: (a: number, b: number, sep: string) => string; content: { size: number } } };
		commands: { focus: (p: "start" | "end" | number) => boolean; setTextSelection: (p: number) => boolean };
	};
};
const noteText = (p: Page) =>
	topEditor(p).evaluate((e) => {
		const d = (e as unknown as Ed).editor?.state.doc;
		return d ? d.textBetween(0, d.content.size, "\n") : "";
	});
async function caretAt(p: Page, where: "start" | "end") {
	const ed = topEditor(p);
	await expect(ed).toHaveAttribute("data-editable", "true", { timeout: 15_000 });
	await ed.click();
	await ed.evaluate((e, w) => (e as unknown as Ed).editor?.commands.focus(w), where);
}
async function dropLines(p: Page, tag: string) {
	await topEditor(p)
		.evaluate((e, tg) => {
			const ed = (
				e as unknown as {
					editor?: {
						state: { doc: { descendants: (f: (n: { isTextblock: boolean; textContent: string; nodeSize: number }, pos: number) => void) => void } };
						chain: () => { deleteRange: (r: { from: number; to: number }) => { run: () => boolean } };
					};
				}
			).editor;
			if (!ed) return;
			const ranges: { from: number; to: number }[] = [];
			ed.state.doc.descendants((n, pos) => {
				if (n.isTextblock && n.textContent.includes(tg)) ranges.push({ from: pos, to: pos + n.nodeSize });
			});
			for (const r of ranges.reverse()) ed.chain().deleteRange(r).run();
		}, tag)
		.catch(() => undefined);
}

test("RT-11: Dennis's Ctrl+Z undoes only his own typing; Audrey's line stays on both screens", async ({ browser }) => {
	test.setTimeout(120_000);
	const tag = randomBytes(2).toString("hex");
	const d = await open(browser, "dennis", `${GG}?tab=notes`);
	const a = await open(browser, "audrey", `${GG}?tab=notes`);
	const before = await noteText(d.page);
	const sD = `Dennis undo ${tag}`;
	const sA = `Audrey keeps ${tag}`;
	try {
		await caretAt(a.page, "end");
		await a.page.keyboard.press("Enter");
		await a.page.keyboard.type(sA, { delay: 25 });
		await expect.poll(async () => (await noteText(d.page)).includes(sA), { timeout: 8_000 }).toBe(true);
		await caretAt(d.page, "end");
		await d.page.keyboard.press("Enter");
		await d.page.keyboard.type(sD, { delay: 25 });
		await expect.poll(async () => (await noteText(a.page)).includes(sD), { timeout: 8_000 }).toBe(true);
		await d.page.waitForTimeout(600);
		for (let i = 0; i < 4; i++) await d.page.keyboard.press("ControlOrMeta+z");
		await expect.poll(async () => (await noteText(a.page)).includes(sD), { timeout: 8_000 }).toBe(false);
		const td = await noteText(d.page);
		const ta = await noteText(a.page);
		console.log(`[rt11] tail d=${JSON.stringify(td.split("\n").slice(-2))} a=${JSON.stringify(ta.split("\n").slice(-2))}`);
		expect(td).toContain(sA);
		expect(ta).toContain(sA);
		expect(td).toBe(ta);
		await snap(d.page, "r3-rt11-undo");
	} finally {
		await dropLines(a.page, tag);
		await a.page.waitForTimeout(1_000);
		console.log(`[rt11] restored: ${(await noteText(a.page)) === before}`);
		await a.ctx.close();
		await d.ctx.close();
	}
});

test("RT-02: both type into the middle of the same word at once; both documents converge and keep each run in order", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const tag = randomBytes(2).toString("hex");
	const d = await open(browser, "dennis", `${GG}?tab=notes`);
	const a = await open(browser, "audrey", `${GG}?tab=notes`);
	const word = `Middleword${tag}`;
	try {
		await caretAt(d.page, "end");
		await d.page.keyboard.press("Enter");
		await d.page.keyboard.type(word, { delay: 15 });
		await expect.poll(async () => (await noteText(a.page)).includes(word), { timeout: 8_000 }).toBe(true);
		// Both carets after "Middle".
		for (const p of [d.page, a.page]) {
			await caretAt(p, "end");
			for (let i = 0; i < word.length - 6; i++) await p.keyboard.press("ArrowLeft");
		}
		await Promise.all([d.page.keyboard.type("AAAA", { delay: 40 }), a.page.keyboard.type("BBBB", { delay: 45 })]);
		await expect.poll(async () => (await noteText(d.page)) === (await noteText(a.page)), { timeout: 8_000 }).toBe(true);
		const line = (await noteText(d.page)).split("\n").find((l) => l.includes(tag)) ?? "";
		console.log(`[rt02] ${line}`);
		expect(line.replace(/[AB]/g, "")).toBe(word.replace(/[AB]/g, ""));
		expect((line.match(/A/g) ?? []).length).toBe(4);
		expect((line.match(/B/g) ?? []).length).toBe(4);
		expect(line.startsWith("Middle")).toBe(true);
	} finally {
		await dropLines(d.page, tag);
		await d.page.waitForTimeout(1_000);
		await a.ctx.close();
		await d.ctx.close();
	}
});

test("RT-08: presence shows who is viewing, and the hover says where each person is", async ({ browser }) => {
	test.setTimeout(120_000);
	const d = await open(browser, "dennis", TOKYO);
	const a = await open(browser, "audrey", `${TOKYO}?days=2027-10-05`);
	const k = await open(browser, "kai", GG);
	try {
		const av = d.page.getByTestId(TESTID.presenceAvatar);
		await expect.poll(async () => av.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
		const labels: string[] = [];
		for (let i = 0; i < (await av.count()); i++) {
			const el = av.nth(i);
			labels.push(
				[await el.getAttribute("aria-label"), await el.getAttribute("title"), await el.getAttribute("data-where")].filter(Boolean).join(" | "),
			);
		}
		console.log(`[rt08] avatars: ${JSON.stringify(labels)}`);
		await av.first().hover();
		await d.page.waitForTimeout(800);
		const tip = await text(d.page.locator('[role="tooltip"], [data-slot="tooltip-content"], [data-slot="hover-card-content"]').last());
		console.log(`[rt08] hover: ${tip}`);
		await snap(d.page, "r3-rt08-presence");
		expect(labels.join(" ") + tip).toMatch(/Audrey|Kai/);
	} finally {
		await k.ctx.close();
		await a.ctx.close();
		await d.ctx.close();
	}
});

// ---------------------------------------------------------------------------
// E3 climate when the archive can't answer
// ---------------------------------------------------------------------------
test("CLIM-02: a city whose normals can't be fetched says 'Climate unavailable right now.' (the others still come from the DB)", async ({
	browser,
}) => {
	const k = await open(browser, "kai", "/t/asia-2027?tab=plan");
	const g = await graph(k.page);
	const tokyo = g.nodes.find((n) => n.name === "Tokyo" && n.type === "city");
	const taipei = g.nodes.find((n) => n.name === "Taipei" && n.type === "city");
	const r = must(
		await call<{ byNode: Record<string, unknown>; unavailable: string[] }>(k.page, "/src/features/insights/insights.functions.ts", "getClimate", {
			tripId: g.trip.id,
			nodeIds: [tokyo?.id, taipei?.id],
		}),
		"getClimate",
	);
	console.log(`[clim02] have ${Object.keys(r.byNode).length}, unavailable ${r.unavailable.length}`);
	test.skip(!r.unavailable.includes(taipei?.id as string), "the archive answered for Taipei");
	await k.page.goto(`/t/asia-2027?sel=n.${taipei?.id}`);
	await expectLive(k.page);
	await expect(k.page.getByTestId(I.climateUnavailable)).toHaveText("Climate unavailable right now.");
	await k.ctx.close();
});

// ---------------------------------------------------------------------------
// Round-3 defects (each test encodes the expected behaviour and fails until fixed)
// ---------------------------------------------------------------------------
test("DEFECT (WP-Insights/WP-Home): 'Add holiday' in Trip settings adds a row; it must not submit the settings form and close the dialog", async ({
	browser,
}) => {
	const d = await open(browser, "dennis", TOKYO);
	const v0 = (await graph(d.page)).trip.version;
	try {
		await d.page.getByTestId(TESTID.tripMenu).click();
		await d.page.getByText("Trip settings").first().click();
		const dlg = d.page.getByRole("dialog").first();
		await expect(dlg).toBeVisible();
		const ed = d.page.getByTestId(TESTID.holidaysEditor);
		await ed.scrollIntoViewIfNeeded();
		await ed.getByTestId(I.holidayAdd).click();
		await d.page.waitForTimeout(1_500);
		const stillOpen = await dlg.isVisible().catch(() => false);
		const toasts = await text(d.page.locator("[data-sonner-toast]"));
		const v1 = (await graph(d.page)).trip.version;
		console.log(`[holiday-add] dialog open: ${stillOpen}; toasts: "${toasts}"; trip version ${v0} → ${v1}`);
		await snap(d.page, "r3-holiday-add");
		expect(stillOpen, "the settings dialog stays open with a new holiday row").toBe(true);
		expect(await ed.getByTestId(I.holidayRow).count()).toBeGreaterThan(0);
	} finally {
		await call(d.page, TF, "updateTrip", { tripId: (await graph(d.page)).trip.id, settings: { holidays: [] } });
		await d.ctx.close();
	}
});

test("DEFECT (F/WP-Plan): a pending move's origin row sits at the item's old slot (after Cha no Ikedaya), not at the end of the day", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const d = await open(browser, "dennis", `${TOKYO}?days=2027-10-05`);
	const m = await open(browser, "maya", TOKYO);
	const g = await graph(d.page);
	const nb = await itemNamed(d.page, "Nakano Broadway");
	const cha = await itemNamed(d.page, "Cha no Ikedaya");
	const d6 = g.days.find((x) => x.date === "2027-10-06")?.id;
	let pid: string | undefined;
	try {
		pid = must(await call<{ proposed?: { id: string } }>(m.page, ITF, "moveItem", { itemId: nb.id, dayId: d6 }), "move").proposed?.id;
		const origin = d.page.getByTestId(P.originRow).first();
		await expect(origin).toBeVisible({ timeout: 10_000 });
		// What follows Cha no Ikedaya in the day, in document order.
		const order = await d.page.evaluate(
			({ cha, originId, cardId }) => {
				const all = [...document.querySelectorAll(`[data-testid="${cardId}"], [data-testid="${originId}"]`)];
				return all.map((e) => (e.getAttribute("data-testid") === originId ? "ORIGIN" : (e.getAttribute("data-item-id") === cha ? "CHA" : "card")));
			},
			{ cha: cha.id, originId: P.originRow, cardId: TESTID.timelineItem },
		);
		console.log(`[origin] order: ${order.join(" ")}`);
		await origin.scrollIntoViewIfNeeded();
		await snap(d.page, "r3-origin-row-position");
		expect(order.indexOf("ORIGIN"), "the origin row follows Cha no Ikedaya").toBe(order.indexOf("CHA") + 1);
	} finally {
		if (pid) await call(m.page, PF, "withdrawProposal", { proposalId: pid });
		await m.ctx.close();
		await d.ctx.close();
	}
});

test("DEFECT (WP-Shell): on a phone, a kept what-if draft shows the WhatIfChip (Review · ✕) like the desktop TopBar", async ({ browser }) => {
	const ctx = await browser.newContext({
		storageState: auth("dennis"),
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
		deviceScaleFactor: 2.625,
	});
	const p = await ctx.newPage();
	await p.goto(`${TOKYO}?days=2027-10-03`);
	await expectLive(p);
	await p.getByRole("button", { name: "More" }).first().tap();
	await p.getByText("Try other dates…").first().tap();
	const dlg = p.getByTestId(TESTID.shiftTripDialog);
	await dlg.getByTestId(I.shiftPlus).tap();
	await dlg.getByRole("button", { name: /Keep exploring/ }).tap();
	await expect(dlg).toBeHidden();
	await snap(p, "r3-phone-whatif-no-chip");
	const chip = p.getByTestId(TESTID.whatIfChip);
	console.log(`[phone-whatif] chips: ${await chip.count()}`);
	await expect(chip.first()).toBeVisible({ timeout: 3_000 });
	await ctx.close();
});

test("DEFECT (WP-Media): a suggested link right after another link to the same place is summarised as 'a link', not 'added 2 links'", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const d = await open(browser, "dennis", `${GG}?tab=media`);
	const m = await open(browser, "maya", GG);
	const g = await graph(d.page);
	const gg = g.nodes.find((n) => n.name === "Golden Gai");
	const MEF = "/src/features/media/media.functions.ts";
	const made: string[] = [];
	const pids: string[] = [];
	try {
		// Audrey-like: Dennis adds a link (direct) …
		const first = must(await call<{ id: string }>(d.page, MEF, "addLink", { tripId: g.trip.id, target: { kind: "node", nodeId: gg?.id }, url: "https://www.japan-guide.com/e/e3011.html" }), "link 1");
		made.push(first.id);
		// … then Maya suggests one link; Dennis suggests one too (suggest mode) within two minutes.
		const r = must(await call<{ proposed?: { id: string; summary: string } }>(m.page, MEF, "addLink", { tripId: g.trip.id, target: { kind: "node", nodeId: gg?.id }, url: "https://www.japan-guide.com/e/e3007.html" }), "maya link");
		if (r.proposed) pids.push(r.proposed.id);
		console.log(`[link-summary] Maya's: ${r.proposed?.summary}`);
		expect(r.proposed?.summary).toBe("added a link to Golden Gai");
		// Accept Maya's, then she suggests another one within two minutes.
		must(await call(d.page, PF, "resolveProposal", { proposalId: r.proposed?.id, decision: "accept" }), "accept");
		const r2 = must(await call<{ proposed?: { id: string; summary: string } }>(m.page, MEF, "addLink", { tripId: g.trip.id, target: { kind: "node", nodeId: gg?.id }, url: "https://www.japan-guide.com/e/e3002.html" }), "maya link 2");
		if (r2.proposed) pids.push(r2.proposed.id);
		console.log(`[link-summary] Maya's second: ${r2.proposed?.summary}`);
		expect(r2.proposed?.summary, "one suggested link reads as one link").toBe("added a link to Golden Gai");
	} finally {
		for (const id of pids) await call(m.page, PF, "withdrawProposal", { proposalId: id });
		const media = await call<{ id: string; url?: string | null }[] | { items: { id: string; url?: string | null }[] }>(d.page, MEF, "listTripMedia", { tripId: g.trip.id });
		const list = media.ok ? (Array.isArray(media.v) ? media.v : media.v.items) : [];
		for (const a of list) if (/japan-guide\.com\/e\/e30(11|07|02)\.html/.test(a.url ?? "") ) await call(d.page, MEF, "deleteAttachment", { id: a.id });
		await m.ctx.close();
		await d.ctx.close();
	}
});

test("DEFECT (WP-Insights): a link guest's what-if keeps the booked NH 9 under Needs rebooking (it has a ref, just hidden), never 'no booking ref'", async ({
	browser,
}) => {
	const gst = await open(browser, null, TOKYO, { token: "qa-share-token-viewer-asia-2027" });
	await gst.page.getByTestId(TESTID.tripMenu).click();
	await gst.page.getByTestId("try-other-dates").click();
	const dlg = gst.page.getByTestId(TESTID.shiftTripDialog);
	await dlg.getByTestId(I.shiftPlus).click();
	const rebook = dlg.getByTestId(I.impactSection).filter({ hasText: /Needs rebooking/i });
	await expect(rebook).toBeVisible();
	const nh9 = await text(dlg.getByTestId(I.impactRow).filter({ hasText: "NH 9" }));
	console.log(`[guest-whatif] NH 9 row: ${nh9} | rebooking: ${await text(rebook)}`);
	expect(nh9).not.toContain("ZK4P7Q");
	await snap(gst.page, "r3-guest-whatif");
	expect(await text(rebook), "the booked flight is still a rebooking for guests").toContain("NH 9");
	await gst.ctx.close();
});

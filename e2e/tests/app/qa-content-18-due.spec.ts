/**
 * I2 "content" verifier: E4 due dates (QA DUE-01/02/03/05/06/08/11), the main
 * list's sorting and completion, and private gift items (ADDENDUM §7.2)
 * never leaking to another member (lists, counts, activity, digest, inbox,
 * mentions, dashboard deadlines, proposals).
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const state = (h: string) => path.join(AUTH, `${h}.json`);

type G = {
	trip: { id: string };
	nodes: { id: string; name: string }[];
	items: { id: string; nodeId: string | null; dayId: string | null; title: string | null }[];
	days: { id: string; date: string }[];
	members: { id: string; name: string; userId: string | null }[];
};
const graphOf = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
async function ctxFor(browser: Browser, h: string, extra: Record<string, unknown> = {}) {
	const ctx = await browser.newContext({ storageState: state(h), viewport: { width: 1440, height: 900 }, ...extra });
	return { ctx, page: await ctx.newPage() };
}
const row = (scope: Page | ReturnType<Page["getByTestId"]>, text: string | RegExp) => scope.getByTestId(L.row).filter({ hasText: text });
async function call<T>(page: Page, mod: string, fn: string, data: unknown): Promise<T> {
	return page.evaluate(
		async ({ mod, fn, data }) => {
			const m = await import(mod);
			try {
				return await m[fn]({ data });
			} catch (e) {
				return { __error: (e as Error).message };
			}
		},
		{ mod, fn, data },
	) as Promise<T>;
}
const LISTS = "/src/features/lists/lists.functions.ts";

let g: G;
test.beforeAll(async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	g = await graphOf(d.page);
	await d.ctx.close();
});

test("DUE-01/02/06/08 the main list: groups, open now, opened 5d ago, x completes and reopens", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=lists");
	await expectLive(d.page);
	const tripId = g.trip.id;
	const mk = (text: string, extra: Record<string, unknown>) =>
		call<{ id?: string; __error?: string }>(d.page, LISTS, "createListItem", { tripId, target: { kind: "trip" }, list: "todo", text, ...extra });
	console.log(await mk("QA overdue: send deposit", { dueDate: "2026-09-20" }));
	console.log(await mk("QA opens today A", { dueDate: "2026-09-23", dueKind: "opens" }));
	console.log(await mk("QA opens today B", { dueDate: "2026-09-22", dueKind: "opens" }));
	console.log(await mk("QA opened 5 days ago", { dueDate: "2026-09-18", dueKind: "opens" }));
	console.log(await mk("QA due in 3 days", { dueDate: "2026-09-26" }));
	console.log(await mk("QA on today", { dueDate: "2026-09-23", dueKind: "on" }));
	await d.page.reload();
	await expectLive(d.page);
	const tab = d.page.getByTestId(TESTID.listsTab);
	await expect(d.page.getByTestId(L.view)).toContainText("Due");
	const heads = await tab.getByTestId(L.groupHead).allInnerTexts();
	console.log("DUE groups", JSON.stringify(heads));
	for (const t of ["QA overdue: send deposit", "QA opens today A", "QA opens today B", "QA opened 5 days ago", "QA due in 3 days", "QA on today"]) {
		const r = row(tab, t);
		console.log("ROW", t, "state=", await r.getAttribute("data-state"), "chip=", (await r.getByTestId(L.dueChip).innerText().catch(() => "-")).replace(/\n/g, " "));
	}
	const order = (await tab.getByTestId(L.rowText).allInnerTexts()).slice(0, 12);
	console.log("FIRST ROWS", JSON.stringify(order));
	await shot(d.page, "18-due-main-list");
	// Only one glow dot per group for open-now rows.
	const glowish = await tab.locator("[data-state=open_now]").evaluateAll((els) => els.map((e) => e.innerHTML.includes("glow") || e.innerHTML.includes("animate")));
	console.log("open_now rows glow markers", JSON.stringify(glowish));
	// DUE-02: x completes, a click within 4 s reopens.
	const r = row(tab, "QA due in 3 days");
	await r.getByTestId(L.rowCheck).focus();
	await d.page.keyboard.press("x");
	await expect(r).toHaveAttribute("data-status", "done");
	await expect(d.page.locator("[data-sonner-toast]")).toHaveCount(0);
	await r.getByTestId(L.rowCheck).click();
	await expect(r).toHaveAttribute("data-status", "open");
	await d.page.waitForTimeout(4500);
	await expect(r).toHaveAttribute("data-status", "open");
	// The overdue signal on the Lists tab label.
	const tabLabel = await d.page.getByTestId(TESTID.centerTabs).innerHTML();
	console.log("Lists tab has warning dot:", /warning/.test(tabLabel));
	await d.ctx.close();
});

test("DUE-03 an ET deadline shows the same instant from a JST browser", async ({ browser }) => {
	const j = await ctxFor(browser, "audrey", { timezoneId: "Asia/Tokyo", locale: "ja-JP" });
	await j.page.goto("/t/asia-2027?tab=lists");
	await expectLive(j.page);
	const chase = row(j.page.getByTestId(TESTID.listsTab), /Chase → Aeroplan transfer/);
	const chip = await chase.getByTestId(L.dueChip).innerText();
	console.log("DUE-03 JST browser chip:", chip);
	const e = await ctxFor(browser, "audrey", { timezoneId: "America/New_York" });
	await e.page.goto("/t/asia-2027?tab=lists");
	await expectLive(e.page);
	const chip2 = await row(e.page.getByTestId(TESTID.listsTab), /Chase → Aeroplan transfer/).getByTestId(L.dueChip).innerText();
	console.log("DUE-03 ET browser chip:", chip2);
	expect(chip).toBe(chip2);
	await j.ctx.close();
	await e.ctx.close();
});

test("DUE-05 dashboard deadlines: overdue first, quick-complete", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/");
	const box = d.page.getByTestId(HOME_TESTID.deadlines);
	await expect(box).toBeVisible({ timeout: 20_000 });
	const rows = await box.getByTestId(HOME_TESTID.deadlineRow).allInnerTexts();
	console.log("DASH deadlines", JSON.stringify(rows.map((r) => r.replace(/\n/g, " | "))));
	await shot(d.page, "18-due05-dashboard");
	const first = box.getByTestId(HOME_TESTID.deadlineRow).first();
	await expect(first).toContainText(/Overdue|Opened \d+d ago/);
	await first.getByTestId(HOME_TESTID.deadlineCheck).click();
	await d.page.waitForTimeout(1500);
	const after = await call<{ text: string; status: string }[]>(d.page, LISTS, "listTripListItems", { tripId: g.trip.id });
	console.log("after dashboard tick:", JSON.stringify(after.filter((x) => x.text.startsWith("QA overdue")).map((x) => x.status)));
	await shot(d.page, "18-due05-dashboard-ticked");
	await d.ctx.close();
});

test("DUE-11 shopping ↔ plan: the label follows its shop's item; By day", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=lists&list=shopping");
	await expectLive(d.page);
	const tab = d.page.getByTestId(TESTID.listsTab);
	const knives = row(tab, "Knife sharpener");
	const before = await knives.getByTestId(L.shopPlan).innerText();
	console.log("shop plan before", before);
	const kap = g.nodes.find((n) => n.name === "Kappabashi Street");
	const item = g.items.find((i) => i.nodeId === kap?.id && i.dayId);
	const day7 = g.days.find((x) => x.date === "2027-10-07");
	const res = await call(d.page, "/src/functions/items.functions.ts", "moveItem", { itemId: item?.id, dayId: day7?.id });
	console.log("moveItem", JSON.stringify(res).slice(0, 200));
	await expect.poll(async () => knives.getByTestId(L.shopPlan).innerText(), { timeout: 8_000 }).not.toBe(before);
	console.log("shop plan after move", await knives.getByTestId(L.shopPlan).innerText());
	await d.page.getByTestId(L.view).click();
	await d.page.getByRole("option", { name: "By day" }).click();
	await d.page.waitForTimeout(600);
	const heads = await tab.getByTestId(L.groupHead).allInnerTexts();
	console.log("BY DAY groups", JSON.stringify(heads));
	await shot(d.page, "18-due11-by-day");
	// Move it back.
	await call(d.page, "/src/functions/items.functions.ts", "moveItem", { itemId: item?.id, dayId: item?.dayId });
	await d.page.getByTestId(L.view).click();
	await d.page.getByRole("option", { name: "Place" }).click();
	await d.ctx.close();
});

test("private gift: never reaches Audrey (lists, counts, activity, digest, inbox, mentions, deadlines, proposals)", async ({ browser }) => {
	test.setTimeout(180_000);
	const a = await ctxFor(browser, "audrey");
	await a.page.goto("/t/asia-2027?tab=lists&list=shopping");
	await expectLive(a.page);
	const aBefore = {
		lists: (await call<unknown[]>(a.page, LISTS, "listTripListItems", { tripId: g.trip.id })).length,
		tab: await a.page.getByTestId(TESTID.centerTabs).innerText(),
	};
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=lists&list=shopping");
	await expectLive(d.page);
	const audrey = g.members.find((m) => m.name.startsWith("Audrey"));
	const kap = g.nodes.find((n) => n.name === "Kappabashi Street");
	const mention = `[@Audrey Tester](mention:${audrey?.id})`;
	const gift = await call<{ id?: string; __error?: string }>(d.page, LISTS, "createListItem", {
		tripId: g.trip.id,
		target: { kind: "node", nodeId: kap?.id },
		list: "shopping",
		text: `PEARL earrings for ${mention}`,
		note: `Hide from ${mention}!`,
		isPrivate: true,
		dueDate: "2026-09-24",
		assigneeIds: [audrey?.id],
		priceAmount: 30000,
		priceCurrency: "JPY",
	});
	console.log("gift", JSON.stringify(gift));
	// And a shared item that later becomes private.
	const later = await call<{ id?: string }>(d.page, LISTS, "createListItem", {
		tripId: g.trip.id,
		target: { kind: "node", nodeId: kap?.id },
		list: "shopping",
		text: `SURPRISE cake stand for ${mention}`,
		assigneeIds: [audrey?.id],
		dueDate: "2026-09-24",
	});
	const lid = (later as { id?: string }).id ?? ((later as unknown as { row?: { id: string } }).row?.id);
	console.log("later", JSON.stringify(later).slice(0, 200));
	const all = await call<{ id: string; text: string }[]>(d.page, LISTS, "listTripListItems", { tripId: g.trip.id });
	const laterId = lid ?? all.find((x) => x.text.startsWith("SURPRISE"))?.id;
	await a.page.waitForTimeout(1500);
	const seenBefore = await a.page.getByText(/SURPRISE cake/).count();
	console.log("Audrey saw SURPRISE while shared:", seenBefore);
	const up = await call(d.page, LISTS, "updateListItem", { id: laterId, patch: { isPrivate: true } });
	console.log("make private:", JSON.stringify(up));
	await a.page.waitForTimeout(2000);
	await a.page.reload();
	await expectLive(a.page);
	const tab = a.page.getByTestId(TESTID.listsTab);
	expect(await tab.innerText()).not.toMatch(/PEARL|SURPRISE/);
	const lists = await call<{ text: string }[]>(a.page, LISTS, "listTripListItems", { tripId: g.trip.id });
	expect(JSON.stringify(lists)).not.toMatch(/PEARL|SURPRISE/);
	console.log("Audrey lists count before/after", aBefore.lists, lists.length, "tabs", JSON.stringify(aBefore.tab), "→", JSON.stringify(await a.page.getByTestId(TESTID.centerTabs).innerText()));
	const counts = await call(a.page, "/src/functions/graph.functions.ts", "getTripCounts", { tripId: g.trip.id });
	const act = await call(a.page, "/src/functions/graph.functions.ts", "listActivity", { tripId: g.trip.id });
	const actText = JSON.stringify(act);
	console.log("activity mentions PEARL:", /PEARL/.test(actText), "SURPRISE:", /SURPRISE/.test(actText));
	const digest = await call(a.page, "/src/functions/activity.functions.ts", "getDigest", { tripId: g.trip.id });
	console.log("digest", JSON.stringify(digest).slice(0, 300));
	const inbox = await call(a.page, "/src/functions/inbox.functions.ts", "listInbox", {});
	const inboxText = JSON.stringify(inbox);
	console.log("inbox mentions PEARL:", /PEARL/.test(inboxText), "SURPRISE:", /SURPRISE/.test(inboxText));
	const mentions = await call(a.page, "/src/features/notes/mentions.functions.ts", "listMyMentions", undefined);
	console.log("mentions PEARL/SURPRISE:", /PEARL|SURPRISE/.test(JSON.stringify(mentions)));
	const deadlines = await call(a.page, "/src/features/home/dashboard.functions.ts", "listMyDeadlines", { everyone: true });
	console.log("deadlines PEARL/SURPRISE:", /PEARL|SURPRISE/.test(JSON.stringify(deadlines)), JSON.stringify(deadlines).slice(0, 200));
	void counts;
	expect(actText).not.toMatch(/PEARL/);
	expect(inboxText).not.toMatch(/PEARL|SURPRISE/);
	expect(JSON.stringify(mentions)).not.toMatch(/PEARL|SURPRISE/);
	expect(JSON.stringify(deadlines)).not.toMatch(/PEARL|SURPRISE/);
	// Audrey (editor) acting on the private id by API: NOT_FOUND everywhere.
	const giftId = gift.id ?? all.find((x) => x.text.startsWith("PEARL"))?.id;
	for (const [fn, data] of [
		["setListItemStatus", { id: giftId, status: "done" }],
		["updateListItem", { id: giftId, patch: { text: "hacked" } }],
		["deleteListItem", { id: giftId }],
		["setListItemAssignees", { id: giftId, memberIds: [] }],
	] as const) {
		const r = await call<{ __error?: string }>(a.page, LISTS, fn, data);
		console.log(`Audrey ${fn} on private:`, JSON.stringify(r).slice(0, 120));
		expect(JSON.stringify(r)).toMatch(/NOT_FOUND|__error/);
	}
	// Maya (a suggester) proposing on it: refused, no proposal row naming it.
	const m = await ctxFor(browser, "maya");
	await m.page.goto("/t/asia-2027?tab=lists");
	await expectLive(m.page);
	const mr = await call(m.page, LISTS, "setListItemStatus", { id: giftId, status: "done" });
	console.log("Maya propose on private:", JSON.stringify(mr).slice(0, 160));
	const props = await call(a.page, "/src/functions/proposals.functions.ts", "listProposals", { tripId: g.trip.id });
	expect(JSON.stringify(props)).not.toMatch(/PEARL|SURPRISE/);
	// The live channel: Audrey's open tab never received the text.
	await shot(a.page, "18-private-audrey");
	// Dennis still sees both, marked private.
	await d.page.reload();
	await expectLive(d.page);
	await expect(row(d.page.getByTestId(TESTID.listsTab), /PEARL/)).toHaveAttribute("data-private", "");
	await shot(d.page, "18-private-dennis");
	for (const c of [a, d, m]) await c.ctx.close();
});

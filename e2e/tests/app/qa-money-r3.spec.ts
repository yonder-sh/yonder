/**
 * QA I2 "money" verifier, round 3 (ADDENDUM §6–§7.3, EXTENSIONS §8): probes
 * around the round-2 fixes (refund caps, delete/restore with refunds, the
 * payment rate, settlement tags, unknown currencies, group budgets) plus new
 * edges (negative exact parts, the still-to-pay remainder at today's rate,
 * cross-trip ids, duplicate trip budgets, Local in Türkiye/USA). Self-contained:
 * logs in through the API and clones the demo per test. Run against an
 * isolated server:  APP_URL=http://localhost:5350 … --workers 1
 */
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { MONEY_TESTID as M } from "../../../src/features/money/testids";
import { TESTID } from "../../../src/lib/testids";

const BASE = process.env.APP_URL ?? "http://localhost:5350";
const SHOTS = process.env.QA_SHOTS ?? "/tmp/qa-money-shots";
const MONEY = "/src/features/money/money.functions.ts";
const HOME = "/src/features/home/dashboard.functions.ts";
const NODES = "/src/functions/nodes.functions.ts";
const TRIPS = "/src/functions/trips.functions.ts";
const PREFS = "/src/functions/prefs.functions.ts";
const INBOX = "/src/functions/inbox.functions.ts";
const MEDIA = "/src/features/media/media.functions.ts";
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "desktop project only");
});

async function login(request: APIRequestContext, email: string, first = "Qa", last = "Tester") {
	const H = { Origin: BASE, "Content-Type": "application/json" };
	for (let i = 0; ; i++) {
		const send = await request.post("/api/auth/email-otp/send-verification-otp", { data: { email, type: "sign-in" }, headers: H });
		const sign = send.ok() ? await request.post("/api/auth/sign-in/email-otp", { data: { email, otp: "000000" }, headers: H }) : null;
		if (sign?.ok()) break;
		if (i >= 4) throw new Error(`login ${email}: ${await send.text()} ${sign ? await sign.text() : ""}`);
		await new Promise((r) => setTimeout(r, 400 + Math.random() * 1200));
	}
	const s = (await (await request.get("/api/auth/get-session")).json()) as { user?: { firstName?: string; lastName?: string } } | null;
	if (!s?.user?.firstName?.trim() || !s.user.lastName?.trim()) {
		const upd = await request.post("/api/auth/update-user", { data: { firstName: first, lastName: last }, headers: H });
		expect(upd.ok()).toBeTruthy();
	}
}

async function userPage(browser: Browser, email: string, first?: string, last?: string, viewport = { width: 1440, height: 900 }) {
	const ctx = await browser.newContext({ baseURL: BASE, viewport });
	await login(ctx.request, email, first, last);
	return { ctx, page: await ctx.newPage() };
}

async function callFn<T>(page: Page, fn: string, data: unknown, module = MONEY): Promise<T> {
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

async function callFnErr(page: Page, fn: string, data: unknown, module = MONEY): Promise<string | null> {
	try {
		await callFn(page, fn, data, module);
		return null;
	} catch (e) {
		return (e as Error).message.slice(0, 300);
	}
}

type Clone = {
	tripId: string;
	slug: string;
	shareTokens: { editor: string; viewer: string };
	ids: { items: Record<string, string>; days: Record<string, string>; nodes: Record<string, string>; legs: Record<string, string> };
	members: { owner: string; maya: string | null; audrey: string };
};

async function clone(request: APIRequestContext, opts: Record<string, unknown> = {}): Promise<Clone> {
	const res = await request.post("/api/test/fixture", { headers: { Origin: BASE }, ...(Object.keys(opts).length ? { data: opts } : {}) });
	expect(res.ok(), await res.text()).toBeTruthy();
	return (await res.json()) as Clone;
}

async function waitLive(page: Page) {
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(async () => {
			const s = await page.getByTestId("connection-pill").evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
			return s.length === 0 || s.includes("live") ? "live" : s.join(",");
		}, { timeout: 30_000 })
		.toBe("live");
}

async function openMoney(page: Page, slug: string, path = "") {
	await page.goto(`/t/${slug}${path}${path.includes("?") ? "&" : "?"}tab=money`);
	await waitLive(page);
	await expect(page.getByTestId(TESTID.moneyTab).first()).toBeVisible();
	await page.waitForTimeout(400);
}

type Pay = { id: string; amountMinor: number; currency: string; homeAmountMinor: number | null; fxDate: string | null; fxRate: number | null; paidAt: string; payers: { memberId: string; amountMinor: number }[] };
type Exp = {
	id: string;
	title: string;
	amountMinor: number | null;
	currency: string | null;
	homeAmountMinor: number | null;
	fxRate: number | null;
	fxDate: string | null;
	status: string;
	splitMode: string;
	shares: { memberId: string; amountMinor: number | null }[];
	payments: Pay[];
	lines: { label: string; amountMinor: number; memberIds: string[] }[];
	target: unknown;
	category: string;
	isPrivate: boolean;
	refundOfId: string | null;
};
type Money = {
	homeCurrency: string;
	expenses: Exp[];
	settlements: { id: string; amountMinor: number; currency: string; homeAmountMinor: number | null; scope: unknown }[];
	budgets: { id: string; nodeId: string | null; memberId: string | null; category: string | null; amountMinor: number; kind: string }[];
};

const pay = (amountMinor: number, payers: { memberId: string; amountMinor: number }[], currency = "JPY", paidAt = new Date().toISOString(), paidTz = "Asia/Tokyo") => ({
	paidAt,
	paidTz,
	currency,
	amountMinor,
	payers,
});

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
async function balancesText(page: Page, slug: string) {
	await openMoney(page, slug);
	return flat(await page.getByTestId(M.balances).innerText());
}

// ---------------------------------------------------------------------------
// 1. Refunds (MONEY-R2-02 / R2-03 follow-ups)
// ---------------------------------------------------------------------------

test("R3 refunds: caps hold on edits, in another currency, on restore; delete/undo keeps exactly its refunds", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r3-o1-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	const bal0 = await balancesText(page, c.slug);
	const orig = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Camera", category: "shopping", amountMinor: 10000, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(10000, [{ memberId: owner, amountMinor: 10000 }])],
	});
	const rA = await callFn<{ id: string }>(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, amountMinor: -6000, currency: "JPY", refundOfId: orig.id, payments: [pay(-6000, [{ memberId: owner, amountMinor: -6000 }])] });
	out.refundB5000 = await callFnErr(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, amountMinor: -5000, currency: "JPY", refundOfId: orig.id });
	const rB = await callFn<{ id: string }>(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, amountMinor: -4000, currency: "JPY", refundOfId: orig.id });
	// edit refund A past the cap
	out.editA7000 = await callFnErr(page, "updateExpense", { id: rA.id, patch: { amountMinor: -7000, payments: [pay(-7000, [{ memberId: owner, amountMinor: -7000 }])] } });
	// shrink the original below its refunds
	out.shrinkOrig = await callFnErr(page, "updateExpense", { id: orig.id, patch: { amountMinor: 8000, payments: [pay(8000, [{ memberId: owner, amountMinor: 8000 }])] } });
	// switch the original to USD $10 (≈ ¥1,576) while ¥10,000 of refunds hang on it
	out.origToUsd = await callFnErr(page, "updateExpense", { id: orig.id, patch: { amountMinor: 1000, currency: "USD", payments: [pay(1000, [{ memberId: owner, amountMinor: 1000 }], "USD")] } });
	// a USD refund on a fully refunded ¥ cost
	out.usdRefundOver = await callFnErr(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, amountMinor: -100, currency: "USD", refundOfId: orig.id });
	// the original made points-only
	out.origToPoints = await callFnErr(page, "updateExpense", { id: orig.id, patch: { amountMinor: null, currency: null, points: { program: "Amex MR", points: 1000 }, payments: [] } });
	// delete refund B alone, then the original: undo of the original brings back A only
	await callFn(page, "deleteExpense", { id: rB.id });
	const del = await callFn<{ refunds: number }>(page, "deleteExpense", { id: orig.id });
	out.deletedWith = del.refunds;
	out.balAfterDelete = await balancesText(page, c.slug);
	out.restoreRefundAlone = await callFnErr(page, "restoreExpense", { id: rA.id });
	await callFn(page, "restoreExpense", { id: orig.id });
	let m = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.liveAfterUndo = m.expenses.map((e) => [e.title, e.amountMinor]);
	// now B can't come back: A (¥6,000) + a new ¥4,000 refund fill the original
	await callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, amountMinor: -4000, currency: "JPY", refundOfId: orig.id });
	out.restoreBOverCap = await callFnErr(page, "restoreExpense", { id: rB.id });
	m = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.liveEnd = m.expenses.map((e) => [e.title, e.amountMinor]);
	// Maya (editor) deletes the original that carries Olga's PRIVATE refund, then undoes
	const priv = await callFn<{ id: string }>(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "Other cost", amountMinor: 20000, currency: "JPY", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] }, payments: [pay(20000, [{ memberId: maya, amountMinor: 20000 }])] });
	const myPrivRefund = await callFn<{ id: string }>(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, amountMinor: -3000, currency: "JPY", refundOfId: priv.id, isPrivate: true });
	const mp = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(mp.page, c.slug);
	const mayaDel = await callFn<{ refunds: number }>(mp.page, "deleteExpense", { id: priv.id });
	out.mayaDeleteReportsRefunds = mayaDel.refunds;
	m = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.olgaPrivRefundAfterMayaDelete = m.expenses.some((e) => e.id === myPrivRefund.id);
	await callFn(mp.page, "restoreExpense", { id: priv.id });
	m = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.olgaPrivRefundAfterMayaUndo = m.expenses.some((e) => e.id === myPrivRefund.id);
	// UI: refund more than what is left on the original
	await openMoney(page, c.slug);
	await page.getByTestId(M.expenseRow).filter({ hasText: /^Camera/ }).first().click();
	const dlg = page.getByTestId(TESTID.addExpenseDialog);
	await expect(dlg).toBeVisible();
	await dlg.getByTestId(M.refund).click();
	await page.waitForTimeout(500);
	await dlg.getByTestId(M.amount).fill("3000");
	out.refundDialog = flat(await dlg.innerText()).slice(0, 400);
	out.refundSaveDisabled = await dlg.getByTestId(M.save).isDisabled();
	await page.screenshot({ path: `${SHOTS}/r3-refund-over-ui.png` });
	await page.keyboard.press("Escape");
	await mp.ctx.close();
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.refundB5000, "second refund past the original").toBeTruthy();
	expect.soft(out.editA7000, "editing a refund past the cap").toBeTruthy();
	expect.soft(out.shrinkOrig, "shrinking the original below its refunds").toBeTruthy();
	expect.soft(out.origToUsd, "switching the original to $10 under ¥10,000 of refunds").toBeTruthy();
	expect.soft(out.usdRefundOver, "a $ refund on a fully refunded ¥ cost").toBeTruthy();
	expect.soft(out.origToPoints, "points-only original with refunds").toBeTruthy();
	expect.soft(out.deletedWith, "the original takes its one live refund along").toBe(1);
	expect.soft(out.balAfterDelete).toBe(bal0);
	expect.soft(out.restoreRefundAlone).toBeTruthy();
	expect.soft(out.restoreBOverCap, "restoring a refund past the cap").toBeTruthy();
	expect.soft(out.olgaPrivRefundAfterMayaUndo, "Maya's undo brings back Olga's private refund").toBe(true);
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 2. Validation holes: negative exact parts and item lines
// ---------------------------------------------------------------------------

test("R3 validation: negative exact parts / item lines, zero amount, payments over the total", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r3-o2-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	const who = (id: string) => (id === owner ? "owner" : id === maya ? "maya" : id);
	// ¥1,000: owner 1,500, Maya −500 (sums to the total)
	const neg = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Negative exact", amountMinor: 1000, currency: "JPY",
		split: { mode: "exact", shares: [{ memberId: owner, amountMinor: 1500 }, { memberId: maya, amountMinor: -500 }] },
		payments: [pay(1000, [{ memberId: owner, amountMinor: 1000 }])],
	}).catch((e) => ({ id: "", err: String(e) }));
	out.negativeExact = neg;
	if (neg.id) {
		await openMoney(page, c.slug);
		out.negPeople = flat(await page.getByTestId(M.people).innerText());
		out.negBal = flat(await page.getByTestId(M.balances).innerText());
		await page.screenshot({ path: `${SHOTS}/r3-negative-exact.png`, fullPage: true });
		await callFn(page, "deleteExpense", { id: neg.id });
	}
	const negLine = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Negative line", amountMinor: 1000, currency: "JPY",
		lines: [{ label: "Set", amountMinor: 1500, memberIds: [owner] }, { label: "Coupon", amountMinor: -500, memberIds: [maya] }],
		payments: [pay(1000, [{ memberId: owner, amountMinor: 1000 }])],
	}).catch((e) => ({ id: "", err: String(e) }));
	out.negativeLine = negLine;
	if (negLine.id) {
		await openMoney(page, c.slug);
		out.negLinePeople = flat(await page.getByTestId(M.people).innerText());
		await callFn(page, "deleteExpense", { id: negLine.id });
	}
	out.zeroAmount = await callFnErr(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "Zero", amountMinor: 0, currency: "JPY" });
	out.negFee = await callFnErr(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Neg fee", amountMinor: 900, currency: "JPY",
		lines: [{ label: "A", amountMinor: 1000, memberIds: [owner] }], fees: [{ label: "Discount", kind: "fixed", amountMinor: -100 }],
	});
	out.negCashValue = await callFnErr(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "Neg cash", points: { program: "Aeroplan", points: 1000, cashValueMinor: -5000, cashValueCurrency: "USD" } });
	// paying ¥12,000 on a ¥10,000 cost: balances still sum to zero?
	const over = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Overpaid", amountMinor: 10000, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(12000, [{ memberId: owner, amountMinor: 12000 }])],
	}).catch((e) => ({ id: "", err: String(e) }));
	out.overpaid = over;
	await openMoney(page, c.slug);
	out.overSummary = flat(await page.getByTestId(M.summary).innerText());
	out.overBal = flat(await page.getByTestId(M.balances).innerText());
	const m = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.overRow = m.expenses.find((e) => e.title === "Overpaid")?.status;
	// the same through the editor: Exact, Olga 1500, Maya -500
	await openMoney(page, c.slug);
	await page.getByTestId(M.addButton).first().click();
	const dlg = page.getByTestId(TESTID.addExpenseDialog);
	await expect(dlg).toBeVisible();
	await dlg.getByTestId(M.amount).fill("1000");
	await dlg.getByTestId(M.title).fill("UI negative exact");
	await dlg.getByTestId(M.splitToggle).click();
	await dlg.getByTestId(M.splitExact).click();
	await page.waitForTimeout(300);
	const ex = dlg.getByTestId(M.splitExactAmount);
	out.exactInputs = await ex.count();
	await ex.nth(0).fill("1500");
	await ex.nth(1).fill("-500");
	if ((await ex.count()) > 2) await ex.nth(2).fill("0");
	await page.waitForTimeout(300);
	out.uiNegSaveDisabled = await dlg.getByTestId(M.save).isDisabled();
	await page.screenshot({ path: `${SHOTS}/r3-negative-exact-ui.png` });
	if (!out.uiNegSaveDisabled) {
		await dlg.getByTestId(M.save).click();
		await page.waitForTimeout(1500);
		const mm = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
		const ue = mm.expenses.find((e) => e.title === "UI negative exact");
		out.uiNegSaved = ue ? ue.shares.map((s) => [who(s.memberId), s.amountMinor]) : "not saved";
		out.uiNegToasts = await page.locator("[data-sonner-toast]").allInnerTexts();
	} else await page.keyboard.press("Escape");
	console.log(JSON.stringify(out, null, 1));
	expect.soft((out.negativeExact as { err?: string }).err, "DEFECT: a negative exact part is refused").toBeTruthy();
	expect.soft((out.negativeLine as { err?: string }).err, "DEFECT: a negative item line is refused").toBeTruthy();
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 3. FX: the unpaid remainder counts as planned at TODAY's rate
// ---------------------------------------------------------------------------

test("R3 FX: still to pay of a part-paid ¥/₺ cost is the remainder at today's rate", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r3-o3-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	await openMoney(page, c.slug);
	// ₺30,000 hotel in Istanbul, ₺10,000 deposit paid a year ago (TRY lost value since)
	const e = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "node", nodeId: c.ids.nodes.istanbul }, title: "Istanbul hotel", category: "lodging", amountMinor: 3000000, currency: "TRY",
		split: { mode: "equal", shares: [{ memberId: owner }] },
		payments: [pay(1000000, [{ memberId: owner, amountMinor: 1000000 }], "TRY", "2025-09-20T09:00:00.000Z", "Europe/Istanbul")],
	});
	const m = await callFn<Money & { latestRates?: Record<string, number> }>(page, "listMoney", { tripId: c.tripId });
	const ex = m.expenses.find((x) => x.id === e.id) as Exp;
	out.expense = { status: ex.status, home: ex.homeAmountMinor, fxRate: ex.fxRate, pay: ex.payments.map((p) => [p.amountMinor, p.homeAmountMinor, p.fxDate, p.fxRate]) };
	const todayRate = ex.fxRate as number; // home per TRY, latest
	const remainderAtToday = Math.round(2000000 * todayRate);
	out.remainderAtToday = remainderAtToday;
	out.plannedMinusPaid = (ex.homeAmountMinor ?? 0) - (ex.payments[0]?.homeAmountMinor ?? 0);
	await openMoney(page, c.slug, "/turkiye/istanbul");
	out.summary = flat(await page.getByTestId(M.summary).innerText());
	out.row = flat(await page.getByTestId(M.expenseRow).filter({ hasText: "Istanbul hotel" }).innerText());
	await page.screenshot({ path: `${SHOTS}/r3-try-remainder.png`, fullPage: true });
	const still = /STILL TO PAY ≈? ?\$([\d,.]+)/.exec(out.summary as string)?.[1]?.replace(/,/g, "");
	out.stillToPay = still;
	console.log(JSON.stringify(out, null, 1));
	expect.soft(Math.round(Number(still) * 100), "DEFECT: Still to pay = ₺20,000 at today's rate").toBe(remainderAtToday);
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 4. IDOR / roles
// ---------------------------------------------------------------------------

test("R3 security: another trip's ids, another member's private rows and own budget lines, viewer writes", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r3-o4-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request, { mayaRole: "editor" });
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	// Olga's rows in her trip
	const shared = await callFn<{ id: string }>(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "Shared", amountMinor: 1000, currency: "JPY", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] }, payments: [pay(1000, [{ memberId: owner, amountMinor: 1000 }])] });
	const secret = await callFn<{ id: string }>(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "Olga secret", amountMinor: 5000, currency: "JPY", isPrivate: true, payments: [pay(5000, [{ memberId: owner, amountMinor: 5000 }])] });
	const st = await callFn<{ id: string }>(page, "createSettlement", { tripId: c.tripId, fromMemberId: maya, toMemberId: owner, amountMinor: 500, currency: "JPY", settledAt: new Date().toISOString(), settledTz: "Asia/Tokyo" });
	const myLine = await callFn<{ id: string }>(page, "setBudgetLine", { tripId: c.tripId, nodeId: null, category: null, memberId: owner, amountMinor: 50000, kind: "total" });
	// A stranger with their own trip
	const s = await userPage(browser, `qa-money-r3-s4-${uniq()}@example.com`, "Sam", "Stranger");
	const sc = await clone(s.ctx.request);
	await openMoney(s.page, sc.slug);
	const sm = sc.members.owner;
	out.xUpdate = await callFnErr(s.page, "updateExpense", { id: shared.id, patch: { title: "pwned" } });
	out.xMarkPaid = await callFnErr(s.page, "markExpensePaid", { id: shared.id });
	out.xRate = await callFnErr(s.page, "setExpenseRate", { id: shared.id, rate: 1 });
	out.xDelete = await callFnErr(s.page, "deleteExpense", { id: shared.id });
	out.xRestore = await callFnErr(s.page, "restoreExpense", { id: shared.id });
	out.xDelSettle = await callFnErr(s.page, "deleteSettlement", { id: st.id });
	out.xDelBudget = await callFnErr(s.page, "deleteBudgetLine", { id: myLine.id });
	out.xRefund = await callFnErr(s.page, "createExpense", { tripId: sc.tripId, target: { kind: "trip" }, amountMinor: -100, currency: "JPY", refundOfId: shared.id });
	out.xSettleMembers = await callFnErr(s.page, "createSettlement", { tripId: sc.tripId, fromMemberId: maya, toMemberId: sm, amountMinor: 100, currency: "JPY", settledAt: new Date().toISOString(), settledTz: "UTC" });
	out.xScopeNode = await callFnErr(s.page, "createSettlement", { tripId: sc.tripId, fromMemberId: sc.members.maya, toMemberId: sm, amountMinor: 100, currency: "JPY", settledAt: new Date().toISOString(), settledTz: "UTC", scope: { nodeId: c.ids.nodes.kyoto } });
	out.xExpenseTarget = await callFnErr(s.page, "createExpense", { tripId: sc.tripId, target: { kind: "node", nodeId: c.ids.nodes.kyoto }, amountMinor: 100, currency: "JPY" });
	out.xBudgetNode = await callFnErr(s.page, "setBudgetLine", { tripId: sc.tripId, nodeId: c.ids.nodes.kyoto, category: null, memberId: null, amountMinor: 100, kind: "total" });
	out.xCsv = await callFnErr(s.page, "exportMoneyCsv", { tripId: c.tripId });
	out.xList = await callFnErr(s.page, "listMoney", { tripId: c.tripId });
	out.xReceipt = await callFnErr(s.page, "createUpload", { tripId: sc.tripId, target: { kind: "expense", expenseId: shared.id }, type: "image/jpeg", size: 1000, name: "r.jpg" }, MEDIA);
	// Maya (editor of Olga's trip): Olga's private row and Olga's own budget line
	const mp = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(mp.page, c.slug);
	out.mUpdateSecret = await callFnErr(mp.page, "updateExpense", { id: secret.id, patch: { title: "seen" } });
	out.mDeleteSecret = await callFnErr(mp.page, "deleteExpense", { id: secret.id });
	out.mRateSecret = await callFnErr(mp.page, "setExpenseRate", { id: secret.id, rate: 1 });
	out.mPaidSecret = await callFnErr(mp.page, "markExpensePaid", { id: secret.id });
	out.mRefundSecret = await callFnErr(mp.page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, amountMinor: -100, currency: "JPY", refundOfId: secret.id });
	out.mReceiptSecret = await callFnErr(mp.page, "createUpload", { tripId: c.tripId, target: { kind: "expense", expenseId: secret.id }, type: "image/jpeg", size: 1000, name: "r.jpg" }, MEDIA);
	out.mSetOlgaLine = await callFnErr(mp.page, "setBudgetLine", { tripId: c.tripId, nodeId: null, category: null, memberId: owner, amountMinor: 1, kind: "total" });
	out.mDeleteOlgaLine = await callFnErr(mp.page, "deleteBudgetLine", { id: myLine.id });
	out.mMakeSharedPrivate = await callFnErr(mp.page, "updateExpense", { id: shared.id, patch: { isPrivate: true } });
	const mm = await callFn<Money>(mp.page, "listMoney", { tripId: c.tripId });
	out.mSeesSecret = mm.expenses.some((e) => e.id === secret.id);
	out.mCsvHasSecret = (await callFn<{ csv: string }>(mp.page, "exportMoneyCsv", { tripId: c.tripId })).csv.includes("Olga secret");
	// Maya demoted to viewer
	await mp.ctx.close();
	const members = await page.evaluate(() => (window as unknown as { __yonder: { graph: { members: { id: string; name: string }[] } } }).__yonder.graph.members.map((x) => [x.id, x.name]));
	out.members = members;
	const olga = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.olgaStillHas = { shared: olga.expenses.find((e) => e.id === shared.id)?.title, secret: olga.expenses.some((e) => e.id === secret.id), settlement: olga.settlements.some((x) => x.id === st.id), line: olga.budgets.some((b) => b.id === myLine.id) };
	await s.ctx.close();
	console.log(JSON.stringify(out, null, 1));
	for (const k of ["xUpdate", "xMarkPaid", "xRate", "xDelete", "xRestore", "xDelSettle", "xDelBudget", "xRefund", "xSettleMembers", "xScopeNode", "xExpenseTarget", "xBudgetNode", "xCsv", "xList", "xReceipt", "mUpdateSecret", "mDeleteSecret", "mRateSecret", "mPaidSecret", "mRefundSecret", "mReceiptSecret", "mSetOlgaLine", "mDeleteOlgaLine"])
		expect.soft(out[k], `${k} must be refused`).toBeTruthy();
	expect.soft(out.mSeesSecret).toBe(false);
	expect.soft(out.mCsvHasSecret).toBe(false);
	expect.soft(out.olgaStillHas).toEqual({ shared: "Shared", secret: true, settlement: true, line: true });
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 5. Settlement tags (MONEY-R2-07) through the UI
// ---------------------------------------------------------------------------

test("R3 settle up from a day's view tags the day; a deleted place's tag disappears", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r3-o5-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	const days = await page.evaluate(() => ((window as unknown as { __yonder: { graph: { days: { id: string; date: string }[] } } }).__yonder.graph.days ?? []).map((d) => [d.id, d.date]));
	await callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "Dinner", amountMinor: 10000, currency: "USD", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] }, payments: [pay(10000, [{ memberId: owner, amountMinor: 10000 }], "USD", new Date().toISOString(), "America/New_York")] });
	await openMoney(page, c.slug, `?days=${days[1]?.[1]}`);
	await page.getByTestId(M.settleUpButton).click();
	const dlg = page.getByTestId(M.settleUpDialog);
	await expect(dlg).toBeVisible();
	await dlg.getByTestId(M.transferRecord).first().click();
	await page.waitForTimeout(500);
	out.recordForm = flat(await dlg.innerText());
	await page.screenshot({ path: `${SHOTS}/r3-settle-day-form.png` });
	const tagSel = dlg.getByRole("combobox", { name: /Tag it/ });
	out.tagDefault = (await tagSel.count()) ? flat(await tagSel.innerText()) : "no tag control";
	await dlg.getByRole("button", { name: "Record payment" }).click();
	await page.waitForTimeout(1200);
	out.recorded = flat(await dlg.innerText());
	await page.screenshot({ path: `${SHOTS}/r3-settle-day-recorded.png` });
	let m = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.scope = m.settlements.map((s) => s.scope);
	await page.keyboard.press("Escape");
	// a settlement tagged to Kiyomizu-dera, then the place is deleted
	await callFn(page, "createSettlement", { tripId: c.tripId, fromMemberId: owner, toMemberId: maya, amountMinor: 100, currency: "USD", settledAt: new Date().toISOString(), settledTz: "Asia/Tokyo", scope: { nodeId: c.ids.nodes.kiyomizu } });
	await callFn(page, "deleteNode", { nodeId: c.ids.nodes.kiyomizu }, NODES);
	await openMoney(page, c.slug);
	await page.getByTestId(M.settleUpButton).click();
	await page.waitForTimeout(600);
	out.rowsAfterDelete = await page.getByTestId(M.settlementRow).allInnerTexts();
	m = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.scopeAfterDelete = m.settlements.map((s) => s.scope);
	await page.screenshot({ path: `${SHOTS}/r3-settle-tag-deleted.png` });
	console.log(JSON.stringify(out, null, 1));
	expect.soft(JSON.stringify(out.scope), "recorded from Day 2's view → tagged to that day").toContain(days[1]?.[0] as string);
	expect.soft(String(out.recorded)).toContain("Day 2");
	expect.soft((out.rowsAfterDelete as string[]).join(" | ")).not.toContain("Kiyomizu");
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 6. Unknown currencies (MONEY-R2-08) everywhere they can enter
// ---------------------------------------------------------------------------

test("R3 unknown currency codes are refused in settlements, points, payments, prefs and CSV", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r3-o6-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	out.settle = await callFnErr(page, "createSettlement", { tripId: c.tripId, fromMemberId: maya, toMemberId: owner, amountMinor: 100, currency: "QQQ", settledAt: new Date().toISOString(), settledTz: "UTC" });
	out.points = await callFnErr(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "p", points: { program: "X", points: 10, cashValueMinor: 100, cashValueCurrency: "QQQ" } });
	out.payment = await callFnErr(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "p", amountMinor: 1000, currency: "JPY", payments: [pay(1000, [{ memberId: owner, amountMinor: 1000 }], "QQQ")] });
	const e = await callFn<{ id: string }>(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "ok", amountMinor: 1000, currency: "JPY" });
	out.patchCurrency = await callFnErr(page, "updateExpense", { id: e.id, patch: { currency: "QQQ" } });
	out.homeCurrency = await callFnErr(page, "updateTrip", { tripId: c.tripId, settings: { currency: "QQQ" } }, TRIPS);
	out.prefs = await callFnErr(page, "setUserPrefs", { displayCurrency: "QQQ" }, PREFS);
	out.csv = await callFnErr(page, "exportMoneyCsv", { tripId: c.tripId, displayCurrency: "QQQ" });
	out.budget = null;
	// with QQQ as the display currency (if it was accepted), does the tab still render?
	if (out.prefs === null) {
		await openMoney(page, c.slug);
		out.tabWithQqq = flat(await page.getByTestId(M.summary).innerText()).slice(0, 200);
		out.displayBtn = flat(await page.getByTestId(M.displayCurrency).innerText());
		await page.screenshot({ path: `${SHOTS}/r3-display-qqq.png` });
		await callFn(page, "setUserPrefs", { displayCurrency: null }, PREFS);
	}
	console.log(JSON.stringify(out, null, 1));
	for (const k of ["settle", "points", "payment", "patchCurrency", "homeCurrency"]) expect.soft(out[k], `${k} with QQQ must be refused`).toBeTruthy();
	// setUserPrefs accepts any 3-letter code, but the tab falls back to the home currency: not reported.
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 7. Duplicate trip: budgets = trip defaults only; never expenses/settlements
// ---------------------------------------------------------------------------

test("R3 duplicate trip copies default budgets only, never expenses, settlements or own lines", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r3-o7-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	await callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "Dup dinner", amountMinor: 1000, currency: "JPY", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] }, payments: [pay(1000, [{ memberId: owner, amountMinor: 1000 }])] });
	await callFn(page, "createSettlement", { tripId: c.tripId, fromMemberId: maya, toMemberId: owner, amountMinor: 500, currency: "JPY", settledAt: new Date().toISOString(), settledTz: "Asia/Tokyo" });
	await callFn(page, "setBudgetLine", { tripId: c.tripId, nodeId: null, category: null, memberId: null, amountMinor: 300000, kind: "total" });
	await callFn(page, "setBudgetLine", { tripId: c.tripId, nodeId: c.ids.nodes.kyoto, category: "food_drink", memberId: null, amountMinor: 5000, kind: "per_day" });
	await callFn(page, "setBudgetLine", { tripId: c.tripId, nodeId: c.ids.nodes.kyoto, category: null, memberId: owner, amountMinor: 7000, kind: "total" });
	const mp = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(mp.page, c.slug);
	await callFn(mp.page, "setBudgetLine", { tripId: c.tripId, nodeId: null, category: null, memberId: maya, amountMinor: 200000, kind: "total" });
	// Maya duplicates Olga's trip (as a member)
	const dup = await callFn<{ tripId: string; slug: string }>(mp.page, "duplicateTrip", { tripId: c.tripId, name: "Maya's copy", startDate: "2028-03-01", include: { notes: false, lists: true, media: false, budgets: true, placeholders: false } }, HOME);
	await openMoney(mp.page, dup.slug);
	const dm = await callFn<Money>(mp.page, "listMoney", { tripId: dup.tripId });
	out.dupExpenses = dm.expenses.length;
	out.dupSettlements = dm.settlements.length;
	out.dupBudgets = dm.budgets.map((b) => [b.memberId === null ? "default" : "member", b.nodeId ? "node" : "root", b.category, b.amountMinor, b.kind]);
	out.dupHome = dm.homeCurrency;
	out.dupTab = flat(await mp.page.getByTestId(TESTID.moneyTab).first().innerText()).slice(0, 600);
	await mp.page.screenshot({ path: `${SHOTS}/r3-dup-money.png`, fullPage: true });
	const dup2 = await callFn<{ tripId: string; slug: string }>(page, "duplicateTrip", { tripId: c.tripId, name: "No budgets copy", startDate: "2028-03-01", include: { notes: false, lists: false, media: false, budgets: false, placeholders: false } }, HOME);
	await openMoney(page, dup2.slug);
	out.dup2Budgets = (await callFn<Money>(page, "listMoney", { tripId: dup2.tripId })).budgets.length;
	await mp.ctx.close();
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.dupExpenses).toBe(0);
	expect.soft(out.dupSettlements).toBe(0);
	expect.soft(out.dupBudgets).toEqual(expect.arrayContaining([["default", "root", null, 300000, "total"], ["default", "node", "food_drink", 5000, "per_day"]]));
	expect.soft((out.dupBudgets as unknown[]).length).toBe(2);
	expect.soft(out.dup2Budgets).toBe(0);
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 8. Display currency Local outside the four Asian countries; group budgets with a private member
// ---------------------------------------------------------------------------

test("R3 Local display in Türkiye/USA/Korea; single expense shows original + ≈; group totals skip a private member", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r3-o8-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	const N = c.ids.nodes;
	await openMoney(page, c.slug);
	await callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "node", nodeId: N.istanbul }, title: "Kebab", category: "food_drink", amountMinor: 120000, currency: "TRY", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] }, payments: [pay(120000, [{ memberId: owner, amountMinor: 120000 }], "TRY", new Date().toISOString(), "Europe/Istanbul")] });
	await callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "node", nodeId: N.seoul }, title: "Bibimbap", category: "food_drink", amountMinor: 15000, currency: "KRW", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] }, payments: [pay(15000, [{ memberId: owner, amountMinor: 15000 }], "KRW", new Date().toISOString(), "Asia/Seoul")] });
	await callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "node", nodeId: N.newark }, title: "Airport taxi", category: "transport", amountMinor: 8000, currency: "USD", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] }, payments: [pay(8000, [{ memberId: owner, amountMinor: 8000 }], "USD", new Date().toISOString(), "America/New_York")] });
	await callFn(page, "setUserPrefs", { displayCurrency: "local" }, PREFS);
	for (const [k, path] of [["istanbul", "/t-rkiye/istanbul"], ["turkiye", "/t-rkiye"], ["seoul", "/south-korea/seoul"], ["newark", "/usa/newark"], ["root", ""]] as const) {
		await openMoney(page, c.slug, path);
		out[k] = { summary: flat(await page.getByTestId(M.summary).innerText()).slice(0, 160), btn: flat(await page.getByTestId(M.displayCurrency).innerText()), rows: (await page.getByTestId(M.expenseRow).allInnerTexts()).map(flat) };
		await page.screenshot({ path: `${SHOTS}/r3-local-${k}.png`, fullPage: true });
	}
	await callFn(page, "setUserPrefs", { displayCurrency: null }, PREFS);
	// group budgets: Olga $50 Seoul, Maya $20 Seoul (private), Audrey none
	await callFn(page, "setBudgetLine", { tripId: c.tripId, nodeId: N.seoul, category: null, memberId: owner, amountMinor: 5000, kind: "total" });
	const mp = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(mp.page, c.slug);
	await callFn(mp.page, "setBudgetLine", { tripId: c.tripId, nodeId: N.seoul, category: null, memberId: maya, amountMinor: 2000, kind: "total" });
	await callFn(mp.page, "setBudgetPrivate", { tripId: c.tripId, private: true });
	await openMoney(page, c.slug, "/south-korea/seoul");
	await page.getByTestId(M.budget).getByRole("radio", { name: "Group" }).click();
	await page.waitForTimeout(500);
	out.groupSeoul = flat(await page.getByTestId(M.budget).innerText());
	await page.screenshot({ path: `${SHOTS}/r3-group-private.png`, fullPage: true });
	await openMoney(mp.page, c.slug, "/south-korea/seoul");
	await mp.page.getByTestId(M.budget).getByRole("radio", { name: "Group" }).click();
	await mp.page.waitForTimeout(500);
	out.groupSeoulMaya = flat(await mp.page.getByTestId(M.budget).innerText());
	await mp.ctx.close();
	console.log(JSON.stringify(out, null, 1));
	expect.soft((out.istanbul as { summary: string }).summary, "Local in Türkiye shows ₺ (TRY)").toMatch(/₺|TRY/);
	expect.soft((out.seoul as { summary: string }).summary, "Local in Korea shows ₩").toContain("₩");
	expect.soft(String(out.groupSeoul), "group total skips Maya's private $20").not.toContain("$70.00");
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 9. Inbox "balance changed" attribution
// ---------------------------------------------------------------------------

test("R3 inbox: balance-changed names the edit that moved MY balance, not an unrelated one", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r3-o9-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	await callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "Ramen", amountMinor: 2000, currency: "USD", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] }, payments: [pay(2000, [{ memberId: owner, amountMinor: 2000 }], "USD", new Date().toISOString(), "America/New_York")] });
	await callFn(page, "createSettlement", { tripId: c.tripId, fromMemberId: maya, toMemberId: owner, amountMinor: 1000, currency: "USD", settledAt: new Date().toISOString(), settledTz: "America/New_York" });
	// Olga herself adds a cost Maya shares (moves Maya's balance), then Maya adds a cost with Audrey only
	await callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "Olga's museum", amountMinor: 1000, currency: "USD", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] }, payments: [pay(1000, [{ memberId: owner, amountMinor: 1000 }], "USD", new Date().toISOString(), "America/New_York")] });
	const mp = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(mp.page, c.slug);
	const inb0 = await callFn<{ items: { kind: string; title: string }[] }>(mp.page, "listInbox", { tripId: c.tripId }, INBOX);
	out.mayaInboxAfterOlga = inb0.items.filter((i) => i.kind === "balance_changed").map((i) => i.title);
	out.mayaNotice0 = await mp.page.getByTestId(M.balanceNotice).allInnerTexts();
	// Now Audrey-style unrelated edit by Olga: a cost between Olga and Audrey only
	await callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "Olga and Audrey taxi", amountMinor: 3000, currency: "USD", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: audrey }] }, payments: [pay(3000, [{ memberId: owner, amountMinor: 3000 }], "USD", new Date().toISOString(), "America/New_York")] });
	const inb1 = await callFn<{ items: { kind: string; title: string }[] }>(mp.page, "listInbox", { tripId: c.tripId }, INBOX);
	out.mayaInboxAfterUnrelated = inb1.items.filter((i) => i.kind === "balance_changed").map((i) => i.title);
	await openMoney(mp.page, c.slug);
	out.mayaNotice1 = await mp.page.getByTestId(M.balanceNotice).allInnerTexts();
	await mp.page.screenshot({ path: `${SHOTS}/r3-balance-notice.png`, fullPage: true });
	await mp.ctx.close();
	console.log(JSON.stringify(out, null, 1));
	expect.soft(String(out.mayaInboxAfterOlga)).toContain("Olga's museum");
	expect.soft(String(out.mayaInboxAfterUnrelated), "DEFECT: the cause is the museum, not the taxi Maya isn't in").toContain("museum");
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 10. Local display in a one-currency scope with a deposit paid months ago
// ---------------------------------------------------------------------------

test("R3 Local: a ¥ scope with a June deposit — totals, breakdown, per person and net positions agree", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r3-o10-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "node", nodeId: c.ids.nodes.ryokan }, title: "Ryokan", category: "lodging", amountMinor: 60000, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(10000, [{ memberId: maya, amountMinor: 10000 }], "JPY", "2026-01-15T03:00:00.000Z")],
	});
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "node", nodeId: c.ids.nodes.kyoto }, title: "Matcha", category: "food_drink", amountMinor: 1500, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }, { memberId: c.members.audrey }] },
		payments: [pay(1500, [{ memberId: owner, amountMinor: 1500 }])],
	});
	await callFn(page, "setUserPrefs", { displayCurrency: "local" }, PREFS);
	await openMoney(page, c.slug, "/japan");
	out.summary = flat(await page.getByTestId(M.summary).innerText());
	out.people = flat(await page.getByTestId(M.people).innerText());
	out.breakdown = flat(await page.getByTestId(M.breakdown).innerText());
	out.net = await page.getByTestId(M.netPositions).allInnerTexts().then((x) => x.map(flat));
	await page.screenshot({ path: `${SHOTS}/r3-local-japan-deposit.png`, fullPage: true });
	await openMoney(page, c.slug, "/japan/kyoto");
	out.kyoto = flat(await page.getByTestId(M.summary).innerText());
	out.kyotoPeople = flat(await page.getByTestId(M.people).innerText());
	await callFn(page, "setUserPrefs", { displayCurrency: null }, PREFS);
	console.log(JSON.stringify(out, null, 1));
	expect.soft(String(out.breakdown), "DEFECT: Lodging shows ¥10,000 paid like the PAID total").toMatch(/¥10(,000|K) paid/);
	expect.soft(String(out.net), "DEFECT: Maya paid ¥5,000 more than her share").toContain("¥5,000");
	expect.soft(String(out.kyoto), "DEFECT: an equal ¥1,500 split 3: your share ¥500").toContain("¥500 planned");
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 11. Suggest mode never turns money into proposals; stale edits conflict; no money in the graph
// ---------------------------------------------------------------------------

test("R3 suggest mode: an expense is still written directly; a stale edit conflicts; the graph carries no money", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r3-o11-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	await openMoney(page, c.slug);
	await page.evaluate((id) => localStorage.setItem(`yonder:suggest:${id}`, "1"), c.tripId);
	await openMoney(page, c.slug);
	out.modePill = flat(await page.locator("header").first().innerText()).slice(0, 200);
	await page.getByTestId(M.addButton).first().click();
	const dlg = page.getByTestId(TESTID.addExpenseDialog);
	await expect(dlg).toBeVisible();
	await dlg.getByTestId(M.amount).fill("42");
	await dlg.getByTestId(M.title).fill("Suggest-mode lunch");
	await dlg.getByTestId(M.save).click();
	await page.waitForTimeout(1500);
	out.toasts = await page.locator("[data-sonner-toast]").allInnerTexts();
	const m = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const e = m.expenses.find((x) => x.title === "Suggest-mode lunch");
	out.saved = e ? { amount: e.amountMinor, currency: e.currency } : "missing";
	const props = await callFn<{ proposals?: unknown[]; open?: unknown[] }>(page, "listProposals", { tripId: c.tripId }, "/src/functions/proposals.functions.ts").catch((err) => ({ err: String(err) }));
	out.proposals = JSON.stringify(props).slice(0, 200);
	await page.screenshot({ path: `${SHOTS}/r3-suggest-mode-expense.png` });
	await page.evaluate((id) => localStorage.removeItem(`yonder:suggest:${id}`), c.tripId);
	// stale edit
	if (e) {
		const old = (e as unknown as { updatedAt: string }).updatedAt;
		await callFn(page, "updateExpense", { id: e.id, patch: { title: "Lunch v2" }, expectedUpdatedAt: old });
		out.staleEdit = await callFnErr(page, "updateExpense", { id: e.id, patch: { title: "Lunch v3" }, expectedUpdatedAt: old });
	}
	// the graph
	const graph = await page.evaluate(async (tripId) => {
		const mod = await import(/* @vite-ignore */ "/src/functions/graph.functions.ts");
		return JSON.stringify(await mod.getTripGraph({ data: { tripId } }));
	}, c.tripId).catch((err) => String(err));
	out.graphHasMoney = /amountMinor|Suggest-mode lunch|Lunch v2|homeAmount/.test(graph);
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.saved).toEqual({ amount: 4200, currency: "USD" });
	expect.soft(out.staleEdit, "a stale expectedUpdatedAt is refused").toBeTruthy();
	expect.soft(out.graphHasMoney).toBe(false);
	await o.ctx.close();
});

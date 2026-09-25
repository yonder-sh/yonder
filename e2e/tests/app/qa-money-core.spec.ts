/**
 * QA I2 "money" verifier (ADDENDUM §6–§7.3, EXTENSIONS §8): real server
 * functions + the Money tab on a fresh demo clone. Self-contained: logs in
 * through the API itself (never touches e2e/.auth), so it can run against an
 * isolated dev server: APP_URL=http://localhost:5350.
 */
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { MONEY_TESTID as M } from "../../../src/features/money/testids";
import { TESTID } from "../../../src/lib/testids";

const BASE = process.env.APP_URL ?? "http://localhost:5350";
const SHOTS = process.env.QA_SHOTS ?? "/tmp/qa-money-shots";
const MONEY = "/src/features/money/money.functions.ts";

export async function login(request: APIRequestContext, email: string, first = "Qa", last = "Tester") {
	const H = { Origin: BASE, "Content-Type": "application/json" };
	const send = await request.post("/api/auth/email-otp/send-verification-otp", {
		data: { email, type: "sign-in" },
		headers: H,
	});
	expect(send.ok(), await send.text()).toBeTruthy();
	const sign = await request.post("/api/auth/sign-in/email-otp", { data: { email, otp: "000000" }, headers: H });
	expect(sign.ok(), await sign.text()).toBeTruthy();
	const s = (await (await request.get("/api/auth/get-session")).json()) as { user?: { firstName?: string; lastName?: string } } | null;
	if (!s?.user?.firstName?.trim() || !s.user.lastName?.trim()) {
		const upd = await request.post("/api/auth/update-user", { data: { firstName: first, lastName: last }, headers: H });
		expect(upd.ok()).toBeTruthy();
	}
}

export async function userPage(browser: Browser, email: string, first?: string, last?: string) {
	const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
	await login(ctx.request, email, first, last);
	return { ctx, page: await ctx.newPage() };
}

export async function callFn<T>(page: Page, fn: string, data: unknown, module = MONEY): Promise<T> {
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

export async function callFnErr(page: Page, fn: string, data: unknown, module = MONEY): Promise<string | null> {
	try {
		await callFn(page, fn, data, module);
		return null;
	} catch (e) {
		return (e as Error).message;
	}
}

export type Clone = {
	tripId: string;
	slug: string;
	shareTokens: { editor: string; viewer: string };
	ids: { items: Record<string, string>; days: Record<string, string>; nodes: Record<string, string>; legs: Record<string, string> };
	members: { owner: string; maya: string | null; audrey: string };
};

export async function clone(request: APIRequestContext, opts: Record<string, unknown> = {}): Promise<Clone> {
	const res = await request.post("/api/test/fixture", {
		headers: { Origin: BASE },
		...(Object.keys(opts).length ? { data: opts } : {}),
	});
	expect(res.ok(), await res.text()).toBeTruthy();
	return (await res.json()) as Clone;
}

export async function waitLive(page: Page) {
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(async () => {
			const s = await page.getByTestId("connection-pill").evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
			return s.length === 0 || s.includes("live") ? "live" : s.join(",");
		}, { timeout: 30_000 })
		.toBe("live");
}

export async function openMoney(page: Page, slug: string, path = "") {
	await page.goto(`/t/${slug}${path}${path.includes("?") ? "&" : "?"}tab=money`);
	await waitLive(page);
	await expect(page.getByTestId(TESTID.moneyTab).first()).toBeVisible();
}

type Exp = {
	id: string;
	title: string;
	amountMinor: number | null;
	currency: string | null;
	homeAmountMinor: number | null;
	fxRate: number | null;
	fxDate: string | null;
	fxSource: string | null;
	status: string;
	splitMode: string;
	shares: { memberId: string; amountMinor: number | null }[];
	payments: { id: string; amountMinor: number; homeAmountMinor: number | null; fxDate: string | null; fxRate: number | null; paidAt: string; payers: { memberId: string; amountMinor: number }[] }[];
	lines: unknown[];
	target: unknown;
	category: string;
	isPrivate: boolean;
};
type Money = { homeCurrency: string; expenses: Exp[]; settlements: { id: string; homeAmountMinor: number | null; netAfter: Record<string, number> | null }[]; latestRates?: Record<string, number>; budgets: unknown[] };

const pay = (amountMinor: number, payers: { memberId: string; amountMinor: number }[], paidAt = new Date().toISOString(), currency = "JPY", paidTz = "Asia/Tokyo") => ({
	paidAt,
	paidTz,
	currency,
	amountMinor,
	payers,
});


test("API: splits, itemize + fee, pooled payers, refund, deposits at their own dates, VND/TWD", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dev@example.com", "Dev", "User");
	const c = await clone(ctx.request);
	await openMoney(page, c.slug);
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	const results: Record<string, unknown> = {};

	// ¥1000 / 3 paid by Maya
	const e1 = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Ramen",
		amountMinor: 1000,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }, { memberId: audrey }] },
		payments: [pay(1000, [{ memberId: maya, amountMinor: 1000 }])],
	});
	// exact that doesn't add up
	results.exactBad = await callFnErr(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Bad exact",
		amountMinor: 1000,
		currency: "JPY",
		split: { mode: "exact", shares: [{ memberId: owner, amountMinor: 500 }, { memberId: maya, amountMinor: 400 }] },
	});
	// exact OK
	const e2 = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Exact taxi",
		amountMinor: 3000,
		currency: "JPY",
		split: { mode: "exact", shares: [{ memberId: owner, amountMinor: 2000 }, { memberId: maya, amountMinor: 1000 }] },
		payments: [pay(3000, [{ memberId: owner, amountMinor: 3000 }])],
	});
	// itemized, 10% service, pooled payers
	const e3 = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Izakaya",
		amountMinor: 6600,
		currency: "JPY",
		lines: [
			{ label: "Sashimi", amountMinor: 3000, memberIds: [owner] },
			{ label: "Tempura", amountMinor: 2000, memberIds: [maya] },
			{ label: "Sake", amountMinor: 1000, memberIds: [owner, maya] },
		],
		fees: [{ label: "Service", kind: "percent", percent: 10 }],
		payments: [pay(6600, [{ memberId: owner, amountMinor: 3300 }, { memberId: audrey, amountMinor: 3300 }])],
	});
	// refund of the izakaya
	const e4 = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		amountMinor: -660,
		currency: "JPY",
		refundOfId: e3.id,
		payments: [pay(-660, [{ memberId: owner, amountMinor: -660 }])],
	});
	// edit the refund's amount the way the editor does (no split in the patch)
	let money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const refund = money.expenses.find((e) => e.id === e4.id) as Exp;
	results.refundShares = refund.shares;
	results.refundTitle = refund.title;
	results.refundEdit = await callFnErr(page, "updateExpense", {
		id: e4.id,
		patch: {
			amountMinor: -1320,
			currency: "JPY",
			payments: [{ ...pay(-1320, [{ memberId: owner, amountMinor: -1320 }]), id: refund.payments[0]?.id }],
		},
	});
	// deposit in June, rest in September
	const e5 = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Ryokan",
		category: "lodging",
		amountMinor: 60000,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(10000, [{ memberId: owner, amountMinor: 10000 }], "2026-06-15T03:00:00.000Z")],
	});
	money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const ry1 = money.expenses.find((e) => e.id === e5.id) as Exp;
	results.ryokanPartial = { status: ry1.status, pay: ry1.payments.map((p) => [p.fxDate, p.fxRate, p.homeAmountMinor]) };
	await openMoney(page, c.slug);
	await page.screenshot({ path: `${SHOTS}/core-root-after-deposit.png`, fullPage: true });
	const ryRow = page.getByTestId(M.expenseRow).filter({ hasText: "Ryokan" });
	results.ryokanRowText = await ryRow.innerText();
	await callFn(page, "markExpensePaid", { id: e5.id, payment: { paidAt: "2026-09-20T03:00:00.000Z", paidTz: "Asia/Tokyo" } });
	money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const ry2 = money.expenses.find((e) => e.id === e5.id) as Exp;
	results.ryokanPaid = { status: ry2.status, planned: [ry2.homeAmountMinor, ry2.fxDate, ry2.fxRate], pay: ry2.payments.map((p) => [p.amountMinor, p.fxDate, p.fxRate, p.homeAmountMinor]) };

	// VND + TWD + KRW
	for (const [cur, amt] of [["VND", 250000], ["TWD", 32050], ["KRW", 15000], ["CAD", 4599], ["TRY", 12000]] as const) {
		const r = await callFn<{ id: string }>(page, "createExpense", {
			tripId: c.tripId,
			target: { kind: "trip" },
			title: `In ${cur}`,
			amountMinor: amt,
			currency: cur,
			split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
			payments: [pay(amt, [{ memberId: owner, amountMinor: amt }], new Date().toISOString(), cur, "UTC")],
		});
		const m = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
		const x = m.expenses.find((e) => e.id === r.id) as Exp;
		results[`fx_${cur}`] = { home: x.homeAmountMinor, rate: x.fxRate, src: x.fxSource, pay: x.payments[0]?.homeAmountMinor };
	}
	money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	results.rates = { JPY: money.latestRates?.JPY, VND: money.latestRates?.VND, TWD: money.latestRates?.TWD, CAD: money.latestRates?.CAD };
	results.e1 = money.expenses.find((e) => e.id === e1.id)?.shares;
	results.e2 = money.expenses.find((e) => e.id === e2.id)?.shares;
	results.e3 = money.expenses.find((e) => e.id === e3.id)?.payments[0]?.payers;
	// ---- expectations (soft: every one is reported) ----
	expect.soft(results.exactBad).toContain("Exact amounts must add up");
	expect.soft((results.refundShares as { amountMinor: number }[]).map((x) => x.amountMinor).sort((a, b) => a - b)).toEqual([-385, -275]);
	expect.soft(results.refundTitle, "refund title follows the original").toContain("Izakaya");
	expect.soft(results.refundEdit, "editing a refund's amount must work (QA money: DEFECT)").toBeNull();
	expect.soft((results.ryokanPartial as { status: string }).status).toBe("partial");
	expect.soft(results.ryokanRowText).toContain("¥10K of ¥60K");
	expect.soft((results.ryokanPaid as { pay: unknown[][] }).pay.map((x) => x[1])).toEqual(["2026-06-15", "2026-09-20"]);
	for (const cur of ["VND", "TWD", "KRW", "CAD", "TRY"]) expect.soft((results[`fx_${cur}`] as { src: string }).src).toBe("currency-api");
	console.log(JSON.stringify(results, null, 1));

	await openMoney(page, c.slug);
	await page.screenshot({ path: `${SHOTS}/core-root.png`, fullPage: true });
	const rows = await page.getByTestId(M.expenseRow).allInnerTexts();
	console.log("ROWS", JSON.stringify(rows, null, 1));
	console.log("PEOPLE", await page.getByTestId(M.people).innerText());
	console.log("BAL", await page.getByTestId(M.balances).innerText());
	console.log("SUMMARY", await page.getByTestId(M.summary).innerText());
	await ctx.close();
});

test("UI: fast entry defaults by country (JP/KR/TW), TWD display, Local display", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dev@example.com", "Dev", "User");
	const c = await clone(ctx.request);
	const out: Record<string, unknown> = {};
	for (const [path, amt] of [["/taiwan/taipei", "320"], ["/south-korea/seoul", "15000"], ["/japan/kyoto", "1200"]] as const) {
		await openMoney(page, c.slug, path);
		await page.getByTestId(M.addButton).first().click();
		const dialog = page.getByTestId(TESTID.addExpenseDialog);
		await expect(dialog).toBeVisible();
		out[`${path}:currency`] = await dialog.getByTestId(M.currency).innerText();
		await dialog.getByTestId(M.amount).fill(amt);
		await dialog.getByTestId(M.title).fill(`Snack ${path}`);
		await page.waitForTimeout(300);
		out[`${path}:converted`] = await dialog.getByTestId(M.converted).innerText().catch(() => null);
		out[`${path}:status`] = await dialog.getByTestId(M.status).innerText();
		await page.screenshot({ path: `${SHOTS}/ui-add${path.replace(/\//g, "_")}.png` });
		await dialog.getByTestId(M.save).click();
		await expect(dialog).toBeHidden();
		const row = page.getByTestId(M.expenseRow).filter({ hasText: `Snack ${path}` });
		await expect(row).toBeVisible();
		out[`${path}:row`] = await row.innerText();
	}
	// Local display inside Taiwan, Korea, Japan and at the root
	await openMoney(page, c.slug, "/taiwan/taipei");
	await page.getByTestId(M.displayCurrency).click();
	await page.getByRole("option", { name: /Local/ }).click();
	await page.waitForTimeout(800);
	out.localTaipei = { btn: await page.getByTestId(M.displayCurrency).innerText(), summary: await page.getByTestId(M.summary).innerText() };
	await page.screenshot({ path: `${SHOTS}/ui-local-taipei.png` });
	await openMoney(page, c.slug, "/south-korea/seoul");
	out.localSeoul = { btn: await page.getByTestId(M.displayCurrency).innerText(), summary: await page.getByTestId(M.summary).innerText() };
	await openMoney(page, c.slug, "/japan");
	out.localJapan = { btn: await page.getByTestId(M.displayCurrency).innerText(), summary: await page.getByTestId(M.summary).innerText() };
	await page.screenshot({ path: `${SHOTS}/ui-local-japan.png` });
	await openMoney(page, c.slug);
	out.localRoot = { btn: await page.getByTestId(M.displayCurrency).innerText(), summary: await page.getByTestId(M.summary).innerText(), bal: await page.getByTestId(M.balances).innerText() };
	// CAD display at the root
	await page.getByTestId(M.displayCurrency).click();
	await page.getByRole("option", { name: /^CAD/ }).first().click();
	await page.waitForTimeout(800);
	out.cadRoot = { btn: await page.getByTestId(M.displayCurrency).innerText(), summary: await page.getByTestId(M.summary).innerText(), people: await page.getByTestId(M.people).innerText() };
	await page.screenshot({ path: `${SHOTS}/ui-cad-root.png` });
	// back to home
	await page.getByTestId(M.displayCurrency).click();
	await page.getByRole("option", { name: /Home currency/ }).click();
	expect.soft(out["/taiwan/taipei:currency"]).toBe("TWD");
	expect.soft(out["/south-korea/seoul:currency"]).toBe("KRW");
	expect.soft(out["/japan/kyoto:currency"]).toBe("JPY");
	expect.soft(out["/taiwan/taipei:row"], "TWD must read NT$, not a bare $ (DEFECT)").toContain("NT$320.00");
	expect.soft((out.localTaipei as { summary: string }).summary, "Local in Taiwan shows NT$ (DEFECT)").toContain("NT$");
	expect.soft((out.localSeoul as { summary: string }).summary).toContain("₩");
	expect.soft((out.localJapan as { summary: string }).summary).toContain("¥");
	expect.soft((out.cadRoot as { summary: string }).summary, "CAD display shows C$ (DEFECT)").toContain("C$");
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});

test("UI: itemize + 10% fee, pooled payers, refund then edit the refund", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dev@example.com", "Dev", "User");
	const c = await clone(ctx.request);
	const out: Record<string, unknown> = {};
	await openMoney(page, c.slug, "/japan/kyoto");
	await page.getByTestId(M.addButton).first().click();
	const dialog = page.getByTestId(TESTID.addExpenseDialog);
	await dialog.getByTestId(M.amount).fill("6600");
	await dialog.getByTestId(M.title).fill("Kaiseki");
	await dialog.getByTestId(M.status).getByRole("radio", { name: "Paid" }).click();
	await dialog.getByTestId(M.more).click();
	await dialog.getByTestId(M.itemize).click();
	const lines = dialog.getByTestId(M.line);
	await lines.nth(0).getByTestId(M.lineLabel).fill("Course A");
	await lines.nth(0).getByTestId(M.lineAmount).fill("3000");
	await lines.nth(0).getByTestId(M.linePerson).filter({ hasText: "Audrey" }).click();
	await lines.nth(0).getByTestId(M.linePerson).filter({ hasText: "Maya" }).click();
	await dialog.getByTestId(M.addLine).click();
	await lines.nth(1).getByTestId(M.lineLabel).fill("Course B");
	await lines.nth(1).getByTestId(M.lineAmount).fill("3000");
	await lines.nth(1).getByTestId(M.linePerson).filter({ hasText: "Maya" }).click();
	await dialog.getByTestId(M.addFee).click();
	await dialog.getByTestId(M.feeValue).first().fill("10");
	await page.waitForTimeout(300);
	out.itemizeRemainder = await dialog.getByTestId(M.remainder).allInnerTexts();
	out.lineWho = await lines.nth(0).innerText();
	await page.screenshot({ path: `${SHOTS}/ui-itemize.png` });
	// pooled payers
	await dialog.getByText("Several people paid (pooled cash)").click();
	const payerAmounts = dialog.getByTestId(M.payerAmount);
	out.payerCount = await payerAmounts.count();
	await payerAmounts.nth(0).fill("4000");
	await payerAmounts.nth(1).fill("2600");
	await page.waitForTimeout(300);
	out.payerRemainder = await dialog.getByTestId(M.multiPayer).innerText();
	await page.screenshot({ path: `${SHOTS}/ui-itemize-payers.png` });
	out.saveEnabled = await dialog.getByTestId(M.save).isEnabled();
	await dialog.getByTestId(M.save).click();
	await expect(dialog).toBeHidden();
	const row = page.getByTestId(M.expenseRow).filter({ hasText: "Kaiseki" });
	await expect(row).toBeVisible();
	out.row = await row.innerText();
	let money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const k = money.expenses.find((e) => e.title === "Kaiseki") as Exp;
	out.kaiseki = { lines: k.lines, payers: k.payments[0]?.payers, split: k.shares };
	// Refund through the editor
	await row.click();
	await expect(dialog).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/ui-kaiseki-edit.png` });
	await dialog.getByTestId(M.refund).click();
	await page.waitForTimeout(500);
	await dialog.getByTestId(M.amount).fill("660");
	await page.screenshot({ path: `${SHOTS}/ui-refund-new.png` });
	await dialog.getByTestId(M.save).click();
	await expect(dialog).toBeHidden();
	money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const r = money.expenses.find((e) => e.amountMinor === -660) as Exp;
	out.refund = { title: r?.title, category: r?.category, shares: r?.shares, status: r?.status, payers: r?.payments[0]?.payers };
	await openMoney(page, c.slug, "/japan/kyoto");
	const rrow = page.getByTestId(M.expenseRow).filter({ hasText: r.title });
	out.refundRow = await rrow.innerText();
	await rrow.click();
	await expect(dialog).toBeVisible();
	await dialog.getByTestId(M.amount).fill("1320");
	await dialog.getByTestId(M.save).click();
	await page.waitForTimeout(1500);
	out.afterRefundEditDialogVisible = await dialog.isVisible();
	out.toasts = await page.locator("[data-sonner-toast]").allInnerTexts();
	await page.screenshot({ path: `${SHOTS}/ui-refund-edit.png` });
	expect.soft(out.itemizeRemainder).toEqual(["Adds up ✓"]);
	expect.soft((out.refund as { shares: { amountMinor: number }[] }).shares.map((x) => x.amountMinor)).toEqual([-330, -330]);
	expect.soft((out.refund as { title: string }).title, "refund title follows the original (DEFECT)").toContain("Kaiseki");
	expect.soft(out.toasts, "editing a refund's amount must save (DEFECT)").toEqual([]);
	expect.soft(out.afterRefundEditDialogVisible).toBe(false);
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});

const INBOX = "/src/functions/inbox.functions.ts";

test("settle-up in ¥ for a USD balance, then edits after settlement are flagged (tab + inbox)", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dev@example.com", "Dev", "User");
	const c = await clone(ctx.request);
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	const out: Record<string, unknown> = {};
	const A = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "node", nodeId: c.ids.nodes.kyoto ?? Object.values(c.ids.nodes)[0] },
		title: "Sushi dinner",
		amountMinor: 7777,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }, { memberId: audrey }] },
		payments: [pay(7777, [{ memberId: owner, amountMinor: 7777 }])],
	});
	const B = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Izakaya night",
		amountMinor: 6600,
		currency: "JPY",
		lines: [
			{ label: "a", amountMinor: 3500, memberIds: [owner] },
			{ label: "b", amountMinor: 2500, memberIds: [maya] },
		],
		fees: [{ label: "Service", kind: "percent", percent: 10 }],
		payments: [pay(6600, [{ memberId: maya, amountMinor: 6600 }])],
	});
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Rental car",
		amountMinor: 10000,
		currency: "USD",
		split: { mode: "exact", shares: [{ memberId: owner, amountMinor: 3333 }, { memberId: maya, amountMinor: 6667 }] },
		payments: [pay(10000, [{ memberId: audrey, amountMinor: 10000 }], new Date().toISOString(), "USD", "America/New_York")],
	});
	await openMoney(page, c.slug);
	out.balBefore = await page.getByTestId(M.balances).innerText();
	await page.getByTestId(M.settleUpButton).click();
	const dlg = page.getByTestId(M.settleUpDialog);
	await expect(dlg).toBeVisible();
	const transfers = await dlg.getByTestId(M.transferRow).allInnerTexts();
	out.transfers = transfers;
	await page.screenshot({ path: `${SHOTS}/settle-dialog.png` });
	// Record every transfer; pay the ones from Maya in JPY
	for (let i = 0; i < 5; i++) {
		const rows = dlg.getByTestId(M.transferRow);
		const n = await rows.count();
		if (!n) break;
		const row = rows.first();
		const text = await row.innerText();
		await row.getByTestId(M.transferRecord).click();
		if (/^Maya/.test(text.trim())) {
			await row.getByRole("button", { name: /USD/ }).first().click();
			await page.getByRole("option", { name: /^JPY/ }).first().click();
			await page.waitForTimeout(200);
		}
		await row.getByLabel("How").fill(i % 2 ? "Venmo" : "cash");
		await page.screenshot({ path: `${SHOTS}/settle-record-${i}.png` });
		out[`recorded_${i}`] = { text, form: await row.innerText() };
		await row.getByRole("button", { name: "Record payment" }).click();
		await page.waitForTimeout(1200);
	}
	await page.screenshot({ path: `${SHOTS}/settle-after.png` });
	out.dialogAfter = await dlg.innerText();
	await page.keyboard.press("Escape");
	let money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.settlements = money.settlements.map((s) => ({ home: s.homeAmountMinor, netAfter: s.netAfter }));
	out.balAfter = await page.getByTestId(M.balances).innerText();
	out.noticeAfterSettle = await page.getByTestId(M.balanceNotice).count();

	// Maya: edit only the note of an expense (no money change)
	const m = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(m.page, c.slug);
	await callFn(m.page, "updateExpense", { id: B.id, patch: { note: "great night" } });
	let inbox = await callFn<{ items: { kind: string; title: string }[] }>(page, "listInbox", { tripId: c.tripId }, INBOX);
	out.inboxAfterNoteEdit = inbox.items?.filter((x) => x.kind === "balance_changed").map((x) => x.title) ?? inbox;
	await openMoney(page, c.slug);
	out.noticeAfterNoteEdit = await page.getByTestId(M.balanceNotice).allInnerTexts();

	// Maya: change the sushi amount
	await callFn(m.page, "updateExpense", { id: A.id, patch: { amountMinor: 8888, currency: "JPY", payments: [pay(8888, [{ memberId: owner, amountMinor: 8888 }])] } });
	inbox = await callFn(page, "listInbox", { tripId: c.tripId }, INBOX);
	out.inboxAfterEdit = inbox.items?.filter((x) => x.kind === "balance_changed").map((x) => x.title) ?? inbox;
	await openMoney(page, c.slug);
	out.noticeAfterEdit = await page.getByTestId(M.balanceNotice).allInnerTexts();
	out.balAfterEdit = await page.getByTestId(M.balances).innerText();
	await page.screenshot({ path: `${SHOTS}/settle-edited.png` });
	money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.recentEdits = (money as unknown as { recentEdits: unknown }).recentEdits;
	// Maya's view: her notice
	await openMoney(m.page, c.slug);
	out.mayaNotice = await m.page.getByTestId(M.balanceNotice).allInnerTexts();
	out.mayaBal = await m.page.getByTestId(M.balances).innerText();
	const mi = await callFn<{ items: { kind: string; title: string }[] }>(m.page, "listInbox", { tripId: c.tripId }, INBOX);
	out.mayaInbox = mi.items?.filter((x) => x.kind === "balance_changed").map((x) => x.title);
	expect.soft(out.inboxAfterNoteEdit).toEqual([]);
	expect.soft(out.noticeAfterNoteEdit).toEqual([]);
	expect.soft(String(out.inboxAfterEdit)).toContain("Balance changed since your last settlement: +$4.70 (Maya edited Sushi dinner)");
	expect.soft(String(out.noticeAfterEdit)).toContain("(Maya edited Sushi dinner)");
	console.log(JSON.stringify(out, null, 1));
	await m.ctx.close();
	await ctx.close();
});

test("MONEY-11: a ¥ settlement zeroes a USD balance (visible remainder at most)", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dev@example.com", "Dev", "User");
	const c = await clone(ctx.request);
	const { owner } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	const out: Record<string, unknown> = {};
	for (const amt of [4321, 2999]) {
		await callFn(page, "createExpense", {
			tripId: c.tripId,
			target: { kind: "trip" },
			title: `Dinner ${amt}`,
			amountMinor: amt,
			currency: "USD",
			split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
			payments: [pay(amt, [{ memberId: owner, amountMinor: amt }], new Date().toISOString(), "USD", "America/New_York")],
		});
	}
	await openMoney(page, c.slug);
	out.before = await page.getByTestId(M.balances).innerText();
	await page.getByTestId(M.settleUpButton).click();
	const dlg = page.getByTestId(M.settleUpDialog);
	const row = dlg.getByTestId(M.transferRow).first();
	out.row = await row.innerText();
	await row.getByTestId(M.transferRecord).click();
	await row.getByRole("button", { name: /USD/ }).first().click();
	await page.getByRole("option", { name: /^JPY/ }).first().click();
	await page.waitForTimeout(300);
	out.form = await row.innerText();
	out.amountField = await row.getByLabel("Amount").inputValue();
	await row.getByLabel("How").fill("cash");
	await page.screenshot({ path: `${SHOTS}/settle-jpy-form.png` });
	await row.getByRole("button", { name: "Record payment" }).click();
	await page.waitForTimeout(1500);
	out.dialogAfter = await dlg.innerText();
	await page.screenshot({ path: `${SHOTS}/settle-jpy-after.png` });
	await page.keyboard.press("Escape");
	out.after = await page.getByTestId(M.balances).innerText();
	const money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.settlement = money.settlements.map((s) => ({ ...s }));
	expect.soft(out.after).toContain("Everyone is square.");
	expect.soft((out.settlement as { currency: string }[])[0]?.currency).toBe("JPY");
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});

const GRAPH = "/src/functions/graph.functions.ts";

test("privacy + roles: suggester adds directly, private expense, guests never see money", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dev@example.com", "Dev", "User");
	const c = await clone(ctx.request, { mayaRole: "suggester" });
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	const out: Record<string, unknown> = {};
	const legId = Object.values(c.ids.legs)[0] as string;
	out.legKeys = Object.keys(c.ids.legs);
	// suggester
	const m = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(m.page, c.slug);
	out.mayaAddBtnEnabled = await m.page.getByTestId(M.addButton).first().isEnabled();
	const mx = await callFn<{ id: string; proposed?: unknown }>(m.page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Maya's coffee",
		amountMinor: 900,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(900, [{ memberId: maya, amountMinor: 900 }])],
	});
	out.suggesterCreate = mx;
	// private on a leg
	const px = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "leg", legId },
		title: "Secret gift",
		amountMinor: 20000,
		currency: "JPY",
		isPrivate: true,
		payments: [pay(20000, [{ memberId: owner, amountMinor: 20000 }])],
	});
	// private with another payer must be refused
	out.privateOtherPayer = await callFnErr(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Private paid by Maya",
		amountMinor: 1000,
		currency: "JPY",
		isPrivate: true,
		payments: [pay(1000, [{ memberId: maya, amountMinor: 1000 }])],
	});
	const mayaMoney = await callFn<Money>(m.page, "listMoney", { tripId: c.tripId });
	out.mayaSeesPrivate = mayaMoney.expenses.some((e) => e.id === px.id);
	out.mayaEditPrivate = await callFnErr(m.page, "updateExpense", { id: px.id, patch: { title: "hacked" } });
	out.mayaDeletePrivate = await callFnErr(m.page, "deleteExpense", { id: px.id });
	const act = await callFn<{ summary: string }[]>(m.page, "listActivity", { tripId: c.tripId, limit: 50 }, GRAPH);
	out.mayaActivity = act.map((a) => a.summary).filter((s) => /expense|gift|coffee/i.test(s));
	const actO = await callFn<{ summary: string }[]>(page, "listActivity", { tripId: c.tripId, limit: 50 }, GRAPH);
	out.ownerActivity = actO.map((a) => a.summary).filter((s) => /expense|gift|coffee/i.test(s));
	await openMoney(page, c.slug);
	out.ownerSummary = await page.getByTestId(M.summary).innerText();
	out.ownerBal = await page.getByTestId(M.balances).innerText();
	await page.screenshot({ path: `${SHOTS}/privacy-owner.png`, fullPage: true });
	await openMoney(m.page, c.slug);
	out.mayaSummary = await m.page.getByTestId(M.summary).innerText();
	out.mayaBal = await m.page.getByTestId(M.balances).innerText();
	// Guests: viewer and editor links
	for (const kind of ["viewer", "editor"] as const) {
		const g = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
		const gp = await g.newPage();
		await gp.goto(`/join#t=${c.shareTokens[kind]}`);
		await gp.waitForURL(/\/t\//, { timeout: 30_000 });
		await waitLive(gp);
		out[`guest_${kind}_tabs`] = await gp.getByRole("tab").allInnerTexts();
		await gp.goto(`/t/${c.slug}?tab=money`);
		await waitLive(gp);
		out[`guest_${kind}_moneyTab`] = await gp.getByTestId(TESTID.moneyTab).count();
		out[`guest_${kind}_listMoney`] = await callFnErr(gp, "listMoney", { tripId: c.tripId });
		out[`guest_${kind}_csv`] = await callFnErr(gp, "exportMoneyCsv", { tripId: c.tripId });
		out[`guest_${kind}_create`] = await callFnErr(gp, "createExpense", {
			tripId: c.tripId,
			target: { kind: "trip" },
			amountMinor: 100,
			currency: "JPY",
		});
		const ga = await callFn<{ summary: string }[]>(gp, "listActivity", { tripId: c.tripId, limit: 100 }, GRAPH);
		out[`guest_${kind}_activity`] = ga.map((a) => a.summary).filter((s) => /expense|settle|budget|coffee/i.test(s));
		const inb = await callFnErr(gp, "listInbox", { tripId: c.tripId }, INBOX);
		out[`guest_${kind}_inbox`] = inb;
		await gp.goto(`/t/${c.slug}?tab=plan`);
		await waitLive(gp);
		out[`guest_${kind}_wallet`] = await gp.locator("svg.lucide-wallet").count();
		await gp.screenshot({ path: `${SHOTS}/guest-${kind}.png` });
		await g.close();
	}
	// delete the leg: the private expense stays, Trip-wide
	await callFn(page, "deleteLeg", { legId }, "/src/functions/legs.functions.ts").catch((e) => {
		out.deleteLegErr = String(e);
	});
	const after = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.privateAfterLegDelete = after.expenses.find((e) => e.id === px.id)?.target;
	await openMoney(page, c.slug);
	out.privateRow = await page.getByTestId(M.expenseRow).filter({ hasText: "Secret gift" }).innerText().catch(() => "missing");
	expect.soft(out.suggesterCreate).toHaveProperty("id");
	expect.soft(out.privateOtherPayer).toContain("A private expense is paid by you.");
	expect.soft(out.mayaSeesPrivate).toBe(false);
	expect.soft(out.mayaEditPrivate).toContain("NOT_FOUND");
	expect.soft(out.mayaActivity).toEqual(["added an expense: Maya's coffee"]);
	for (const k of ["viewer", "editor"]) {
		expect.soft(out[`guest_${k}_moneyTab`]).toBe(0);
		expect.soft(out[`guest_${k}_listMoney`]).toContain("FORBIDDEN");
		expect.soft(out[`guest_${k}_csv`]).toContain("FORBIDDEN");
		expect.soft(out[`guest_${k}_activity`]).toEqual([]);
		expect.soft(out[`guest_${k}_wallet`]).toBe(0);
	}
	expect.soft(out.privateAfterLegDelete).toEqual({ kind: "trip" });
	console.log(JSON.stringify(out, null, 1));
	await m.ctx.close();
	await ctx.close();
	void audrey;
});

test("budgets: default vs custom + notice, derived parent, over-allocation, per-day, categories, private", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dev@example.com", "Dev", "User");
	const c = await clone(ctx.request);
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	const N = c.ids.nodes;
	await openMoney(page, c.slug);
	const out: Record<string, unknown> = {};
	const m = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(m.page, c.slug);
	const setLine = (p: Page, nodeId: string | null, memberId: string | null, amountMinor: number, kind = "total", category: string | null = null) =>
		callFn<{ id: string }>(p, "setBudgetLine", { tripId: c.tripId, nodeId, category, memberId, amountMinor, kind });
	// spend: Tokyo ¥10,000 (owner paid, split owner+maya), Osaka ¥6,000 (maya paid, split both), Kyoto food ¥3,000
	for (const [node, amt, payer, cat] of [["tokyo", 10000, owner, "activities"], ["osaka", 6000, maya, "food_drink"], ["kyoto", 3000, owner, "food_drink"]] as const) {
		await callFn(page, "createExpense", {
			tripId: c.tripId,
			target: { kind: "node", nodeId: N[node] },
			title: `Spend ${node}`,
			category: cat,
			amountMinor: amt,
			currency: "JPY",
			split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
			payments: [pay(amt, [{ memberId: payer, amountMinor: amt }])],
		});
	}
	// 1. default Japan $500; Maya custom $400; default changes to $600
	await setLine(page, N.japan as string, null, 50000);
	await setLine(m.page, N.japan as string, maya, 40000);
	out.mayaOwnForOther = await callFnErr(m.page, "setBudgetLine", { tripId: c.tripId, nodeId: N.japan, category: null, memberId: owner, amountMinor: 1, kind: "total" });
	await setLine(page, N.japan as string, null, 60000);
	await openMoney(m.page, c.slug, "/japan");
	out.mayaJapanBudget = await m.page.getByTestId(M.budget).innerText();
	out.mayaNotice = await m.page.getByTestId(M.budgetNotice).allInnerTexts();
	await m.page.screenshot({ path: `${SHOTS}/budget-maya-japan.png`, fullPage: true });
	const mi = await callFn<{ items: { kind: string; title: string }[] }>(m.page, "listInbox", { tripId: c.tripId }, INBOX);
	out.mayaInboxBudget = mi.items?.filter((x) => x.kind === "budget_notice").map((x) => x.title);
	await openMoney(page, c.slug, "/japan");
	out.ownerJapanBudgetMine = await page.getByTestId(M.budget).innerText();
	await page.getByTestId(M.budget).getByRole("radio", { name: "Group" }).click();
	out.ownerJapanBudgetGroup = await page.getByTestId(M.budget).innerText();
	await page.screenshot({ path: `${SHOTS}/budget-owner-japan-group.png`, fullPage: true });
	// 2. children: Tokyo $50, Kyoto $30 under Japan $60 → over-allocated for the owner (default)
	await setLine(page, N.tokyo as string, null, 5000);
	await setLine(page, N.kyoto as string, null, 3000);
	await openMoney(page, c.slug, "/japan");
	await page.getByTestId(M.budget).getByRole("radio", { name: "Mine" }).click();
	out.ownerJapanOver = await page.getByTestId(M.budget).innerText();
	await page.screenshot({ path: `${SHOTS}/budget-owner-over.png`, fullPage: true });
	// 3. remove the Japan default → derived for the owner (Maya keeps her own $400)
	const money = await callFn<{ budgets: { id: string; nodeId: string | null; memberId: string | null; category: string | null }[] }>(page, "listMoney", { tripId: c.tripId });
	const japanDefault = money.budgets.find((b) => b.nodeId === N.japan && b.memberId === null);
	await callFn(page, "deleteBudgetLine", { id: japanDefault?.id });
	await openMoney(page, c.slug, "/japan");
	out.ownerJapanDerived = await page.getByTestId(M.budget).innerText();
	await page.screenshot({ path: `${SHOTS}/budget-owner-derived.png`, fullPage: true });
	await openMoney(m.page, c.slug, "/japan");
	out.mayaJapanAfterDefaultDeleted = await m.page.getByTestId(M.budget).innerText();
	// 4. per day at Tokyo + a category inside Kyoto
	await setLine(page, N.tokyo as string, null, 2000, "per_day");
	await setLine(page, N.kyoto as string, null, 1000, "total", "food_drink");
	await openMoney(page, c.slug, "/japan/tokyo");
	out.ownerTokyo = await page.getByTestId(M.budget).innerText();
	await openMoney(page, c.slug, "/japan/kyoto");
	out.ownerKyoto = await page.getByTestId(M.budget).innerText();
	await page.screenshot({ path: `${SHOTS}/budget-owner-kyoto.png`, fullPage: true });
	// 5. root: trip default $1000 with children lines below
	await setLine(page, null, null, 100000);
	await openMoney(page, c.slug);
	out.ownerRoot = await page.getByTestId(M.budget).innerText();
	// 6. private: Maya hides her budgets
	await callFn(m.page, "setBudgetPrivate", { tripId: c.tripId, private: true });
	const om = await callFn<{ budgets: { memberId: string | null }[]; privateBudgetMemberIds: string[] }>(page, "listMoney", { tripId: c.tripId });
	out.ownerSeesMayaLines = om.budgets.filter((b) => b.memberId === maya).length;
	out.privateIds = om.privateBudgetMemberIds;
	await openMoney(page, c.slug, "/japan");
	await page.getByTestId(M.budget).getByRole("radio", { name: "Group" }).click();
	out.ownerJapanGroupPrivate = await page.getByTestId(M.budget).innerText();
	await page.screenshot({ path: `${SHOTS}/budget-owner-group-private.png`, fullPage: true });
	expect.soft(String(out.mayaNotice)).toContain("Trip default is now $600.00; yours stays $400.00");
	expect.soft(String(out.mayaInboxBudget)).toContain("Trip default is now $600.00");
	expect.soft(out.mayaOwnForOther).toContain("FORBIDDEN");
	expect.soft(out.ownerJapanDerived).toContain("derived");
	expect.soft(out.ownerJapanDerived).toContain("unbudgeted");
	expect.soft(out.ownerTokyo).toContain("/day × 3");
	expect.soft(out.ownerSeesMayaLines).toBe(0);
	expect.soft(out.ownerJapanGroupPrivate).toContain("1 person keeps their budget private.");
	// Kyoto food ($9.52) is inside its $10 line; the Osaka food ($19.03) is unbudgeted: the derived root food row must not be "over" (DEFECT)
	expect.soft(out.ownerRoot, "derived budget counts unbudgeted spend against itself (DEFECT)").not.toContain("$18.55 over");
	console.log(JSON.stringify(out, null, 1));
	await m.ctx.close();
	await ctx.close();
	void audrey;
});

test("CSV vs scope totals, manual rate, home-currency change, former member", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dev@example.com", "Dev", "User");
	const c = await clone(ctx.request);
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	const N = c.ids.nodes;
	await openMoney(page, c.slug);
	const out: Record<string, unknown> = {};
	const e1 = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "node", nodeId: N.tokyo },
		title: "Tokyo tower, \"top deck\"",
		amountMinor: 3000,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }, { memberId: audrey }] },
		payments: [pay(3000, [{ memberId: maya, amountMinor: 3000 }])],
	});
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "node", nodeId: N.kyoto },
		title: "=HYPERLINK(\"http://x\")",
		amountMinor: 50000,
		currency: "JPY",
		expectedOn: "2027-10-05",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
	});
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "node", nodeId: N.kyoto },
		title: "My private kimono",
		amountMinor: 8000,
		currency: "JPY",
		isPrivate: true,
		payments: [pay(8000, [{ memberId: owner, amountMinor: 8000 }])],
	});
	await callFn(page, "createSettlement", {
		tripId: c.tripId,
		fromMemberId: owner,
		toMemberId: maya,
		amountMinor: 1000,
		currency: "JPY",
		settledAt: new Date().toISOString(),
		settledTz: "Asia/Tokyo",
		method: "cash",
	});
	// CSV through the UI at Japan
	await openMoney(page, c.slug, "/japan");
	out.japanSummary = await page.getByTestId(M.summary).innerText();
	await page.getByTestId(M.moreMenu).click();
	const dl = page.waitForEvent("download", { timeout: 15_000 }).catch((e) => e);
	await page.getByTestId(M.exportCsv).click();
	const d = await dl;
	if (d && typeof (d as { path?: unknown }).path === "function") {
		const fs = await import("node:fs");
		const p = await (d as import("@playwright/test").Download).path();
		out.csvFilename = (d as import("@playwright/test").Download).suggestedFilename();
		out.csv = fs.readFileSync(p as string, "utf8");
	} else out.csvDownload = String(d);
	// Manual rate
	await callFn(page, "setExpenseRate", { id: e1.id, rate: 0.01 });
	let money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const ex = money.expenses.find((e) => e.id === e1.id) as Exp;
	out.manual = { home: ex.homeAmountMinor, rate: ex.fxRate, src: ex.fxSource, pay: ex.payments.map((p) => [p.homeAmountMinor, p.fxRate]) };
	// Former member: remove Maya
	await callFn(page, "removeMember", { memberId: maya }, "/src/features/home/sharing.functions.ts").catch((e) => {
		out.removeErr = String(e);
	});
	await openMoney(page, c.slug);
	out.rootAfterRemove = {
		bal: await page.getByTestId(M.balances).innerText(),
		people: await page.getByTestId(M.people).innerText(),
		rows: await page.getByTestId(M.expenseRow).allInnerTexts(),
	};
	await page.screenshot({ path: `${SHOTS}/former-member.png`, fullPage: true });
	// Home currency → CAD
	await callFn(page, "updateTrip", { tripId: c.tripId, settings: { currency: "CAD" } }, "/src/functions/trips.functions.ts");
	await page.waitForTimeout(6000);
	money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.afterRehome = {
		home: money.homeCurrency,
		expenses: money.expenses.map((e) => ({ t: e.title, home: e.homeAmountMinor, rate: e.fxRate, src: e.fxSource, pay: e.payments.map((p) => [p.homeAmountMinor, p.fxRate]) })),
		settlements: money.settlements.map((s) => s.homeAmountMinor),
		budgets: money.budgets,
	};
	await openMoney(page, c.slug);
	out.rootCad = await page.getByTestId(M.summary).innerText();
	await page.screenshot({ path: `${SHOTS}/root-cad.png`, fullPage: true });
	const csvTotal = /\r\nTotal,,,,,,,([\d.]+),([\d.]+)/.exec(String(out.csv));
	const uiPlanned = /PLANNED\n\$([\d,.]+)/.exec(String(out.japanSummary));
	expect.soft(csvTotal?.[1], "CSV planned total equals the Money tab's (DEFECT)").toBe(uiPlanned?.[1]?.replace(/,/g, ""));
	expect.soft(String(out.csv)).toContain("'=HYPERLINK");
	expect.soft((out.manual as { src: string }).src).toBe("manual");
	expect.soft((out.rootAfterRemove as { people: string }).people).toContain("Maya Chen (former member)");
	expect.soft((out.afterRehome as { home: string }).home).toBe("CAD");
	expect.soft((out.afterRehome as { expenses: { src: string }[] }).expenses[0]?.src).toBe("manual");
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});

const LISTS = "/src/features/lists/lists.functions.ts";

test("UI: shopping Bought + tax-free, private gift, manual rate on a paid cost, points cpp", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dev@example.com", "Dev", "User");
	const c = await clone(ctx.request);
	const { owner } = c.members;
	const maya = c.members.maya as string;
	const N = c.ids.nodes;
	await openMoney(page, c.slug);
	const out: Record<string, unknown> = {};
	const dialog = page.getByTestId(TESTID.addExpenseDialog);
	// private priced gift
	const gift = await callFn<{ id: string }>(page, "createListItem", {
		tripId: c.tripId,
		target: { kind: "node", nodeId: N.tokyo },
		list: "shopping",
		text: "Secret gift for Maya",
		priceAmount: 5000,
		priceCurrency: "JPY",
		isPrivate: true,
	}, LISTS);
	await openMoney(page, c.slug, "/japan/tokyo");
	out.shoppingRows = await page.getByTestId(M.shoppingRow).allInnerTexts();
	await page.screenshot({ path: `${SHOTS}/shopping-tokyo.png`, fullPage: true });
	// Maya doesn't see the gift's planned cost
	const m = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(m.page, c.slug, "/japan/tokyo");
	out.mayaShoppingRows = await m.page.getByTestId(M.shoppingRow).allInnerTexts();
	out.mayaSummary = await m.page.getByTestId(M.summary).innerText().catch(() => "none");
	// Bought on the knife
	const knife = page.getByTestId(M.shoppingRow).filter({ hasText: "knife" });
	await knife.getByRole("button", { name: "Bought" }).click();
	await expect(dialog).toBeVisible();
	out.knifeDialog = { amount: await dialog.getByTestId(M.amount).inputValue(), cur: await dialog.getByTestId(M.currency).innerText(), title: await dialog.getByTestId(M.title).inputValue() };
	await dialog.getByTestId(M.more).click();
	await dialog.getByText("Tax-free · refund pending").click();
	await page.screenshot({ path: `${SHOTS}/shopping-bought-dialog.png` });
	await dialog.getByTestId(M.save).click();
	await expect(dialog).toBeHidden();
	let money = await callFn<Money & { expenses: (Exp & { listItemId: string | null; taxFreePending: boolean })[] }>(page, "listMoney", { tripId: c.tripId });
	const k = money.expenses.find((e) => /knife/i.test(e.title));
	out.knifeExpense = { status: k?.status, listItemId: k?.listItemId, taxFree: k?.taxFreePending, cat: k?.category, shares: k?.shares.length };
	const items = await callFn<{ id: string; text: string; status: string }[]>(page, "listTripListItems", { tripId: c.tripId }, LISTS);
	out.knifeListStatus = items.filter((i) => /knife/i.test(i.text)).map((i) => i.status);
	// Bought on the private gift → starts private
	const g = page.getByTestId(M.shoppingRow).filter({ hasText: "Secret gift" });
	await g.getByRole("button", { name: "Bought" }).click();
	await expect(dialog).toBeVisible();
	await dialog.getByTestId(M.more).click();
	out.giftPrivateChecked = await dialog.getByTestId(M.private).getAttribute("aria-checked").catch(() => null) ?? await dialog.getByTestId(M.private).getAttribute("data-state");
	await dialog.getByTestId(M.save).click();
	await expect(dialog).toBeHidden();
	money = await callFn(page, "listMoney", { tripId: c.tripId });
	out.giftExpensePrivate = money.expenses.find((e) => /Secret gift/.test(e.title))?.isPrivate;
	void gift;
	// manual rate on a new paid expense
	await openMoney(page, c.slug, "/japan/kyoto");
	await page.getByTestId(M.addButton).first().click();
	await dialog.getByTestId(M.amount).fill("10000");
	await dialog.getByTestId(M.title).fill("Card at my bank's rate");
	await dialog.getByTestId(M.status).getByRole("radio", { name: "Paid" }).click();
	await dialog.getByTestId(M.more).click();
	await dialog.getByLabel(/Your rate/).fill("0.01");
	await page.screenshot({ path: `${SHOTS}/manual-rate-dialog.png` });
	await dialog.getByTestId(M.save).click();
	await expect(dialog).toBeHidden();
	money = await callFn(page, "listMoney", { tripId: c.tripId });
	const mr = money.expenses.find((e) => /bank's rate/.test(e.title)) as Exp;
	out.manualRate = { planned: mr.homeAmountMinor, src: mr.fxSource, pay: mr.payments.map((p) => [p.homeAmountMinor, p.fxRate]) };
	await openMoney(page, c.slug, "/japan/kyoto");
	out.kyotoRows = await page.getByTestId(M.expenseRow).allInnerTexts();
	out.kyotoSummary = await page.getByTestId(M.summary).innerText();
	out.kyotoPeople = await page.getByTestId(M.people).innerText();
	await page.screenshot({ path: `${SHOTS}/manual-rate-kyoto.png`, fullPage: true });
	// points via the editor
	await openMoney(page, c.slug);
	await page.getByTestId(M.addButton).first().click();
	await dialog.getByTestId(M.title).fill("JFK-HND in J");
	await dialog.getByTestId(M.currency).click();
	await page.getByRole("option", { name: /^USD/ }).first().click();
	await dialog.getByTestId(M.status).getByRole("radio", { name: "Paid" }).click();
	await dialog.getByTestId(M.more).click();
	await dialog.getByTestId(M.points).click();
	await dialog.getByLabel("Programme", { exact: true }).fill("Aeroplan");
	await dialog.getByLabel("Points", { exact: true }).fill("240000");
	await dialog.getByLabel("Source programme").fill("Chase UR");
	await dialog.getByLabel("Source points").fill("200000");
	await dialog.getByLabel("Cash price").fill("6000");
	await dialog.getByTestId(M.amount).fill("300");
	await page.waitForTimeout(300);
	out.pointsEditor = await dialog.innerText();
	await page.screenshot({ path: `${SHOTS}/points-dialog.png` });
	await dialog.getByTestId(M.save).click();
	await expect(dialog).toBeHidden();
	await openMoney(page, c.slug);
	out.rootSummary = await page.getByTestId(M.summary).innerText();
	out.rootPeople = await page.getByTestId(M.people).innerText();
	out.rootBal = await page.getByTestId(M.balances).innerText();
	await page.screenshot({ path: `${SHOTS}/points-root.png`, fullPage: true });
	expect.soft(out.mayaShoppingRows).toHaveLength(1);
	expect.soft(out.knifeListStatus, "Bought in the Money tab marks the shopping item bought (DEFECT)").not.toEqual(["open"]);
	expect.soft((out.knifeExpense as { taxFree: boolean }).taxFree).toBe(true);
	expect.soft(out.giftExpensePrivate).toBe(true);
	expect.soft((out.manualRate as { pay: number[][] }).pay[0]?.[0], "the manual rate applies to what was paid (DEFECT)").toBe(10000);
	expect.soft(out.rootSummary).toContain("2.38¢");
	expect.soft(out.rootSummary).toContain("2.85¢");
	expect.soft(out.rootBal).toContain("Audrey owes you $121.15");
	console.log(JSON.stringify(out, null, 1));
	await m.ctx.close();
	await ctx.close();
	void owner;
	void maya;
});

test("viewer read-only, day scope + inspector, over-allocation, phone fast entry", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dev@example.com", "Dev", "User");
	const c = await clone(ctx.request, { mayaRole: "viewer" });
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	const N = c.ids.nodes;
	await openMoney(page, c.slug);
	const out: Record<string, unknown> = {};
	const dayIds = Object.entries(c.ids.days);
	out.days = dayIds.map(([k]) => k);
	const itemIds = Object.entries(c.ids.items);
	out.items = itemIds.map(([k]) => k);
	const itemId = itemIds[0]?.[1] as string;
	const dayId = dayIds[1]?.[1] as string;
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "item", itemId },
		amountMinor: 2400,
		currency: "JPY",
		payments: [pay(2400, [{ memberId: owner, amountMinor: 2400 }])],
	});
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "day", dayId },
		amountMinor: 5000,
		currency: "JPY",
		payments: [pay(5000, [{ memberId: owner, amountMinor: 5000 }])],
	});
	const legId = Object.values(c.ids.legs)[1] as string;
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "leg", legId },
		amountMinor: 4000,
		currency: "JPY",
	});
	const money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.defaults = money.expenses.map((e) => ({ title: e.title, cat: e.category, shares: e.shares.length, target: e.target }));
	// over-allocation: Japan default $50 < Tokyo $40 + Kyoto $30
	for (const [node, amt] of [["japan", 5000], ["tokyo", 4000], ["kyoto", 3000]] as const)
		await callFn(page, "setBudgetLine", { tripId: c.tripId, nodeId: N[node], category: null, memberId: null, amountMinor: amt, kind: "total" });
	await openMoney(page, c.slug, "/japan");
	out.over = await page.getByTestId(M.budget).innerText();
	await page.screenshot({ path: `${SHOTS}/budget-over.png`, fullPage: true });
	// viewer Maya
	const m = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(m.page, c.slug);
	out.viewerAddEnabled = await m.page.getByTestId(M.addButton).first().isEnabled();
	out.viewerCreate = await callFnErr(m.page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, amountMinor: 100, currency: "JPY" });
	out.viewerBudgetOwn = await callFnErr(m.page, "setBudgetLine", { tripId: c.tripId, nodeId: null, category: null, memberId: maya, amountMinor: 100, kind: "total" });
	out.viewerRows = await m.page.getByTestId(M.expenseRow).count();
	await m.page.getByTestId(M.expenseRow).first().click();
	await m.page.waitForTimeout(500);
	out.viewerEditor = await m.page.getByTestId(TESTID.addExpenseDialog).innerText().catch(() => "no dialog");
	await m.page.screenshot({ path: `${SHOTS}/viewer-editor.png` });
	await m.ctx.close();
	// day scope via the URL's day range? open the day inspector through the Plan tab instead
	await page.goto(`/t/${c.slug}?tab=plan`);
	await waitLive(page);
	await page.screenshot({ path: `${SHOTS}/plan-with-money.png` });
	out.walletIcons = await page.locator("svg.lucide-wallet").count();
	// phone
	const p = await browser.newContext({ baseURL: BASE, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 });
	await login(p.request, "dev@example.com", "Dev", "User");
	const pp = await p.newPage();
	await pp.goto(`/t/${c.slug}/japan/kyoto`);
	await waitLive(pp);
	let taps = 0;
	await pp.getByTestId("fab").tap();
	taps++;
	await pp.getByTestId("fab-expense").tap().catch(async () => {
		await pp.getByRole("menuitem", { name: /Expense/ }).tap();
	});
	taps++;
	const dlg = pp.getByTestId(TESTID.addExpenseDialog);
	await expect(dlg).toBeVisible();
	out.phoneCurrency = await dlg.getByTestId(M.currency).innerText();
	out.phoneFocused = await pp.evaluate(() => document.activeElement?.getAttribute("data-testid"));
	await dlg.getByTestId(M.amount).fill("1500");
	await pp.screenshot({ path: `${SHOTS}/phone-add.png` });
	await dlg.getByTestId(M.save).tap();
	taps++;
	await expect(dlg).toBeHidden();
	out.phoneTaps = taps;
	await pp.goto(`/t/${c.slug}/japan/kyoto?tab=money`);
	await waitLive(pp);
	await pp.screenshot({ path: `${SHOTS}/phone-money.png`, fullPage: true });
	out.phoneOverflow = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	await p.close();
	expect.soft(out.over).toContain("Over-allocated: its places add up to $70.00.");
	expect.soft(out.viewerAddEnabled).toBe(false);
	expect.soft(out.viewerCreate).toContain("FORBIDDEN");
	expect.soft(out.phoneTaps).toBeLessThanOrEqual(3);
	expect.soft(out.phoneOverflow).toBe(0);
	const phoneMoney = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const phoneExp = phoneMoney.expenses.find((e) => e.amountMinor === 1500);
	expect.soft(phoneExp?.target, "the phone FAB expense lands in the current scope, Kyoto (DEFECT)").toEqual({ kind: "node", nodeId: N.kyoto });
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
	void audrey;
});

test("placeholder merge: a member claims the placeholder and balances carry over", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dev@example.com", "Dev", "User");
	const c = await clone(ctx.request);
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	const out: Record<string, unknown> = {};
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Taxi for three",
		amountMinor: 900,
		currency: "USD",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }, { memberId: audrey }] },
		payments: [pay(900, [{ memberId: owner, amountMinor: 900 }], new Date().toISOString(), "USD", "UTC")],
	});
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Shared platter",
		amountMinor: 600,
		currency: "USD",
		lines: [{ label: "Platter", amountMinor: 600, memberIds: [owner, maya, audrey] }],
		payments: [pay(600, [{ memberId: owner, amountMinor: 600 }], new Date().toISOString(), "USD", "UTC")],
	});
	await openMoney(page, c.slug);
	out.before = await page.getByTestId(M.balances).innerText();
	const m = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(m.page, c.slug);
	out.claim = await callFn(m.page, "claimPlaceholder", { tripId: c.tripId, memberId: audrey }, "/src/features/home/sharing.functions.ts").catch((e) => String(e));
	await openMoney(page, c.slug);
	out.after = await page.getByTestId(M.balances).innerText();
	const money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.shares = money.expenses.map((e) => ({ t: e.title, shares: e.shares, lines: e.lines }));
	await page.screenshot({ path: `${SHOTS}/merge-after.png`, fullPage: true });
	expect.soft(out.before).toContain("Audrey owes you $5.00 · Maya owes you $5.00");
	expect.soft(out.after, "Maya takes over Audrey's $5.00 too (DEFECT)").toContain("Maya owes you $10.00");
	console.log(JSON.stringify(out, null, 1));
	await m.ctx.close();
	await ctx.close();
});

test("home change vs budgets, pooled payment edit, receipt upload, delete + undo", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dev@example.com", "Dev", "User");
	const c = await clone(ctx.request);
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	const out: Record<string, unknown> = {};
	await callFn(page, "setBudgetLine", { tripId: c.tripId, nodeId: null, category: null, memberId: null, amountMinor: 300000, kind: "total" });
	const pooled = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Pooled cash dinner",
		amountMinor: 9000,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }, { memberId: audrey }] },
		payments: [pay(9000, [{ memberId: owner, amountMinor: 5000 }, { memberId: maya, amountMinor: 4000 }])],
	});
	// edit the pooled payment amount + total in the editor
	await openMoney(page, c.slug);
	const dialog = page.getByTestId(TESTID.addExpenseDialog);
	await page.getByTestId(M.expenseRow).filter({ hasText: "Pooled cash dinner" }).click();
	await expect(dialog).toBeVisible();
	out.paymentRow = await dialog.getByTestId(M.paymentRow).innerText();
	await dialog.getByTestId(M.amount).fill("9900");
	await dialog.getByTestId(M.paymentRow).getByLabel("Payment amount").fill("9900");
	await dialog.getByTestId(M.save).click();
	await page.waitForTimeout(1500);
	out.pooledEditDialogOpen = await dialog.isVisible();
	out.pooledEditToasts = await page.locator("[data-sonner-toast]").allInnerTexts();
	await page.screenshot({ path: `${SHOTS}/pooled-edit.png` });
	await page.keyboard.press("Escape");
	// receipt upload on a new expense
	await page.getByTestId(M.addButton).first().click();
	await dialog.getByTestId(M.amount).fill("1234");
	await dialog.getByTestId(M.title).fill("With receipt");
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
	await dialog.getByTestId(M.receipt).setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: png });
	await dialog.getByTestId(M.save).click();
	await expect(dialog).toBeHidden();
	await page.waitForTimeout(3000);
	out.receiptToasts = await page.locator("[data-sonner-toast]").allInnerTexts();
	await page.getByTestId(M.expenseRow).filter({ hasText: "With receipt" }).click();
	await expect(dialog).toBeVisible();
	await page.waitForTimeout(1500);
	out.receipts = await dialog.getByTestId(M.receipts).innerText();
	await page.screenshot({ path: `${SHOTS}/receipt.png` });
	// delete + undo
	await dialog.getByTestId(M.delete).click();
	await expect(dialog).toBeHidden();
	out.deleteToast = await page.locator("[data-sonner-toast]").allInnerTexts();
	await page.locator("[data-sonner-toast]").getByRole("button", { name: /Undo/ }).first().click();
	await page.waitForTimeout(1500);
	out.restored = await page.getByTestId(M.expenseRow).filter({ hasText: "With receipt" }).count();
	// home currency → JPY: budgets?
	await callFn(page, "updateTrip", { tripId: c.tripId, settings: { currency: "JPY" } }, "/src/functions/trips.functions.ts");
	await page.waitForTimeout(6000);
	const money = await callFn<Money & { budgets: { amountMinor: number }[] }>(page, "listMoney", { tripId: c.tripId });
	out.afterJpy = { home: money.homeCurrency, budgets: money.budgets.map((b) => b.amountMinor), exp: money.expenses.map((e) => [e.title, e.homeAmountMinor]) };
	await openMoney(page, c.slug);
	out.budgetJpy = await page.getByTestId(M.budget).innerText();
	expect.soft(out.pooledEditToasts, "a pooled payment can be edited (DEFECT)").toEqual([]);
	expect.soft(out.restored).toBe(1);
	expect.soft((out.afterJpy as { budgets: number[] }).budgets[0], "budgets follow a home-currency change (DEFECT)").not.toBe(300000);
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
	void pooled;
});

test("Asia 2027 (QA seed): Dennis and Audrey, Vietnam Local, per-scope", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const d = await userPage(browser, "dennis@asia2027.test");
	await openMoney(d.page, "asia-2027");
	out.dennisRoot = { s: await d.page.getByTestId(M.summary).innerText(), b: await d.page.getByTestId(M.balances).innerText(), rows: await d.page.getByTestId(M.expenseRow).allInnerTexts() };
	await d.page.screenshot({ path: `${SHOTS}/asia-dennis-root.png`, fullPage: true });
	const vn = await d.page.evaluate(() => [...document.querySelectorAll('[data-testid="outline-row"], a')].map((a) => (a as HTMLAnchorElement).href).filter((h) => /vietnam/i.test(h)).slice(0, 3));
	out.vnLinks = vn;
	await openMoney(d.page, "asia-2027", "/vietnam");
	await d.page.getByTestId(M.displayCurrency).click();
	await d.page.getByRole("option", { name: /Local/ }).click();
	await d.page.waitForTimeout(800);
	await d.page.getByTestId(M.addButton).first().click();
	const dlg = d.page.getByTestId(TESTID.addExpenseDialog);
	out.vnCurrency = await dlg.getByTestId(M.currency).innerText();
	await dlg.getByTestId(M.amount).fill("150.000");
	await dlg.getByTestId(M.title).fill("Banh mi");
	await d.page.waitForTimeout(300);
	out.vnConverted = await dlg.getByTestId(M.converted).innerText().catch(() => null);
	await dlg.getByTestId(M.save).click();
	await expect(dlg).toBeHidden();
	out.vnScope = { btn: await d.page.getByTestId(M.displayCurrency).innerText(), s: await d.page.getByTestId(M.summary).innerText(), rows: await d.page.getByTestId(M.expenseRow).allInnerTexts() };
	await d.page.screenshot({ path: `${SHOTS}/asia-vietnam-local.png`, fullPage: true });
	await d.page.getByTestId(M.displayCurrency).click();
	await d.page.getByRole("option", { name: /Home currency/ }).click();
	await d.ctx.close();
	const a = await userPage(browser, "audrey@asia2027.test");
	await openMoney(a.page, "asia-2027", "/japan");
	out.audreyJapan = { s: await a.page.getByTestId(M.summary).innerText(), n: await a.page.getByTestId(M.netPositions).innerText().catch(() => "none"), rows: await a.page.getByTestId(M.expenseRow).allInnerTexts() };
	await a.page.screenshot({ path: `${SHOTS}/asia-audrey-japan.png`, fullPage: true });
	await a.ctx.close();
	const k = await userPage(browser, "kai@asia2027.test");
	await openMoney(k.page, "asia-2027");
	out.kai = { add: await k.page.getByTestId(M.addButton).first().isEnabled(), rows: await k.page.getByTestId(M.expenseRow).count() };
	await k.ctx.close();
	const e = await userPage(browser, "eve@asia2027.test");
	await e.page.goto("/t/asia-2027?tab=money");
	await e.page.waitForTimeout(3000);
	out.eve = { url: e.page.url(), money: await e.page.getByTestId(TESTID.moneyTab).count() };
	await e.ctx.close();
	expect.soft((out.kai as { add: boolean }).add).toBe(false);
	expect.soft((out.eve as { money: number }).money).toBe(0);
	expect.soft(out.vnCurrency).toBe("VND");
	console.log(JSON.stringify(out, null, 1));
});

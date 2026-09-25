/**
 * QA I2 "money" verifier, round 2 (ADDENDUM §6–§7.3, EXTENSIONS §8): the
 * edge cases round 1 didn't cover, plus the money side of the round-1
 * security reports (a view-link guest claiming a placeholder; a demoted
 * member keeping an old edit-link grant). Self-contained: logs in through
 * the API, clones the demo per test. Run against an isolated server:
 *   APP_URL=http://localhost:5350 … --workers 1
 */
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { MONEY_TESTID as M } from "../../../src/features/money/testids";
import { TESTID } from "../../../src/lib/testids";

const BASE = process.env.APP_URL ?? "http://localhost:5350";
const SHOTS = process.env.QA_SHOTS ?? "/tmp/qa-money-shots";
const MONEY = "/src/features/money/money.functions.ts";
const SHARING = "/src/features/home/sharing.functions.ts";
const GRAPH = "/src/functions/graph.functions.ts";
const INBOX = "/src/functions/inbox.functions.ts";
const ACT = "/src/functions/activity.functions.ts";
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
		return (e as Error).message;
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
	payments: { id: string; amountMinor: number; currency: string; homeAmountMinor: number | null; fxDate: string | null; fxRate: number | null; fxSource?: string | null; paidAt: string; payers: { memberId: string; amountMinor: number }[] }[];
	lines: { label: string; amountMinor: number; memberIds: string[] }[];
	fees: unknown[];
	target: unknown;
	category: string;
	isPrivate: boolean;
	points: unknown;
};
type Money = {
	homeCurrency: string;
	ratesAsOf: string | null;
	expenses: Exp[];
	settlements: { id: string; amountMinor: number; currency: string; homeAmountMinor: number | null; fxRate: number | null; netAfter: Record<string, number> | null; scope: unknown }[];
	latestRates?: Record<string, number>;
	budgets: { id: string; nodeId: string | null; memberId: string | null; category: string | null; amountMinor: number; kind: string }[];
};

const pay = (amountMinor: number, payers: { memberId: string; amountMinor: number }[], currency = "JPY", paidAt = new Date().toISOString(), paidTz = "Asia/Tokyo") => ({
	paidAt,
	paidTz,
	currency,
	amountMinor,
	payers,
});

/** The engine's balances as the tab shows them. */
async function balancesText(page: Page, slug: string) {
	await openMoney(page, slug);
	return (await page.getByTestId(M.balances).innerText()).replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// 1. Round-1 security reports, money side
// ---------------------------------------------------------------------------

test("R1 re-verify: a signed-in VIEW-link guest can't claim a placeholder into money", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o1-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	await openMoney(o.page, c.slug);
	await callFn(o.page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Ryokan deposit",
		amountMinor: 30000,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: c.members.owner }, { memberId: c.members.audrey }] },
		payments: [pay(30000, [{ memberId: c.members.owner, amountMinor: 30000 }])],
	});
	// A stranger named Audrey (so the first-name match can't be the only guard)
	const s = await userPage(browser, `qa-money-r2-s1-${uniq()}@example.com`, "Audrey", "Stranger");
	await s.page.goto(`/join#t=${c.shareTokens.viewer}`);
	await s.page.waitForURL(/\/t\//, { timeout: 30_000 });
	await waitLive(s.page);
	out.tabsBefore = await s.page.getByRole("tab").allInnerTexts();
	out.claim = await callFnErr(s.page, "claimPlaceholder", { tripId: c.tripId, memberId: c.members.audrey }, SHARING);
	await s.page.reload();
	await waitLive(s.page);
	out.tabsAfter = await s.page.getByRole("tab").allInnerTexts();
	out.listMoney = await callFnErr(s.page, "listMoney", { tripId: c.tripId });
	out.csv = await callFnErr(s.page, "exportMoneyCsv", { tripId: c.tripId });
	out.me = await s.page.evaluate(() => (window as unknown as { __yonder?: { graph?: { me?: unknown } } }).__yonder?.graph?.me ?? null);
	await s.page.screenshot({ path: `${SHOTS}/r2-stranger-after-claim.png` });
	// the same through the edit link
	const s2 = await userPage(browser, `qa-money-r2-s2-${uniq()}@example.com`, "Audrey", "Other");
	await s2.page.goto(`/join#t=${c.shareTokens.editor}`);
	await s2.page.waitForURL(/\/t\//, { timeout: 30_000 });
	await waitLive(s2.page);
	out.claimEditLink = await callFnErr(s2.page, "claimPlaceholder", { tripId: c.tripId, memberId: c.members.audrey }, SHARING);
	out.listMoneyEditLink = await callFnErr(s2.page, "listMoney", { tripId: c.tripId });
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.claim, "claim refused for a view-link guest").toContain("FORBIDDEN");
	expect.soft(out.claimEditLink, "claim refused for an edit-link guest").toContain("FORBIDDEN");
	expect.soft(out.listMoney).toContain("FORBIDDEN");
	expect.soft(out.listMoneyEditLink).toContain("FORBIDDEN");
	expect.soft(String(out.tabsAfter)).not.toContain("Money");
	await s.ctx.close();
	await s2.ctx.close();
	await o.ctx.close();
});

test("R1 re-verify: a promoted guest demoted to 'Can view' loses money writes (old edit-link grant)", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o2-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	await openMoney(o.page, c.slug);
	const gEmail = `qa-money-r2-g-${uniq()}@example.com`;
	const g = await userPage(browser, gEmail, "Gina", "Guest");
	await g.page.goto(`/join#t=${c.shareTokens.editor}`);
	await g.page.waitForURL(/\/t\//, { timeout: 30_000 });
	await waitLive(g.page);
	const gUser = await g.page.evaluate(async () => (await (await fetch("/api/auth/get-session")).json()).user.id as string);
	out.promote = await callFn(o.page, "promoteGuest", { tripId: c.tripId, userId: gUser, role: "suggester" }, SHARING).catch((e) => String(e));
	await g.page.reload();
	await waitLive(g.page);
	out.meAfterPromote = await g.page.evaluate(() => (window as unknown as { __yonder?: { graph?: { me?: unknown } } }).__yonder?.graph?.me ?? null);
	out.suggesterCreate = await callFnErr(g.page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "Gina coffee", amountMinor: 500, currency: "JPY" });
	const memberId = (out.promote as { memberId?: string }).memberId as string;
	out.demote = await callFnErr(o.page, "updateMemberRole", { memberId, role: "viewer" }, SHARING);
	await g.page.reload();
	await waitLive(g.page);
	out.meAfterDemote = await g.page.evaluate(() => (window as unknown as { __yonder?: { graph?: { me?: unknown } } }).__yonder?.graph?.me ?? null);
	out.viewerCreate = await callFnErr(g.page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, title: "after demotion", amountMinor: 500, currency: "JPY" });
	out.viewerSettle = await callFnErr(g.page, "createSettlement", { tripId: c.tripId, fromMemberId: memberId, toMemberId: c.members.owner, amountMinor: 100, currency: "JPY", settledAt: new Date().toISOString(), settledTz: "Asia/Tokyo" });
	out.viewerListMoney = await callFnErr(g.page, "listMoney", { tripId: c.tripId });
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.suggesterCreate, "a suggester member adds an expense directly").toBeNull();
	expect.soft((out.meAfterDemote as { role?: string })?.role).toBe("viewer");
	expect.soft(out.viewerCreate, "a 'Can view' member can't add expenses").toContain("FORBIDDEN");
	expect.soft(out.viewerSettle).toContain("FORBIDDEN");
	expect.soft(out.viewerListMoney, "a viewer member still reads money").toBeNull();
	await g.ctx.close();
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 2. Engine edge cases through the real server functions
// ---------------------------------------------------------------------------

test("API edge cases: rounding owner, fixed tip, validation, mixed-currency payments, old dates, unknown currency", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o3-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	await openMoney(page, c.slug);
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	const find = async (id: string) => (await callFn<Money>(page, "listMoney", { tripId: c.tripId })).expenses.find((e) => e.id === id) as Exp;

	// a) payer outside the split: ¥1001 split owner+maya paid by Audrey → exact sum, leftover by member order
	const a = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Payer outside", amountMinor: 1001, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: maya }, { memberId: owner }] },
		payments: [pay(1001, [{ memberId: audrey, amountMinor: 1001 }])],
	});
	// b) payer inside: ¥100 split 3 paid by Maya → Maya takes the leftover
	const b = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Leftover to payer", amountMinor: 100, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }, { memberId: audrey }] },
		payments: [pay(100, [{ memberId: maya, amountMinor: 100 }])],
	});
	// c) itemized with a fixed tip and a % tax
	const cc = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Tip test", amountMinor: 3601, currency: "JPY",
		lines: [
			{ label: "A", amountMinor: 1000, memberIds: [owner] },
			{ label: "B", amountMinor: 2000, memberIds: [maya, audrey] },
		],
		fees: [
			{ label: "Tax", kind: "percent", percent: 10 },
			{ label: "Tip", kind: "fixed", amountMinor: 301 },
		],
		payments: [pay(3601, [{ memberId: owner, amountMinor: 3601 }])],
	});
	out.tipSplit = await callFn<unknown>(page, "listMoney", { tripId: c.tripId }).then((m) => (m as Money).expenses.find((e) => e.id === cc.id));
	// d) lines + fees that don't add up
	out.itemizeBad = await callFnErr(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Bad items", amountMinor: 5000, currency: "JPY",
		lines: [{ label: "A", amountMinor: 1000, memberIds: [owner] }],
		fees: [{ label: "Tax", kind: "percent", percent: 10 }],
	});
	// e) payers that don't add up
	out.payersBad = await callFnErr(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Bad payers", amountMinor: 5000, currency: "JPY",
		payments: [pay(5000, [{ memberId: owner, amountMinor: 3000 }, { memberId: maya, amountMinor: 1000 }])],
	});
	// f) negative without a refund link
	out.negativeNoRefund = await callFnErr(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Negative", amountMinor: -500, currency: "JPY",
	});
	// g) a private expense can't be split with others
	out.privateSplit = await callFnErr(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Private split", amountMinor: 1000, currency: "JPY", isPrivate: true,
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(1000, [{ memberId: owner, amountMinor: 1000 }])],
	});
	// h) a member id from another trip
	out.foreignMember = await callFnErr(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Foreign", amountMinor: 1000, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: "01a0cf00-0000-7000-8000-000000000001" }] },
	});
	// i) a ¥ planned cost with a USD deposit (card charged in USD), then the rest in ¥
	const i = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Mixed-currency ryokan", category: "lodging", amountMinor: 60000, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(10000, [{ memberId: owner, amountMinor: 10000 }], "USD", "2026-06-15T15:00:00.000Z", "America/New_York")],
	});
	const iE = await find(i.id);
	out.mixed = { status: iE.status, home: iE.homeAmountMinor, pay: iE.payments.map((p) => [p.currency, p.amountMinor, p.homeAmountMinor, p.fxDate]) };
	await openMoney(page, c.slug);
	out.mixedRow = await page.getByTestId(M.expenseRow).filter({ hasText: "Mixed-currency" }).innerText();
	// j) a payment years back (before the rate source's history) and one in the future
	const j = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Old booking", amountMinor: 20000, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(20000, [{ memberId: owner, amountMinor: 20000 }], "JPY", "2019-03-01T03:00:00.000Z")],
	}).catch((e) => ({ id: "", err: String(e) }));
	out.oldDate = j.id ? await find(j.id).then((e) => ({ status: e.status, home: e.homeAmountMinor, pay: e.payments.map((p) => [p.homeAmountMinor, p.fxDate, p.fxRate]) })) : j;
	const k = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Future-dated", amountMinor: 1000, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(1000, [{ memberId: owner, amountMinor: 1000 }], "JPY", "2027-10-10T03:00:00.000Z")],
	}).catch((e) => ({ id: "", err: String(e) }));
	out.futureDate = k.id ? await find(k.id).then((e) => ({ status: e.status, pay: e.payments.map((p) => [p.homeAmountMinor, p.fxDate]) })) : k;
	// k) an unknown currency code
	out.unknownCurrency = await callFnErr(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Unknown currency", amountMinor: 1000, currency: "QQQ",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(1000, [{ memberId: owner, amountMinor: 1000 }], "QQQ")],
	});
	// l) a USD cost paid in ¥ cash
	const l = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "USD tour paid in yen", amountMinor: 5000, currency: "USD",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(7900, [{ memberId: maya, amountMinor: 7900 }], "JPY")],
	}).catch((e) => ({ id: "", err: String(e) }));
	out.usdPaidInYen = l.id ? await find(l.id).then((e) => ({ status: e.status, home: e.homeAmountMinor, pay: e.payments.map((p) => [p.currency, p.amountMinor, p.homeAmountMinor]) })) : l;

	const money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.a = money.expenses.find((e) => e.id === a.id)?.shares;
	out.b = money.expenses.find((e) => e.id === b.id)?.shares;
	await openMoney(page, c.slug);
	out.rows = await page.getByTestId(M.expenseRow).allInnerTexts();
	out.summary = await page.getByTestId(M.summary).innerText();
	out.people = await page.getByTestId(M.people).innerText();
	out.bal = await page.getByTestId(M.balances).innerText();
	await page.screenshot({ path: `${SHOTS}/r2-edge-root.png`, fullPage: true });
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.itemizeBad).toBeTruthy();
	expect.soft(out.payersBad).toBeTruthy();
	expect.soft(out.negativeNoRefund, "a negative amount needs a refund link").toBeTruthy();
	// a private expense's split is ignored (it stays the creator's alone): accepted by design
	expect.soft(out.foreignMember).toBeTruthy();
});

test("points: two bookings of one programme average cpp; points-only never in balances", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o4-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	out.balBefore = (await page.getByTestId(M.balances).innerText()).replace(/\s+/g, " ");
	// booking 1: 240k Aeroplan (from 200k Chase UR), cash price $6000, taxes $300 paid
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "JFK-HND J", category: "transport",
		amountMinor: 30000, currency: "USD",
		points: { program: "Aeroplan", points: 240000, sourceProgram: "Chase UR", sourcePoints: 200000, cashValueMinor: 600000, cashValueCurrency: "USD" },
		split: { mode: "equal", shares: [{ memberId: owner }] },
		payments: [pay(30000, [{ memberId: owner, amountMinor: 30000 }], "USD", new Date().toISOString(), "America/New_York")],
	});
	// booking 2: 60k Aeroplan, points only (no cash), cash price $900
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "ICN-HAN Y", category: "transport",
		points: { program: "Aeroplan", points: 60000, cashValueMinor: 90000, cashValueCurrency: "USD" },
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
	}).catch((e) => {
		out.pointsOnlyErr = String(e);
	});
	await openMoney(page, c.slug);
	out.summary = await page.getByTestId(M.summary).innerText();
	out.people = await page.getByTestId(M.people).innerText();
	out.bal = (await page.getByTestId(M.balances).innerText()).replace(/\s+/g, " ");
	out.rows = await page.getByTestId(M.expenseRow).allInnerTexts();
	await page.screenshot({ path: `${SHOTS}/r2-points.png`, fullPage: true });
	// average: (6000-300 + 900) / 300000 = 2.2¢
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.pointsOnlyErr).toBeUndefined();
	expect.soft(String(out.summary), "Aeroplan averaged over both bookings").toContain("2.20¢");
	expect.soft(out.bal, "points never enter balances").toBe(out.balBefore);
	await o.ctx.close();
});

test("settlements: mismatch leaves a visible remainder, scope tag, delete restores, CAD display in settle-up", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o5-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Dinner", amountMinor: 10000, currency: "USD",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(10000, [{ memberId: owner, amountMinor: 10000 }], "USD", new Date().toISOString(), "America/New_York")],
	});
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Taxi", amountMinor: 3000, currency: "USD",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: audrey }] },
		payments: [pay(3000, [{ memberId: owner, amountMinor: 3000 }], "USD", new Date().toISOString(), "America/New_York")],
	});
	out.bal0 = await balancesText(page, c.slug);
	// Maya pays ¥7,000 (≈ $44.4 < $50): a visible remainder must stay
	const s1 = await callFn<{ id: string }>(page, "createSettlement", {
		tripId: c.tripId, fromMemberId: maya, toMemberId: owner, amountMinor: 7000, currency: "JPY",
		settledAt: new Date().toISOString(), settledTz: "Asia/Tokyo", method: "cash", scope: { nodeId: c.ids.nodes.kyoto },
	});
	out.bal1 = await balancesText(page, c.slug);
	// Settle up dialog with display CAD
	await page.getByTestId(M.displayCurrency).click();
	await page.getByRole("option", { name: /^CAD/ }).first().click();
	await page.waitForTimeout(800);
	out.balCad = (await page.getByTestId(M.balances).innerText()).replace(/\s+/g, " ");
	await page.getByTestId(M.settleUpButton).click();
	const dlg = page.getByTestId(M.settleUpDialog);
	await expect(dlg).toBeVisible();
	out.settleCad = (await dlg.innerText()).replace(/\n+/g, " | ");
	await page.screenshot({ path: `${SHOTS}/r2-settle-cad.png` });
	await page.keyboard.press("Escape");
	// Maya's view isn't changed by my display currency
	const m = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(m.page, c.slug);
	out.mayaBtn = await m.page.getByTestId(M.displayCurrency).innerText();
	out.mayaBal = (await m.page.getByTestId(M.balances).innerText()).replace(/\s+/g, " ");
	await m.ctx.close();
	await page.getByTestId(M.displayCurrency).click();
	await page.getByRole("option", { name: /Home currency/ }).click();
	// delete the settlement → the balance comes back
	await callFn(page, "deleteSettlement", { id: s1.id });
	out.bal2 = await balancesText(page, c.slug);
	// settle exactly in USD, then zero
	const money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.settlementsAfterDelete = money.settlements.length;
	await callFn(page, "createSettlement", {
		tripId: c.tripId, fromMemberId: maya, toMemberId: owner, amountMinor: 5000, currency: "USD",
		settledAt: new Date().toISOString(), settledTz: "America/New_York", method: "Venmo",
	});
	out.bal3 = await balancesText(page, c.slug);
	// a settlement between the same person, zero, negative
	out.selfSettle = await callFnErr(page, "createSettlement", { tripId: c.tripId, fromMemberId: owner, toMemberId: owner, amountMinor: 1, currency: "USD", settledAt: new Date().toISOString(), settledTz: "UTC" });
	out.zeroSettle = await callFnErr(page, "createSettlement", { tripId: c.tripId, fromMemberId: maya, toMemberId: owner, amountMinor: 0, currency: "USD", settledAt: new Date().toISOString(), settledTz: "UTC" });
	await page.getByTestId(M.settleUpButton).click();
	out.dialogRecorded = (await page.getByTestId(M.settleUpDialog).innerText()).replace(/\n+/g, " | ");
	await page.screenshot({ path: `${SHOTS}/r2-settle-recorded.png` });
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.bal1, "a ¥7,000 payment of a $50 debt leaves a visible remainder").toMatch(/Maya owes you \$[1-9]/);
	expect.soft(out.settleCad, "settle-up: home first, display second").toMatch(/\$15\.00 \| ≈ C\$/);
	expect.soft(out.mayaBtn).not.toContain("CAD");
	expect.soft(out.bal2).toBe(out.bal0);
	expect.soft(out.selfSettle).toBeTruthy();
	expect.soft(out.zeroSettle).toBeTruthy();
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 3. Budgets UI
// ---------------------------------------------------------------------------

test("budgets UI: Custom badge, Follow default, Reset, category over-allocation, suggester limits, private label", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o6-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request, { mayaRole: "suggester" });
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	const N = c.ids.nodes;
	await openMoney(page, c.slug);
	const setLine = (p: Page, nodeId: string | null, memberId: string | null, amountMinor: number, category: string | null = null, kind = "total") =>
		callFn<{ id: string }>(p, "setBudgetLine", { tripId: c.tripId, nodeId, category, memberId, amountMinor, kind });
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "node", nodeId: N.kyoto }, title: "Kyoto dinner", category: "food_drink",
		amountMinor: 10000, currency: "USD",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(10000, [{ memberId: owner, amountMinor: 10000 }], "USD", new Date().toISOString(), "America/New_York")],
	});
	// Japan: all $100, food $80 + lodging $50 → categories over-allocate the all line
	await setLine(page, N.japan as string, null, 10000);
	await setLine(page, N.japan as string, null, 8000, "food_drink");
	await setLine(page, N.japan as string, null, 5000, "lodging");
	const m = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await openMoney(m.page, c.slug);
	out.suggesterDefault = await callFnErr(m.page, "setBudgetLine", { tripId: c.tripId, nodeId: N.japan, category: null, memberId: null, amountMinor: 1, kind: "total" });
	out.suggesterOwn = await callFnErr(m.page, "setBudgetLine", { tripId: c.tripId, nodeId: N.japan, category: null, memberId: maya, amountMinor: 7000, kind: "total" });
	await setLine(page, N.japan as string, null, 12000); // default changes: Maya keeps $70 + sees the notice
	await openMoney(page, c.slug, "/japan");
	out.ownerJapan = await page.getByTestId(M.budget).innerText();
	await page.screenshot({ path: `${SHOTS}/r2-budget-owner-japan.png`, fullPage: true });
	await openMoney(m.page, c.slug, "/japan");
	const mb = m.page.getByTestId(M.budget);
	out.mayaJapan = await mb.innerText();
	out.mayaButtons = await mb.getByRole("button").allInnerTexts();
	await m.page.screenshot({ path: `${SHOTS}/r2-budget-maya-custom.png`, fullPage: true });
	// Follow default → Maya's own line is gone
	const follow = mb.getByRole("button", { name: /Follow default/ });
	if (await follow.count()) {
		await follow.first().click();
		await m.page.waitForTimeout(1200);
	}
	out.mayaAfterFollow = await mb.innerText();
	let money = await callFn<Money>(m.page, "listMoney", { tripId: c.tripId });
	out.mayaLinesAfterFollow = money.budgets.filter((b) => b.memberId === maya).length;
	// Set a custom one again through the UI edit button, then Reset to trip default
	const edit = mb.getByTestId(M.budgetEdit).first();
	out.editButtons = await mb.getByTestId(M.budgetEdit).count();
	if (await edit.count()) {
		await edit.click();
		await m.page.waitForTimeout(500);
		out.editUi = await m.page.locator('[role="dialog"], [data-radix-popper-content-wrapper]').last().innerText().catch(() => "none");
		await m.page.screenshot({ path: `${SHOTS}/r2-budget-maya-edit.png` });
		await m.page.keyboard.press("Escape");
	}
	await setLine(m.page, N.japan as string, maya, 9000);
	await openMoney(m.page, c.slug, "/japan");
	out.mayaCustom2 = await mb.innerText();
	const reset = mb.getByRole("button", { name: /Reset to trip default/ });
	out.resetCount = await reset.count();
	if (out.resetCount) {
		await reset.first().click();
		await m.page.waitForTimeout(1200);
	}
	money = await callFn<Money>(m.page, "listMoney", { tripId: c.tripId });
	out.mayaLinesAfterReset = money.budgets.filter((b) => b.memberId === maya).length;
	// private toggle: Maya hides, owner's Group view says "private"
	await callFn(m.page, "setBudgetLine", { tripId: c.tripId, nodeId: N.kyoto, category: null, memberId: maya, amountMinor: 4000, kind: "total" });
	const priv = m.page.getByTestId(M.budgetPrivate);
	out.privToggle = await priv.count();
	if (out.privToggle) {
		await priv.first().click();
		await m.page.waitForTimeout(1000);
	}
	await m.page.screenshot({ path: `${SHOTS}/r2-budget-maya-private.png`, fullPage: true });
	await openMoney(page, c.slug, "/japan/kyoto");
	await page.getByTestId(M.budget).getByRole("radio", { name: "Group" }).click();
	out.ownerKyotoGroup = await page.getByTestId(M.budget).innerText();
	await page.screenshot({ path: `${SHOTS}/r2-budget-owner-group.png`, fullPage: true });
	const om = await callFn<Money & { privateBudgetMemberIds: string[] }>(page, "listMoney", { tripId: c.tripId });
	out.ownerSeesMaya = om.budgets.filter((b) => b.memberId === maya).length;
	out.privateIds = om.privateBudgetMemberIds;
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.suggesterDefault, "a suggester can't set the trip default").toContain("FORBIDDEN");
	expect.soft(out.suggesterOwn, "a suggester sets their own line").toBeNull();
	expect.soft(String(out.ownerJapan), "categories that add up past the all line warn").toMatch(/[Oo]ver-allocated/);
	expect.soft(String(out.mayaJapan)).toContain("Custom");
	expect.soft(String(out.mayaJapan)).toContain("Trip default is now $120.00; yours stays $70.00");
	expect.soft(out.mayaLinesAfterFollow).toBe(0);
	// Reset and the private toggle live in the row popover / ⋯ menu: see "budgets UI 2"
	await m.ctx.close();
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 4. Guests: digest, counts, inbox (a signed-in guest on the edit link)
// ---------------------------------------------------------------------------

test("signed-in link guest: no money in digest, counts, inbox, Plan cards, item overview", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o7-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	const g = await userPage(browser, `qa-money-r2-g7-${uniq()}@example.com`, "Gus", "Guest");
	await g.page.goto(`/join#t=${c.shareTokens.editor}`);
	await g.page.waitForURL(/\/t\//, { timeout: 30_000 });
	await waitLive(g.page);
	const d0 = await callFn<{ currentVersion: number }>(g.page, "getDigest", { tripId: c.tripId }, ACT).catch((e) => ({ err: String(e), currentVersion: 0 }));
	out.digest0 = d0;
	out.markSeen = await callFnErr(g.page, "markTripSeen", { tripId: c.tripId, version: d0.currentVersion }, ACT);
	await openMoney(page, c.slug);
	const itemId = c.ids.items.sky as string;
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "item", itemId }, title: "Shibuya Sky tickets", amountMinor: 6000, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(6000, [{ memberId: owner, amountMinor: 6000 }])],
	});
	await callFn(page, "createSettlement", { tripId: c.tripId, fromMemberId: maya, toMemberId: owner, amountMinor: 3000, currency: "JPY", settledAt: new Date().toISOString(), settledTz: "Asia/Tokyo" });
	await callFn(page, "setBudgetLine", { tripId: c.tripId, nodeId: null, category: null, memberId: null, amountMinor: 100000, kind: "total" });
	await g.page.waitForTimeout(1500);
	out.digest1 = await callFn(g.page, "getDigest", { tripId: c.tripId }, ACT).catch((e) => ({ err: String(e) }));
	out.ownerDigest = await callFn(page, "getDigest", { tripId: c.tripId }, ACT).catch((e) => ({ err: String(e) }));
	out.counts = await callFn(g.page, "getTripCounts", { tripId: c.tripId }, GRAPH).catch((e) => String(e));
	out.inbox = await callFnErr(g.page, "listInbox", { tripId: c.tripId }, INBOX);
	const inb = await callFn<{ items: { kind: string }[] }>(g.page, "listInbox", { tripId: c.tripId }, INBOX).catch(() => null);
	out.inboxKinds = inb?.items?.map((x) => x.kind);
	out.listMoney = await callFnErr(g.page, "listMoney", { tripId: c.tripId });
	await g.page.goto(`/t/${c.slug}?tab=plan`);
	await waitLive(g.page);
	out.wallet = await g.page.locator("svg.lucide-wallet").count();
	out.bodyHasYen = await g.page.evaluate(() => /¥6,000|Shibuya Sky tickets/.test(document.body.innerText));
	await g.page.screenshot({ path: `${SHOTS}/r2-guest-plan.png` });
	// the item's overview for the guest
	await g.page.goto(`/t/${c.slug}?sel=i.${itemId}`);
	await waitLive(g.page);
	await g.page.waitForTimeout(1000);
	out.guestItemText = (await g.page.locator("body").innerText()).match(/.{0,40}(Money|Expense|¥6,000|Wallet).{0,40}/g);
	await g.page.screenshot({ path: `${SHOTS}/r2-guest-item.png` });
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.listMoney).toContain("FORBIDDEN");
	expect.soft(out.wallet).toBe(0);
	expect.soft(out.bodyHasYen).toBe(false);
	expect.soft(JSON.stringify(out.counts)).not.toMatch(/expense|money/i);
	expect.soft(JSON.stringify(out.digest1)).not.toMatch(/expense|settlement|budget/i);
	await g.ctx.close();
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 5. Budgets through the menus (Reset lives in the edit popover, private in ⋯)
// ---------------------------------------------------------------------------

test("budgets UI 2: Reset to trip default in the editor, Keep my budgets private, group view with partial budgets", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o8-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	const N = c.ids.nodes;
	await openMoney(page, c.slug);
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "node", nodeId: N.kyoto }, title: "Kyoto dinner", category: "food_drink",
		amountMinor: 10000, currency: "USD",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(10000, [{ memberId: owner, amountMinor: 10000 }], "USD", new Date().toISOString(), "America/New_York")],
	});
	await callFn(page, "setBudgetLine", { tripId: c.tripId, nodeId: N.kyoto, category: null, memberId: null, amountMinor: 8000, kind: "total" });
	const m = await userPage(browser, "maya@example.com", "Maya", "Chen");
	await callFn(m.page, "setBudgetLine", { tripId: c.tripId, nodeId: N.kyoto, category: null, memberId: maya, amountMinor: 4000, kind: "total" }).catch(async () => {
		await openMoney(m.page, c.slug);
		await callFn(m.page, "setBudgetLine", { tripId: c.tripId, nodeId: N.kyoto, category: null, memberId: maya, amountMinor: 4000, kind: "total" });
	});
	await openMoney(m.page, c.slug, "/japan/kyoto");
	const mb = m.page.getByTestId(M.budget);
	out.mayaKyoto = await mb.innerText();
	// open the All costs row editor
	await mb.getByTestId(M.budgetEdit).first().click();
	await m.page.waitForTimeout(500);
	const pop = m.page.getByRole("dialog").last();
	out.popover = await pop.innerText().catch(() => "none");
	await m.page.screenshot({ path: `${SHOTS}/r2-budget-edit-popover.png` });
	const reset = m.page.getByRole("button", { name: "Reset to trip default" });
	out.resetVisible = await reset.count();
	if (out.resetVisible) {
		await reset.first().click();
		await m.page.waitForTimeout(1200);
	}
	let money = await callFn<Money>(m.page, "listMoney", { tripId: c.tripId });
	out.mayaLinesAfterReset = money.budgets.filter((b) => b.memberId === maya).length;
	out.mayaKyotoAfterReset = await mb.innerText();
	// set own again, then Keep my budgets private
	await callFn(m.page, "setBudgetLine", { tripId: c.tripId, nodeId: N.kyoto, category: null, memberId: maya, amountMinor: 4000, kind: "total" });
	await mb.getByRole("button", { name: "Budget options" }).click();
	await m.page.getByRole("menuitemcheckbox", { name: /Keep my budgets private/ }).click();
	await m.page.waitForTimeout(1200);
	money = await callFn<Money & { myBudgetPrivate: boolean }>(m.page, "listMoney", { tripId: c.tripId });
	out.mayaPrivate = (money as unknown as { myBudgetPrivate: boolean }).myBudgetPrivate;
	await openMoney(page, c.slug, "/japan/kyoto");
	await page.getByTestId(M.budget).getByRole("radio", { name: "Group" }).click();
	out.ownerGroupPrivate = await page.getByTestId(M.budget).innerText();
	await page.screenshot({ path: `${SHOTS}/r2-budget-owner-group-private.png`, fullPage: true });
	const om = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.ownerSeesMayaLines = om.budgets.filter((b) => b.memberId === maya).length;
	// Maya public again, owner removes the Kyoto default: Group = Maya's $40 alone vs everyone's $100?
	await callFn(m.page, "setBudgetPrivate", { tripId: c.tripId, private: false });
	const def = om.budgets.find((b) => b.memberId === null && b.nodeId === N.kyoto);
	await callFn(page, "deleteBudgetLine", { id: def?.id });
	await openMoney(page, c.slug, "/japan/kyoto");
	await page.getByTestId(M.budget).getByRole("radio", { name: "Group" }).click();
	out.ownerGroupPartial = await page.getByTestId(M.budget).innerText();
	await page.screenshot({ path: `${SHOTS}/r2-budget-group-partial.png`, fullPage: true });
	await openMoney(m.page, c.slug, "/japan/kyoto");
	out.mayaMine = await m.page.getByTestId(M.budget).innerText();
	console.log(JSON.stringify(out, null, 1));
	// DEFECT (stale Trip default / Just me toggle, see the "budget editor" test): Maya's Custom row
	// opened on "Trip default" with "Remove default", so there was no Reset to trip default.
	expect.soft(out.resetVisible, "DEFECT: Custom row popover offers Reset to trip default").toBeGreaterThan(0);
	expect.soft(out.mayaLinesAfterReset).toBe(0);
	expect.soft(out.mayaPrivate).toBe(true);
	expect.soft(out.ownerSeesMayaLines).toBe(0);
	expect.soft(String(out.ownerGroupPrivate)).toContain("private");
	expect.soft(String(out.ownerGroupPartial), "Group view: only Maya has a Kyoto budget ($40, her share $50); the owner's unbudgeted $50 isn't hers").not.toContain("$60.00 over");
	await m.ctx.close();
	await o.ctx.close();
});

// ---------------------------------------------------------------------------
// 6. UI: breakdowns vs totals, inspector panel, day scope, settle dialog, editor, phone
// ---------------------------------------------------------------------------

test("UI look: breakdown adds up to the total, inspector Money, day scope, settle-up dialog, editor with payments", async ({ browser }) => {
	test.setTimeout(240_000);
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o9-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	const N = c.ids.nodes;
	await openMoney(page, c.slug);
	const days = await page.evaluate(() => ((window as unknown as { __yonder: { graph: { days: { id: string; date: string }[] } } }).__yonder.graph.days ?? []).map((d) => [d.id, d.date]));
	out.days = days;
	const itemId = c.ids.items.sky as string;
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "item", itemId }, title: "Shibuya Sky tickets", amountMinor: 6000, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }, { memberId: audrey }] },
		payments: [pay(6000, [{ memberId: owner, amountMinor: 6000 }])],
	});
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "node", nodeId: N.kyoto }, title: "Kyoto ryokan", category: "lodging", amountMinor: 80000, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(20000, [{ memberId: maya, amountMinor: 20000 }], "JPY", "2026-07-01T03:00:00.000Z")],
	});
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "day", dayId: days[1]?.[0] }, title: "Day pass", category: "transport", amountMinor: 1500, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
	});
	await openMoney(page, c.slug);
	const sumOf = async () => {
		const rows = await page.getByTestId(M.breakdown).innerText();
		const planned = /PLANNED\n[≈ ]*\$([\d,.]+)/.exec(await page.getByTestId(M.summary).innerText())?.[1];
		return { rows, planned };
	};
	out.catRoot = await sumOf();
	await page.getByTestId(M.breakdown).getByRole("radio", { name: "Place" }).click({ timeout: 5000 }).catch(() => page.getByTestId(M.breakdown).getByText("Place", { exact: true }).click({ timeout: 5000 }).catch(() => undefined));
	await page.waitForTimeout(400);
	out.placeRoot = await page.getByTestId(M.breakdown).innerText();
	await page.getByTestId(M.breakdown).getByRole("radio", { name: "Day" }).click({ timeout: 5000 }).catch(() => page.getByTestId(M.breakdown).getByText("Day", { exact: true }).click({ timeout: 5000 }).catch(() => undefined));
	await page.waitForTimeout(400);
	out.dayRoot = await page.getByTestId(M.breakdown).innerText();
	await page.screenshot({ path: `${SHOTS}/r2-root-breakdown-day.png`, fullPage: true });
	// day scope (the tab at ?days=)
	await openMoney(page, c.slug, `?days=${days[1]?.[1]}`);
	out.dayScope = { summary: await page.getByTestId(M.summary).innerText(), rows: await page.getByTestId(M.expenseRow).allInnerTexts() };
	await page.screenshot({ path: `${SHOTS}/r2-day-scope.png`, fullPage: true });
	// inspector Money for Kyoto
	await page.goto(`/t/${c.slug}?sel=n.${N.kyoto}`);
	await waitLive(page);
	const insp = page.getByTestId(TESTID.inspector);
	await insp.getByRole("tab", { name: /Money/ }).click({ timeout: 5000 }).catch(() => undefined);
	await page.waitForTimeout(800);
	out.inspectorKyoto = await page.getByTestId(TESTID.moneyPanel).innerText().catch(() => "no panel");
	await page.screenshot({ path: `${SHOTS}/r2-inspector-kyoto.png` });
	// inspector Money for the item
	await page.goto(`/t/${c.slug}?sel=i.${itemId}`);
	await waitLive(page);
	await insp.getByRole("tab", { name: /Money/ }).click({ timeout: 5000 }).catch(() => undefined);
	await page.waitForTimeout(800);
	out.inspectorItem = await page.getByTestId(TESTID.moneyPanel).innerText().catch(() => "no panel");
	await page.screenshot({ path: `${SHOTS}/r2-inspector-item.png` });
	// editor of the partially paid ryokan
	await openMoney(page, c.slug);
	await page.getByTestId(M.expenseRow).filter({ hasText: "Kyoto ryokan" }).click();
	const dlg = page.getByTestId(TESTID.addExpenseDialog);
	await expect(dlg).toBeVisible();
	await page.waitForTimeout(600);
	out.editor = await dlg.innerText();
	await page.screenshot({ path: `${SHOTS}/r2-editor-partial.png` });
	// Mark paid in the editor
	const mark = dlg.getByTestId(M.markPaid);
	out.markPaidCount = await mark.count();
	if (out.markPaidCount) {
		console.log("EDITOR", JSON.stringify(out, null, 1));
		await mark.first().click({ timeout: 5000 });
		await page.waitForTimeout(600);
		await page.screenshot({ path: `${SHOTS}/r2-editor-markpaid.png` });
		out.afterMark = await dlg.innerText({ timeout: 3000 }).catch(() => "closed");
		if (await dlg.isVisible()) await dlg.getByTestId(M.save).click({ timeout: 5000 }).catch(() => undefined);
		await page.waitForTimeout(1200);
	}
	await page.keyboard.press("Escape");
	const money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const ry = money.expenses.find((e) => e.title === "Kyoto ryokan") as Exp;
	out.ryokanAfterMark = { status: ry.status, pay: ry.payments.map((p) => [p.currency, p.amountMinor, p.payers.map((x) => [x.memberId === owner ? "owner" : x.memberId === maya ? "maya" : "?", x.amountMinor])]) };
	// settle-up dialog, settled state
	await openMoney(page, c.slug);
	await page.getByTestId(M.settleUpButton).click();
	await expect(page.getByTestId(M.settleUpDialog)).toBeVisible();
	await page.waitForTimeout(700);
	out.settle = await page.getByTestId(M.settleUpDialog).innerText();
	await page.screenshot({ path: `${SHOTS}/r2-settle-dialog.png` });
	await page.keyboard.press("Escape");
	console.log(JSON.stringify(out, null, 1));
	const cat = out.catRoot as { rows: string; planned: string };
	const catSum = [...cat.rows.matchAll(/\n\$([\d,.]+)/g)].reduce((a, m) => a + Number((m[1] as string).replace(/,/g, "")), 0);
	expect.soft(catSum.toFixed(2), "DEFECT: the category breakdown adds up to the Planned total (shopping-list costs are missing)").toBe(cat.planned.replace(/,/g, ""));
	await o.ctx.close();
});

test("phone: Money tab and the add sheet at 412px", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
	await login(ctx.request, `qa-money-r2-p-${uniq()}@example.com`, "Pia", "Phone");
	const page = await ctx.newPage();
	const c = await clone(ctx.request);
	await page.goto(`/t/${c.slug}/japan/kyoto?tab=money`);
	await waitLive(page);
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "node", nodeId: c.ids.nodes.kyoto }, title: "Matcha set", category: "food_drink", amountMinor: 2400, currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: c.members.owner }, { memberId: c.members.maya as string }] },
		payments: [pay(2400, [{ memberId: c.members.owner, amountMinor: 2400 }])],
	});
	await page.goto(`/t/${c.slug}/japan/kyoto?tab=money`);
	await waitLive(page);
	await page.waitForTimeout(800);
	// pull the sheet up to 92%
	await page.mouse.move(206, 812);
	await page.mouse.down();
	await page.mouse.move(206, 500, { steps: 8 });
	await page.mouse.move(206, 90, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(800);
	await page.getByRole("tab", { name: /Money/ }).first().click().catch(() => undefined);
	await page.waitForTimeout(800);
	await page.screenshot({ path: `${SHOTS}/r2-phone-money.png` });
	out.sheetText = (await page.getByTestId(TESTID.mobileSheet).innerText().catch(() => "")).slice(0, 600);
	out.overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	await page.getByTestId(M.addButton).first().click();
	const dlg = page.getByTestId(TESTID.addExpenseDialog);
	await expect(dlg).toBeVisible();
	await page.waitForTimeout(500);
	out.focus = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
	out.inputmode = await dlg.getByTestId(M.amount).getAttribute("inputmode");
	out.currency = await dlg.getByTestId(M.currency).innerText();
	await page.screenshot({ path: `${SHOTS}/r2-phone-add.png` });
	await dlg.getByTestId(M.more).click();
	await page.waitForTimeout(400);
	await page.screenshot({ path: `${SHOTS}/r2-phone-add-more.png`, fullPage: true });
	out.dialogOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.overflow).toBe(0);
	expect.soft(out.focus).toBe(M.amount);
	expect.soft(out.inputmode).toBe("decimal");
	await ctx.close();
});

test("budget editor: the Trip default / Just me toggle is stale when the popover reopens", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o10-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const owner = c.members.owner;
	const N = c.ids.nodes;
	await openMoney(page, c.slug, "/japan/kyoto");
	await callFn(page, "setBudgetLine", { tripId: c.tripId, nodeId: N.kyoto, category: null, memberId: null, amountMinor: 8000, kind: "total" });
	await openMoney(page, c.slug, "/japan/kyoto");
	const b = page.getByTestId(M.budget);
	const row = b.getByTestId(M.budgetEdit).first();
	const pop = () => page.locator("[data-slot=popover-content]").last();
	// 1) my own line: Just me → $40
	await row.click();
	await expect(pop()).toBeVisible();
	await pop().getByRole("radio", { name: "Just me" }).click();
	await pop().getByLabel(/Amount/).fill("40");
	await pop().getByRole("button", { name: "Save" }).click();
	await expect(pop()).toBeHidden();
	await page.waitForTimeout(800);
	out.afterOwn = await b.innerText();
	// 2) the trip default: Trip default → $100
	await b.getByTestId(M.budgetEdit).first().click();
	await expect(pop()).toBeVisible();
	out.pop2 = await pop().innerText();
	await pop().getByRole("radio", { name: "Trip default" }).click();
	await pop().getByLabel(/Amount/).fill("100");
	await pop().getByRole("button", { name: "Save" }).click();
	await expect(pop()).toBeHidden();
	await page.waitForTimeout(800);
	out.afterDefault = await b.innerText();
	// 3) reopen my Custom row to change MY line to $45
	await b.getByTestId(M.budgetEdit).first().click();
	await expect(pop()).toBeVisible();
	out.pop3 = await pop().innerText();
	out.pop3Checked = await pop().getByRole("radio", { checked: true }).allInnerTexts();
	out.pop3Amount = await pop().getByLabel(/Amount/).inputValue();
	await page.screenshot({ path: `${SHOTS}/r2-budget-stale-toggle.png` });
	await pop().getByLabel(/Amount/).fill("45");
	await pop().getByRole("button", { name: "Save" }).click();
	await page.waitForTimeout(1000);
	const money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.lines = money.budgets.filter((x) => x.nodeId === N.kyoto).map((x) => [x.memberId === owner ? "mine" : x.memberId === null ? "default" : "other", x.amountMinor]);
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.pop3Checked, "DEFECT: reopening my Custom row selects Just me").toContain("Just me");
	expect.soft(out.lines, "my $45 goes to my own line, the $100 default stays").toEqual(expect.arrayContaining([["default", 10000], ["mine", 4500]]));
	await o.ctx.close();
});

test("split defaults to the item's people; item ⋯ Add expense; a typed name becomes a placeholder in the split", async ({ browser }) => {
	test.setTimeout(180_000);
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o11-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	const itemId = c.ids.items.sky as string;
	out.assign = await callFnErr(page, "setItemAssignees", { itemId, memberIds: [owner, maya] }, "/src/functions/items.functions.ts");
	const e = await callFn<{ id: string }>(page, "createExpense", { tripId: c.tripId, target: { kind: "item", itemId }, amountMinor: 3600, currency: "JPY" });
	let money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const ex = money.expenses.find((x) => x.id === e.id) as Exp;
	out.itemDefault = { title: ex.title, cat: ex.category, shares: ex.shares.map((s) => (s.memberId === owner ? "owner" : s.memberId === maya ? "maya" : "other")) };
	out.itemAssignees = await page.evaluate((id) => (window as unknown as { __yonder: { graph: { items: { id: string; assignees?: string[]; assigneeIds?: string[] }[] } } }).__yonder.graph.items.find((i) => i.id === id), itemId);
	console.log("EARLY", JSON.stringify(out, null, 1));
	// the Plan card's ⋯ → Add expense
	const d1 = Object.values(c.ids.days)[0];
	await page.goto(`/t/${c.slug}?tab=plan`);
	await waitLive(page);
	const card = page.getByTestId("timeline-item").filter({ hasText: "Shibuya Sky" }).first();
	await card.scrollIntoViewIfNeeded();
	await card.hover();
	await card.getByTestId("plan-item-menu").click({ timeout: 10_000 });
	await page.getByRole("menuitem", { name: /Add expense/ }).click();
	const dlg = page.getByTestId(TESTID.addExpenseDialog);
	await expect(dlg).toBeVisible();
	await page.waitForTimeout(500);
	out.itemDialog = (await dlg.innerText()).replace(/\n+/g, " | ").slice(0, 400);
	out.itemDialogCurrency = await dlg.getByTestId(M.currency).innerText();
	await dlg.getByTestId(M.amount).fill("1800");
	// split: add a typed person
	await dlg.getByTestId(M.splitToggle).click();
	await page.waitForTimeout(300);
	await dlg.getByTestId(M.splitAddPerson).click();
	await page.waitForTimeout(300);
	await page.keyboard.type("Kenji");
	await page.waitForTimeout(500);
	out.pickerOptions = await page.getByRole("option").allInnerTexts();
	await page.screenshot({ path: `${SHOTS}/r2-split-typed-person.png` });
	const add = page.getByRole("option", { name: /Kenji/ }).first();
	if (await add.count()) await add.click();
	await page.waitForTimeout(1200);
	out.splitAfterAdd = (await dlg.innerText()).match(/Split[^\n]*\n[^\n]*/)?.[0];
	await page.screenshot({ path: `${SHOTS}/r2-split-after-kenji.png` });
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
	await dlg.getByTestId(M.save).click();
	await expect(dlg).toBeHidden({ timeout: 10_000 });
	money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const ex2 = money.expenses.find((x) => x.amountMinor === 1800) as Exp;
	const graph = await page.evaluate(() => (window as unknown as { __yonder: { graph: { members: { id: string; name: string; status: string }[] } } }).__yonder.graph.members.map((m) => [m.id, m.name, m.status]));
	out.members = graph.map((m) => `${m[1]}:${m[2]}`);
	out.itemUiExpense = ex2 ? { target: ex2.target, shares: ex2.shares.map((s) => graph.find((m) => m[0] === s.memberId)?.[1] ?? s.memberId) } : "missing";
	await openMoney(page, c.slug);
	out.bal = (await page.getByTestId(M.balances).innerText()).replace(/\s+/g, " ");
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.itemDefault, "split defaults to the people tagged on the item").toMatchObject({ shares: ["owner", "maya"] });
	expect.soft(out.itemDialogCurrency).toBe("JPY");
	expect.soft(JSON.stringify(out.itemUiExpense)).toContain("Kenji");
	void d1;
	await o.ctx.close();
});

test("CSV: day range, Only, display currency vs the tab", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o12-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	const N = c.ids.nodes;
	await openMoney(page, c.slug);
	const days = await page.evaluate(() => ((window as unknown as { __yonder: { graph: { days: { id: string; date: string }[] } } }).__yonder.graph.days ?? []).map((d) => [d.id, d.date]));
	await callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "day", dayId: days[1]?.[0] }, title: "Day pass", amountMinor: 1500, currency: "JPY", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] } });
	await callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "node", nodeId: N.japan }, title: "JR Pass", amountMinor: 50000, currency: "JPY", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] }, payments: [pay(50000, [{ memberId: owner, amountMinor: 50000 }])] });
	await callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "node", nodeId: N.tokyo }, title: "Tokyo metro", amountMinor: 2000, currency: "JPY", split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] }, payments: [pay(2000, [{ memberId: maya, amountMinor: 2000 }])] });
	const total = (csv: string) => /\r\nTotal,,,,,,,([\d.-]+),([\d.-]+)/.exec(csv)?.slice(1);
	const planned = async (path: string) => {
		await openMoney(page, c.slug, path);
		return /PLANNED\n[≈ ]*[A-Z$]*\$?([\d,.]+)/.exec(await page.getByTestId(M.summary).innerText())?.[1]?.replace(/,/g, "");
	};
	const day = await callFn<{ csv: string }>(page, "exportMoneyCsv", { tripId: c.tripId, days: { from: days[1]?.[1], to: days[1]?.[1] } });
	out.dayCsvTotal = total(day.csv);
	out.dayTab = await planned(`?days=${days[1]?.[1]}`);
	const only = await callFn<{ csv: string }>(page, "exportMoneyCsv", { tripId: c.tripId, nodeId: N.japan, only: true });
	out.onlyCsvTotal = total(only.csv);
	out.onlyCsvRows = only.csv.split("\r\n").filter((l) => /JR Pass|Tokyo metro|knife/i.test(l)).map((l) => l.split(",")[1]);
	const jp = await callFn<{ csv: string }>(page, "exportMoneyCsv", { tripId: c.tripId, nodeId: N.japan });
	out.japanCsvTotal = total(jp.csv);
	out.japanTab = await planned("/japan");
	const cad = await callFn<{ csv: string }>(page, "exportMoneyCsv", { tripId: c.tripId, nodeId: N.japan, displayCurrency: "CAD" });
	out.cadHeader = cad.csv.split("\r\n").slice(0, 2);
	out.cadTotal = cad.csv.split("\r\n").find((l) => l.startsWith("Total"));
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.dayCsvTotal?.[0]).toBe(out.dayTab);
	expect.soft((out.japanCsvTotal as string[])?.[0]).toBe(out.japanTab);
	await o.ctx.close();
});

test("refunds follow the original: split edit, original deleted, refund bigger than the original", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o13-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	const orig = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, title: "Tax-free camera", category: "shopping", amountMinor: 100000, currency: "JPY", taxFreePending: true,
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(100000, [{ memberId: owner, amountMinor: 100000 }])],
	});
	const ref = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId, target: { kind: "trip" }, amountMinor: -10000, currency: "JPY", refundOfId: orig.id,
		payments: [pay(-10000, [{ memberId: owner, amountMinor: -10000 }])],
	});
	const who = (id: string) => (id === owner ? "owner" : id === maya ? "maya" : id === audrey ? "audrey" : id);
	const refShares = async () => (await callFn<Money>(page, "listMoney", { tripId: c.tripId })).expenses.find((e) => e.id === ref.id)?.shares.map((s) => [who(s.memberId), s.amountMinor]);
	out.refund0 = await refShares();
	out.refundCategory = (await callFn<Money>(page, "listMoney", { tripId: c.tripId })).expenses.filter((e) => e.id === ref.id || e.id === orig.id).map((e) => [e.title, e.category]);
	await openMoney(page, c.slug);
	out.breakdownWithRefund = await page.getByTestId(M.breakdown).innerText();
	out.bal0 = await balancesText(page, c.slug);
	await callFn(page, "updateExpense", { id: orig.id, patch: { split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }, { memberId: audrey }] } } });
	out.refundAfterSplitEdit = await refShares();
	out.bal1 = await balancesText(page, c.slug);
	// refund larger than the original
	out.bigRefund = await callFnErr(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, amountMinor: -500000, currency: "JPY", refundOfId: orig.id });
	// a refund of a refund
	out.refundOfRefund = await callFnErr(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, amountMinor: -100, currency: "JPY", refundOfId: ref.id });
	// delete the original
	await callFn(page, "deleteExpense", { id: orig.id });
	const m2 = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.afterDelete = m2.expenses.filter((e) => e.id === ref.id || e.id === orig.id).map((e) => ({ t: e.title, shares: e.shares.length }));
	out.bal2 = await balancesText(page, c.slug);
	out.rows2 = await page.getByTestId(M.expenseRow).allInnerTexts();
	await page.screenshot({ path: `${SHOTS}/r2-refund-orphan.png`, fullPage: true });
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.bigRefund, "DEFECT: a refund can't exceed its original").toBeTruthy();
	expect.soft(out.bal2, "DEFECT: deleting the original takes its refund with it (no orphan balance)").toContain("Everyone is square");
	await o.ctx.close();
});

test("UI refund of a shopping purchase keeps the original's category", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const o = await userPage(browser, `qa-money-r2-o14-${uniq()}@example.com`, "Olga", "Owner");
	const c = await clone(o.ctx.request);
	const page = o.page;
	const { owner } = c.members;
	const maya = c.members.maya as string;
	await openMoney(page, c.slug);
	await callFn(page, "createExpense", {
		tripId: c.tripId, target: { kind: "node", nodeId: c.ids.nodes.tokyo }, title: "Camera", category: "shopping", amountMinor: 100000, currency: "JPY", taxFreePending: true,
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(100000, [{ memberId: owner, amountMinor: 100000 }])],
	});
	await openMoney(page, c.slug);
	await page.getByTestId(M.expenseRow).filter({ hasText: "Camera" }).click();
	const dlg = page.getByTestId(TESTID.addExpenseDialog);
	await expect(dlg).toBeVisible();
	await dlg.getByTestId(M.refund).click();
	await page.waitForTimeout(500);
	await dlg.getByTestId(M.amount).fill("10000");
	out.refundDialog = (await dlg.innerText()).replace(/\n+/g, " | ").slice(0, 300);
	await page.screenshot({ path: `${SHOTS}/r2-refund-ui.png` });
	await dlg.getByTestId(M.save).click();
	await expect(dlg).toBeHidden();
	const money = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	out.cats = money.expenses.map((e) => [e.title, e.category, e.amountMinor]);
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.cats).toContainEqual(["Refund · Camera", "shopping", -10000]);
	await o.ctx.close();
});

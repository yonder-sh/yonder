import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import {
	allocate,
	balances,
	categoryFor,
	centsPerPoint,
	convertMinor,
	csvText,
	currencySymbol,
	type EngineExpense,
	type EnginePayment,
	expenseFacts,
	expenseStatus,
	formatCpp,
	formatMoney,
	formatMoneyShort,
	isKnownCurrency,
	itemize,
	minorDigits,
	minorToInput,
	moneyCsv,
	owedShares,
	ownPaymentRate,
	parseMoneyInput,
	payerOrder,
	percentOf,
	remainingInCurrency,
	scopeSummary,
	settleUp,
	splitEqual,
	toMinor,
} from "./money";

const D = "m-dennis";
const A = "m-audrey";
const M = "m-maya";
const ORDER = [D, A, M];

let n = 0;
function pay(
	amountMinor: number,
	payers: [string, number][] | string,
	opts: Partial<EnginePayment> = {},
): EnginePayment {
	const list =
		typeof payers === "string"
			? [{ memberId: payers, amountMinor }]
			: payers.map(([memberId, a]) => ({ memberId, amountMinor: a }));
	return {
		id: `p${++n}`,
		currency: "JPY",
		amountMinor,
		homeAmountMinor: Math.round((amountMinor / 150) * 100),
		payers: list,
		...opts,
	};
}

function exp(e: Partial<EngineExpense> = {}): EngineExpense {
	return {
		id: `e${++n}`,
		category: "food_drink",
		amountMinor: 3000,
		currency: "JPY",
		homeAmountMinor: 2000,
		splitMode: "equal",
		shares: ORDER.map((memberId) => ({ memberId, amountMinor: null })),
		lines: [],
		fees: [],
		payments: [],
		isPrivate: false,
		refundOfId: null,
		points: null,
		...e,
	};
}

const total = (r: Record<string, number>) =>
	Object.values(r).reduce((a, b) => a + b, 0);

describe("currency helpers", () => {
	it("MONEY-R2-08: knows the ISO currencies the picker offers, not made-up codes", () => {
		for (const c of ["USD", "CAD", "JPY", "KRW", "VND", "TWD", "TRY", "EUR"])
			expect(isKnownCurrency(c)).toBe(true);
		expect(isKnownCurrency("CHF")).toBe(true);
		expect(isKnownCurrency("QQQ")).toBe(false);
		expect(isKnownCurrency("XXX")).toBe(false);
		expect(isKnownCurrency("usd")).toBe(false);
		expect(isKnownCurrency("")).toBe(false);
	});

	it("knows each currency's minor digits", () => {
		expect(minorDigits("JPY")).toBe(0);
		expect(minorDigits("KRW")).toBe(0);
		expect(minorDigits("VND")).toBe(0);
		expect(minorDigits("USD")).toBe(2);
		expect(minorDigits("CAD")).toBe(2);
		expect(minorDigits("TWD")).toBe(2);
		expect(minorDigits("TRY")).toBe(2);
		expect(minorDigits("BHD")).toBe(3);
		expect(minorDigits("XXX-not")).toBe(2);
	});

	it("converts between major and minor units", () => {
		expect(toMinor(8.1, "USD")).toBe(810);
		expect(toMinor(1200, "JPY")).toBe(1200);
		expect(minorToInput(810, "USD")).toBe("8.10");
		expect(minorToInput(1200, "JPY")).toBe("1200");
	});

	it("formats with the narrow symbol and the currency's precision", () => {
		expect(formatMoney(1200, "JPY")).toBe("¥1,200");
		expect(formatMoney(810, "USD")).toBe("$8.10");
		expect(formatMoney(-350, "USD")).toBe("-$3.50");
		expect(formatMoney(150000, "VND")).toBe("₫150,000");
		expect(formatMoneyShort(52_000, "JPY")).toBe("¥52K");
		expect(formatMoneyShort(81_000, "USD")).toBe("$810.00");
		expect(formatMoneyShort(120_000, "USD")).toBe("$1.2K");
	});

	it("QA MONEY-QA-02: never a bare $ (or ¥) for a currency that isn't USD (JPY)", () => {
		expect(formatMoney(32_000, "TWD")).toBe("NT$320.00");
		expect(formatMoney(17_000, "CAD")).toBe("C$170.00");
		expect(formatMoney(-350, "CAD")).toBe("-C$3.50");
		expect(formatMoney(1000, "AUD")).toBe("A$10.00");
		expect(formatMoney(1000, "CNY")).toBe("CN¥10.00");
		expect(formatMoney(1000, "ARS")).not.toMatch(/^\$/);
		expect(formatMoney(1000, "SEK")).not.toMatch(/^kr/);
		expect(formatMoney(1500, "KRW")).toBe("₩1,500");
		expect(formatMoney(1000, "EUR")).toBe("€10.00");
		expect(formatMoneyShort(14_775_000, "CAD")).toBe("C$147.8K");
		expect(currencySymbol("TWD")).toBe("NT$");
		expect(currencySymbol("USD")).toBe("$");
		expect(currencySymbol("JPY")).toBe("¥");
	});

	it("parses what people type", () => {
		expect(parseMoneyInput("1200", "JPY")).toBe(1200);
		expect(parseMoneyInput("1,200", "JPY")).toBe(1200);
		expect(parseMoneyInput("¥1,200", "JPY")).toBe(1200);
		expect(parseMoneyInput("1.200", "JPY")).toBe(1200);
		expect(parseMoneyInput("8.10", "USD")).toBe(810);
		expect(parseMoneyInput("8,10", "USD")).toBe(810);
		expect(parseMoneyInput("$1,234.56", "USD")).toBe(123456);
		expect(parseMoneyInput("1.234,56", "EUR")).toBe(123456);
		expect(parseMoneyInput("1 234,5", "EUR")).toBe(123450);
		expect(parseMoneyInput("-3.5", "USD")).toBe(-350);
		expect(parseMoneyInput("1.2k", "USD")).toBe(120000);
		expect(parseMoneyInput("52k", "JPY")).toBe(52000);
		expect(parseMoneyInput("", "USD")).toBeNull();
		expect(parseMoneyInput("abc", "USD")).toBeNull();
		expect(parseMoneyInput("1.234", "USD")).toBeNull();
		expect(parseMoneyInput("12.5", "JPY")).toBeNull();
		expect(parseMoneyInput("1e20", "USD")).toBeNull();
	});

	it("converts minor units at a rate, rounding at the target precision", () => {
		expect(convertMinor(1200, "JPY", "USD", 1 / 150)).toBe(800);
		expect(convertMinor(1000, "JPY", "USD", 0.0066667)).toBe(667);
		expect(convertMinor(810, "USD", "JPY", 150)).toBe(1215);
		expect(convertMinor(-1000, "JPY", "USD", 1 / 150)).toBe(-667);
		expect(convertMinor(500, "USD", "USD", 2)).toBe(500);
	});
});

describe("allocate (deterministic rounding)", () => {
	it("always sums exactly to the total", () => {
		let seed = 42;
		const rnd = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		for (let t = 0; t < 500; t++) {
			const tot = Math.floor(rnd() * 2_000_000) - 500_000;
			const k = 1 + Math.floor(rnd() * 7);
			const w = Array.from({ length: k }, () => Math.floor(rnd() * 1000));
			const parts = allocate(tot, w);
			expect(parts.reduce((a, b) => a + b, 0)).toBe(tot);
			expect(parts.every((p) => Number.isInteger(p))).toBe(true);
		}
	});

	it("gives leftovers by the largest remainder, then priority", () => {
		expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
		expect(allocate(10, [1, 1, 1], [2, 0, 1])).toEqual([3, 4, 3]);
		expect(allocate(100, [1, 2])).toEqual([33, 67]);
		expect(allocate(-10, [1, 1, 1], [1, 2, 0])).toEqual([-3, -3, -4]);
	});

	it("splits equally when every weight is zero, and handles huge totals", () => {
		expect(allocate(5, [0, 0])).toEqual([3, 2]);
		const big = 999_999_999_999;
		const parts = allocate(big, [999_999_999_999, 1, 3]);
		expect(parts.reduce((a, b) => a + b, 0)).toBe(big);
		expect(allocate(0, [1, 2])).toEqual([0, 0]);
		expect(allocate(7, [])).toEqual([]);
	});
});

describe("splits (MONEY-01, exact, itemize, refunds)", () => {
	it("MONEY-01: a 3-way ¥ split is exact and the remainder goes to the payer", () => {
		expect(splitEqual(1000, ORDER, [A], ORDER)).toEqual({
			[D]: 333,
			[A]: 334,
			[M]: 333,
		});
		// Two leftover units: one to the payer, then one by member order.
		expect(splitEqual(1001, ORDER, [M], ORDER)).toEqual({
			[D]: 334,
			[A]: 333,
			[M]: 334,
		});
		const e = exp({ amountMinor: 1000, payments: [pay(1000, M)] });
		expect(owedShares(e, { memberOrder: ORDER })).toEqual({
			[D]: 333,
			[A]: 333,
			[M]: 334,
		});
	});

	it("gives the leftover by member order when the payer isn't in the split", () => {
		expect(splitEqual(1000, [A, M], [D], ORDER)).toEqual({
			[A]: 500,
			[M]: 500,
		});
		expect(splitEqual(1001, [M, A], [D], ORDER)).toEqual({
			[A]: 501,
			[M]: 500,
		});
	});

	it("uses exact amounts when they add up, and scales them when they don't", () => {
		const e = exp({
			amountMinor: 3000,
			splitMode: "exact",
			shares: [
				{ memberId: D, amountMinor: 2000 },
				{ memberId: A, amountMinor: 1000 },
			],
		});
		expect(owedShares(e)).toEqual({ [D]: 2000, [A]: 1000 });
		const off = { ...e, amountMinor: 3300 };
		expect(total(owedShares(off))).toBe(3300);
	});

	it("MONEY-14: an itemized bill with a 10% service charge splits proportionally", () => {
		const lines = [
			{ label: "Ramen", amountMinor: 1200, memberIds: [D] },
			{ label: "Gyoza", amountMinor: 600, memberIds: [D, A] },
			{ label: "Beer", amountMinor: 800, memberIds: [A] },
		];
		const fees = [
			{
				label: "Service",
				kind: "percent" as const,
				percent: 10,
				amountMinor: null,
			},
		];
		const it = itemize(lines, fees, [D], ORDER);
		expect(it.subtotals).toEqual({ [D]: 1500, [A]: 1100 });
		expect(it.feeAmounts).toEqual([260]);
		expect(it.perMember).toEqual({ [D]: 1650, [A]: 1210 });
		expect(it.total).toBe(2860);
		const e = exp({ amountMinor: 2860, lines, fees, payments: [pay(2860, D)] });
		expect(owedShares(e, { memberOrder: ORDER })).toEqual({
			[D]: 1650,
			[A]: 1210,
		});
	});

	it("spreads a fixed fee (tip) proportionally and rounds exactly", () => {
		const it = itemize(
			[
				{ amountMinor: 1000, memberIds: [D] },
				{ amountMinor: 2000, memberIds: [A] },
				{ amountMinor: 1000, memberIds: [M] },
			],
			[
				{ kind: "fixed", percent: null, amountMinor: 101 },
				{ kind: "percent", percent: 8.25, amountMinor: null },
			],
			[A],
			ORDER,
		);
		expect(it.feeAmounts).toEqual([101, 330]);
		expect(total(it.perMember)).toBe(it.total);
		expect(it.total).toBe(4431);
		expect(it.perMember[A]).toBeGreaterThan(it.perMember[D] ?? 0);
	});

	it("rounds percent fees half away from zero", () => {
		expect(percentOf(1005, 10)).toBe(101); // 100.5 → 101
		expect(percentOf(1004, 10)).toBe(100);
		expect(percentOf(-1005, 10)).toBe(-101);
		expect(percentOf(999, 0)).toBe(0);
	});

	it("MONEY-15: a refund splits back in the original's proportions", () => {
		const orig = exp({
			amountMinor: 3000,
			splitMode: "exact",
			shares: [
				{ memberId: D, amountMinor: 2000 },
				{ memberId: A, amountMinor: 1000 },
			],
			payments: [pay(3000, D)],
		});
		const refund = exp({
			amountMinor: -600,
			refundOfId: orig.id,
			shares: [],
			payments: [pay(-600, D)],
		});
		const byId = new Map([
			[orig.id, orig],
			[refund.id, refund],
		]);
		expect(owedShares(refund, { byId, memberOrder: ORDER })).toEqual({
			[D]: -400,
			[A]: -200,
		});
		const net = balances([orig, refund], [], { byId, memberOrder: ORDER });
		expect(total(net)).toBe(0);
		// Dennis paid 3000 − 600 = 2400 (in USD cents at 1/150), owes 2000 − 400.
		expect(net[A]).toBeLessThan(0);
	});

	it("keeps a private expense out of every split", () => {
		const e = exp({ isPrivate: true, payments: [pay(3000, D)] });
		expect(owedShares(e)).toEqual({});
		expect(balances([e], [])).toEqual({});
	});

	it("falls back to the payers when nobody is in the split", () => {
		const e = exp({
			shares: [],
			payments: [
				pay(3000, [
					[D, 2000],
					[A, 1000],
				]),
			],
		});
		expect(owedShares(e, { memberOrder: ORDER })).toEqual({
			[D]: 2000,
			[A]: 1000,
		});
		expect(total(balances([e], []))).toBe(0);
	});
});

describe("payments and status (MONEY-13, MONEY-16)", () => {
	it("MONEY-13: two payers pool one payment", () => {
		const e = exp({
			amountMinor: 9000,
			homeAmountMinor: 6000,
			payments: [
				pay(
					9000,
					[
						[D, 5000],
						[A, 4000],
					],
					{ homeAmountMinor: 6000 },
				),
			],
		});
		const f = expenseFacts(e, { memberOrder: ORDER });
		expect(f.paid).toEqual({ [D]: 3333, [A]: 2667 });
		expect(total(f.paid)).toBe(6000);
		expect(f.actualShare).toEqual({ [D]: 2000, [A]: 2000, [M]: 2000 });
		expect(payerOrder(e.payments)).toEqual([D, A]);
	});

	it("MONEY-16: a deposit then the rest, each at its own date's rate", () => {
		const deposit = pay(10_000, A, {
			paidAt: "2027-06-01T12:00:00+09:00",
			homeAmountMinor: 6900,
		});
		const e = exp({
			amountMinor: 60_000,
			homeAmountMinor: 40_000,
			payments: [deposit],
		});
		expect(expenseStatus(e)).toBe("partial");
		expect(remainingInCurrency(e)).toBe(50_000);
		const f1 = expenseFacts(e, { memberOrder: ORDER });
		expect(f1.actualHome).toBe(6900);
		// The ¥50,000 still to pay at the latest rate (the plan's ¥60,000 =
		// $400.00), not the plan minus the deposit at June's rate.
		expect(f1.remainingHome).toBe(33_333);
		expect(f1.plannedHome).toBe(6900 + 33_333);
		const rest = pay(50_000, D, {
			paidAt: "2027-10-05T15:00:00+09:00",
			homeAmountMinor: 33_500,
		});
		const paid = { ...e, payments: [deposit, rest] };
		expect(expenseStatus(paid)).toBe("paid");
		const f2 = expenseFacts(paid, { memberOrder: ORDER });
		expect(f2.actualHome).toBe(6900 + 33_500);
		expect(f2.remainingHome).toBe(0);
		expect(f2.paid).toEqual({ [A]: 6900, [D]: 33_500 });
	});

	it("compares mixed-currency payments at home, with a 0.5% tolerance", () => {
		const e = exp({
			amountMinor: 15_000,
			homeAmountMinor: 10_000,
			payments: [pay(9960, D, { currency: "USD", homeAmountMinor: 9960 })],
		});
		expect(expenseStatus(e)).toBe("paid");
		expect(
			expenseStatus({
				...e,
				payments: [pay(9000, D, { currency: "USD", homeAmountMinor: 9000 })],
			}),
		).toBe("partial");
		expect(remainingInCurrency(e)).toBeNull();
	});

	it("treats a refund as paid once the money came back", () => {
		const r = exp({
			amountMinor: -500,
			refundOfId: "x",
			payments: [pay(-500, D)],
		});
		expect(expenseStatus(r)).toBe("paid");
		expect(expenseStatus({ ...r, payments: [pay(-200, D)] })).toBe("partial");
	});
});

describe("balances and settle-up (MONEY-03, MONEY-08, MONEY-11)", () => {
	const dinner = exp({
		amountMinor: 9000,
		homeAmountMinor: 6000,
		payments: [pay(9000, D, { homeAmountMinor: 6000 })],
	});
	const taxi = exp({
		amountMinor: 3000,
		homeAmountMinor: 2000,
		shares: [D, A].map((memberId) => ({ memberId, amountMinor: null })),
		payments: [pay(3000, A, { homeAmountMinor: 2000 })],
	});

	it("nets paid − share per member and sums to zero", () => {
		const net = balances([dinner, taxi], [], { memberOrder: ORDER });
		expect(net).toEqual({ [D]: 3000, [A]: -1000, [M]: -2000 });
		expect(total(net)).toBe(0);
	});

	it("MONEY-03: settle-up gives ≤ n−1 transfers and recording them zeroes everyone", () => {
		const net = balances([dinner, taxi], [], { memberOrder: ORDER });
		const t = settleUp(net);
		expect(t.length).toBeLessThanOrEqual(2);
		expect(t).toEqual([
			{ from: M, to: D, amountMinor: 2000 },
			{ from: A, to: D, amountMinor: 1000 },
		]);
		const after = balances(
			[dinner, taxi],
			t.map((x) => ({
				fromMemberId: x.from,
				toMemberId: x.to,
				homeAmountMinor: x.amountMinor,
			})),
			{ memberOrder: ORDER },
		);
		expect(Object.values(after).every((v) => v === 0)).toBe(true);
	});

	it("settles many people in at most n−1 transfers", () => {
		const net: Record<string, number> = {
			a: 500,
			b: -200,
			c: -300,
			d: 1000,
			e: -1000,
			f: 0,
		};
		const t = settleUp(net);
		expect(t.length).toBeLessThanOrEqual(4);
		const left = { ...net };
		for (const x of t) {
			left[x.from] = (left[x.from] ?? 0) + x.amountMinor;
			left[x.to] = (left[x.to] ?? 0) - x.amountMinor;
		}
		expect(Object.values(left).every((v) => v === 0)).toBe(true);
		expect(settleUp({})).toEqual([]);
	});

	it("MONEY-08: points never enter balances; only their cash taxes do", () => {
		const award = exp({
			amountMinor: null,
			currency: null,
			homeAmountMinor: null,
			points: {
				program: "Aeroplan",
				points: 240_000,
				sourceProgram: null,
				sourcePoints: null,
				cashValueMinor: null,
				cashValueCurrency: null,
			},
			payments: [],
		});
		expect(Object.values(balances([award], [])).every((v) => v === 0)).toBe(
			true,
		);
		const withTaxes = {
			...award,
			payments: [pay(15_000, D, { currency: "USD", homeAmountMinor: 15_000 })],
		};
		const net = balances([withTaxes], [], { memberOrder: ORDER });
		expect(total(net)).toBe(0);
		expect(net[D]).toBe(15_000 - 5000);
	});

	it("MONEY-11: a ¥ settlement zeroes a USD balance up to a visible 1-unit remainder", () => {
		const net0 = balances([taxi], [], { memberOrder: ORDER });
		expect(net0).toEqual({ [A]: 1000, [D]: -1000 });
		// Dennis pays Audrey ¥1,493 at 0.0067 → $10.00 (1000.31¢ → 1000); at 0.0066 → 985.
		const home = convertMinor(1493, "JPY", "USD", 0.0067);
		const after = balances(
			[taxi],
			[{ fromMemberId: D, toMemberId: A, homeAmountMinor: home }],
			{
				memberOrder: ORDER,
			},
		);
		expect(Math.abs(after[D] ?? 0)).toBeLessThanOrEqual(1);
		const off = balances(
			[taxi],
			[{ fromMemberId: D, toMemberId: A, homeAmountMinor: 998 }],
		);
		expect(off[D]).toBe(-2); // visible, never absorbed
	});
});

describe("scope summary", () => {
	it("totals planned, actual, remaining and the delta vs plan", () => {
		const planned = exp({
			amountMinor: 60_000,
			homeAmountMinor: 40_000,
			category: "lodging",
		});
		const over = exp({
			amountMinor: 3000,
			homeAmountMinor: 2000,
			payments: [pay(3300, D, { homeAmountMinor: 2200 })],
		});
		const partial = exp({
			amountMinor: 6000,
			homeAmountMinor: 4000,
			category: "activities",
			payments: [pay(1500, A, { homeAmountMinor: 1000 })],
		});
		const mine = exp({
			isPrivate: true,
			amountMinor: 18_000,
			homeAmountMinor: 12_000,
			payments: [pay(18_000, D, { homeAmountMinor: 12_000 })],
		});
		const s = scopeSummary([planned, over, partial, mine], {
			memberOrder: ORDER,
		});
		expect(s.count).toBe(3);
		expect(s.plannedHome).toBe(46_000);
		expect(s.actualHome).toBe(3200);
		expect(s.remainingHome).toBe(40_000 + 3000);
		expect(s.projectedHome).toBe(3200 + 43_000);
		expect(s.deltaHome).toBe(200);
		expect(s.privateCount).toBe(1);
		expect(s.privateActualHome).toBe(12_000);
		expect(s.byCategory.lodging).toEqual({
			planned: 40_000,
			actual: 0,
			count: 1,
		});
		expect(s.byCategory.food_drink?.actual).toBe(2200);
		const pp = s.perPerson;
		expect(
			total(
				Object.fromEntries(Object.entries(pp).map(([k, v]) => [k, v.planned])),
			),
		).toBe(46_000);
		expect(
			total(Object.fromEntries(Object.entries(pp).map(([k, v]) => [k, v.net]))),
		).toBe(0);
		expect(pp[D]?.paid).toBe(2200);
	});

	it("QA MONEY-QA-12: one currency throughout → exact totals in it (Local shows ₩15,000)", () => {
		const krw = (a: number, e: Partial<EngineExpense> = {}) =>
			exp({ amountMinor: a, currency: "KRW", homeAmountMinor: 1083, ...e });
		const s = scopeSummary(
			[
				krw(15_000),
				krw(6000, {
					payments: [pay(2000, D, { currency: "KRW", homeAmountMinor: 144 })],
				}),
			],
			{ memberOrder: ORDER },
		);
		expect(s.original).toMatchObject({
			currency: "KRW",
			planned: 21_000,
			actual: 2000,
			remaining: 19_000,
		});
		// A second currency anywhere (a payment too): no exact total.
		expect(
			scopeSummary([krw(15_000), exp()], { memberOrder: ORDER }).original,
		).toBeNull();
		expect(
			scopeSummary(
				[krw(15_000, { payments: [pay(10, D, { currency: "USD" })] })],
				{ memberOrder: ORDER },
			).original,
		).toBeNull();
		// A rate still pending: no exact total either (the home total is partial).
		expect(
			scopeSummary([krw(15_000, { homeAmountMinor: null })], {
				memberOrder: ORDER,
			}).original,
		).toBeNull();
	});

	it("sums points per programme per person with cents per point for redeemed and source", () => {
		const award = exp({
			amountMinor: 11_000,
			currency: "USD",
			homeAmountMinor: 11_000,
			shares: [D, A].map((memberId) => ({ memberId, amountMinor: null })),
			points: {
				program: "Aeroplan",
				points: 240_000,
				sourceProgram: "Chase UR",
				sourcePoints: 200_000,
				cashValueMinor: 560_000,
				cashValueCurrency: "USD",
				cashValueHomeMinor: 560_000,
			},
			payments: [pay(11_000, D, { currency: "USD", homeAmountMinor: 11_000 })],
		});
		const s = scopeSummary([award], { memberOrder: ORDER });
		const aero = s.programs.find((p) => p.program === "Aeroplan");
		expect(aero?.points).toBe(240_000);
		expect(aero?.perMember).toEqual({ [D]: 120_000, [A]: 120_000 });
		expect(aero?.cpp).toBeCloseTo((560_000 - 11_000) / 240_000, 6);
		const ur = s.programs.find((p) => p.program === "Chase UR");
		expect(ur?.sourcePoints).toBe(200_000);
		expect(ur?.sourceCpp).toBeCloseTo((560_000 - 11_000) / 200_000, 6);
		expect(formatCpp(aero?.cpp ?? 0, "USD")).toBe("2.29¢");
		expect(centsPerPoint(null, 0, 1)).toBeNull();
		expect(centsPerPoint(1000, 0, 0)).toBeNull();
	});
});

describe("defaults and CSV", () => {
	it("infers the category from the place or leg", () => {
		expect(categoryFor({ kind: "place", category: "ramen" as never })).toBe(
			"activities",
		);
		expect(categoryFor({ kind: "place", category: "restaurant" })).toBe(
			"food_drink",
		);
		expect(categoryFor({ kind: "place", category: "lodging" })).toBe("lodging");
		expect(categoryFor({ kind: "place", category: "shopping" })).toBe(
			"shopping",
		);
		expect(categoryFor({ kind: "place", category: "airport" })).toBe(
			"transport",
		);
		expect(categoryFor({ kind: "place", category: "temple_shrine" })).toBe(
			"activities",
		);
		expect(categoryFor({ kind: "place", category: null })).toBe("fees_other");
		expect(categoryFor({ kind: "leg", mode: "transit" })).toBe("transport");
		expect(categoryFor({ kind: "other" })).toBe("fees_other");
	});

	it("guards text cells against formula injection and quotes them", () => {
		expect(csvText("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
		expect(csvText("+1")).toBe("'+1");
		expect(csvText("@me")).toBe("'@me");
		expect(csvText('Ramen "Ichiran", Shibuya')).toBe(
			'"Ramen ""Ichiran"", Shibuya"',
		);
		expect(csvText(null)).toBe("");
	});

	it("MONEY-20: the CSV carries the scope's totals, people and balances", () => {
		const e1 = exp({
			title: "Dinner",
			amountMinor: 9000,
			homeAmountMinor: 6000,
			payments: [pay(9000, D, { homeAmountMinor: 6000 })],
		});
		const s = scopeSummary([e1], { memberOrder: ORDER });
		const net = balances([e1], []);
		const csv = moneyCsv({
			scopeName: "Tokyo",
			home: "USD",
			rows: [
				{
					date: "2027-10-04",
					title: "Dinner",
					where: "Tokyo",
					category: "food_drink",
					status: "paid",
					amountMinor: 9000,
					currency: "JPY",
					plannedHome: 6000,
					actualHome: 6000,
					paidBy: "Dennis",
					split: "Dennis, Audrey, Maya",
					points: "",
					isPrivate: false,
					note: "",
				},
			],
			summary: s,
			balances: net,
			names: { [D]: "Dennis", [A]: "Audrey", [M]: "Maya" },
			display: { currency: "CAD", rate: 1.37 },
		});
		// QA MONEY-20: a UTF-8 BOM first, so Excel reads "—", "›", "¥" right.
		expect(csv.startsWith("\uFEFFExpenses — Tokyo\r\n")).toBe(true);
		expect(new TextEncoder().encode(csv).slice(0, 3)).toEqual(
			new Uint8Array([0xef, 0xbb, 0xbf]),
		);
		const lines = csv.slice(1).split("\r\n");
		expect(lines[0]).toBe("Expenses — Tokyo");
		expect(lines).toContain(
			'2027-10-04,Dinner,Tokyo,Food & drink,paid,9000,JPY,60.00,60.00,Dennis,"Dennis, Audrey, Maya",,,',
		);
		expect(lines).toContain("Total,,,,,,,60.00,60.00");
		expect(lines).toContain("Dennis,20.00,20.00,60.00,40.00,54.80");
		expect(lines).toContain("Maya,-20.00,-27.40");
	});

	it("QA MONEY-QA-07: my private rows sit below the Total, so the rows add up to it", () => {
		const pub = exp({ amountMinor: 9000, homeAmountMinor: 6000 });
		const mine = exp({
			isPrivate: true,
			amountMinor: 3000,
			homeAmountMinor: 2000,
		});
		const s = scopeSummary([pub, mine], { memberOrder: ORDER });
		const row = (title: string, planned: number, isPrivate: boolean) => ({
			date: "2027-10-04",
			title,
			where: "Tokyo",
			category: "food_drink" as const,
			status: "planned" as const,
			amountMinor: planned,
			currency: "USD",
			plannedHome: planned,
			actualHome: 0,
			paidBy: "",
			split: "",
			points: "",
			isPrivate,
			note: "",
		});
		const lines = moneyCsv({
			scopeName: "Tokyo",
			home: "USD",
			rows: [row("Gift", 2000, true), row("Dinner", 6000, false)],
			summary: s,
			balances: {},
			names: {},
		}).split("\r\n");
		const total = lines.indexOf("Total,,,,,,,60.00,0.00");
		expect(total).toBeGreaterThan(0);
		expect(lines.findIndex((l) => l.includes("Dinner"))).toBeLessThan(total);
		expect(lines.findIndex((l) => l.includes("Gift"))).toBeGreaterThan(total);
		expect(lines).toContain("Private total,,,,,,,20.00,0.00");
	});
});

describe("manual rates (QA MONEY-QA-03)", () => {
	it("a payment's rate inherited from its cost is not its own", () => {
		const e = { fxManual: true, fxRate: 0.01, currency: "JPY" };
		expect(ownPaymentRate({ ...e }, e)).toBeUndefined();
		expect(ownPaymentRate({ ...e, fxRate: 0.0065 }, e)).toBe(0.0065);
		expect(
			ownPaymentRate({ fxManual: true, fxRate: 0.01, currency: "KRW" }, e),
		).toBe(0.01);
		expect(
			ownPaymentRate({ fxManual: false, fxRate: 0.0067, currency: "JPY" }, e),
		).toBeUndefined();
		expect(
			ownPaymentRate(
				{ ...e },
				{ fxManual: false, fxRate: 0.0067, currency: "JPY" },
			),
		).toBe(0.01);
	});
});

describe("QA round 3 (WP-Money fix round)", () => {
	it("MONEY-16: a part-paid ₺ cost still owes its remainder at TODAY's rate, not plan − deposit", () => {
		// ₺30,000 hotel; ₺10,000 deposit a year ago at 0.02417 ($241.74); today 0.020477.
		const hotel = exp({
			category: "lodging",
			amountMinor: 3_000_000,
			currency: "TRY",
			homeCurrency: "USD",
			fxRate: 0.020477,
			homeAmountMinor: convertMinor(3_000_000, "TRY", "USD", 0.020477),
			shares: [{ memberId: D, amountMinor: null }],
			payments: [
				pay(1_000_000, D, {
					currency: "TRY",
					homeAmountMinor: 24_174,
					paidAt: "2025-09-20T09:00:00Z",
				}),
			],
		});
		expect(hotel.homeAmountMinor).toBe(61_431);
		const f = expenseFacts(hotel, { memberOrder: ORDER });
		expect(f.status).toBe("partial");
		expect(f.remainingHome).toBe(40_954); // ₺20,000 × 0.020477 = $409.54
		expect(f.plannedHome).toBe(24_174 + 40_954); // $651.28, not $614.30
		expect(f.plannedShare).toEqual({ [D]: 65_128 });
		const s = scopeSummary([hotel], { memberOrder: ORDER });
		expect(s.remainingHome).toBe(40_954);
		expect(s.plannedHome).toBe(65_128);
		expect(s.perPerson[D]?.planned).toBe(65_128);
		expect(s.projectedHome).toBe(s.actualHome + s.remainingHome);
	});

	it("MONEY-16: the remainder follows a manual rate on the cost, and scales without a rate", () => {
		const base = exp({
			amountMinor: 60_000,
			homeAmountMinor: 40_000,
			payments: [pay(10_000, A, { homeAmountMinor: 6900 })],
		});
		expect(
			expenseFacts({ ...base, homeCurrency: "USD", fxRate: 0.0065 })
				.remainingHome,
		).toBe(32_500); // ¥50,000 × 0.0065
		expect(expenseFacts(base).remainingHome).toBe(33_333); // 40,000 × 5/6
		// A payment in another currency: the remainder can't be told in ¥, so
		// it stays the plan minus what was paid at home.
		const mixed = {
			...base,
			payments: [pay(6900, A, { currency: "USD", homeAmountMinor: 6900 })],
		};
		expect(expenseFacts(mixed).remainingHome).toBe(40_000 - 6900);
		// A payment still waiting for its rate: the plan stays the plan.
		const pending = {
			...base,
			payments: [pay(10_000, A, { homeAmountMinor: null })],
		};
		expect(expenseFacts(pending).plannedHome).toBe(40_000);
		expect(expenseFacts(pending).remainingHome).toBe(33_333);
	});

	it("MONEY-19: a one-currency scope has exact shares, nets and categories in that currency", () => {
		// ¥1,500 matcha split 3, paid by Dennis; ¥60,000 ryokan (Dennis + Maya)
		// with a ¥10,000 deposit by Maya at an older rate.
		const matcha = exp({
			amountMinor: 1500,
			homeAmountMinor: 1004,
			payments: [pay(1500, D, { homeAmountMinor: 1004 })],
		});
		const ryokan = exp({
			category: "lodging",
			amountMinor: 60_000,
			homeAmountMinor: 40_160,
			shares: [D, M].map((memberId) => ({ memberId, amountMinor: null })),
			payments: [pay(10_000, M, { homeAmountMinor: 6900 })],
		});
		const s = scopeSummary([matcha, ryokan], { memberOrder: ORDER });
		const o = s.original;
		expect(o?.currency).toBe("JPY");
		expect(o?.perPerson[D]).toEqual({
			planned: 30_500,
			actual: 5500,
			paid: 1500,
			net: -4000,
		});
		expect(o?.perPerson[M]).toEqual({
			planned: 30_500,
			actual: 5500,
			paid: 10_000,
			net: 4500,
		});
		expect(o?.perPerson[A]).toEqual({
			planned: 500,
			actual: 500,
			paid: 0,
			net: -500,
		});
		expect(o?.byCategory.lodging).toEqual({
			planned: 60_000,
			actual: 10_000,
			count: 1,
		});
		expect(o?.byCategory.food_drink).toEqual({
			planned: 1500,
			actual: 1500,
			count: 1,
		});
		// Per person adds up to the exact totals; the nets to zero.
		const people = Object.values(o?.perPerson ?? {});
		expect(people.reduce((a, p) => a + p.planned, 0)).toBe(o?.planned);
		expect(people.reduce((a, p) => a + p.actual, 0)).toBe(o?.actual);
		expect(people.reduce((a, p) => a + p.net, 0)).toBe(0);
		// A private cost stays out, as at home.
		const mine = exp({
			isPrivate: true,
			amountMinor: 999,
			payments: [pay(999, D)],
		});
		expect(
			scopeSummary([matcha, mine], { memberOrder: ORDER }).original?.perPerson[
				D
			],
		).toEqual({ planned: 500, actual: 500, paid: 1500, net: 1000 });
	});
});

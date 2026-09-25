/**
 * E5 money engine (EXTENSIONS §8.2, ADDENDUM §6 and §7.3), WP-Money. Pure;
 * integer minor units throughout, BigInt where a product could pass 2^53.
 *
 * - Currency helpers: `minorDigits(ccy)` (Intl; JPY, KRW and VND are 0),
 *   `toMinor`, `fromMinor`, `formatMoney`, `formatMoneyShort`,
 *   `parseMoneyInput`, `convertMinor`.
 * - `allocate(total, weights, priority)`: largest remainder; ties (and every
 *   leftover unit of an equal split) go by `priority`, which puts the payer
 *   first, then trip member order — so parts ALWAYS sum exactly to the total.
 * - `owedShares` (equal / exact / itemized with proportional fees / refunds in
 *   the original's proportions), `expenseStatus`, `expenseFacts` (home
 *   planned/actual/remaining, per-person planned and actual shares, who paid).
 * - `balances` (trip-wide, private expenses and points excluded, settlements
 *   applied), `settleUp` (≤ n−1 transfers), `scopeSummary` (totals, delta,
 *   per person, net positions, categories, points per programme with cents per
 *   point), `moneyCsv`.
 *
 * Sign convention: `net > 0` = the member is owed money; `net < 0` = owes.
 */
import type {
	ExpenseCategory,
	LegMode,
	PlaceCategory,
} from "@/lib/schemas/enums";

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

const DIGITS = new Map<string, number>();

/** Decimal places of a currency (ISO 4217 via Intl): JPY/KRW/VND → 0, USD → 2. */
export function minorDigits(currency: string): number {
	const hit = DIGITS.get(currency);
	if (hit !== undefined) return hit;
	let d = 2;
	try {
		d =
			new Intl.NumberFormat("en", {
				style: "currency",
				currency,
			}).resolvedOptions().maximumFractionDigits ?? 2;
	} catch {
		d = 2;
	}
	// Nobody pays in fractions of these, whatever the runtime's ICU says.
	if (currency === "VND" || currency === "KRW" || currency === "JPY") d = 0;
	DIGITS.set(currency, d);
	return d;
}

/** The trip currencies (ADDENDUM §7.3), known even to a runtime without Intl's list. */
const TRIP_CURRENCIES = [
	"USD",
	"CAD",
	"JPY",
	"KRW",
	"VND",
	"TWD",
	"TRY",
	"EUR",
];
let KNOWN: ReadonlySet<string> | null = null;
let NAMES: Intl.DisplayNames | null | undefined;

/**
 * An ISO 4217 code the app knows: the runtime's currency list (what the
 * currency picker offers, and what `minorDigits` can size), plus the trip
 * currencies. "QQQ" is not one.
 */
export function isKnownCurrency(code: string): boolean {
	if (!/^[A-Z]{3}$/.test(code)) return false;
	if (!KNOWN) {
		let list: string[] = [];
		try {
			list = (
				Intl as unknown as { supportedValuesOf(k: string): string[] }
			).supportedValuesOf("currency");
		} catch {
			list = [];
		}
		KNOWN = new Set(list.length ? [...list, ...TRIP_CURRENCIES] : []);
	}
	if (KNOWN.size) return KNOWN.has(code);
	// No list in this runtime: ask Intl for the currency's name instead.
	if (TRIP_CURRENCIES.includes(code)) return true;
	if (NAMES === undefined) {
		try {
			NAMES = new Intl.DisplayNames(["en"], {
				type: "currency",
				fallback: "none",
			});
		} catch {
			NAMES = null;
		}
	}
	if (!NAMES) return true;
	try {
		return NAMES.of(code) !== undefined;
	} catch {
		return false;
	}
}

export function toMinor(amount: number, currency: string): number {
	return Math.round(amount * 10 ** minorDigits(currency));
}

export function fromMinor(minor: number, currency: string): number {
	return minor / 10 ** minorDigits(currency);
}

/**
 * Symbols for currencies whose narrow symbol is shared with another one
 * ("$" is USD's, "¥" JPY's): a TWD or CAD amount must never read like USD.
 */
const SYMBOL_OVERRIDE: Readonly<Record<string, string>> = {
	CAD: "C$",
	TWD: "NT$",
	AUD: "A$",
	NZD: "NZ$",
	HKD: "HK$",
	SGD: "S$",
	MXN: "MX$",
	CNY: "CN¥",
};
/** The one currency that may use each shared narrow symbol as is. */
const SYMBOL_OWNER: Readonly<Record<string, string>> = {
	$: "USD",
	"¥": "JPY",
	"£": "GBP",
	"₩": "KRW",
};
const AMBIGUOUS = new Set(["$", "¥", "£", "₩", "kr"]);

type Fmt = { f: Intl.NumberFormat; symbol: string | null };
const FORMATTERS = new Map<string, Fmt>();
function formatter(
	currency: string,
	locale: string,
	opts: Intl.NumberFormatOptions = {},
): Fmt {
	const k = `${locale}|${currency}|${JSON.stringify(opts)}`;
	let hit = FORMATTERS.get(k);
	if (!hit) {
		const d = minorDigits(currency);
		const make = (currencyDisplay: "narrowSymbol" | "symbol") =>
			new Intl.NumberFormat(locale, {
				style: "currency",
				currency,
				currencyDisplay,
				minimumFractionDigits: d,
				maximumFractionDigits: d,
				...opts,
			});
		try {
			let f = make("narrowSymbol");
			const symbol: string | null = SYMBOL_OVERRIDE[currency] ?? null;
			if (!symbol) {
				const narrow = f
					.formatToParts(0)
					.find((p) => p.type === "currency")?.value;
				// A shared symbol ("$" for ARS, "kr" for SEK) → the locale's own
				// symbol or code ("ARS 5.00"), never a bare "$".
				if (
					narrow &&
					AMBIGUOUS.has(narrow) &&
					SYMBOL_OWNER[narrow] !== currency
				)
					f = make("symbol");
			}
			hit = { f, symbol };
		} catch {
			hit = {
				f: new Intl.NumberFormat(locale, {
					minimumFractionDigits: d,
					maximumFractionDigits: d,
				}),
				symbol: null,
			};
		}
		FORMATTERS.set(k, hit);
	}
	return hit;
}

function formatWith(fmt: Fmt, value: number): string {
	if (!fmt.symbol) return fmt.f.format(value);
	const symbol = fmt.symbol;
	return fmt.f
		.formatToParts(value)
		.map((p) => (p.type === "currency" ? symbol : p.value))
		.join("");
}

/** "¥1,200", "$8.10", "₫150,000", "NT$320.00", "C$170.00". */
export function formatMoney(
	minor: number,
	currency: string,
	locale = "en",
): string {
	return formatWith(formatter(currency, locale), fromMinor(minor, currency));
}

/**
 * Compact amounts for chips and summaries: "¥52k", "$1.2k", "$8.10" (under
 * 1,000 the full amount is kept).
 */
export function formatMoneyShort(
	minor: number,
	currency: string,
	locale = "en",
): string {
	const v = fromMinor(minor, currency);
	if (Math.abs(v) < 1000) return formatMoney(minor, currency, locale);
	return formatWith(
		formatter(currency, locale, {
			notation: "compact",
			minimumFractionDigits: 0,
			maximumFractionDigits: 1,
		}),
		v,
	);
}

/** Just the symbol: "¥", "$", "NT$", "₩", "C$". */
export function currencySymbol(currency: string, locale = "en"): string {
	const fmt = formatter(currency, locale);
	if (fmt.symbol) return fmt.symbol;
	const parts = fmt.f.formatToParts(0);
	return parts.find((p) => p.type === "currency")?.value ?? currency;
}

/**
 * What a person typed → minor units, or null. Accepts "1,200", "1200.5",
 * "8,10" (a lone comma with 1–2 trailing digits is a decimal comma), "¥1200",
 * "-300", "1.2k". Rejects more decimals than the currency has.
 */
export function parseMoneyInput(
	input: string,
	currency: string,
): number | null {
	let s = input.trim().replace(/[\s '’_]/g, "");
	if (!s) return null;
	let neg = false;
	if (s.startsWith("-") || s.startsWith("−")) {
		neg = true;
		s = s.slice(1);
	}
	s = s.replace(/^[^\d.,]+/, "").replace(/[^\d.,kK]+$/, "");
	let mult = 1;
	if (/[kK]$/.test(s)) {
		mult = 1000;
		s = s.slice(0, -1);
	}
	if (!/^[\d.,]+$/.test(s)) return null;
	const d = minorDigits(currency);
	const lastComma = s.lastIndexOf(",");
	const lastDot = s.lastIndexOf(".");
	let intPart: string;
	let frac = "";
	if (lastDot >= 0 && lastComma >= 0) {
		const decAt = Math.max(lastDot, lastComma);
		intPart = s.slice(0, decAt).replace(/[.,]/g, "");
		frac = s.slice(decAt + 1);
	} else if (lastDot >= 0) {
		const parts = s.split(".");
		if (parts.length > 2) {
			// "1.200.000" thousands dots
			if (parts.slice(1).every((p) => p.length === 3)) intPart = parts.join("");
			else return null;
		} else if (d === 0 && parts[1]?.length === 3) {
			intPart = parts.join(""); // "1.200" in a no-decimals currency = 1200
		} else {
			intPart = parts[0] ?? "";
			frac = parts[1] ?? "";
		}
	} else if (lastComma >= 0) {
		const parts = s.split(",");
		if (
			parts.length === 2 &&
			(parts[1]?.length ?? 0) >= 1 &&
			(parts[1]?.length ?? 0) <= 2 &&
			d > 0
		) {
			intPart = parts[0] ?? "";
			frac = parts[1] ?? "";
		} else if (parts.slice(1).every((p) => p.length === 3)) {
			intPart = parts.join("");
		} else return null;
	} else {
		intPart = s;
	}
	if (intPart === "" && frac === "") return null;
	if (!/^\d*$/.test(intPart) || !/^\d*$/.test(frac)) return null;
	if (mult === 1 && frac.length > d) return null;
	const value = Number(`${intPart || "0"}.${frac || "0"}`) * mult;
	if (!Number.isFinite(value) || value > 1e12) return null;
	const minor = Math.round(value * 10 ** d);
	return neg ? -minor : minor;
}

/** "1200" / "8.10" for an input field (no symbol, no grouping). */
export function minorToInput(minor: number, currency: string): string {
	const d = minorDigits(currency);
	return fromMinor(minor, currency).toFixed(d);
}

/**
 * Converts minor units with `rate` = target units per 1 source unit. Rounds
 * half away from zero at the target's precision.
 */
export function convertMinor(
	amountMinor: number,
	from: string,
	to: string,
	rate: number,
): number {
	if (from === to) return amountMinor;
	const v = fromMinor(amountMinor, from) * rate * 10 ** minorDigits(to);
	return Math.sign(v) * Math.round(Math.abs(v));
}

// ---------------------------------------------------------------------------
// Allocation (deterministic rounding)
// ---------------------------------------------------------------------------

/**
 * Splits `total` over `weights` so the parts sum EXACTLY to `total`: each part
 * gets the floor of its exact share, and the leftover units go one by one by
 * the largest remainder, ties broken by `priority` (lower first; defaults to
 * the index). Negative totals (refunds) mirror positive ones. Weights ≤ 0
 * count as 0; when every weight is 0 the split is equal.
 */
export function allocate(
	total: number,
	weights: readonly number[],
	priority?: readonly number[],
): number[] {
	const n = weights.length;
	if (n === 0) return [];
	if (!Number.isInteger(total))
		throw new Error(`allocate: total must be an integer (${total})`);
	const sign = total < 0 ? -1n : 1n;
	const T = BigInt(Math.abs(total));
	const ints = weights.every((x) => Number.isSafeInteger(x));
	let w = weights.map((x) =>
		Number.isFinite(x) && x > 0
			? BigInt(ints ? x : Math.round(x * 1_000_000))
			: 0n,
	);
	let W = w.reduce((a, b) => a + b, 0n);
	if (W === 0n) {
		w = weights.map(() => 1n);
		W = BigInt(n);
	}
	const base: bigint[] = [];
	const rem: bigint[] = [];
	let used = 0n;
	for (let i = 0; i < n; i++) {
		const p = T * (w[i] as bigint);
		const b = p / W;
		base.push(b);
		rem.push(p % W);
		used += b;
	}
	let left = T - used;
	const order = [...Array(n).keys()].sort((a, b) => {
		const ra = rem[a] as bigint;
		const rb = rem[b] as bigint;
		if (ra !== rb) return ra > rb ? -1 : 1;
		const pa = priority?.[a] ?? a;
		const pb = priority?.[b] ?? b;
		return pa - pb || a - b;
	});
	for (let k = 0; left > 0n; k = (k + 1) % n) {
		const i = order[k] as number;
		base[i] = (base[i] as bigint) + 1n;
		left -= 1n;
	}
	return base.map((b) => Number(b * sign));
}

/**
 * Tie-break ranks for `ids`: payers first (in the order given), then trip
 * member order, then the order of `ids`.
 */
export function priorityOf(
	ids: readonly string[],
	payerIds: readonly string[] = [],
	memberOrder: readonly string[] = [],
): number[] {
	return ids.map((id, i) => {
		const p = payerIds.indexOf(id);
		if (p >= 0) return p;
		const m = memberOrder.indexOf(id);
		return payerIds.length + (m >= 0 ? m : memberOrder.length + i);
	});
}

/** Allocates `total` over a member → weight record, deterministically. */
export function allocateTo(
	total: number,
	weights: Readonly<Record<string, number>>,
	payerIds: readonly string[] = [],
	memberOrder: readonly string[] = [],
): Record<string, number> {
	const ids = sortMembers(Object.keys(weights), memberOrder);
	const parts = allocate(
		total,
		ids.map((id) => weights[id] ?? 0),
		priorityOf(ids, payerIds, memberOrder),
	);
	const out: Record<string, number> = {};
	ids.forEach((id, i) => {
		out[id] = parts[i] ?? 0;
	});
	return out;
}

/** `total` split equally among `memberIds` (leftover to the payer, then member order). */
export function splitEqual(
	total: number,
	memberIds: readonly string[],
	payerIds: readonly string[] = [],
	memberOrder: readonly string[] = [],
): Record<string, number> {
	const ids = [...new Set(memberIds)];
	return allocateTo(
		total,
		Object.fromEntries(ids.map((id) => [id, 1])),
		payerIds,
		memberOrder,
	);
}

function sortMembers(ids: readonly string[], memberOrder: readonly string[]) {
	const rank = (id: string) => {
		const i = memberOrder.indexOf(id);
		return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
	};
	return [...ids].sort(
		(a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
	);
}

function sum(xs: Iterable<number>): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}

function addInto(
	acc: Record<string, number>,
	part: Readonly<Record<string, number>>,
	sign = 1,
) {
	for (const [k, v] of Object.entries(part)) acc[k] = (acc[k] ?? 0) + sign * v;
}

// ---------------------------------------------------------------------------
// Expense shapes (structural: `ExpenseDto` satisfies them)
// ---------------------------------------------------------------------------

export type EnginePayer = { memberId: string; amountMinor: number };
export type EnginePayment = {
	id?: string;
	currency: string;
	amountMinor: number;
	homeAmountMinor: number | null;
	paidAt?: string;
	payers: readonly EnginePayer[];
};
export type EngineLine = {
	label?: string;
	amountMinor: number;
	memberIds: readonly string[];
};
export type EngineFee = {
	label?: string;
	kind: "percent" | "fixed";
	percent: number | null;
	amountMinor: number | null;
};
export type EnginePoints = {
	program: string;
	points: number;
	sourceProgram: string | null;
	sourcePoints: number | null;
	cashValueMinor: number | null;
	cashValueCurrency: string | null;
	/** The cash value in the home currency (the server fills it). */
	cashValueHomeMinor?: number | null;
};
export type EngineExpense = {
	id: string;
	title?: string;
	category?: ExpenseCategory;
	amountMinor: number | null;
	currency: string | null;
	homeAmountMinor: number | null;
	/**
	 * The home currency and the rate (home per 1 unit of `currency`) behind
	 * `homeAmountMinor`: the latest daily rate, or the cost's manual one. The
	 * unpaid remainder of a part-paid cost converts at it (EXTENSIONS §8.2);
	 * without them it is scaled from `homeAmountMinor`.
	 */
	homeCurrency?: string | null;
	fxRate?: number | null;
	splitMode: "equal" | "exact";
	shares: readonly { memberId: string; amountMinor: number | null }[];
	lines: readonly EngineLine[];
	fees: readonly EngineFee[];
	payments: readonly EnginePayment[];
	isPrivate: boolean;
	refundOfId: string | null;
	points: EnginePoints | null;
};
export type EngineSettlement = {
	fromMemberId: string;
	toMemberId: string;
	homeAmountMinor: number | null;
};

export type MoneyCtx = {
	/** Trip member order (`graph.members`), the tie-break after the payer. */
	memberOrder?: readonly string[];
	/** Other expenses by id (refunds read their original's proportions). */
	byId?: ReadonlyMap<string, EngineExpense>;
};

/** Payers of every payment, the biggest contributor first. */
export function payerOrder(payments: readonly EnginePayment[]): string[] {
	const paid: Record<string, number> = {};
	const first: string[] = [];
	for (const p of payments)
		for (const x of p.payers) {
			if (!(x.memberId in paid)) first.push(x.memberId);
			paid[x.memberId] = (paid[x.memberId] ?? 0) + Math.abs(x.amountMinor);
		}
	return first.sort(
		(a, b) =>
			(paid[b] ?? 0) - (paid[a] ?? 0) || first.indexOf(a) - first.indexOf(b),
	);
}

// ---------------------------------------------------------------------------
// Itemize
// ---------------------------------------------------------------------------

/** A percent fee on `base` minor units, rounded half away from zero. */
export function percentOf(base: number, percent: number): number {
	const bp = BigInt(Math.round(percent * 10_000)); // 1% = 10_000
	const p = BigInt(Math.abs(base)) * bp;
	const q = p / 1_000_000n;
	const r = p % 1_000_000n;
	const v = Number(r * 2n >= 1_000_000n ? q + 1n : q);
	return base < 0 ? -v : v;
}

export type ItemizeResult = {
	/** Each person's share of lines + fees. */
	perMember: Record<string, number>;
	/** Each person's lines only. */
	subtotals: Record<string, number>;
	linesTotal: number;
	/** Per fee, its amount. */
	feeAmounts: number[];
	/** lines + fees. */
	total: number;
};

/**
 * ADDENDUM §6 itemize: a line several people had is split equally among them;
 * each fee (a % of the lines, or a fixed amount) is spread proportionally to
 * each person's subtotal.
 */
export function itemize(
	lines: readonly EngineLine[],
	fees: readonly EngineFee[],
	payerIds: readonly string[] = [],
	memberOrder: readonly string[] = [],
): ItemizeResult {
	const subtotals: Record<string, number> = {};
	for (const line of lines) {
		if (!line.memberIds.length) continue;
		addInto(
			subtotals,
			splitEqual(line.amountMinor, line.memberIds, payerIds, memberOrder),
		);
	}
	const linesTotal = sum(lines.map((l) => l.amountMinor));
	const perMember: Record<string, number> = { ...subtotals };
	const feeAmounts: number[] = [];
	for (const f of fees) {
		const amount =
			f.kind === "percent"
				? percentOf(linesTotal, f.percent ?? 0)
				: (f.amountMinor ?? 0);
		feeAmounts.push(amount);
		if (amount !== 0 && Object.keys(subtotals).length)
			addInto(perMember, allocateTo(amount, subtotals, payerIds, memberOrder));
	}
	return {
		perMember,
		subtotals,
		linesTotal,
		feeAmounts,
		total: linesTotal + sum(feeAmounts),
	};
}

// ---------------------------------------------------------------------------
// One expense
// ---------------------------------------------------------------------------

/**
 * Who owes what of the expense's planned total, in ITS currency. Private
 * expenses owe nothing (they stay out of splits). A split with nobody in it
 * falls back to the payers (they paid for themselves), so balances always sum
 * to zero.
 */
export function owedShares(
	exp: EngineExpense,
	ctx: MoneyCtx = {},
): Record<string, number> {
	if (exp.isPrivate) return {};
	const order = ctx.memberOrder ?? [];
	const payers = payerOrder(exp.payments);
	const total = exp.amountMinor ?? 0;
	if (exp.refundOfId) {
		const orig = ctx.byId?.get(exp.refundOfId);
		if (orig && !orig.isPrivate && orig.refundOfId !== exp.id) {
			const w = owedShares({ ...orig, refundOfId: null }, ctx);
			if (Object.keys(w).length && Object.values(w).some((v) => v !== 0))
				return allocateTo(total, absWeights(w), payers, order);
		}
	}
	if (exp.lines.length) {
		const it = itemize(exp.lines, exp.fees, payers, order);
		if (it.total === total) return it.perMember;
		return allocateTo(total, absWeights(it.perMember), payers, order);
	}
	const shares = exp.shares.filter((s) => s.memberId);
	if (shares.length) {
		if (exp.splitMode === "exact") {
			const w: Record<string, number> = {};
			for (const s of shares) w[s.memberId] = s.amountMinor ?? 0;
			if (sum(Object.values(w)) === total) return w;
			return allocateTo(total, absWeights(w), payers, order);
		}
		return splitEqual(
			total,
			shares.map((s) => s.memberId),
			payers,
			order,
		);
	}
	if (payers.length && total !== 0) {
		const w: Record<string, number> = {};
		for (const p of exp.payments)
			for (const x of p.payers)
				w[x.memberId] = (w[x.memberId] ?? 0) + Math.abs(x.amountMinor);
		return allocateTo(total, w, payers, order);
	}
	return {};
}

function absWeights(
	w: Readonly<Record<string, number>>,
): Record<string, number> {
	return Object.fromEntries(
		Object.entries(w).map(([k, v]) => [k, Math.abs(v)]),
	);
}

export type ExpenseStatusValue = "planned" | "partial" | "paid";

/**
 * planned (no payment) → partial ("¥10k of ¥60k") → paid (covered). Same
 * currency: compared in minor units; mixed: in the home currency.
 */
export function expenseStatus(exp: EngineExpense): ExpenseStatusValue {
	if (!exp.payments.length) return "planned";
	const total = exp.amountMinor;
	if (total === null || total === 0) return "paid";
	const cov = paidInCurrency(exp);
	if (cov !== null)
		return total > 0
			? cov >= total
				? "paid"
				: "partial"
			: cov <= total
				? "paid"
				: "partial";
	const planned = exp.homeAmountMinor;
	const paid = sum(exp.payments.map((p) => p.homeAmountMinor ?? 0));
	if (planned === null) return "partial";
	// Rates move between the plan and the payment: within 0.5% counts as paid.
	const tol = Math.abs(planned) * 0.005;
	return Math.abs(paid) + tol >= Math.abs(planned) ? "paid" : "partial";
}

type RateFields = {
	fxManual: boolean;
	fxRate: number | null;
	currency: string | null;
};

/**
 * A payment's OWN manual rate (undefined = none). A manual rate on the cost
 * also converts its payments in the same currency (ADDENDUM §6 "manual rate
 * override per cost": what was paid follows it) and is stored on them; that
 * inherited rate isn't the payment's own, so it follows the cost's rate when
 * that changes or is cleared.
 */
export function ownPaymentRate(
	payment: RateFields,
	expense: RateFields,
): number | undefined {
	if (!payment.fxManual || payment.fxRate === null) return undefined;
	const inherited =
		expense.fxManual &&
		expense.fxRate !== null &&
		payment.currency === expense.currency &&
		payment.fxRate === expense.fxRate;
	return inherited ? undefined : payment.fxRate;
}

/** Σ payments in the expense's currency, or null when a payment is in another one. */
export function paidInCurrency(exp: EngineExpense): number | null {
	if (!exp.currency) return null;
	let s = 0;
	for (const p of exp.payments) {
		if (p.currency !== exp.currency) return null;
		s += p.amountMinor;
	}
	return s;
}

/** The unpaid remainder in the expense's currency (0 when paid; null when unknown). */
export function remainingInCurrency(exp: EngineExpense): number | null {
	if (exp.amountMinor === null) return 0;
	const paid = paidInCurrency(exp);
	if (paid === null) return null;
	const r = exp.amountMinor - paid;
	return exp.amountMinor >= 0 ? Math.max(0, r) : Math.min(0, r);
}

/**
 * `remainder` (minor units of the expense's currency) at home, at the rate
 * the planned total uses (the latest daily rate or the cost's manual rate).
 * Null when the planned total has no home amount yet.
 */
export function remainderAtHome(
	exp: Pick<
		EngineExpense,
		"amountMinor" | "currency" | "homeAmountMinor" | "homeCurrency" | "fxRate"
	>,
	remainder: number,
): number | null {
	if (remainder === 0) return 0;
	if (exp.homeAmountMinor === null || !exp.amountMinor || !exp.currency)
		return null;
	if (exp.homeCurrency && exp.fxRate && exp.fxRate > 0)
		return convertMinor(remainder, exp.currency, exp.homeCurrency, exp.fxRate);
	// No rate on hand: the same proportion of the planned total's home amount
	// (rounded half away from zero).
	const num =
		BigInt(Math.abs(exp.homeAmountMinor)) * BigInt(Math.abs(remainder));
	const den = BigInt(Math.abs(exp.amountMinor));
	const q = num / den;
	const v = Number((num % den) * 2n >= den ? q + 1n : q);
	const sign =
		Math.sign(exp.homeAmountMinor) *
		Math.sign(remainder) *
		Math.sign(exp.amountMinor);
	return sign < 0 ? -v : v;
}

export type ExpenseFacts = {
	status: ExpenseStatusValue;
	/**
	 * The planned total at home (null = rate pending). A part-paid cost counts
	 * what was paid (each payment at its own date's rate) plus the unpaid
	 * remainder at the latest rate (EXTENSIONS §8.2, ADDENDUM §7.3).
	 */
	plannedHome: number | null;
	/** Σ payments at home. */
	actualHome: number;
	/** The unpaid remainder at home, at the latest rate (counts as planned). */
	remainingHome: number;
	/** Owed per member in the expense's currency. */
	owed: Record<string, number>;
	plannedShare: Record<string, number>;
	actualShare: Record<string, number>;
	/** Paid per member at home. */
	paid: Record<string, number>;
	/** Payments whose home amount is still pending a rate. */
	unconverted: boolean;
};

/** Home-currency facts for one expense (shares split with the owed proportions). */
export function expenseFacts(
	exp: EngineExpense,
	ctx: MoneyCtx = {},
): ExpenseFacts {
	const order = ctx.memberOrder ?? [];
	const payers = payerOrder(exp.payments);
	const owed = owedShares(exp, ctx);
	const status = expenseStatus(exp);
	const actualHome = sum(exp.payments.map((p) => p.homeAmountMinor ?? 0));
	const unconverted =
		exp.payments.some((p) => p.homeAmountMinor === null) ||
		(exp.amountMinor !== null && exp.homeAmountMinor === null);
	let plannedHome =
		exp.amountMinor === null
			? exp.payments.length
				? actualHome
				: 0
			: exp.homeAmountMinor;
	let remainingHome = 0;
	if (status !== "paid" && plannedHome !== null) {
		// MONEY-16 / ADDENDUM §7.3: payments convert at their paid date, the
		// unpaid remainder at the latest rate, so a deposit paid when the rate
		// was different never shifts what is still to pay.
		const left = remainingInCurrency(exp);
		const leftHome =
			status === "partial" && left !== null ? remainderAtHome(exp, left) : null;
		if (leftHome !== null) {
			remainingHome = leftHome;
			if (!exp.payments.some((p) => p.homeAmountMinor === null))
				plannedHome = actualHome + leftHome;
		} else {
			const r = plannedHome - actualHome;
			remainingHome = plannedHome >= 0 ? Math.max(0, r) : Math.min(0, r);
		}
	}
	const weights = absWeights(owed);
	const hasSplit = Object.keys(weights).length > 0;
	const plannedShare =
		hasSplit && plannedHome !== null
			? allocateTo(plannedHome, weights, payers, order)
			: {};
	const actualShare = hasSplit
		? allocateTo(actualHome, weights, payers, order)
		: {};
	const paid: Record<string, number> = {};
	for (const p of exp.payments) {
		if (p.homeAmountMinor === null || !p.payers.length) continue;
		const w: Record<string, number> = {};
		for (const x of p.payers)
			w[x.memberId] = (w[x.memberId] ?? 0) + Math.abs(x.amountMinor);
		addInto(paid, allocateTo(p.homeAmountMinor, w, payers, order));
	}
	return {
		status,
		plannedHome,
		actualHome,
		remainingHome,
		owed,
		plannedShare,
		actualShare,
		paid,
		unconverted,
	};
}

// ---------------------------------------------------------------------------
// Balances and settle-up (trip-wide)
// ---------------------------------------------------------------------------

/**
 * Net per member at home: paid − actual share, plus settlements (the payer of
 * a settlement is owed less). Private expenses never count; points never
 * enter (only the cash taxes/fees payments of a points booking do).
 */
export function balances(
	expenses: readonly EngineExpense[],
	settlements: readonly EngineSettlement[],
	ctx: MoneyCtx = {},
): Record<string, number> {
	const byId = ctx.byId ?? new Map(expenses.map((e) => [e.id, e]));
	const net: Record<string, number> = {};
	for (const e of expenses) {
		if (e.isPrivate) continue;
		const f = expenseFacts(e, { ...ctx, byId });
		addInto(net, f.paid);
		addInto(net, f.actualShare, -1);
	}
	for (const s of settlements) {
		const h = s.homeAmountMinor ?? 0;
		net[s.fromMemberId] = (net[s.fromMemberId] ?? 0) + h;
		net[s.toMemberId] = (net[s.toMemberId] ?? 0) - h;
	}
	return net;
}

export type Transfer = { from: string; to: string; amountMinor: number };

/**
 * Minimal transfers that zero `net` (member → home minor units; + = is owed):
 * the biggest debtor pays the biggest creditor, repeatedly, so there are at
 * most n−1 transfers. Deterministic (ties by id).
 */
export function settleUp(net: Readonly<Record<string, number>>): Transfer[] {
	const cred = Object.entries(net)
		.filter(([, v]) => v > 0)
		.map(([id, v]) => ({ id, v }));
	const debt = Object.entries(net)
		.filter(([, v]) => v < 0)
		.map(([id, v]) => ({ id, v: -v }));
	const byAmount = (
		a: { id: string; v: number },
		b: { id: string; v: number },
	) => b.v - a.v || (a.id < b.id ? -1 : 1);
	const out: Transfer[] = [];
	for (;;) {
		cred.sort(byAmount);
		debt.sort(byAmount);
		const c = cred[0];
		const d = debt[0];
		if (!c || !d || c.v <= 0 || d.v <= 0) break;
		const x = Math.min(c.v, d.v);
		out.push({ from: d.id, to: c.id, amountMinor: x });
		c.v -= x;
		d.v -= x;
		if (c.v === 0) cred.shift();
		if (d.v === 0) debt.shift();
	}
	return out;
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

/**
 * Cents per point (home MINOR units per point): (cash price − cash taxes and
 * fees paid) ÷ points. Null without a cash price or points.
 */
export function centsPerPoint(
	cashValueHome: number | null | undefined,
	feesHome: number,
	points: number | null | undefined,
): number | null {
	if (cashValueHome === null || cashValueHome === undefined || !points)
		return null;
	return (cashValueHome - feesHome) / points;
}

/** "1.84¢" (2-decimal homes) or "¥1.9/pt". */
export function formatCpp(minorPerPoint: number, home: string): string {
	if (minorDigits(home) === 2) return `${minorPerPoint.toFixed(2)}¢`;
	return `${currencySymbol(home)}${minorPerPoint.toFixed(2)}/pt`;
}

export type ProgramSummary = {
	program: string;
	/** Points redeemed from this programme. */
	points: number;
	perMember: Record<string, number>;
	/** Bookings that have a cash price (the cpp average's base). */
	valuedPoints: number;
	valueHome: number;
	feesHome: number;
	/** Averaged over the valued bookings: Σ(value − fees) ÷ Σ points. */
	cpp: number | null;
	/** As a source programme (transferred from), for the source cpp. */
	sourcePoints: number;
	sourceValuedPoints: number;
	sourceCpp: number | null;
};

// ---------------------------------------------------------------------------
// Scope summary
// ---------------------------------------------------------------------------

export type PersonTotals = {
	/** Share of the planned totals. */
	planned: number;
	/** Share of what was actually paid. */
	actual: number;
	/** What they paid. */
	paid: number;
	/** paid − actual (within this scope; + = paid more than their share). */
	net: number;
};

export type ScopeSummary = {
	count: number;
	plannedHome: number;
	actualHome: number;
	remainingHome: number;
	/** actual + remaining (what the scope will cost at this point). */
	projectedHome: number;
	/** Σ over PAID expenses of (actual − planned): + = over plan. */
	deltaHome: number;
	perPerson: Record<string, PersonTotals>;
	byCategory: Partial<
		Record<ExpenseCategory, { planned: number; actual: number; count: number }>
	>;
	programs: ProgramSummary[];
	/** Rows still waiting for a rate. */
	unconverted: number;
	/** My private rows (only I see them), kept out of every other number. */
	privateCount: number;
	privatePlannedHome: number;
	privateActualHome: number;
	/**
	 * When every counted cost (and each of its payments) is in ONE currency:
	 * the planned, paid and still-to-pay totals in it, exactly (a "Local"
	 * display in that currency shows these instead of a round trip through
	 * home cents: ₩15,000, never "≈ ₩14,997"), and the per-person shares, nets
	 * and category totals in it too, so an equal ¥1,500 split reads ¥500 each
	 * (QA MONEY-19).
	 */
	original: {
		currency: string;
		planned: number;
		actual: number;
		remaining: number;
		perPerson: Record<string, PersonTotals>;
		byCategory: Partial<
			Record<
				ExpenseCategory,
				{ planned: number; actual: number; count: number }
			>
		>;
	} | null;
};

export type OriginalAmounts = {
	currency: string;
	/** The planned amount (or, with none, what was paid). */
	planned: number;
	actual: number;
	/** Still to pay (0 once paid). */
	remaining: number;
};

/**
 * One cost in its own currency: planned, paid and still to pay, exactly.
 * Null when a payment is in another currency (or there is no amount at all).
 */
export function originalAmounts(e: EngineExpense): OriginalAmounts | null {
	let currency = e.amountMinor !== null ? e.currency : null;
	let actual = 0;
	for (const p of e.payments) {
		if (currency === null) currency = p.currency;
		else if (p.currency !== currency) return null;
		actual += p.amountMinor;
	}
	if (!currency) return null;
	const status = expenseStatus(e);
	return {
		currency,
		planned: e.amountMinor ?? actual,
		actual,
		remaining: status === "paid" ? 0 : (remainingInCurrency(e) ?? 0),
	};
}

/**
 * Totals and true-ups for the expenses in one scope (the caller filters them).
 * Private rows are counted separately; points never enter cash numbers.
 */
export function scopeSummary(
	expenses: readonly EngineExpense[],
	ctx: MoneyCtx = {},
): ScopeSummary {
	const byId = ctx.byId ?? new Map(expenses.map((e) => [e.id, e]));
	const c = { ...ctx, byId };
	const s: ScopeSummary = {
		count: 0,
		plannedHome: 0,
		actualHome: 0,
		remainingHome: 0,
		projectedHome: 0,
		deltaHome: 0,
		perPerson: {},
		byCategory: {},
		programs: [],
		unconverted: 0,
		privateCount: 0,
		privatePlannedHome: 0,
		privateActualHome: 0,
		original: null,
	};
	/** The one currency of every counted cost so far (undefined = none yet, null = mixed). */
	let oneCurrency: string | null | undefined;
	const orig = { planned: 0, actual: 0, remaining: 0 };
	const origPeople: Record<string, PersonTotals> = {};
	const origCategory: NonNullable<ScopeSummary["original"]>["byCategory"] = {};
	const sameCurrency = (c: string | null) => {
		if (c === null) return;
		if (oneCurrency === undefined) oneCurrency = c;
		else if (oneCurrency !== c) oneCurrency = null;
	};
	const programs = new Map<string, ProgramSummary>();
	const program = (name: string) => {
		let p = programs.get(name);
		if (!p) {
			p = {
				program: name,
				points: 0,
				perMember: {},
				valuedPoints: 0,
				valueHome: 0,
				feesHome: 0,
				cpp: null,
				sourcePoints: 0,
				sourceValuedPoints: 0,
				sourceCpp: null,
			};
			programs.set(name, p);
		}
		return p;
	};
	const sourceValue = new Map<string, { value: number; points: number }>();
	const person = (id: string) => {
		let p = s.perPerson[id];
		if (!p) {
			p = { planned: 0, actual: 0, paid: 0, net: 0 };
			s.perPerson[id] = p;
		}
		return p;
	};
	for (const e of expenses) {
		const f = expenseFacts(e, c);
		if (f.unconverted) s.unconverted += 1;
		if (e.isPrivate) {
			s.privateCount += 1;
			s.privatePlannedHome += f.plannedHome ?? 0;
			s.privateActualHome += f.actualHome;
			continue;
		}
		s.count += 1;
		s.plannedHome += f.plannedHome ?? 0;
		s.actualHome += f.actualHome;
		s.remainingHome += f.remainingHome;
		if (e.amountMinor !== null) sameCurrency(e.currency);
		for (const p of e.payments) sameCurrency(p.currency);
		const o = oneCurrency ? originalAmounts(e) : null;
		if (o) {
			orig.planned += o.planned;
			orig.actual += o.actual;
			orig.remaining += o.remaining;
			// The same shares as at home, but of the exact amounts: owed parts
			// (in the cost's currency) and each payer's own amount.
			const payers = payerOrder(e.payments);
			const order = c.memberOrder ?? [];
			const w = absWeights(f.owed);
			const pick = (id: string) => {
				let p = origPeople[id];
				if (!p) {
					p = { planned: 0, actual: 0, paid: 0, net: 0 };
					origPeople[id] = p;
				}
				return p;
			};
			if (Object.keys(w).length) {
				for (const [m, v] of Object.entries(
					allocateTo(o.planned, w, payers, order),
				))
					pick(m).planned += v;
				for (const [m, v] of Object.entries(
					allocateTo(o.actual, w, payers, order),
				))
					pick(m).actual += v;
			}
			for (const p of e.payments)
				for (const x of p.payers) pick(x.memberId).paid += x.amountMinor;
			const oc = e.category ?? "fees_other";
			const cat = origCategory[oc] ?? { planned: 0, actual: 0, count: 0 };
			origCategory[oc] = cat;
			cat.planned += o.planned;
			cat.actual += o.actual;
			cat.count += 1;
		}
		if (f.status === "paid" && e.amountMinor !== null && f.plannedHome !== null)
			s.deltaHome += f.actualHome - f.plannedHome;
		for (const [m, v] of Object.entries(f.plannedShare)) person(m).planned += v;
		for (const [m, v] of Object.entries(f.actualShare)) person(m).actual += v;
		for (const [m, v] of Object.entries(f.paid)) person(m).paid += v;
		const cat = e.category ?? "fees_other";
		const bc = s.byCategory[cat] ?? { planned: 0, actual: 0, count: 0 };
		s.byCategory[cat] = bc;
		bc.planned += f.plannedHome ?? 0;
		bc.actual += f.actualHome;
		bc.count += 1;
		if (e.points) {
			const p = program(e.points.program);
			p.points += e.points.points;
			const w = Object.keys(f.owed).length
				? absWeights(f.owed)
				: Object.fromEntries(payerOrder(e.payments).map((m) => [m, 1]));
			if (Object.keys(w).length)
				addInto(
					p.perMember,
					allocateTo(
						e.points.points,
						w,
						payerOrder(e.payments),
						c.memberOrder ?? [],
					),
				);
			const value = e.points.cashValueHomeMinor;
			if (value !== null && value !== undefined) {
				p.valuedPoints += e.points.points;
				p.valueHome += value;
				p.feesHome += f.actualHome;
				if (e.points.sourceProgram && e.points.sourcePoints) {
					const sv = sourceValue.get(e.points.sourceProgram) ?? {
						value: 0,
						points: 0,
					};
					sv.value += value - f.actualHome;
					sv.points += e.points.sourcePoints;
					sourceValue.set(e.points.sourceProgram, sv);
				}
			}
			if (e.points.sourceProgram && e.points.sourcePoints)
				program(e.points.sourceProgram).sourcePoints += e.points.sourcePoints;
		}
	}
	for (const p of Object.values(s.perPerson)) p.net = p.paid - p.actual;
	s.projectedHome = s.actualHome + s.remainingHome;
	if (oneCurrency && s.unconverted === 0) {
		for (const p of Object.values(origPeople)) p.net = p.paid - p.actual;
		// Everyone the home table lists (a zero row stays a zero row).
		for (const id of Object.keys(s.perPerson))
			origPeople[id] ??= { planned: 0, actual: 0, paid: 0, net: 0 };
		s.original = {
			currency: oneCurrency,
			...orig,
			perPerson: origPeople,
			byCategory: origCategory,
		};
	}
	for (const p of programs.values()) {
		p.cpp = p.valuedPoints ? (p.valueHome - p.feesHome) / p.valuedPoints : null;
		const sv = sourceValue.get(p.program);
		if (sv?.points) {
			p.sourceValuedPoints = sv.points;
			p.sourceCpp = sv.value / sv.points;
		}
	}
	s.programs = [...programs.values()].sort(
		(a, b) =>
			b.points + b.sourcePoints - (a.points + a.sourcePoints) ||
			(a.program < b.program ? -1 : 1),
	);
	return s;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
	lodging: "Lodging",
	transport: "Transport",
	food_drink: "Food & drink",
	activities: "Activities & tickets",
	shopping: "Shopping",
	fees_other: "Fees & other",
};

/** ADDENDUM §6: the default category from the attached place or leg. */
export function categoryFor(
	target:
		| { kind: "place"; category: PlaceCategory | null }
		| { kind: "leg"; mode: LegMode | null; stay?: boolean }
		| { kind: "other" },
): ExpenseCategory {
	if (target.kind === "leg") return "transport";
	if (target.kind === "other" || !target.category) return "fees_other";
	switch (target.category) {
		case "lodging":
			return "lodging";
		case "food_drink":
		case "restaurant":
		case "cafe":
		case "market":
		case "bar":
		case "nightlife":
			return "food_drink";
		case "shopping":
			return "shopping";
		case "station":
		case "airport":
		case "port":
			return "transport";
		case "other":
			return "fees_other";
		default:
			return "activities";
	}
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180; text cells guarded against formula injection)
// ---------------------------------------------------------------------------

/** A text cell: quoted when needed; a leading = + - @ tab or CR gets a ' prefix. */
export function csvText(v: string | null | undefined): string {
	let s = v ?? "";
	if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A number cell in major units at the currency's precision ("1200", "8.10", "-3.50"). */
export function csvAmount(
	minor: number | null | undefined,
	currency: string,
): string {
	if (minor === null || minor === undefined) return "";
	return fromMinor(minor, currency).toFixed(minorDigits(currency));
}

export type CsvExpenseRow = {
	date: string;
	title: string;
	where: string;
	category: ExpenseCategory;
	status: ExpenseStatusValue;
	amountMinor: number | null;
	currency: string | null;
	plannedHome: number | null;
	actualHome: number;
	paidBy: string;
	split: string;
	points: string;
	isPrivate: boolean;
	note: string;
};

/**
 * The byte-order mark the CSV starts with: without it Excel reads a UTF-8
 * file as Windows-1252 and shows "Expenses â€" Asia 2027" (QA MONEY-20).
 */
export const CSV_BOM = "\uFEFF";

/**
 * The scope's CSV (UTF-8, with a BOM): expenses, then per-person totals, then
 * the trip-wide balances. `display` adds a converted column to the totals.
 */
export function moneyCsv(opts: {
	scopeName: string;
	home: string;
	rows: readonly CsvExpenseRow[];
	summary: ScopeSummary;
	balances: Readonly<Record<string, number>>;
	names: Readonly<Record<string, string>>;
	display?: { currency: string; rate: number } | null;
}): string {
	const { home, summary, names } = opts;
	const lines: string[] = [];
	const row = (...cells: string[]) => lines.push(cells.join(","));
	const disp =
		opts.display && opts.display.currency !== home ? opts.display : null;
	const conv = (m: number) =>
		disp
			? csvAmount(
					convertMinor(m, home, disp.currency, disp.rate),
					disp.currency,
				)
			: null;
	row(csvText(`Expenses — ${opts.scopeName}`));
	row(
		"Date",
		"Title",
		"Where",
		"Category",
		"Status",
		"Amount",
		"Currency",
		`Planned (${home})`,
		`Paid (${home})`,
		"Paid by",
		"Split",
		"Points",
		"Private",
		"Note",
	);
	const expenseRow = (r: CsvExpenseRow) =>
		row(
			csvText(r.date),
			csvText(r.title),
			csvText(r.where),
			csvText(EXPENSE_CATEGORY_LABEL[r.category]),
			r.status,
			r.currency ? csvAmount(r.amountMinor, r.currency) : "",
			r.currency ?? "",
			csvAmount(r.plannedHome, home),
			csvAmount(r.actualHome, home),
			csvText(r.paidBy),
			csvText(r.split),
			csvText(r.points),
			r.isPrivate ? "yes" : "",
			csvText(r.note),
		);
	// The rows above "Total" add up to it (and to the Money tab); my private
	// rows are kept out of every total, so they get their own block below.
	for (const r of opts.rows) if (!r.isPrivate) expenseRow(r);
	row(
		"Total",
		"",
		"",
		"",
		"",
		"",
		"",
		csvAmount(summary.plannedHome, home),
		csvAmount(summary.actualHome, home),
	);
	const mine = opts.rows.filter((r) => r.isPrivate);
	if (mine.length) {
		lines.push("");
		row("Only you (private; not in the totals above)");
		for (const r of mine) expenseRow(r);
		row(
			"Private total",
			"",
			"",
			"",
			"",
			"",
			"",
			csvAmount(summary.privatePlannedHome, home),
			csvAmount(summary.privateActualHome, home),
		);
	}
	lines.push("");
	row(csvText(`Per person — ${opts.scopeName}`));
	row(
		"Person",
		`Planned share (${home})`,
		`Actual share (${home})`,
		`Paid (${home})`,
		`Net (${home})`,
		...(disp ? [`Net (≈ ${disp.currency})`] : []),
	);
	for (const [m, p] of Object.entries(summary.perPerson))
		row(
			csvText(names[m] ?? "Former member"),
			csvAmount(p.planned, home),
			csvAmount(p.actual, home),
			csvAmount(p.paid, home),
			csvAmount(p.net, home),
			...(disp ? [conv(p.net) ?? ""] : []),
		);
	lines.push("");
	row("Balances — whole trip");
	row(
		"Person",
		`Balance (${home})`,
		...(disp ? [`Balance (≈ ${disp.currency})`] : []),
	);
	for (const [m, v] of Object.entries(opts.balances))
		row(
			csvText(names[m] ?? "Former member"),
			csvAmount(v, home),
			...(disp ? [conv(v) ?? ""] : []),
		);
	return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

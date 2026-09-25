/**
 * FX (EXTENSIONS §8.2, ADDENDUM §7.3), WP-Money.
 *
 * Source: the free, no-key fawazahmed0 currency-api (every trip currency incl.
 * TWD and VND; historical dates by URL), primary on jsDelivr (`FX_URL`, per
 * date `…@<YYYY-MM-DD>/v1`), then its Cloudflare mirror (`FX_FALLBACK_URL`,
 * host `<YYYY-MM-DD>.currency-api.pages.dev`). Hosts come from the env only
 * (never from input); native fetch, 8 s timeout, 2 MB cap, no redirects.
 *
 * Rates are cached per date in `fx_rates` as USD → quote (every other pair is
 * a cross rate); a day is fetched once, under a Redis lock. A date the source
 * lacks (a gap, or the future: a planned payment in 2027) uses the nearest
 * earlier cached date, and the conversion says which ("rate from 12 Sep").
 *
 * Jobs (queue `money`, wired by F): `fxDaily` re-converts planned amounts and
 * rows dated after the rate they used (never manual ones); `fxRehome`
 * re-converts a trip after a home-currency change (manual rates follow by
 * the cross rate, so the user's own rate survives). Budget lines are
 * re-based in the currency change's own transaction (`rebaseBudgets`, money.server).
 */
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import {
	expensePayments,
	expenses,
	fxRates,
	settlements,
	trips,
} from "@/db/schema";
import { convertMinor } from "@/lib/engine/money";
import { getEnv } from "@/server/env.server";
import { key, redis } from "@/server/live/redis.server";
import { withTripTx } from "@/server/tx.server";

export type Conversion = {
	homeMinor: number;
	rate: number;
	/** The rate's own date (earlier than asked when the source had a gap). */
	rateDate: string;
	source: "same" | "currency-api" | "frankfurter" | "manual";
};

export type DayRates = {
	/** The date the rates are for (may be earlier than asked). */
	date: string;
	/** Quote units per 1 USD. */
	rates: ReadonlyMap<string, number>;
	source: string;
};

const BASE = "USD";
const MAX_BYTES = 2_000_000;
const DEFAULT_FX_URL =
	"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1";
const DEFAULT_FALLBACK_URL = "https://latest.currency-api.pages.dev/v1";

let isoCodes: Set<string> | null = null;
/** ISO 4217 codes this runtime knows (the source also lists crypto; those are dropped). */
function iso(): Set<string> {
	if (!isoCodes) {
		try {
			isoCodes = new Set(
				(
					Intl as unknown as { supportedValuesOf(k: string): string[] }
				).supportedValuesOf("currency"),
			);
		} catch {
			isoCodes = new Set();
		}
		for (const c of ["USD", "CAD", "JPY", "KRW", "VND", "TWD", "TRY", "EUR"])
			isoCodes.add(c);
	}
	return isoCodes;
}

/** Today in UTC (`YYYY-MM-DD`); the source publishes by UTC date. */
export function todayUtc(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` of an instant in a zone (a payment's local date). */
export function dateIn(instant: string | Date, tz: string): string {
	const d = typeof instant === "string" ? new Date(instant) : instant;
	try {
		return new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(d);
	} catch {
		return d.toISOString().slice(0, 10);
	}
}

function fxEnabled(): boolean {
	const env = getEnv();
	// FX_URL empty in the env disables conversion (getCapabilities().fx).
	return env.FX_URL !== undefined || process.env.FX_URL === undefined;
}

function urlsFor(date: string, today: string): string[] {
	const env = getEnv();
	const primary = env.FX_URL ?? DEFAULT_FX_URL;
	const fallback = env.FX_FALLBACK_URL ?? DEFAULT_FALLBACK_URL;
	const out: string[] = [];
	const dated = primary.includes("@latest")
		? primary.replace("@latest", `@${date}`)
		: primary;
	out.push(`${dated.replace(/\/$/, "")}/currencies/usd.json`);
	if (fallback.includes("//latest."))
		out.push(
			`${fallback.replace("//latest.", `//${date}.`).replace(/\/$/, "")}/currencies/usd.json`,
		);
	if (date === today) {
		out.push(`${primary.replace(/\/$/, "")}/currencies/usd.json`);
		out.push(`${fallback.replace(/\/$/, "")}/currencies/usd.json`);
	}
	return [...new Set(out)];
}

/** Parses the currency-api's `{ date, usd: { jpy: 147.2, … } }`. */
export function parseCurrencyApi(
	body: unknown,
): { date: string; rates: Map<string, number> } | null {
	if (!body || typeof body !== "object") return null;
	const b = body as { date?: unknown; usd?: unknown };
	if (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date))
		return null;
	if (!b.usd || typeof b.usd !== "object") return null;
	const codes = iso();
	const rates = new Map<string, number>();
	for (const [k, v] of Object.entries(b.usd as Record<string, unknown>)) {
		const code = k.toUpperCase();
		if (!/^[A-Z]{3}$/.test(code) || !codes.has(code)) continue;
		if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1e12)
			continue;
		rates.set(code, v);
	}
	rates.set(BASE, 1);
	return rates.size > 10 ? { date: b.date, rates } : null;
}

async function fetchJson(url: string): Promise<unknown> {
	const res = await fetch(url, {
		redirect: "error",
		signal: AbortSignal.timeout(8_000),
		headers: { accept: "application/json" },
	});
	if (!res.ok) throw new Error(`fx ${res.status}`);
	const len = Number(res.headers.get("content-length") ?? 0);
	if (len > MAX_BYTES) throw new Error("fx response too large");
	const text = await res.text();
	if (text.length > MAX_BYTES) throw new Error("fx response too large");
	return JSON.parse(text);
}

async function loadDay(date: string): Promise<DayRates | null> {
	const rows = await db
		.select({
			quote: fxRates.quote,
			rate: fxRates.rate,
			source: fxRates.source,
		})
		.from(fxRates)
		.where(and(eq(fxRates.date, date), eq(fxRates.base, BASE)));
	if (rows.length < 10) return null;
	const rates = new Map<string, number>(
		rows.map((r) => [r.quote, Number(r.rate)]),
	);
	rates.set(BASE, 1);
	return { date, rates, source: rows[0]?.source ?? "currency-api" };
}

async function storeDay(date: string, rates: ReadonlyMap<string, number>) {
	const values = [...rates]
		.filter(([q]) => q !== BASE)
		.map(([quote, rate]) => ({
			date,
			base: BASE,
			quote,
			rate,
			source: "currency-api",
		}));
	for (let i = 0; i < values.length; i += 200)
		await db
			.insert(fxRates)
			.values(values.slice(i, i + 200))
			.onConflictDoNothing();
}

/** Fetches one date from the source (once across processes, under a lock). */
async function fetchDay(date: string, today: string): Promise<DayRates | null> {
	const lockKey = key("fx", "lock", date);
	let locked = false;
	try {
		locked = (await redis().set(lockKey, "1", "PX", 20_000, "NX")) === "OK";
	} catch {
		locked = true; // Redis down: fetch anyway, the insert is idempotent
	}
	if (!locked) {
		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 250));
			const hit = await loadDay(date);
			if (hit) return hit;
		}
		return null;
	}
	try {
		const t0 = Date.now();
		for (const url of urlsFor(date, today)) {
			if (Date.now() - t0 > 12_000) break;
			try {
				const parsed = parseCurrencyApi(await fetchJson(url));
				if (!parsed) continue;
				await storeDay(parsed.date, parsed.rates);
				return {
					date: parsed.date,
					rates: parsed.rates,
					source: "currency-api",
				};
			} catch {
				// next URL
			}
		}
		return null;
	} finally {
		try {
			await redis().del(lockKey);
		} catch {
			/* expires by itself */
		}
	}
}

/** Recently resolved dates, per process (the DB is the durable cache). */
const memo = new Map<string, { at: number; value: DayRates | null }>();
const MEMO_MS = 10 * 60_000;
/** Dates whose fetch failed recently: don't hammer a source that's down. */
const failedAt = new Map<string, number>();
const RETRY_MS = 5 * 60_000;

/**
 * The rates for `date` (clamped to today): cached, else fetched, else the
 * nearest earlier cached date, else the nearest later one. Null only when
 * nothing is known at all.
 */
export async function ratesOn(
	date: string,
	opts: { fetch?: boolean; now?: Date } = {},
): Promise<DayRates | null> {
	const today = todayUtc(opts.now);
	const d = date > today ? today : date;
	const m = memo.get(d);
	if (m && Date.now() - m.at < MEMO_MS && m.value) return m.value;
	let r = await loadDay(d);
	const recentlyFailed = Date.now() - (failedAt.get(d) ?? 0) < RETRY_MS;
	if (!r && opts.fetch !== false && fxEnabled() && !recentlyFailed) {
		r = await fetchDay(d, today);
		if (!r) failedAt.set(d, Date.now());
		// A day the source hasn't published yet: try the day before.
		if (!r && d === today) {
			const y = new Date(`${d}T00:00:00Z`);
			y.setUTCDate(y.getUTCDate() - 1);
			const yd = y.toISOString().slice(0, 10);
			r = (await loadDay(yd)) ?? (await fetchDay(yd, today));
		}
	}
	if (!r) {
		const [earlier] = await db
			.select({ date: fxRates.date })
			.from(fxRates)
			.where(and(eq(fxRates.base, BASE), lte(fxRates.date, d)))
			.orderBy(sql`${fxRates.date} desc`)
			.limit(1);
		if (earlier) r = await loadDay(earlier.date);
	}
	if (!r) {
		const [later] = await db
			.select({ date: fxRates.date })
			.from(fxRates)
			.where(and(eq(fxRates.base, BASE), gt(fxRates.date, d)))
			.orderBy(fxRates.date)
			.limit(1);
		if (later) r = await loadDay(later.date);
	}
	if (r?.date === d) memo.set(d, { at: Date.now(), value: r });
	return r;
}

/** `to` units per 1 `from` from one day's USD table, or null when unknown. */
export function crossRate(
	day: Pick<DayRates, "rates">,
	from: string,
	to: string,
): number | null {
	if (from === to) return 1;
	const rf = day.rates.get(from);
	const rt = day.rates.get(to);
	if (!rf || !rt) return null;
	return rt / rf;
}

/** Converts, or null when no rate is known (the row stays "rate pending"). */
export async function tryConvert(
	amountMinor: number,
	from: string,
	to: string,
	date: string,
	opts: { fetch?: boolean } = {},
): Promise<Conversion | null> {
	if (from === to)
		return { homeMinor: amountMinor, rate: 1, rateDate: date, source: "same" };
	const day = await ratesOn(date, opts);
	if (!day) return null;
	const rate = crossRate(day, from, to);
	if (rate === null) return null;
	return {
		homeMinor: convertMinor(amountMinor, from, to, rate),
		rate,
		rateDate: day.date,
		source: "currency-api",
	};
}

/** Like `tryConvert`, but throws when no rate is known. */
export async function convert(
	amountMinor: number,
	from: string,
	to: string,
	date: string,
): Promise<Conversion> {
	const c = await tryConvert(amountMinor, from, to, date);
	if (!c) throw new Error(`No rate for ${from} → ${to} on ${date}.`);
	return c;
}

/** A manual rate (home per unit): never re-converted by the jobs. */
export function manualConversion(
	amountMinor: number,
	from: string,
	to: string,
	rate: number,
	date: string,
): Conversion {
	return {
		homeMinor: convertMinor(amountMinor, from, to, rate),
		rate,
		rateDate: date,
		source: "manual",
	};
}

/** The latest rates as `code → units per 1 home` (for display conversion). */
export async function latestRatesFor(
	home: string,
	opts: { fetch?: boolean } = {},
): Promise<{ date: string; rates: Record<string, number> } | null> {
	const day = await ratesOn(todayUtc(), opts);
	if (!day) return null;
	const rh = day.rates.get(home);
	if (!rh) return null;
	const rates: Record<string, number> = {};
	for (const [code, r] of day.rates) rates[code] = r / rh;
	return { date: day.date, rates };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

type ConvCols = {
	homeCurrency: string;
	homeAmountMinor: number | null;
	fxRate: number | null;
	fxDate: string;
	fxSource: string;
	fxManual: boolean;
};

export function convCols(
	c: Conversion | null,
	home: string,
	fallbackDate: string,
): ConvCols {
	return {
		homeCurrency: home,
		homeAmountMinor: c?.homeMinor ?? null,
		fxRate: c?.rate ?? null,
		fxDate: c?.rateDate ?? fallbackDate,
		fxSource: c?.source ?? "pending",
		fxManual: c?.source === "manual",
	};
}

async function tripHome(tripId: string): Promise<string | null> {
	const [t] = await db
		.select({ settings: trips.settings })
		.from(trips)
		.where(eq(trips.id, tripId));
	if (!t) return null;
	return (t.settings as { currency?: string } | null)?.currency ?? "USD";
}

/**
 * Re-converts one trip's rows. `all` (a home change): every row; otherwise
 * only planned amounts, rows still pending a rate, and rows dated after the
 * rate they used. Manual rates are kept (on a home change they move by the
 * cross rate of their own date). Returns how many rows changed.
 */
export async function reconvertTrip(
	tripId: string,
	opts: { all: boolean; emit?: boolean },
): Promise<number> {
	const home = await tripHome(tripId);
	if (!home) return 0;
	const today = todayUtc();
	const exps = await db
		.select()
		.from(expenses)
		.where(and(eq(expenses.tripId, tripId), isNull(expenses.deletedAt)));
	const pays = exps.length
		? await db
				.select()
				.from(expensePayments)
				.where(eq(expensePayments.tripId, tripId))
		: [];
	const sets = await db
		.select()
		.from(settlements)
		.where(and(eq(settlements.tripId, tripId), isNull(settlements.deletedAt)));

	type Patch = { table: "e" | "p" | "s"; id: string; cols: ConvCols };
	const patches: Patch[] = [];
	const redo = async (
		row: {
			homeCurrency: string | null;
			homeAmountMinor: number | null;
			fxRate: number | null;
			fxDate: string | null;
			fxManual: boolean;
		},
		amount: number,
		currency: string,
		date: string,
		planned: boolean,
	): Promise<ConvCols | null> => {
		const homeChanged = row.homeCurrency !== home;
		const stale =
			opts.all ||
			homeChanged ||
			row.homeAmountMinor === null ||
			planned ||
			(row.fxDate !== null && row.fxDate < date && row.fxDate < today);
		if (!stale) return null;
		if (row.fxManual && row.fxRate !== null) {
			if (!homeChanged) return null;
			const cross = await tryConvert(
				1_000_000,
				row.homeCurrency ?? home,
				home,
				row.fxDate ?? date,
			);
			if (!cross) return null;
			const rate = row.fxRate * cross.rate;
			return convCols(
				manualConversion(amount, currency, home, rate, row.fxDate ?? date),
				home,
				date,
			);
		}
		const c = await tryConvert(amount, currency, home, planned ? today : date);
		if (!c) return null;
		if (
			!homeChanged &&
			c.homeMinor === row.homeAmountMinor &&
			c.rateDate === row.fxDate
		)
			return null;
		return convCols(c, home, date);
	};
	for (const e of exps) {
		if (e.amountMinor === null || !e.currency) continue;
		const cols = await redo(e, e.amountMinor, e.currency, today, true);
		if (cols) patches.push({ table: "e", id: e.id, cols });
	}
	for (const p of pays) {
		const cols = await redo(
			p,
			p.amountMinor,
			p.currency,
			dateIn(p.paidAt, p.paidTz),
			false,
		);
		if (cols) patches.push({ table: "p", id: p.id, cols });
	}
	for (const s of sets) {
		const cols = await redo(
			s,
			s.amountMinor,
			s.currency,
			dateIn(s.settledAt, s.settledTz),
			false,
		);
		if (cols) patches.push({ table: "s", id: s.id, cols });
	}
	if (!patches.length) return 0;
	await withTripTx(tripId, async (tx, out) => {
		for (const p of patches) {
			const t =
				p.table === "e"
					? expenses
					: p.table === "p"
						? expensePayments
						: settlements;
			await tx
				.update(t)
				.set(p.cols)
				.where(and(eq(t.tripId, tripId), eq(t.id, p.id)));
		}
		if (opts.emit !== false) out.emit({ keys: ["money"] });
	});
	return patches.length;
}

/**
 * `money.fxDaily`: today's rates, then every trip with live money rows gets
 * its planned amounts and not-yet-dated rows re-converted.
 */
export async function fxDaily(): Promise<void> {
	await ratesOn(todayUtc());
	const res = await db.execute(sql`
		select distinct trip_id::text as id from expenses where deleted_at is null
		union select distinct trip_id::text from settlements where deleted_at is null`);
	for (const r of res.rows as { id: string }[])
		await reconvertTrip(r.id, { all: false });
}

/** `money.fxRehome`: a home-currency change re-converts every expense, payment and settlement. */
export async function fxRehome(tripId: string): Promise<void> {
	await reconvertTrip(tripId, { all: true });
}

/** Rows of a trip whose home currency isn't the trip's (a home change the job hasn't reached yet). */
export async function staleHomeRows(
	tripId: string,
	home: string,
): Promise<number> {
	const res = await db.execute(sql`
		select count(*)::int as n from expenses
		 where trip_id = ${tripId} and deleted_at is null and home_currency is distinct from ${home}
		   and amount_minor is not null`);
	return (res.rows[0] as { n: number } | undefined)?.n ?? 0;
}

/** Tests: forget the per-process caches. */
export function _resetFxMemo(): void {
	memo.clear();
	failedAt.clear();
}

/**
 * WP-Money's database layer (EXTENSIONS §8, ADDENDUM §6–§7.3): the privacy-
 * filtered read behind `listMoney`, input normalization and validation, and
 * the writes behind every money server function. DB only, except
 * `prepareConversions` (FX; call it BEFORE the transaction).
 *
 * Privacy: every read keeps `not is_private or created_by = me`; a private
 * expense has no split and only its creator pays; it writes no activity.
 * Activity summaries never carry amounts (`meta.expenseId` + `meta.name`).
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@/db/db.server";
import { db } from "@/db/db.server";
import {
	budgetLines,
	expenseFees,
	expenseLineMembers,
	expenseLines,
	expensePaymentPayers,
	expensePayments,
	expenseShares,
	expenses,
	listItems,
	settlements,
	tripMembers,
	trips,
} from "@/db/schema";
import {
	balances,
	categoryFor,
	convertMinor,
	type EngineExpense,
	EXPENSE_CATEGORY_LABEL,
	expenseStatus,
	formatMoney,
	isKnownCurrency,
	itemize,
	owedShares,
	ownPaymentRate,
	payerOrder,
	remainingInCurrency,
} from "@/lib/engine/money";
import type {
	ExpenseCategory,
	LegMode,
	PlaceCategory,
} from "@/lib/schemas/enums";
import type {
	ExpenseInput,
	FeeInput,
	LineInput,
	PaymentInput,
} from "@/lib/schemas/money";
import {
	type BundleTarget,
	bundleTargetColumns,
	bundleTargetOf,
} from "@/lib/schemas/targets";
import { logActivity } from "@/server/activity.server";
import { fail } from "@/server/authz/session.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { assertBundleTarget, tripMemberIds } from "@/server/perms.server";
import { freshKeys } from "@/server/position.server";
import type {
	BudgetLineDto,
	ExpenseDto,
	MoneyDto,
	PaymentDto,
	SettlementDto,
} from "../money.functions";
import {
	type Conversion,
	convCols,
	crossRate,
	dateIn,
	latestRatesFor,
	manualConversion,
	ratesOn,
	todayUtc,
	tryConvert,
} from "./fx.server";

export type Me = { userId: string; memberId: string | null };
type Actor = { userId: string; name: string };

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function tripHomeCurrency(
	exec: DbOrTx,
	tripId: string,
): Promise<string> {
	const [t] = await exec
		.select({ settings: trips.settings })
		.from(trips)
		.where(eq(trips.id, tripId));
	return (t?.settings as { currency?: string } | null)?.currency ?? "USD";
}

const iso = (d: Date | string) =>
	typeof d === "string" ? new Date(d).toISOString() : d.toISOString();

/** Expenses visible to `me` (live unless `withDeleted`), with every child row. */
export async function loadExpenses(
	exec: DbOrTx,
	tripId: string,
	me: Me,
	opts: { ids?: string[]; withDeleted?: boolean; publicOnly?: boolean } = {},
): Promise<ExpenseDto[]> {
	const rows = await exec
		.select()
		.from(expenses)
		.where(
			and(
				eq(expenses.tripId, tripId),
				opts.withDeleted ? undefined : isNull(expenses.deletedAt),
				opts.publicOnly
					? eq(expenses.isPrivate, false)
					: or(
							eq(expenses.isPrivate, false),
							eq(expenses.createdBy, me.userId),
						),
				opts.ids?.length ? inArray(expenses.id, opts.ids) : undefined,
			),
		)
		.orderBy(asc(expenses.createdAt), asc(expenses.id));
	if (!rows.length) return [];
	const ids = rows.map((r) => r.id);
	// One after another: a transaction has a single client.
	const pays = await exec
		.select()
		.from(expensePayments)
		.where(
			and(
				eq(expensePayments.tripId, tripId),
				inArray(expensePayments.expenseId, ids),
			),
		)
		.orderBy(asc(expensePayments.paidAt), asc(expensePayments.id));
	const shares = await exec
		.select()
		.from(expenseShares)
		.where(
			and(
				eq(expenseShares.tripId, tripId),
				inArray(expenseShares.expenseId, ids),
			),
		);
	const lines = await exec
		.select()
		.from(expenseLines)
		.where(
			and(
				eq(expenseLines.tripId, tripId),
				inArray(expenseLines.expenseId, ids),
			),
		)
		.orderBy(asc(expenseLines.position), asc(expenseLines.id));
	const fees = await exec
		.select()
		.from(expenseFees)
		.where(
			and(eq(expenseFees.tripId, tripId), inArray(expenseFees.expenseId, ids)),
		)
		.orderBy(asc(expenseFees.position), asc(expenseFees.id));
	const payIds = pays.map((p) => p.id);
	const lineIds = lines.map((l) => l.id);
	const payers = payIds.length
		? await exec
				.select()
				.from(expensePaymentPayers)
				.where(
					and(
						eq(expensePaymentPayers.tripId, tripId),
						inArray(expensePaymentPayers.paymentId, payIds),
					),
				)
		: [];
	const lineMembers = lineIds.length
		? await exec
				.select()
				.from(expenseLineMembers)
				.where(
					and(
						eq(expenseLineMembers.tripId, tripId),
						inArray(expenseLineMembers.lineId, lineIds),
					),
				)
		: [];
	const group = <T, K>(xs: readonly T[], k: (x: T) => K) => {
		const m = new Map<K, T[]>();
		for (const x of xs) {
			const key = k(x);
			const list = m.get(key);
			if (list) list.push(x);
			else m.set(key, [x]);
		}
		return m;
	};
	const payersBy = group(payers, (p) => p.paymentId);
	const paysBy = group(pays, (p) => p.expenseId);
	const sharesBy = group(shares, (s) => s.expenseId);
	const linesBy = group(lines, (l) => l.expenseId);
	const lineMembersBy = group(lineMembers, (l) => l.lineId);
	const feesBy = group(fees, (f) => f.expenseId);

	return rows.map((e): ExpenseDto => {
		const payments: PaymentDto[] = (paysBy.get(e.id) ?? []).map((p) => ({
			id: p.id,
			paidAt: iso(p.paidAt),
			paidTz: p.paidTz,
			currency: p.currency,
			amountMinor: p.amountMinor,
			homeAmountMinor: p.homeAmountMinor,
			fxRate: p.fxRate === null ? null : Number(p.fxRate),
			fxDate: p.fxDate,
			fxSource: p.fxSource,
			fxManual: p.fxManual,
			method: p.method,
			payers: (payersBy.get(p.id) ?? []).map((x) => ({
				memberId: x.memberId,
				amountMinor: x.amountMinor,
			})),
		}));
		const dto: ExpenseDto = {
			id: e.id,
			target: bundleTargetOf(e),
			title: e.title,
			category: e.category,
			amountMinor: e.amountMinor,
			currency: e.currency,
			homeAmountMinor: e.homeAmountMinor,
			homeCurrency: e.homeCurrency,
			fxRate: e.fxRate === null ? null : Number(e.fxRate),
			fxDate: e.fxDate,
			fxSource: e.fxSource,
			fxManual: e.fxManual,
			points:
				e.points !== null && e.pointsProgram !== null
					? {
							program: e.pointsProgram,
							points: e.points,
							sourceProgram: e.sourceProgram,
							sourcePoints: e.sourcePoints,
							cashValueMinor: e.cashValueMinor,
							cashValueCurrency: e.cashValueCurrency,
						}
					: null,
			expectedOn: e.expectedOn,
			status: "planned",
			splitMode: e.splitMode,
			shares: (sharesBy.get(e.id) ?? []).map((s) => ({
				memberId: s.memberId,
				amountMinor: s.amountMinor,
			})),
			lines: (linesBy.get(e.id) ?? []).map((l) => ({
				id: l.id,
				label: l.label,
				amountMinor: l.amountMinor,
				memberIds: (lineMembersBy.get(l.id) ?? []).map((m) => m.memberId),
			})),
			fees: (feesBy.get(e.id) ?? []).map((f) => ({
				id: f.id,
				label: f.label,
				kind: f.kind,
				percent: f.percent === null ? null : Number(f.percent),
				amountMinor: f.amountMinor,
			})),
			payments,
			isPrivate: e.isPrivate,
			taxFreePending: e.taxFreePending,
			refundOfId: e.refundOfId,
			listItemId: e.listItemId,
			note: e.note,
			createdBy: e.createdBy,
			createdAt: iso(e.createdAt),
			updatedAt: iso(e.updatedAt),
			...(e.deletedAt ? { deletedAt: iso(e.deletedAt) } : {}),
		};
		dto.status = expenseStatus(dto);
		return dto;
	});
}

export async function loadSettlements(
	exec: DbOrTx,
	tripId: string,
): Promise<SettlementDto[]> {
	const rows = await exec
		.select()
		.from(settlements)
		.where(and(eq(settlements.tripId, tripId), isNull(settlements.deletedAt)))
		.orderBy(asc(settlements.settledAt), asc(settlements.id));
	return rows.map((s) => ({
		id: s.id,
		fromMemberId: s.fromMemberId,
		toMemberId: s.toMemberId,
		amountMinor: s.amountMinor,
		currency: s.currency,
		homeAmountMinor: s.homeAmountMinor,
		homeCurrency: s.homeCurrency,
		fxRate: s.fxRate === null ? null : Number(s.fxRate),
		settledAt: iso(s.settledAt),
		settledTz: s.settledTz,
		method: s.method,
		note: s.note,
		scope: s.nodeId
			? { nodeId: s.nodeId }
			: s.dayId
				? { dayId: s.dayId }
				: null,
		netAfter: s.netAfter ?? null,
		createdAt: iso(s.createdAt),
	}));
}

/**
 * Read-time repair: rows whose home currency isn't the trip's (a home change
 * the `fxRehome` job hasn't reached) or that still wait for a rate are shown
 * converted from the cached rates (nothing is written).
 */
async function rehomeForRead(
	home: string,
	exps: ExpenseDto[],
	sets: SettlementDto[],
): Promise<void> {
	const today = todayUtc();
	const conv = (amount: number, currency: string, date: string) =>
		tryConvert(amount, currency, home, date, { fetch: false });
	for (const e of exps) {
		const stale = e.homeCurrency !== null && e.homeCurrency !== home;
		if (
			e.amountMinor !== null &&
			e.currency &&
			(stale || e.homeAmountMinor === null)
		) {
			const c = await conv(e.amountMinor, e.currency, today);
			e.homeAmountMinor = c?.homeMinor ?? null;
			e.fxRate = c?.rate ?? null;
		}
		for (const p of e.payments) {
			if (!stale && p.homeAmountMinor !== null) continue;
			const c = await conv(
				p.amountMinor,
				p.currency,
				dateIn(p.paidAt, p.paidTz),
			);
			p.homeAmountMinor = c?.homeMinor ?? null;
			p.fxRate = c?.rate ?? null;
		}
		e.homeCurrency = home;
		e.status = expenseStatus(e);
	}
	for (const s of sets) {
		if (s.homeCurrency === home && s.homeAmountMinor !== null) continue;
		const c = await conv(
			s.amountMinor,
			s.currency,
			dateIn(s.settledAt, s.settledTz),
		);
		s.homeAmountMinor = c?.homeMinor ?? null;
		s.fxRate = c?.rate ?? null;
		s.homeCurrency = home;
	}
}

/** Everything the Money tab needs for `me`, privacy-filtered (the `listMoney` body). */
export async function loadMoney(tripId: string, me: Me): Promise<MoneyDto> {
	const home = await tripHomeCurrency(db, tripId);
	const [exps, sets, budgets, privRows, rates] = await Promise.all([
		loadExpenses(db, tripId, me),
		loadSettlements(db, tripId),
		db
			.select()
			.from(budgetLines)
			.where(
				and(
					eq(budgetLines.tripId, tripId),
					or(
						isNull(budgetLines.memberId),
						me.memberId ? eq(budgetLines.memberId, me.memberId) : sql`false`,
						sql`${budgetLines.memberId} in (select id from trip_members where trip_id = ${tripId} and not budget_private)`,
					),
				),
			)
			.orderBy(asc(budgetLines.createdAt), asc(budgetLines.id)),
		db
			.select({ id: tripMembers.id })
			.from(tripMembers)
			.where(
				and(
					eq(tripMembers.tripId, tripId),
					eq(tripMembers.budgetPrivate, true),
				),
			),
		latestRatesFor(home).catch(() => null),
	]);
	// A stale home currency (the rehome job hasn't run yet): convert for display.
	if (
		exps.some(
			(e) =>
				(e.amountMinor !== null && e.homeCurrency !== home) ||
				e.payments.some((p) => p.homeAmountMinor === null),
		) ||
		sets.some((s) => s.homeCurrency !== home)
	)
		await rehomeForRead(home, exps, sets);
	// Cash value of points bookings, at home, for cents per point.
	for (const e of exps) {
		const p = e.points as
			| (ExpenseDto["points"] & { cashValueHomeMinor?: number | null })
			| null;
		if (p?.cashValueMinor != null && p.cashValueCurrency) {
			const c = await tryConvert(
				p.cashValueMinor,
				p.cashValueCurrency,
				home,
				e.fxDate ?? todayUtc(),
				{ fetch: false },
			);
			p.cashValueHomeMinor = c?.homeMinor ?? null;
		}
	}
	const budgetDtos: BudgetLineDto[] = budgets.map((b) => ({
		id: b.id,
		nodeId: b.nodeId,
		category: b.category,
		memberId: b.memberId,
		amountMinor: b.amountMinor,
		kind: b.kind,
		defaultSeenMinor: b.defaultSeenMinor,
	}));
	const fxDates = [
		...exps.map((e) => e.fxDate),
		...exps.flatMap((e) => e.payments.map((p) => p.fxDate)),
	].filter((d): d is string => !!d);
	const ratesAsOf =
		rates?.date ?? (fxDates.length ? (fxDates.sort().at(-1) ?? null) : null);
	const recentEdits = me.memberId
		? await recentMoneyEdits(tripId, me, sets)
		: [];
	return {
		homeCurrency: home,
		ratesAsOf,
		expenses: exps,
		settlements: sets,
		budgets: budgetDtos,
		privateBudgetMemberIds: privRows
			.map((r) => r.id)
			.filter((id) => id !== me.memberId),
		myBudgetPrivate: privRows.some((r) => r.id === me.memberId),
		latestRates: rates?.rates ?? {},
		recentEdits,
	};
}

/**
 * ADDENDUM §7.3: `expense.*` rows by OTHER people since my latest settlement
 * that moved MY balance (newest first, ≤ 10), for "Balance changed since your
 * last settlement: +$6.20 (Maya edited Ramen Ichiran)".
 */
async function recentMoneyEdits(
	tripId: string,
	me: Me,
	sets: readonly SettlementDto[],
): Promise<NonNullable<MoneyDto["recentEdits"]>> {
	if (!me.memberId) return [];
	const mine = sets.filter(
		(s) => s.fromMemberId === me.memberId || s.toMemberId === me.memberId,
	);
	const last = mine.at(-1);
	if (!last) return [];
	const rows = await balanceEdits(db, {
		tripId,
		memberId: me.memberId,
		userId: me.userId,
		since: last.createdAt,
		limit: 10,
	});
	return rows.map((r) => ({
		at: r.at,
		actorName: r.actorName,
		verb: r.verb,
		expenseId: r.expenseId,
		title: r.title,
		cause: r.cause,
	}));
}

export type BalanceEdit = {
	/** The activity row's trip version (null on old rows). */
	version: number | null;
	at: string;
	actorName: string;
	actorMemberId: string | null;
	verb: string;
	expenseId: string | null;
	title: string | null;
	/** "Olga added an expense: Olga's museum": first name + the activity summary. */
	cause: string;
};

/**
 * QA MONEY-21 (ADDENDUM §7.3): the `expense.*` activity by other people since
 * `since` about costs that move `memberId`'s balance: they paid it, are in
 * its split or one of its items, or it refunds one they are in. Another
 * person's taxi split between two others is not a cause. Private costs never
 * count (they write no activity and stay out of balances). Newest first. One
 * rule for the Money tab's notice and the inbox's `balance_changed` item.
 */
export async function balanceEdits(
	exec: DbOrTx,
	opts: {
		tripId: string;
		memberId: string;
		userId: string;
		since: string | Date;
		limit?: number;
	},
): Promise<BalanceEdit[]> {
	const { tripId, memberId, userId } = opts;
	const since =
		typeof opts.since === "string" ? opts.since : opts.since.toISOString();
	const involves = (expenseId: ReturnType<typeof sql>) => sql`(
		exists (select 1 from expense_shares s
		         where s.expense_id = ${expenseId} and s.member_id = ${memberId})
		or exists (select 1 from expense_payments p
		             join expense_payment_payers x on x.payment_id = p.id
		            where p.expense_id = ${expenseId} and x.member_id = ${memberId})
		or exists (select 1 from expense_lines l
		             join expense_line_members lm on lm.line_id = l.id
		            where l.expense_id = ${expenseId} and lm.member_id = ${memberId}))`;
	const res = await exec.execute(sql`
		select a.version, a.created_at as at, a.actor_name as "actorName", a.verb,
		       a.summary, a.meta->>'expenseId' as "expenseId", a.meta->>'name' as title,
		       (select am.id::text from trip_members am
		         where am.trip_id = a.trip_id and am.user_id = a.actor_user_id limit 1) as "actorMemberId"
		  from activity_log a
		 where a.trip_id = ${tripId} and a.verb like 'expense.%'
		   and a.created_at > ${since}
		   and a.actor_user_id is distinct from ${userId}
		   and exists (
		     select 1 from expenses e
		      where e.trip_id = a.trip_id and e.id::text = a.meta->>'expenseId'
		        and not e.is_private
		        and (${involves(sql`e.id`)}
		             or (e.refund_of_id is not null and ${involves(sql`e.refund_of_id`)})))
		 order by a.version desc nulls last, a.created_at desc
		 limit ${opts.limit ?? 1}`);
	return (
		res.rows as {
			version: number | string | null;
			at: string | Date;
			actorName: string;
			verb: string;
			summary: string;
			expenseId: string | null;
			title: string | null;
			actorMemberId: string | null;
		}[]
	).map((r) => ({
		version: r.version === null ? null : Number(r.version),
		at: iso(r.at),
		actorName: r.actorName,
		actorMemberId: r.actorMemberId,
		verb: r.verb,
		expenseId: r.expenseId,
		title: r.title,
		cause: `${firstWord(r.actorName)} ${r.summary}`.slice(0, 200),
	}));
}

/** "Olga" of "Olga Owner" (the inbox words people the same way). */
function firstWord(name: string | null | undefined): string {
	return (name ?? "").trim().split(/\s+/)[0] || "Someone";
}

// ---------------------------------------------------------------------------
// Normalize + validate
// ---------------------------------------------------------------------------

export type NormPayment = {
	id?: string;
	paidAt: string;
	paidTz: string;
	currency: string;
	amountMinor: number;
	payers: { memberId: string; amountMinor: number }[];
	method: string | null;
	fxRate?: number;
};

export type NormExpense = {
	target: BundleTarget;
	title: string | null;
	category: ExpenseCategory | null;
	amountMinor: number | null;
	currency: string | null;
	points: ExpenseInput["points"] | null;
	expectedOn: string | null;
	splitMode: "equal" | "exact";
	shares: { memberId: string; amountMinor: number | null }[];
	/** True when the caller didn't send a split (the server picks the default people). */
	defaultSplit: boolean;
	lines: LineInput[];
	fees: FeeInput[];
	payments: NormPayment[];
	isPrivate: boolean;
	refundOfId: string | null;
	listItemId: string | null;
	taxFreePending: boolean;
	fxRate?: number;
	note: string | null;
};

/** The fields `createExpense` takes, all optional; null clears (the `updateExpense` patch). */
export type ExpenseFields = {
	[K in keyof Omit<ExpenseInput, "tripId" | "id">]?: ExpenseInput[K] | null;
};

function bad(msg: string): never {
	return fail("VALIDATION", msg);
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function normPayment(p: PaymentInput): NormPayment {
	const payers = new Map<string, number>();
	for (const x of p.payers)
		payers.set(x.memberId, (payers.get(x.memberId) ?? 0) + x.amountMinor);
	return {
		...(p.id ? { id: p.id } : {}),
		paidAt: p.paidAt,
		paidTz: p.paidTz,
		currency: p.currency,
		amountMinor: p.amountMinor,
		payers: [...payers].map(([memberId, amountMinor]) => ({
			memberId,
			amountMinor,
		})),
		method: p.method?.trim() || null,
		...(p.fxRate !== undefined ? { fxRate: p.fxRate } : {}),
	};
}

/** Merges input fields over an existing expense (or nothing) into one shape. */
export function normalizeExpense(
	f: ExpenseFields,
	base: ExpenseDto | null,
): NormExpense {
	const pick = <K extends keyof ExpenseFields>(
		k: K,
	): ExpenseFields[K] | undefined => (k in f ? f[k] : undefined);
	const has = (k: keyof ExpenseFields) => k in f && f[k] !== undefined;
	const amountMinor = has("amountMinor")
		? (f.amountMinor ?? null)
		: (base?.amountMinor ?? null);
	const currency = has("currency")
		? (f.currency ?? null)
		: (base?.currency ?? null);
	const split = pick("split");
	const basePoints = base?.points
		? {
				program: base.points.program,
				points: base.points.points,
				...(base.points.sourceProgram
					? { sourceProgram: base.points.sourceProgram }
					: {}),
				...(base.points.sourcePoints
					? { sourcePoints: base.points.sourcePoints }
					: {}),
				...(base.points.cashValueMinor !== null
					? { cashValueMinor: base.points.cashValueMinor }
					: {}),
				...(base.points.cashValueCurrency
					? { cashValueCurrency: base.points.cashValueCurrency }
					: {}),
			}
		: null;
	return {
		target: f.target ?? base?.target ?? { kind: "trip" },
		title: has("title") ? f.title?.trim() || null : (base?.title ?? null),
		category: f.category ?? base?.category ?? null,
		amountMinor,
		currency,
		points: has("points") ? (f.points ?? null) : basePoints,
		expectedOn: has("expectedOn")
			? (f.expectedOn ?? null)
			: (base?.expectedOn ?? null),
		splitMode: split ? split.mode : (base?.splitMode ?? "equal"),
		shares: split
			? split.shares.map((s) => ({
					memberId: s.memberId,
					amountMinor: split.mode === "exact" ? (s.amountMinor ?? null) : null,
				}))
			: (base?.shares.map((s) => ({ ...s })) ?? []),
		defaultSplit: !split && !base,
		lines: has("lines")
			? (f.lines ?? [])
			: (base?.lines.map((l) => ({
					label: l.label,
					amountMinor: l.amountMinor,
					memberIds: [...l.memberIds],
				})) ?? []),
		fees: has("fees")
			? (f.fees ?? [])
			: (base?.fees.map(
					(x) =>
						({
							label: x.label,
							kind: x.kind,
							...(x.percent !== null ? { percent: x.percent } : {}),
							...(x.amountMinor !== null ? { amountMinor: x.amountMinor } : {}),
						}) as FeeInput,
				) ?? []),
		payments: has("payments")
			? (f.payments ?? []).map(normPayment)
			: (base?.payments.map((p) => {
					const own = ownPaymentRate(p, base);
					return {
						id: p.id,
						paidAt: p.paidAt,
						paidTz: p.paidTz,
						currency: p.currency,
						amountMinor: p.amountMinor,
						payers: p.payers.map((x) => ({ ...x })),
						method: p.method,
						...(own !== undefined ? { fxRate: own } : {}),
					};
				}) ?? []),
		isPrivate: has("isPrivate") ? !!f.isPrivate : (base?.isPrivate ?? false),
		refundOfId: has("refundOfId")
			? (f.refundOfId ?? null)
			: (base?.refundOfId ?? null),
		listItemId: has("listItemId")
			? (f.listItemId ?? null)
			: (base?.listItemId ?? null),
		taxFreePending: has("taxFreePending")
			? !!f.taxFreePending
			: (base?.taxFreePending ?? false),
		...(has("fxRate")
			? typeof f.fxRate === "number"
				? { fxRate: f.fxRate }
				: {}
			: base?.fxManual && base.fxRate !== null
				? { fxRate: base.fxRate }
				: {}),
		note: has("note") ? f.note?.trim() || null : (base?.note ?? null),
	};
}

/**
 * ADDENDUM §7.3: only currencies the app knows (the currency picker's list,
 * which is also the minor-unit table); anything else would wait for a rate
 * forever and be formatted with guessed decimals.
 */
export function assertCurrency(code: string | null | undefined): void {
	if (code != null && !isKnownCurrency(code))
		bad(`${code} isn't a currency Yonder knows. Pick one from the list.`);
}

/** Shape checks that need no database (sums, signs, points, itemize, currencies). */
export function validateShape(e: NormExpense): void {
	if (e.amountMinor === null && !e.points)
		bad("An expense needs an amount or points.");
	if ((e.amountMinor === null) !== (e.currency === null))
		bad("Send the amount and its currency together.");
	assertCurrency(e.currency);
	assertCurrency(e.points?.cashValueCurrency);
	for (const p of e.payments) assertCurrency(p.currency);
	const refund = e.refundOfId !== null;
	if (e.amountMinor !== null) {
		if (refund && e.amountMinor >= 0) bad("A refund is a negative amount.");
		if (!refund && e.amountMinor < 0)
			bad("Only a refund can be negative. Link it to the original.");
	}
	if (e.points) {
		if (
			(e.points.sourceProgram === undefined) !==
			(e.points.sourcePoints === undefined)
		)
			bad("Give the source programme and its points together.");
		if (
			(e.points.cashValueMinor === undefined) !==
			(e.points.cashValueCurrency === undefined)
		)
			bad("Give the cash price and its currency together.");
		// A cash price is what the booking would have cost: never ≤ 0 (it
		// would turn cents per point negative).
		if (e.points.cashValueMinor !== undefined && e.points.cashValueMinor <= 0)
			bad("The cash price must be more than zero.");
	}
	for (const p of e.payments) {
		if (p.amountMinor === 0) bad("A payment needs an amount.");
		if (refund ? p.amountMinor > 0 : p.amountMinor < 0)
			bad(refund ? "Refund payments are negative." : "Payments are positive.");
		if (!p.payers.length) bad("Every payment needs someone who paid.");
		if (sum(p.payers.map((x) => x.amountMinor)) !== p.amountMinor)
			bad("Payers must add up to each payment.");
		if (
			p.payers.some(
				(x) => Math.sign(x.amountMinor) === -Math.sign(p.amountMinor),
			)
		)
			bad("Payers must add up to each payment.");
	}
	if (e.isPrivate) return;
	if (e.lines.length) {
		if (e.amountMinor === null) bad("Itemize needs an amount.");
		if (e.lines.some((l) => !l.memberIds.length))
			bad("Every item needs who had it.");
		// QA MONEY-01/14: a negative line would flip that person's share into
		// money they are owed ("Coupon −¥500 → Maya"); only a refund's lines
		// are negative, and then all of them.
		if (e.lines.some((l) => (refund ? l.amountMinor > 0 : l.amountMinor < 0)))
			bad(
				refund
					? "A refund's items are negative amounts."
					: "Item amounts can't be negative.",
			);
		const it = itemize(e.lines, feesForEngine(e.fees));
		if (it.total !== e.amountMinor)
			bad("Items and fees must add up to the total.");
	} else if (e.fees.length) bad("Fees go with itemized lines.");
	// A refund's split is recomputed from its original (`refundShares`), so a
	// new amount never has to match the old exact parts.
	if (
		e.splitMode === "exact" &&
		!refund &&
		!e.lines.length &&
		e.shares.length
	) {
		if (e.shares.some((s) => s.amountMinor === null))
			bad("Give everyone in an exact split an amount.");
		// QA MONEY-01: a negative part flips sign in balances (Maya "owes" the
		// ¥500 she was meant to get back).
		if (e.shares.some((s) => (s.amountMinor ?? 0) < 0))
			bad("Exact amounts can't be negative.");
		if (sum(e.shares.map((s) => s.amountMinor ?? 0)) !== (e.amountMinor ?? 0))
			bad("Exact amounts must add up to the total.");
	}
}

export function feesForEngine(fees: readonly FeeInput[]) {
	return fees.map((f) => ({
		label: f.label,
		kind: f.kind,
		percent: f.kind === "percent" ? (f.percent ?? 0) : null,
		amountMinor: f.kind === "fixed" ? (f.amountMinor ?? 0) : null,
	}));
}

/** Every member id the expense names. */
function memberIdsOf(e: NormExpense): string[] {
	return [
		...e.shares.map((s) => s.memberId),
		...e.lines.flatMap((l) => l.memberIds),
		...e.payments.flatMap((p) => p.payers.map((x) => x.memberId)),
	];
}

type TargetFacts = {
	name: string | null;
	category: ExpenseCategory;
	/** The people tagged on the item or leg (the default split). */
	tagged: string[];
};

/** The target's name, default category and tagged people. */
async function targetFacts(
	tx: DbOrTx,
	tripId: string,
	target: BundleTarget,
): Promise<TargetFacts> {
	const q = async <T>(s: ReturnType<typeof sql>) =>
		(await tx.execute(s)).rows as T[];
	switch (target.kind) {
		case "trip":
			return { name: null, category: "fees_other", tagged: [] };
		case "node": {
			const [n] = await q<{ name: string; category: PlaceCategory | null }>(sql`
				select name, category::text as category from nodes where id = ${target.nodeId} and trip_id = ${tripId}`);
			return {
				name: n?.name ?? null,
				category: categoryFor({ kind: "place", category: n?.category ?? null }),
				tagged: [],
			};
		}
		case "item": {
			const [it] = await q<{
				name: string | null;
				category: PlaceCategory | null;
			}>(sql`
				select coalesce(i.title, n.name) as name, n.category::text as category
				  from items i left join nodes n on n.id = i.node_id and n.trip_id = i.trip_id
				 where i.id = ${target.itemId} and i.trip_id = ${tripId}`);
			const tagged = await q<{ id: string }>(sql`
				select member_id::text as id from item_assignees where item_id = ${target.itemId} and trip_id = ${tripId}`);
			return {
				name: it?.name ?? null,
				category: categoryFor({
					kind: "place",
					category: it?.category ?? null,
				}),
				tagged: tagged.map((t) => t.id),
			};
		}
		case "leg": {
			const [l] = await q<{
				kind: string;
				mode: LegMode | null;
				a: string | null;
				b: string | null;
				stay: string | null;
			}>(sql`
				select l.kind::text as kind, l.mode::text as mode,
				       coalesce(fi.title, fn.name) as a, coalesce(ti.title, tn.name) as b,
				       sn.name as stay
				  from legs l
				  left join items fi on fi.id = l.from_item_id and fi.trip_id = l.trip_id
				  left join nodes fn on fn.id = fi.node_id and fn.trip_id = l.trip_id
				  left join items ti on ti.id = l.to_item_id and ti.trip_id = l.trip_id
				  left join nodes tn on tn.id = ti.node_id and tn.trip_id = l.trip_id
				  left join trip_days d on d.id = l.stay_day_id and d.trip_id = l.trip_id
				  left join nodes sn on sn.id = d.night_node_id and sn.trip_id = l.trip_id
				 where l.id = ${target.legId} and l.trip_id = ${tripId}`);
			const tagged = await q<{ id: string }>(sql`
				select member_id::text as id from leg_assignees where leg_id = ${target.legId} and trip_id = ${tripId}`);
			const name =
				l?.kind === "pair"
					? l.a && l.b
						? `${l.a} → ${l.b}`
						: null
					: l?.stay
						? `Stay · ${l.stay}`
						: null;
			return {
				name,
				category: categoryFor({ kind: "leg", mode: l?.mode ?? null }),
				tagged: tagged.map((t) => t.id),
			};
		}
		case "day": {
			const [d] = await q<{ n: number; title: string | null }>(sql`
				select (select count(*)::int from trip_days x where x.trip_id = d.trip_id and x.date <= d.date) as n,
				       d.title
				  from trip_days d where d.id = ${target.dayId} and d.trip_id = ${tripId}`);
			return {
				name: d ? `Day ${d.n}${d.title ? ` · ${d.title}` : ""}` : null,
				category: "fees_other",
				tagged: [],
			};
		}
	}
}

/** All live people of a trip (active, invited, placeholders), in member order. */
async function activeMemberIds(tx: DbOrTx, tripId: string): Promise<string[]> {
	const rows = await tx
		.select({ id: tripMembers.id })
		.from(tripMembers)
		.where(
			and(
				eq(tripMembers.tripId, tripId),
				sql`${tripMembers.status}::text <> 'removed'`,
			),
		)
		.orderBy(asc(tripMembers.createdAt), asc(tripMembers.id));
	return rows.map((r) => r.id);
}

export type Ctx = {
	tripId: string;
	actor: Actor;
	me: Me;
	home: string;
};

/**
 * Checks everything that needs the database (members, target, list item,
 * refund original), fills the defaults (title, category, split) and returns
 * the final shape. Runs inside the transaction.
 */
export async function resolveExpense(
	tx: Tx,
	ctx: Ctx,
	e: NormExpense,
	opts: {
		creatorUserId: string;
		expenseId?: string;
		/** The planned amount at home (`prepareConversions`), for the refund cap. */
		plannedHome?: number | null;
	},
): Promise<NormExpense> {
	await assertBundleTarget(tx, ctx.tripId, e.target);
	const facts = await targetFacts(tx, ctx.tripId, e.target);
	const out: NormExpense = { ...e };
	if (out.listItemId) {
		const [li] = (
			await tx.execute(sql`
			select is_private, created_by from list_items
			 where id = ${out.listItemId} and trip_id = ${ctx.tripId} and deleted_at is null`)
		).rows as { is_private: boolean; created_by: string | null }[];
		if (!li || (li.is_private && li.created_by !== ctx.me.userId))
			fail("NOT_FOUND", "list item");
		// Gift privacy (ADDENDUM §10): from a private list item → private.
		if (li.is_private && !opts.expenseId) out.isPrivate = true;
	}
	let original: RefundOriginal | null = null;
	if (out.refundOfId) {
		if (out.refundOfId === opts.expenseId) bad("A refund can't refund itself.");
		const [orig] = await tx
			.select({
				id: expenses.id,
				title: expenses.title,
				refundOfId: expenses.refundOfId,
				isPrivate: expenses.isPrivate,
				createdBy: expenses.createdBy,
				amountMinor: expenses.amountMinor,
				currency: expenses.currency,
				homeAmountMinor: expenses.homeAmountMinor,
			})
			.from(expenses)
			.where(
				and(
					eq(expenses.tripId, ctx.tripId),
					eq(expenses.id, out.refundOfId),
					isNull(expenses.deletedAt),
				),
			);
		if (!orig || (orig.isPrivate && orig.createdBy !== ctx.me.userId))
			fail("NOT_FOUND", "original expense");
		if (orig.refundOfId) bad("Link a refund to the original expense.");
		// "Refund · Izakaya": named after the original, never its place.
		if (!out.title && !opts.expenseId)
			out.title = `Refund · ${orig.title}`.slice(0, 120);
		// A private cost's refund quotes its title: it stays private too.
		if (orig.isPrivate) out.isPrivate = true;
		original = {
			id: orig.id,
			amountMinor: orig.amountMinor,
			currency: orig.currency,
			homeMinor: orig.homeAmountMinor,
		};
	}
	if (out.isPrivate) {
		if (opts.creatorUserId !== ctx.me.userId)
			fail("FORBIDDEN", "Only its creator can make an expense private.");
		// Private: no split; only the creator pays.
		out.shares = [];
		out.lines = [];
		out.fees = [];
		out.splitMode = "equal";
		out.defaultSplit = false;
		const meId = ctx.me.memberId;
		for (const p of out.payments) {
			if (!meId || p.payers.some((x) => x.memberId !== meId))
				bad("A private expense is paid by you.");
		}
	}
	if (out.defaultSplit && !out.lines.length && !out.isPrivate) {
		const everyone = await activeMemberIds(tx, ctx.tripId);
		const tagged = facts.tagged.filter((m) => everyone.includes(m));
		out.shares = (tagged.length ? tagged : everyone).map((memberId) => ({
			memberId,
			amountMinor: null,
		}));
		out.splitMode = "equal";
	}
	if (!out.category) out.category = facts.category;
	if (!out.title)
		out.title = (facts.name ?? EXPENSE_CATEGORY_LABEL[out.category]).slice(
			0,
			120,
		);
	// Live people of the trip; a retired member may stay where they already were
	// (editing an old expense must not fail because its payer left the trip).
	const ids = memberIdsOf(out);
	const ok = new Set(await tripMemberIds(tx, ctx.tripId, ids));
	if (opts.expenseId) {
		const kept = (
			await tx.execute(sql`
				select distinct member_id::text as id from (
				  select s.member_id from expense_shares s where s.expense_id = ${opts.expenseId} and s.trip_id = ${ctx.tripId}
				  union all
				  select pp.member_id from expense_payment_payers pp
				    join expense_payments p on p.id = pp.payment_id and p.trip_id = pp.trip_id
				   where p.expense_id = ${opts.expenseId} and p.trip_id = ${ctx.tripId}
				  union all
				  select lm.member_id from expense_line_members lm
				    join expense_lines l on l.id = lm.line_id and l.trip_id = lm.trip_id
				   where l.expense_id = ${opts.expenseId} and l.trip_id = ${ctx.tripId}
				) x`)
		).rows as { id: string }[];
		for (const r of kept) ok.add(r.id);
	}
	if (ids.some((id) => !ok.has(id)))
		bad("Someone in this expense isn't on the trip.");
	validateShape(out);
	// ADDENDUM §6 refunds: together they never pass their original.
	if (original && out.amountMinor !== null)
		await assertRefundsFit(tx, ctx, original, {
			id: opts.expenseId ?? null,
			amountMinor: out.amountMinor,
			currency: out.currency,
			homeMinor: opts.plannedHome ?? null,
		});
	else if (opts.expenseId && !out.refundOfId)
		await assertRefundsFit(tx, ctx, {
			id: opts.expenseId,
			amountMinor: out.amountMinor,
			currency: out.currency,
			homeMinor: opts.plannedHome ?? null,
		});
	return out;
}

type RefundOriginal = {
	id: string;
	amountMinor: number | null;
	currency: string | null;
	/** At home (planned: the latest rate). */
	homeMinor: number | null;
};

/**
 * ADDENDUM §6 refunds: the live refunds of an expense can't add up to more
 * than it (else Planned, Still to pay and the per-person shares go negative).
 * `replacing` is the refund being written (it stands in for its stored row).
 * Compared in the original's currency when every refund is in it, else at
 * home (0.5% for rates that moved), skipped when a rate is still pending.
 * Counts the refunds everyone sees plus my own private ones (never someone
 * else's private row).
 */
async function assertRefundsFit(
	tx: Tx,
	ctx: Ctx,
	orig: RefundOriginal,
	replacing?: {
		id: string | null;
		amountMinor: number;
		currency: string | null;
		homeMinor: number | null;
	},
): Promise<void> {
	const stored = await tx
		.select({
			id: expenses.id,
			amountMinor: expenses.amountMinor,
			currency: expenses.currency,
			homeMinor: expenses.homeAmountMinor,
		})
		.from(expenses)
		.where(
			and(
				eq(expenses.tripId, ctx.tripId),
				eq(expenses.refundOfId, orig.id),
				isNull(expenses.deletedAt),
				or(
					eq(expenses.isPrivate, false),
					eq(expenses.createdBy, ctx.me.userId),
				),
			),
		);
	const refunds = [
		...stored.filter((r) => r.amountMinor !== null && r.id !== replacing?.id),
		...(replacing ? [replacing] : []),
	];
	if (!refunds.length) return;
	if (orig.amountMinor === null || orig.currency === null)
		bad("This cost has refunds, so it needs a cash amount.");
	const abs = (xs: readonly (number | null)[]) =>
		xs.reduce<number>((a, x) => a + Math.abs(x ?? 0), 0);
	if (refunds.every((r) => r.currency === orig.currency)) {
		if (abs(refunds.map((r) => r.amountMinor)) > Math.abs(orig.amountMinor))
			bad(
				`Refunds can't add up to more than the original ${formatMoney(Math.abs(orig.amountMinor), orig.currency)}.`,
			);
		return;
	}
	if (orig.homeMinor === null || refunds.some((r) => r.homeMinor === null))
		return;
	const cap = Math.abs(orig.homeMinor);
	if (abs(refunds.map((r) => r.homeMinor)) > cap + Math.ceil(cap * 0.005))
		bad(
			`Refunds can't add up to more than the original (about ${formatMoney(cap, ctx.home)}).`,
		);
}

/** Conversions for the planned amount and each payment (network: BEFORE the transaction). */
export async function prepareConversions(
	e: NormExpense,
	home: string,
): Promise<{ planned: Conversion | null; payments: (Conversion | null)[] }> {
	const today = todayUtc();
	const planned =
		e.amountMinor === null || !e.currency
			? null
			: e.fxRate !== undefined && e.currency !== home
				? manualConversion(e.amountMinor, e.currency, home, e.fxRate, today)
				: await tryConvert(e.amountMinor, e.currency, home, today);
	const payments = await Promise.all(
		e.payments.map((p) => {
			const date = dateIn(p.paidAt, p.paidTz);
			// The cost's manual rate converts what was paid in its currency too.
			const rate =
				p.fxRate ?? (p.currency === e.currency ? e.fxRate : undefined);
			return rate !== undefined && p.currency !== home
				? manualConversion(p.amountMinor, p.currency, home, rate, date)
				: tryConvert(p.amountMinor, p.currency, home, date);
		}),
	);
	return { planned, payments };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function expenseCols(
	e: NormExpense,
	conv: Conversion | null,
	home: string,
): Omit<typeof expenses.$inferInsert, "id" | "tripId" | "createdBy"> {
	const cols = bundleTargetColumns(e.target);
	const today = todayUtc();
	const c =
		e.amountMinor === null
			? {
					homeCurrency: home,
					homeAmountMinor: null,
					fxRate: null,
					fxDate: null,
					fxSource: null,
					fxManual: false,
				}
			: convCols(conv, home, today);
	return {
		...cols,
		listItemId: e.listItemId,
		refundOfId: e.refundOfId,
		title: e.title ?? "Expense",
		category: e.category ?? "fees_other",
		amountMinor: e.amountMinor,
		currency: e.currency,
		...c,
		points: e.points?.points ?? null,
		pointsProgram: e.points?.program ?? null,
		sourcePoints: e.points?.sourcePoints ?? null,
		sourceProgram: e.points?.sourceProgram ?? null,
		cashValueMinor: e.points?.cashValueMinor ?? null,
		cashValueCurrency: e.points?.cashValueCurrency ?? null,
		expectedOn: e.expectedOn,
		splitMode: e.splitMode,
		isPrivate: e.isPrivate,
		taxFreePending: e.taxFreePending,
		note: e.note,
	};
}

/** Replaces the split, lines, fees and payments of an expense. Payments keep their ids (receipts). */
async function writeChildren(
	tx: Tx,
	ctx: Ctx,
	expenseId: string,
	e: NormExpense,
	convs: (Conversion | null)[],
): Promise<void> {
	const { tripId } = ctx;
	await tx
		.delete(expenseShares)
		.where(
			and(
				eq(expenseShares.tripId, tripId),
				eq(expenseShares.expenseId, expenseId),
			),
		);
	await tx
		.delete(expenseLines)
		.where(
			and(
				eq(expenseLines.tripId, tripId),
				eq(expenseLines.expenseId, expenseId),
			),
		);
	await tx
		.delete(expenseFees)
		.where(
			and(eq(expenseFees.tripId, tripId), eq(expenseFees.expenseId, expenseId)),
		);
	if (e.shares.length)
		await tx.insert(expenseShares).values(
			e.shares.map((s) => ({
				tripId,
				expenseId,
				memberId: s.memberId,
				amountMinor: e.splitMode === "exact" ? s.amountMinor : null,
			})),
		);
	if (e.lines.length) {
		const keys = freshKeys(e.lines.length);
		const rows = await tx
			.insert(expenseLines)
			.values(
				e.lines.map((l, i) => ({
					tripId,
					expenseId,
					label: l.label,
					amountMinor: l.amountMinor,
					position: keys[i] as string,
				})),
			)
			.returning({ id: expenseLines.id });
		const members = rows.flatMap((r, i) =>
			[...new Set(e.lines[i]?.memberIds ?? [])].map((memberId) => ({
				tripId,
				lineId: r.id,
				memberId,
			})),
		);
		if (members.length) await tx.insert(expenseLineMembers).values(members);
	}
	if (e.fees.length) {
		const keys = freshKeys(e.fees.length);
		await tx.insert(expenseFees).values(
			e.fees.map((f, i) => ({
				tripId,
				expenseId,
				label: f.label,
				kind: f.kind,
				percent: f.kind === "percent" ? (f.percent ?? 0) : null,
				amountMinor: f.kind === "fixed" ? (f.amountMinor ?? 0) : null,
				position: keys[i] as string,
			})),
		);
	}
	// Payments: update kept ids, insert new ones, delete the rest.
	const existing = await tx
		.select({ id: expensePayments.id })
		.from(expensePayments)
		.where(
			and(
				eq(expensePayments.tripId, tripId),
				eq(expensePayments.expenseId, expenseId),
			),
		);
	const keep = new Set(
		e.payments.map((p) => p.id).filter((id): id is string => !!id),
	);
	const gone = existing.map((r) => r.id).filter((id) => !keep.has(id));
	if (gone.length)
		await tx
			.delete(expensePayments)
			.where(
				and(
					eq(expensePayments.tripId, tripId),
					inArray(expensePayments.id, gone),
				),
			);
	const known = new Set(existing.map((r) => r.id));
	for (const [i, p] of e.payments.entries()) {
		const conv = convs[i] ?? null;
		const cols = {
			paidAt: new Date(p.paidAt),
			paidTz: p.paidTz,
			currency: p.currency,
			amountMinor: p.amountMinor,
			...convCols(conv, ctx.home, dateIn(p.paidAt, p.paidTz)),
			method: p.method,
			updatedAt: new Date(),
		};
		let paymentId: string;
		if (p.id && known.has(p.id)) {
			paymentId = p.id;
			await tx
				.update(expensePayments)
				.set(cols)
				.where(
					and(eq(expensePayments.tripId, tripId), eq(expensePayments.id, p.id)),
				);
			await tx
				.delete(expensePaymentPayers)
				.where(
					and(
						eq(expensePaymentPayers.tripId, tripId),
						eq(expensePaymentPayers.paymentId, p.id),
					),
				);
		} else {
			if (p.id) {
				const [taken] = await tx
					.select({ id: expensePayments.id })
					.from(expensePayments)
					.where(eq(expensePayments.id, p.id));
				if (taken) fail("CONFLICT", "that payment id is already taken");
			}
			const [row] = await tx
				.insert(expensePayments)
				.values({
					...(p.id ? { id: p.id } : {}),
					tripId,
					expenseId,
					createdBy: ctx.actor.userId,
					...cols,
				})
				.returning({ id: expensePayments.id });
			paymentId = (row as { id: string }).id;
		}
		await tx.insert(expensePaymentPayers).values(
			p.payers.map((x) => ({
				tripId,
				paymentId,
				memberId: x.memberId,
				amountMinor: x.amountMinor,
			})),
		);
	}
}

/**
 * Refunds follow their original: an exact split in the original's
 * proportions, computed now (so it survives the original being private to
 * someone else or deleted later).
 */
async function refundShares(
	tx: Tx,
	ctx: Ctx,
	e: NormExpense,
): Promise<NormExpense> {
	if (!e.refundOfId || e.isPrivate || e.amountMinor === null) return e;
	const [orig] = await loadExpenses(tx, ctx.tripId, ctx.me, {
		ids: [e.refundOfId],
	});
	if (!orig) return e;
	const order = await activeMemberIds(tx, ctx.tripId);
	const draft: EngineExpense = {
		id: "refund",
		amountMinor: e.amountMinor,
		currency: e.currency,
		homeAmountMinor: null,
		splitMode: "equal",
		shares: [],
		lines: [],
		fees: [],
		payments: e.payments.map((p) => ({ ...p, homeAmountMinor: null })),
		isPrivate: false,
		refundOfId: orig.id,
		points: null,
	};
	const owed = owedShares(draft, {
		byId: new Map([[orig.id, orig]]),
		memberOrder: order,
	});
	if (!Object.keys(owed).length) return e;
	return {
		...e,
		lines: [],
		fees: [],
		splitMode: "exact",
		shares: Object.entries(owed).map(([memberId, amountMinor]) => ({
			memberId,
			amountMinor,
		})),
	};
}

/**
 * ADDENDUM §6 "shopping list link": recording the expense of an open list
 * item marks it bought (done), the same as ticking it in Lists.
 */
async function markListItemBought(
	tx: Tx,
	out: TxOutbox,
	ctx: Ctx,
	listItemId: string,
): Promise<void> {
	const rows = await tx
		.update(listItems)
		.set({
			status: "done",
			doneAt: new Date(),
			doneBy: ctx.actor.userId,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(listItems.tripId, ctx.tripId),
				eq(listItems.id, listItemId),
				eq(listItems.status, "open"),
				isNull(listItems.deletedAt),
				or(
					eq(listItems.isPrivate, false),
					eq(listItems.createdBy, ctx.me.userId),
				),
			),
		)
		.returning({ id: listItems.id });
	if (rows.length) out.emit({ entity: "listItem", ids: [listItemId] });
}

export async function insertExpense(
	tx: Tx,
	out: TxOutbox,
	ctx: Ctx,
	input: { id?: string; fields: ExpenseFields },
	prepared: {
		norm: NormExpense;
		conv: Awaited<ReturnType<typeof prepareConversions>>;
	},
): Promise<{ id: string }> {
	let e = await resolveExpense(tx, ctx, prepared.norm, {
		creatorUserId: ctx.me.userId,
		plannedHome: prepared.conv.planned?.homeMinor ?? null,
	});
	e = await refundShares(tx, ctx, e);
	if (input.id) {
		const [taken] = await tx
			.select({ id: expenses.id })
			.from(expenses)
			.where(eq(expenses.id, input.id));
		if (taken) fail("CONFLICT", "that id is already taken");
	}
	const [row] = await tx
		.insert(expenses)
		.values({
			...(input.id ? { id: input.id } : {}),
			tripId: ctx.tripId,
			createdBy: ctx.actor.userId,
			...expenseCols(e, prepared.conv.planned, ctx.home),
		})
		.returning({ id: expenses.id });
	const id = (row as { id: string }).id;
	await writeChildren(tx, ctx, id, e, prepared.conv.payments);
	if (e.listItemId) await markListItemBought(tx, out, ctx, e.listItemId);
	if (!e.isPrivate)
		await logActivity(tx, out, {
			tripId: ctx.tripId,
			actor: ctx.actor,
			verb: "expense.add",
			summary: `added an expense: ${e.title}`,
			...targetActivityCols(e.target),
			meta: { expenseId: id, name: (e.title ?? "").slice(0, 200) },
		});
	out.emit({ entity: "expense", ids: [id] });
	return { id };
}

/** Deletes an expense's activity lines (`expense.*` with its `meta.expenseId`); returns how many. */
export async function dropExpenseActivity(
	tx: Tx,
	tripId: string,
	expenseId: string,
): Promise<number> {
	const res = await tx.execute(sql`
		delete from activity_log
		 where trip_id = ${tripId}
		   and verb like 'expense.%'
		   and meta->>'expenseId' = ${expenseId}
		returning id`);
	return res.rows.length;
}

function targetActivityCols(t: BundleTarget) {
	const c = bundleTargetColumns(t);
	return { nodeId: c.nodeId, itemId: c.itemId, legId: c.legId, dayId: c.dayId };
}

/** Loads one expense for a write, answering NOT_FOUND for someone else's private row. */
export async function expenseForWrite(
	exec: DbOrTx,
	tripId: string,
	id: string,
	me: Me,
	opts: { withDeleted?: boolean } = {},
): Promise<ExpenseDto> {
	const [e] = await loadExpenses(exec, tripId, me, {
		ids: [id],
		withDeleted: opts.withDeleted,
	});
	if (!e) return fail("NOT_FOUND");
	return e;
}

export async function updateExpenseRow(
	tx: Tx,
	out: TxOutbox,
	ctx: Ctx,
	id: string,
	prepared: {
		norm: NormExpense;
		conv: Awaited<ReturnType<typeof prepareConversions>>;
	},
	opts: {
		expectedUpdatedAt?: string;
		verb?: "expense.update" | "expense.paid";
		keepPlannedConversion?: boolean;
	} = {},
): Promise<{ updatedAt: string }> {
	const [locked] = await tx
		.select({
			updatedAt: expenses.updatedAt,
			createdBy: expenses.createdBy,
			isPrivate: expenses.isPrivate,
		})
		.from(expenses)
		.where(
			and(
				eq(expenses.tripId, ctx.tripId),
				eq(expenses.id, id),
				isNull(expenses.deletedAt),
			),
		)
		.for("update");
	if (!locked || (locked.isPrivate && locked.createdBy !== ctx.me.userId))
		return fail("NOT_FOUND");
	if (
		opts.expectedUpdatedAt &&
		iso(locked.updatedAt) !== new Date(opts.expectedUpdatedAt).toISOString()
	)
		fail("CONFLICT");
	let e = await resolveExpense(tx, ctx, prepared.norm, {
		creatorUserId: locked.createdBy ?? "",
		expenseId: id,
		plannedHome: prepared.conv.planned?.homeMinor ?? null,
	});
	e = await refundShares(tx, ctx, e);
	const goingPrivate = e.isPrivate && !locked.isPrivate;
	if (goingPrivate) {
		// Its shared refunds are named after it and split in its proportions.
		const [shared] = await tx
			.select({ id: expenses.id })
			.from(expenses)
			.where(
				and(
					eq(expenses.tripId, ctx.tripId),
					eq(expenses.refundOfId, id),
					isNull(expenses.deletedAt),
					eq(expenses.isPrivate, false),
				),
			)
			.limit(1);
		if (shared)
			bad(
				"This cost has refunds the group can see. Delete them before making it private.",
			);
	}
	const cols = expenseCols(e, prepared.conv.planned, ctx.home);
	const [row] = await tx
		.update(expenses)
		.set({ ...cols, updatedAt: new Date() })
		.where(and(eq(expenses.tripId, ctx.tripId), eq(expenses.id, id)))
		.returning({ updatedAt: expenses.updatedAt });
	await writeChildren(tx, ctx, id, e, prepared.conv.payments);
	// Made private afterwards (ADDENDUM §7.2, EXTENSIONS §8.5): its earlier
	// lines quote the title, so they go, as if it had always been private.
	if (goingPrivate && (await dropExpenseActivity(tx, ctx.tripId, id)))
		out.emit({ entity: "activity" });
	if (!e.isPrivate && !locked.isPrivate)
		await logActivity(tx, out, {
			tripId: ctx.tripId,
			actor: ctx.actor,
			verb: opts.verb ?? "expense.update",
			summary: `${opts.verb === "expense.paid" ? "marked paid" : "edited"} ${e.title}`,
			...targetActivityCols(e.target),
			meta: { expenseId: id, name: (e.title ?? "").slice(0, 200) },
		});
	out.emit({ entity: "expense", ids: [id] });
	return { updatedAt: iso((row as { updatedAt: Date }).updatedAt) };
}

/** "Mark paid": one payment for the remainder (me, now, the expense's currency). */
export function paymentForRemainder(
	e: ExpenseDto,
	me: Me,
	patch: Partial<PaymentInput> = {},
	now = new Date(),
	tz = "UTC",
): NormPayment {
	if (!me.memberId) return fail("FORBIDDEN");
	const currency = patch.currency ?? e.currency;
	if (!currency || e.amountMinor === null)
		bad("Points-only costs have nothing to pay.");
	let amount = patch.amountMinor;
	if (amount === undefined) {
		const rem = remainingInCurrency(e);
		if (rem === null || currency !== e.currency)
			bad("Give the amount for a payment in another currency.");
		if (rem === 0) bad("This is already paid.");
		amount = rem;
	}
	return normPayment({
		paidAt: patch.paidAt ?? now.toISOString(),
		paidTz: patch.paidTz ?? tz,
		currency,
		amountMinor: amount,
		payers: patch.payers ?? [{ memberId: me.memberId, amountMinor: amount }],
		...(patch.method ? { method: patch.method } : {}),
		...(patch.fxRate !== undefined ? { fxRate: patch.fxRate } : {}),
	});
}

/**
 * Soft-deletes an expense and, with it, its live refunds (ADDENDUM §6: a
 * refund is part of its original; alone it would keep moving balances with
 * its stored shares). They share the original's `deleted_at` (one
 * transaction, one `now()`), which is how `restoreExpenseRow` brings back
 * exactly those. `refunds` counts the ones I can see.
 */
export async function softDeleteExpense(
	tx: Tx,
	out: TxOutbox,
	ctx: Ctx,
	id: string,
): Promise<{ deletedAt: string; refunds: number }> {
	const stamp = sql`date_trunc('milliseconds', now())`;
	const [row] = await tx
		.update(expenses)
		.set({ deletedAt: stamp })
		.where(
			and(
				eq(expenses.tripId, ctx.tripId),
				eq(expenses.id, id),
				isNull(expenses.deletedAt),
				or(
					eq(expenses.isPrivate, false),
					eq(expenses.createdBy, ctx.me.userId),
				),
			),
		)
		.returning({
			deletedAt: expenses.deletedAt,
			title: expenses.title,
			isPrivate: expenses.isPrivate,
		});
	if (!row?.deletedAt) return fail("NOT_FOUND");
	const refunds = await tx
		.update(expenses)
		.set({ deletedAt: stamp })
		.where(
			and(
				eq(expenses.tripId, ctx.tripId),
				eq(expenses.refundOfId, id),
				isNull(expenses.deletedAt),
			),
		)
		.returning({
			id: expenses.id,
			isPrivate: expenses.isPrivate,
			createdBy: expenses.createdBy,
		});
	const seen = refunds.filter(
		(r) => !r.isPrivate || r.createdBy === ctx.me.userId,
	);
	if (!row.isPrivate)
		await logActivity(tx, out, {
			tripId: ctx.tripId,
			actor: ctx.actor,
			verb: "expense.delete",
			summary: `deleted ${row.title}`,
			meta: { expenseId: id, name: row.title.slice(0, 200) },
		});
	out.emit({
		entity: "expense",
		ids: [id, ...refunds.filter((r) => !r.isPrivate).map((r) => r.id)],
	});
	return { deletedAt: iso(row.deletedAt), refunds: seen.length };
}

/**
 * Restores a deleted expense with the refunds deleted along with it (same
 * `deleted_at`); a refund whose original is still deleted can't come back
 * alone.
 */
export async function restoreExpenseRow(
	tx: Tx,
	out: TxOutbox,
	ctx: Ctx,
	id: string,
): Promise<{ ok: true }> {
	const mine = or(
		eq(expenses.isPrivate, false),
		eq(expenses.createdBy, ctx.me.userId),
	);
	const [cur] = await tx
		.select({ refundOfId: expenses.refundOfId })
		.from(expenses)
		.where(
			and(
				eq(expenses.tripId, ctx.tripId),
				eq(expenses.id, id),
				sql`${expenses.deletedAt} is not null`,
				mine,
			),
		)
		.for("update");
	if (!cur) return fail("NOT_FOUND");
	let original: RefundOriginal | null = null;
	if (cur.refundOfId) {
		const [orig] = await tx
			.select({
				id: expenses.id,
				amountMinor: expenses.amountMinor,
				currency: expenses.currency,
				homeMinor: expenses.homeAmountMinor,
			})
			.from(expenses)
			.where(
				and(
					eq(expenses.tripId, ctx.tripId),
					eq(expenses.id, cur.refundOfId),
					isNull(expenses.deletedAt),
				),
			);
		if (!orig) bad("Its original expense was deleted. Restore that first.");
		original = orig;
	}
	// Before the original: they're matched on its deletion time.
	const refunds = (
		await tx.execute(sql`
			update expenses r set deleted_at = null, updated_at = now()
			 where r.trip_id = ${ctx.tripId} and r.refund_of_id = ${id}
			   and r.deleted_at is not null
			   and r.deleted_at = (select o.deleted_at from expenses o
			                        where o.id = ${id} and o.trip_id = ${ctx.tripId})
			returning r.id::text as id, r.is_private as "isPrivate"`)
	).rows as { id: string; isPrivate: boolean }[];
	const [row] = await tx
		.update(expenses)
		.set({ deletedAt: null, updatedAt: new Date() })
		.where(
			and(
				eq(expenses.tripId, ctx.tripId),
				eq(expenses.id, id),
				sql`${expenses.deletedAt} is not null`,
				mine,
			),
		)
		.returning({ title: expenses.title, isPrivate: expenses.isPrivate });
	if (!row) return fail("NOT_FOUND");
	// A refund restored alone still fits its original (others may have come since).
	if (original) await assertRefundsFit(tx, ctx, original);
	if (!row.isPrivate)
		await logActivity(tx, out, {
			tripId: ctx.tripId,
			actor: ctx.actor,
			verb: "expense.restore",
			summary: `restored ${row.title}`,
			meta: { expenseId: id, name: row.title.slice(0, 200) },
		});
	out.emit({
		entity: "expense",
		ids: [id, ...refunds.filter((r) => !r.isPrivate).map((r) => r.id)],
	});
	return { ok: true };
}

/**
 * ADDENDUM §7.1: budget amounts are in the trip's home currency, so a home
 * change re-bases every budget line of the trip (trip defaults, members' own
 * lines, private ones too, and the default each own line was set against) at
 * the latest rate. Runs INSIDE the transaction that changes the currency
 * (`updateTripCore`), so a budget is never read in the wrong currency; the
 * rate comes from the cached table (a fetch only when nothing is cached).
 * No rate at all with budgets to convert: VALIDATION, and nothing changes.
 * Returns how many lines changed.
 */
export async function rebaseBudgets(
	tx: DbOrTx,
	tripId: string,
	from: string,
	to: string,
): Promise<number> {
	if (from === to) return 0;
	const lines = await tx
		.select({
			id: budgetLines.id,
			amountMinor: budgetLines.amountMinor,
			defaultSeenMinor: budgetLines.defaultSeenMinor,
		})
		.from(budgetLines)
		.where(eq(budgetLines.tripId, tripId));
	if (!lines.length) return 0;
	const today = todayUtc();
	const day =
		(await ratesOn(today, { fetch: false })) ?? (await ratesOn(today));
	const rate = day ? crossRate(day, from, to) : null;
	if (rate === null)
		return fail(
			"VALIDATION",
			`There's no exchange rate from ${from} to ${to} yet to convert the budgets. Try again in a minute.`,
		);
	const conv = (m: number) => Math.max(0, convertMinor(m, from, to, rate));
	for (const l of lines)
		await tx
			.update(budgetLines)
			.set({
				amountMinor: conv(l.amountMinor),
				defaultSeenMinor:
					l.defaultSeenMinor === null ? null : conv(l.defaultSeenMinor),
				updatedAt: new Date(),
			})
			.where(and(eq(budgetLines.tripId, tripId), eq(budgetLines.id, l.id)));
	return lines.length;
}

/** Every member's trip-wide net right now (home minor units; + = is owed). */
export async function netNow(
	exec: DbOrTx,
	tripId: string,
): Promise<Record<string, number>> {
	// Public rows only: nobody's private expense ever moves a balance.
	const all = await loadExpenses(
		exec,
		tripId,
		{ userId: "", memberId: null },
		{ publicOnly: true },
	);
	const sets = await loadSettlements(exec, tripId);
	const order = await activeMemberIds(exec, tripId);
	return balances(all, sets, { memberOrder: order });
}

/** A member's current net and their latest settlement's snapshot (the F inbox's `balance_changed`). */
export async function balanceSinceSettlement(
	exec: DbOrTx,
	tripId: string,
	memberId: string,
): Promise<{
	netMinor: number;
	afterMinor: number | null;
	settlementId: string | null;
	home: string;
}> {
	const net = await netNow(exec, tripId);
	const sets = await loadSettlements(exec, tripId);
	const last = sets
		.filter((s) => s.fromMemberId === memberId || s.toMemberId === memberId)
		.at(-1);
	return {
		netMinor: net[memberId] ?? 0,
		afterMinor: last?.netAfter?.[memberId] ?? null,
		settlementId: last?.id ?? null,
		home: await tripHomeCurrency(exec, tripId),
	};
}

export { payerOrder };

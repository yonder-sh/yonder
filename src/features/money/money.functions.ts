/**
 * WP-Money server functions (EXTENSIONS §8.5, ADDENDUM §6 and §7).
 *
 * Rules every body keeps:
 * - Policy `{ direct: 'manageExpenses' }` for every write (`requireDirect`):
 *   owner, editor and suggester MEMBERS; guests never reach money (reads need
 *   `seeBookingDetails` → 403 for guests, 404 for strangers).
 * - Privacy: every read filters `not is_private or created_by = me`; private
 *   expenses have no split and only their creator pays; they write no
 *   activity. Activity summaries never carry amounts.
 * - Amounts are integer minor units; conversions per ADDENDUM §7.3 (planned at
 *   the latest rate, each payment at its paid date, settlements at their day,
 *   manual rates kept). Conversions run BEFORE the transaction (network).
 * - Payers, shares and line members must be non-removed members of the trip
 *   (placeholders included: free-text names go through `addPlaceholder`).
 * - Gift privacy (ADDENDUM §10): an expense created from a PRIVATE list item
 *   starts private.
 * - History (ADDENDUM §7.3): `expense.add|update|paid|delete|restore`,
 *   `settlement.add|delete`, `budget.update` with `meta.expenseId`.
 *   `createSettlement` stores `net_after` (every member's net right after it).
 * - Budgets (ADDENDUM §7.1): a member's own line stores the default's amount
 *   it was set against (`default_seen_minor`); "Follow default" deletes it.
 * - Receipts: photos/PDFs via WP-Media's upload with target
 *   `{ kind: 'expense', expenseId, paymentId? }`.
 * Keys: money (+ counts, activity; the inbox follows `money`).
 *
 * `*.server` modules are imported at the top but only USED inside handlers,
 * which TanStack Start strips from the client bundle.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { budgetLines, settlements, tripMembers, trips } from "@/db/schema";
import { readListItems } from "@/features/lists/server/lists.server";
import { can } from "@/lib/auth/roles";
import { indexGraph } from "@/lib/engine/graph-index";
import {
	balances,
	type CsvExpenseRow,
	expenseFacts,
	moneyCsv,
	ownPaymentRate,
	scopeSummary,
} from "@/lib/engine/money";
import {
	expenseAnchor,
	inMoneyView,
	targetLabel,
} from "@/lib/engine/money-scope";
import { Id, IsoDate } from "@/lib/schemas/common";
import type {
	BudgetKind,
	ExpenseCategory,
	ExpenseStatus,
	FeeKind,
	SplitMode,
} from "@/lib/schemas/enums";
import { EXPENSE_CATEGORY_VALUES } from "@/lib/schemas/enums";
import {
	BudgetLineInput,
	CurrencyCode,
	EXPENSE_LIMITS,
	ExpenseInput,
	FeeInput,
	LineInput,
	MinorAmount,
	PaymentInput,
	PointsInput,
	SettlementInput,
	SplitInput,
} from "@/lib/schemas/money";
import { BundleTarget } from "@/lib/schemas/targets";
import { logActivity } from "@/server/activity.server";
import { requireTripCapability } from "@/server/authz/access.server";
import { withNamedUser, withUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { loadTripGraph } from "@/server/graph.server";
import { assertBundleTarget, tripOf } from "@/server/perms.server";
import { requireDirect } from "@/server/proposals/proposable.server";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import {
	dateIn,
	manualConversion,
	todayUtc,
	tryConvert,
} from "./server/fx.server";
import {
	assertCurrency,
	type Ctx,
	type ExpenseFields,
	expenseForWrite,
	insertExpense,
	loadMoney,
	netNow,
	normalizeExpense,
	paymentForRemainder,
	prepareConversions,
	restoreExpenseRow,
	softDeleteExpense,
	tripHomeCurrency,
	updateExpenseRow,
	validateShape,
} from "./server/money.server";
import { plainText, shoppingCosts, shoppingExpense } from "./shopping";

export type PaymentDto = {
	id: string;
	paidAt: string;
	paidTz: string;
	currency: string;
	amountMinor: number;
	homeAmountMinor: number | null;
	fxRate: number | null;
	fxDate: string | null;
	fxSource: string | null;
	fxManual: boolean;
	method: string | null;
	payers: { memberId: string; amountMinor: number }[];
};

export type ExpenseDto = {
	id: string;
	target: BundleTarget;
	title: string;
	category: ExpenseCategory;
	amountMinor: number | null;
	currency: string | null;
	homeAmountMinor: number | null;
	homeCurrency: string | null;
	fxRate: number | null;
	fxDate: string | null;
	fxSource: string | null;
	fxManual: boolean;
	points: {
		program: string;
		points: number;
		sourceProgram: string | null;
		sourcePoints: number | null;
		cashValueMinor: number | null;
		cashValueCurrency: string | null;
		/** The cash value at home (latest rates), for cents per point. */
		cashValueHomeMinor?: number | null;
	} | null;
	expectedOn: string | null;
	/** Derived from the payments (ADDENDUM §7.3). */
	status: ExpenseStatus;
	splitMode: SplitMode;
	shares: { memberId: string; amountMinor: number | null }[];
	lines: {
		id: string;
		label: string;
		amountMinor: number;
		memberIds: string[];
	}[];
	fees: {
		id: string;
		label: string;
		kind: FeeKind;
		percent: number | null;
		amountMinor: number | null;
	}[];
	payments: PaymentDto[];
	isPrivate: boolean;
	taxFreePending: boolean;
	refundOfId: string | null;
	listItemId: string | null;
	note: string | null;
	createdBy: string | null;
	createdAt: string;
	updatedAt: string;
	/** Only on rows read for a restore. */
	deletedAt?: string;
};

export type SettlementDto = {
	id: string;
	fromMemberId: string;
	toMemberId: string;
	amountMinor: number;
	currency: string;
	homeAmountMinor: number | null;
	homeCurrency: string | null;
	fxRate: number | null;
	settledAt: string;
	settledTz: string;
	method: string | null;
	note: string | null;
	scope: { nodeId: string } | { dayId: string } | null;
	/** Every member's net (home minor units) right after this settlement (ADDENDUM §7.3). */
	netAfter: Record<string, number> | null;
	createdAt: string;
};

export type BudgetLineDto = {
	id: string;
	nodeId: string | null;
	category: ExpenseCategory | null;
	/** null = the trip default. */
	memberId: string | null;
	amountMinor: number;
	kind: BudgetKind;
	/** Member lines: the trip default this line was set against (the notice when it differs). */
	defaultSeenMinor: number | null;
};

export type MoneyDto = {
	/** The trip's home currency (`settings.currency`). */
	homeCurrency: string;
	/** The newest FX date used, for "rates as of". */
	ratesAsOf: string | null;
	expenses: ExpenseDto[];
	settlements: SettlementDto[];
	/** Trip defaults + the caller's own lines + other members' non-private lines. */
	budgets: BudgetLineDto[];
	/** Members whose budgets are private ("private" in the UI). */
	privateBudgetMemberIds: string[];
	/** The caller's own "keep my budgets private" toggle. */
	myBudgetPrivate?: boolean;
	/** The latest rates as `code → units per 1 home` (display currency, entry previews). */
	latestRates?: Record<string, number>;
	/**
	 * `expense.*` changes by other people since the caller's latest settlement
	 * that moved the caller's balance (costs they paid, share, had an item of,
	 * or a refund of one), newest first ("Balance changed since your last
	 * settlement … (Maya edited Ramen Ichiran)"; `balanceEdits`).
	 */
	recentEdits?: {
		at: string;
		actorName: string;
		verb: string;
		expenseId: string | null;
		title: string | null;
		/** "Maya edited Ramen Ichiran", worded as the inbox item words it. */
		cause?: string;
	}[];
};

const TripIdInput = z.object({ tripId: z.uuid() }).strict();
const IdInput = z.object({ id: z.uuid() }).strict();

/** `updateExpense`'s patch: any createExpense field (null clears an optional one). */
export const ExpensePatch = z
	.object({
		target: BundleTarget,
		title: z.string().trim().max(EXPENSE_LIMITS.title).nullable(),
		category: z.enum(EXPENSE_CATEGORY_VALUES),
		amountMinor: MinorAmount.nullable(),
		currency: CurrencyCode.nullable(),
		points: PointsInput.nullable(),
		expectedOn: IsoDate.nullable(),
		payments: z.array(PaymentInput).max(EXPENSE_LIMITS.payments),
		split: SplitInput,
		lines: z.array(LineInput).max(EXPENSE_LIMITS.lines),
		fees: z.array(FeeInput).max(EXPENSE_LIMITS.fees),
		isPrivate: z.boolean(),
		refundOfId: Id.nullable(),
		listItemId: Id.nullable(),
		taxFreePending: z.boolean(),
		fxRate: z.number().positive().max(1e9).nullable(),
		note: z.string().max(EXPENSE_LIMITS.note).nullable(),
	})
	.partial()
	.strict();
export type ExpensePatch = z.infer<typeof ExpensePatch>;

type Caller = { id: string; name: string };

function ctxOf(
	tripId: string,
	user: Caller,
	memberId: string | null,
	home: string,
): Ctx {
	return {
		tripId,
		actor: { userId: user.id, name: user.name },
		me: { userId: user.id, memberId },
		home,
	};
}

/** The trip of an expense (live unless `includeDeleted`) and the caller's access. */
async function expenseAccess(
	fn:
		| "updateExpense"
		| "markExpensePaid"
		| "setExpenseRate"
		| "deleteExpense"
		| "restoreExpense",
	id: string,
	user: Parameters<typeof requireDirect>[2],
	opts: { includeDeleted?: boolean } = {},
) {
	const tripId = await tripOf("expenses", id, opts);
	if (!tripId) return fail("NOT_FOUND");
	const access = await requireDirect(fn, tripId, user);
	const home = await tripHomeCurrency(db, tripId);
	return { tripId, access, home };
}

/** Everything the Money tab needs, privacy-filtered. Guests: 403. Keys: money. */
export const listMoney = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(TripIdInput)
	.handler(async ({ data, context }): Promise<MoneyDto> => {
		const access = await requireTripCapability(
			data.tripId,
			"seeBookingDetails",
			context.user,
		);
		return loadMoney(data.tripId, {
			userId: context.user.id,
			memberId: access.memberId,
		});
	});

export const createExpense = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(ExpenseInput)
	.handler(async ({ data, context }): Promise<{ id: string }> => {
		const access = await requireDirect(
			"createExpense",
			data.tripId,
			context.user,
		);
		const home = await tripHomeCurrency(db, data.tripId);
		const { tripId, id, ...fields } = data;
		const norm = normalizeExpense(fields, null);
		validateShape(norm);
		const conv = await prepareConversions(norm, home);
		const ctx = ctxOf(tripId, context.user, access.memberId, home);
		return withTripTx(
			tripId,
			(tx, out) =>
				insertExpense(
					tx,
					out,
					ctx,
					{ ...(id ? { id } : {}), fields },
					{ norm, conv },
				),
			mutationMeta(access, context.user),
		);
	});

export const updateExpense = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				id: z.uuid(),
				/** Any createExpense field except tripId and id; `payments` replaces the list. */
				patch: z.record(z.string(), z.unknown()),
				expectedUpdatedAt: z.string().optional(),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<{ updatedAt: string }> => {
		const parsed = ExpensePatch.safeParse(data.patch);
		if (!parsed.success)
			return fail("VALIDATION", "That change doesn't look right.");
		const { tripId, access, home } = await expenseAccess(
			"updateExpense",
			data.id,
			context.user,
		);
		const me = { userId: context.user.id, memberId: access.memberId };
		const base = await expenseForWrite(db, tripId, data.id, me);
		const norm = normalizeExpense(parsed.data as ExpenseFields, base);
		validateShape(norm);
		const conv = await prepareConversions(norm, home);
		const ctx = ctxOf(tripId, context.user, access.memberId, home);
		return withTripTx(
			tripId,
			(tx, out) =>
				updateExpenseRow(
					tx,
					out,
					ctx,
					data.id,
					{ norm, conv },
					{
						...(data.expectedUpdatedAt
							? { expectedUpdatedAt: data.expectedUpdatedAt }
							: {}),
					},
				),
			mutationMeta(access, context.user),
		);
	});

/**
 * Existing payments as inputs (ids kept, so receipts stay attached). A rate
 * a payment only inherited from the cost's manual rate is left out: it
 * follows the cost's rate (`prepareConversions`).
 */
function paymentsAsInput(e: ExpenseDto): PaymentInput[] {
	return e.payments.map((p) => {
		const own = ownPaymentRate(p, e);
		return {
			id: p.id,
			paidAt: p.paidAt,
			paidTz: p.paidTz,
			currency: p.currency,
			amountMinor: p.amountMinor,
			payers: p.payers,
			...(p.method ? { method: p.method } : {}),
			...(own !== undefined ? { fxRate: own } : {}),
		};
	});
}

/** "Mark paid": one payment for the unpaid remainder (defaults: me, now, the expense's currency). */
export const markExpensePaid = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({ id: z.uuid(), payment: PaymentInput.partial().optional() })
			.strict(),
	)
	.handler(async ({ data, context }): Promise<{ updatedAt: string }> => {
		const { tripId, access, home } = await expenseAccess(
			"markExpensePaid",
			data.id,
			context.user,
		);
		const me = { userId: context.user.id, memberId: access.memberId };
		const base = await expenseForWrite(db, tripId, data.id, me);
		const [trip] = await db
			.select({ tz: trips.defaultTz })
			.from(trips)
			.where(eq(trips.id, tripId));
		const payment = paymentForRemainder(
			base,
			me,
			data.payment ?? {},
			new Date(),
			trip?.tz ?? "UTC",
		);
		const norm = normalizeExpense(
			{
				payments: [
					...paymentsAsInput(base),
					{
						paidAt: payment.paidAt,
						paidTz: payment.paidTz,
						currency: payment.currency,
						amountMinor: payment.amountMinor,
						payers: payment.payers,
						...(payment.method ? { method: payment.method } : {}),
						...(payment.fxRate !== undefined ? { fxRate: payment.fxRate } : {}),
					},
				],
			},
			base,
		);
		validateShape(norm);
		const conv = await prepareConversions(norm, home);
		const ctx = ctxOf(tripId, context.user, access.memberId, home);
		return withTripTx(
			tripId,
			(tx, out) =>
				updateExpenseRow(
					tx,
					out,
					ctx,
					data.id,
					{ norm, conv },
					{ verb: "expense.paid" },
				),
			mutationMeta(access, context.user),
		);
	});

/** Manual FX override (null = back to the source's rate). */
export const setExpenseRate = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				id: z.uuid(),
				paymentId: z.uuid().optional(),
				rate: z.number().positive().max(1e9).nullable(),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<{ updatedAt: string }> => {
		const { tripId, access, home } = await expenseAccess(
			"setExpenseRate",
			data.id,
			context.user,
		);
		const me = { userId: context.user.id, memberId: access.memberId };
		const base = await expenseForWrite(db, tripId, data.id, me);
		let fields: ExpenseFields;
		if (data.paymentId) {
			if (!base.payments.some((p) => p.id === data.paymentId))
				return fail("NOT_FOUND", "payment");
			fields = {
				payments: paymentsAsInput(base).map((p) => {
					if (p.id !== data.paymentId) return p;
					const { fxRate: _old, ...rest } = p;
					return data.rate === null ? rest : { ...rest, fxRate: data.rate };
				}),
			};
		} else {
			fields = { fxRate: data.rate };
		}
		const norm = normalizeExpense(fields, base);
		const conv = await prepareConversions(norm, home);
		const ctx = ctxOf(tripId, context.user, access.memberId, home);
		return withTripTx(
			tripId,
			(tx, out) => updateExpenseRow(tx, out, ctx, data.id, { norm, conv }),
			mutationMeta(access, context.user),
		);
	});

/** Deletes an expense and its refunds (`refunds`: how many went with it; restore brings them back). */
export const deleteExpense = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(IdInput)
	.handler(
		async ({
			data,
			context,
		}): Promise<{ deletedAt: string; refunds: number }> => {
			const { tripId, access, home } = await expenseAccess(
				"deleteExpense",
				data.id,
				context.user,
			);
			const ctx = ctxOf(tripId, context.user, access.memberId, home);
			return withTripTx(
				tripId,
				(tx, out) => softDeleteExpense(tx, out, ctx, data.id),
				mutationMeta(access, context.user),
			);
		},
	);

export const restoreExpense = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(IdInput)
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const { tripId, access, home } = await expenseAccess(
			"restoreExpense",
			data.id,
			context.user,
			{
				includeDeleted: true,
			},
		);
		const ctx = ctxOf(tripId, context.user, access.memberId, home);
		return withTripTx(
			tripId,
			(tx, out) => restoreExpenseRow(tx, out, ctx, data.id),
			mutationMeta(access, context.user),
		);
	});

export const createSettlement = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(SettlementInput)
	.handler(async ({ data, context }): Promise<{ id: string }> => {
		const access = await requireDirect(
			"createSettlement",
			data.tripId,
			context.user,
		);
		assertCurrency(data.currency);
		const home = await tripHomeCurrency(db, data.tripId);
		const date = dateIn(data.settledAt, data.settledTz);
		const conv =
			data.fxRate !== undefined && data.currency !== home
				? manualConversion(
						data.amountMinor,
						data.currency,
						home,
						data.fxRate,
						date,
					)
				: await tryConvert(data.amountMinor, data.currency, home, date);
		return withTripTx(
			data.tripId,
			async (tx, out) => {
				// Former members can still settle what they owe (never a merged placeholder).
				const people = (
					await tx.execute(sql`
						select id::text as id from trip_members
						 where trip_id = ${data.tripId} and merged_into_id is null
						   and id in (${data.fromMemberId}, ${data.toMemberId})`)
				).rows as { id: string }[];
				if (people.length !== 2)
					fail("VALIDATION", "Both people must be on this trip.");
				if (data.scope)
					await assertBundleTarget(
						tx,
						data.tripId,
						"nodeId" in data.scope
							? { kind: "node", nodeId: data.scope.nodeId }
							: { kind: "day", dayId: data.scope.dayId },
					);
				if (data.id) {
					const [taken] = await tx
						.select({ id: settlements.id })
						.from(settlements)
						.where(eq(settlements.id, data.id));
					if (taken) fail("CONFLICT", "that id is already taken");
				}
				const [row] = await tx
					.insert(settlements)
					.values({
						...(data.id ? { id: data.id } : {}),
						tripId: data.tripId,
						fromMemberId: data.fromMemberId,
						toMemberId: data.toMemberId,
						amountMinor: data.amountMinor,
						currency: data.currency,
						homeCurrency: home,
						homeAmountMinor: conv?.homeMinor ?? null,
						fxRate: conv?.rate ?? null,
						fxDate: conv?.rateDate ?? date,
						fxSource: conv?.source ?? "pending",
						fxManual: conv?.source === "manual",
						settledAt: new Date(data.settledAt),
						settledTz: data.settledTz,
						method: data.method?.trim() || null,
						note: data.note?.trim() || null,
						nodeId:
							data.scope && "nodeId" in data.scope ? data.scope.nodeId : null,
						dayId:
							data.scope && "dayId" in data.scope ? data.scope.dayId : null,
						createdBy: context.user.id,
					})
					.returning({ id: settlements.id });
				const id = (row as { id: string }).id;
				// Every member's net right after it ("balance changed since your last settlement").
				const net = await netNow(tx, data.tripId);
				await tx
					.update(settlements)
					.set({ netAfter: net })
					.where(
						and(eq(settlements.tripId, data.tripId), eq(settlements.id, id)),
					);
				const names = (
					await tx.execute(sql`
						select m.id::text as id,
						       coalesce(u.name, m.display_name, split_part(m.email, '@', 1)) as name
						  from trip_members m left join "user" u on u.id = m.user_id
						 where m.trip_id = ${data.tripId}
						   and m.id in (${data.fromMemberId}, ${data.toMemberId})`)
				).rows as { id: string; name: string | null }[];
				const nameOf = (m: string) =>
					names.find((x) => x.id === m)?.name ?? "someone";
				await logActivity(tx, out, {
					tripId: data.tripId,
					actor: { userId: context.user.id, name: context.user.name },
					verb: "settlement.add",
					summary: `recorded a settlement from ${nameOf(data.fromMemberId)} to ${nameOf(data.toMemberId)}`,
				});
				out.emit({ entity: "settlement", ids: [id] });
				return { id };
			},
			mutationMeta(access, context.user),
		);
	});

export const deleteSettlement = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(IdInput)
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const [s] = await db
			.select({ tripId: settlements.tripId })
			.from(settlements)
			.where(and(eq(settlements.id, data.id), isNull(settlements.deletedAt)));
		if (!s) return fail("NOT_FOUND");
		const access = await requireDirect(
			"deleteSettlement",
			s.tripId,
			context.user,
		);
		return withTripTx(
			s.tripId,
			async (tx, out) => {
				const [row] = await tx
					.update(settlements)
					.set({ deletedAt: sql`date_trunc('milliseconds', now())` })
					.where(
						and(
							eq(settlements.tripId, s.tripId),
							eq(settlements.id, data.id),
							isNull(settlements.deletedAt),
						),
					)
					.returning({ id: settlements.id });
				if (!row) return fail("NOT_FOUND");
				await logActivity(tx, out, {
					tripId: s.tripId,
					actor: { userId: context.user.id, name: context.user.name },
					verb: "settlement.delete",
					summary: "deleted a settlement",
				});
				out.emit({ entity: "settlement", ids: [data.id] });
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});

/** Upserts one budget line; trip-default lines (memberId null) need `manageBudgets`, own lines only yours. */
export const setBudgetLine = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(BudgetLineInput)
	.handler(async ({ data, context }): Promise<{ id: string }> => {
		const access = await requireDirect(
			"setBudgetLine",
			data.tripId,
			context.user,
		);
		if (data.memberId === null && !can(access, "manageBudgets"))
			fail("FORBIDDEN", "Only owners and editors set the trip default.");
		if (data.memberId !== null && data.memberId !== access.memberId)
			fail("FORBIDDEN", "You can only set your own budget.");
		return withTripTx(
			data.tripId,
			async (tx, out) => {
				if (data.nodeId)
					await assertBundleTarget(tx, data.tripId, {
						kind: "node",
						nodeId: data.nodeId,
					});
				const slot = and(
					eq(budgetLines.tripId, data.tripId),
					data.nodeId
						? eq(budgetLines.nodeId, data.nodeId)
						: isNull(budgetLines.nodeId),
					data.category
						? eq(budgetLines.category, data.category)
						: isNull(budgetLines.category),
				);
				const [def] =
					data.memberId === null
						? []
						: await tx
								.select({ amountMinor: budgetLines.amountMinor })
								.from(budgetLines)
								.where(and(slot, isNull(budgetLines.memberId)));
				const [existing] = await tx
					.select({ id: budgetLines.id })
					.from(budgetLines)
					.where(
						and(
							slot,
							data.memberId
								? eq(budgetLines.memberId, data.memberId)
								: isNull(budgetLines.memberId),
						),
					);
				const cols = {
					amountMinor: data.amountMinor,
					kind: data.kind,
					defaultSeenMinor:
						data.memberId === null ? null : (def?.amountMinor ?? null),
					updatedAt: new Date(),
				};
				let id: string;
				if (existing) {
					id = existing.id;
					await tx
						.update(budgetLines)
						.set(cols)
						.where(
							and(eq(budgetLines.tripId, data.tripId), eq(budgetLines.id, id)),
						);
				} else {
					const [row] = await tx
						.insert(budgetLines)
						.values({
							tripId: data.tripId,
							nodeId: data.nodeId,
							category: data.category,
							memberId: data.memberId,
							createdBy: context.user.id,
							...cols,
						})
						.returning({ id: budgetLines.id });
					id = (row as { id: string }).id;
				}
				if (data.memberId === null)
					await logActivity(tx, out, {
						tripId: data.tripId,
						actor: { userId: context.user.id, name: context.user.name },
						verb: "budget.update",
						summary: "updated the trip budget",
						nodeId: data.nodeId,
					});
				out.emit({ entity: "budget", ids: [id] });
				return { id };
			},
			mutationMeta(access, context.user),
		);
	});

export const deleteBudgetLine = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(IdInput)
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const [line] = await db
			.select({
				tripId: budgetLines.tripId,
				memberId: budgetLines.memberId,
				nodeId: budgetLines.nodeId,
			})
			.from(budgetLines)
			.where(eq(budgetLines.id, data.id));
		if (!line) return fail("NOT_FOUND");
		const access = await requireDirect(
			"deleteBudgetLine",
			line.tripId,
			context.user,
		);
		if (line.memberId === null && !can(access, "manageBudgets"))
			fail("FORBIDDEN", "Only owners and editors change the trip default.");
		if (line.memberId !== null && line.memberId !== access.memberId)
			return fail("NOT_FOUND");
		return withTripTx(
			line.tripId,
			async (tx, out) => {
				await tx
					.delete(budgetLines)
					.where(
						and(
							eq(budgetLines.tripId, line.tripId),
							eq(budgetLines.id, data.id),
						),
					);
				if (line.memberId === null)
					await logActivity(tx, out, {
						tripId: line.tripId,
						actor: { userId: context.user.id, name: context.user.name },
						verb: "budget.update",
						summary: "removed a trip budget",
						nodeId: line.nodeId,
					});
				out.emit({ entity: "budget", ids: [data.id] });
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});

/** The caller's own "private budgets" toggle (`trip_members.budget_private`). */
export const setBudgetPrivate = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(TripIdInput.extend({ private: z.boolean() }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const access = await requireDirect(
			"setBudgetPrivate",
			data.tripId,
			context.user,
		);
		const memberId = access.memberId;
		if (!memberId) return fail("FORBIDDEN");
		return withTripTx(
			data.tripId,
			async (tx, out) => {
				await tx
					.update(tripMembers)
					.set({ budgetPrivate: data.private })
					.where(
						and(
							eq(tripMembers.tripId, data.tripId),
							eq(tripMembers.id, memberId),
						),
					);
				out.emit({ entity: "budget", ids: [memberId] });
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});

/**
 * CSV of the scope's expenses, per-person totals and balances, with the
 * Money tab's own view (scope, "Only", day range) and its priced shopping
 * items, so the Total row equals the tab. Guests: 403.
 */
export const exportMoneyCsv = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(
		TripIdInput.extend({
			nodeId: z.uuid().optional(),
			/** "Only <scope>": just the scope's own costs. */
			only: z.boolean().optional(),
			days: z.object({ from: IsoDate, to: IsoDate }).strict().optional(),
			displayCurrency: CurrencyCode.optional(),
		}).strict(),
	)
	.handler(
		async ({ data, context }): Promise<{ filename: string; csv: string }> => {
			const access = await requireTripCapability(
				data.tripId,
				"seeBookingDetails",
				context.user,
			);
			if (data.displayCurrency) assertCurrency(data.displayCurrency);
			const me = { userId: context.user.id, memberId: access.memberId };
			const money = await loadMoney(data.tripId, me);
			const graph = await loadTripGraph(data.tripId, access);
			if (!graph) return fail("NOT_FOUND");
			const ix = indexGraph(graph);
			const scope = data.nodeId ? ix.node(data.nodeId) : null;
			if (data.nodeId && !scope) return fail("NOT_FOUND");
			const home = money.homeCurrency;
			const order = graph.members.map((m) => m.id);
			const byId = new Map(money.expenses.map((e) => [e.id, e]));
			const view = {
				scopeId: scope?.id ?? null,
				only: data.only ?? false,
				days: data.days ?? null,
			};
			const inScope = money.expenses.filter((e) =>
				inMoneyView(ix, e.target, view),
			);
			// Open, priced shopping items are planned costs, as in the tab.
			const linked = new Set(
				money.expenses
					.map((e) => e.listItemId)
					.filter((id): id is string => !!id),
			);
			const shopping = shoppingCosts(
				await readListItems(db, data.tripId, context.user.id),
				linked,
				home,
				money.latestRates,
			).filter((c) => inMoneyView(ix, c.item.target, view));
			const summary = scopeSummary(
				[...inScope, ...shopping.map(shoppingExpense)],
				{ memberOrder: order, byId },
			);
			const net = balances(
				money.expenses.filter((e) => !e.isPrivate),
				money.settlements,
				{ memberOrder: order, byId },
			);
			const names: Record<string, string> = Object.fromEntries(
				graph.members.map((m) => [m.id, m.name]),
			);
			const who = (ids: readonly string[]) =>
				[...new Set(ids)].map((m) => names[m] ?? "Former member").join(", ");
			const whereOf = (target: BundleTarget) => {
				const anchor = expenseAnchor(ix, target);
				const place = anchor.nodeId
					? ix
							.path(anchor.nodeId)
							.map((n) => n.name)
							.join(" › ")
					: "Trip-wide";
				const label = targetLabel(ix, target);
				return label === place || target.kind === "node"
					? place
					: `${place} · ${label}`;
			};
			const rows: CsvExpenseRow[] = inScope.map((e) => {
				const paidDate = e.payments[0]
					? dateIn(e.payments[0].paidAt, e.payments[0].paidTz)
					: null;
				// The tab's own numbers (a part-paid cost: what was paid, each
				// payment at its date, + the rest at today's rate), so the rows
				// add up to the Total row.
				const facts = expenseFacts(e, { memberOrder: order, byId });
				return {
					date: paidDate ?? e.expectedOn ?? e.createdAt.slice(0, 10),
					title: e.title,
					where: whereOf(e.target),
					category: e.category,
					status: e.status,
					amountMinor: e.amountMinor,
					currency: e.currency,
					plannedHome:
						e.amountMinor === null && !e.payments.length
							? null
							: facts.plannedHome,
					actualHome: facts.actualHome,
					paidBy: who(
						e.payments.flatMap((p) => p.payers.map((x) => x.memberId)),
					),
					split: e.isPrivate
						? "Only me"
						: e.lines.length
							? `Itemized (${who(e.lines.flatMap((l) => l.memberIds))})`
							: who(e.shares.map((s) => s.memberId)),
					points: e.points
						? `${e.points.points} ${e.points.program}${e.points.sourceProgram ? ` (from ${e.points.sourcePoints} ${e.points.sourceProgram})` : ""}`
						: "",
					isPrivate: e.isPrivate,
					note: e.note ?? "",
				};
			});
			rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
			// Shopping-list costs have no date: after the dated rows.
			for (const c of shopping)
				rows.push({
					date: "",
					title: plainText(c.item.text) || "Shopping",
					where: whereOf(c.item.target),
					category: "shopping",
					status: "planned",
					amountMinor: c.amountMinor,
					currency: c.currency,
					plannedHome: c.homeMinor,
					actualHome: 0,
					paidBy: "",
					split: c.item.isPrivate
						? "Only me"
						: `Shopping list${c.item.assigneeIds.length ? ` (${who(c.item.assigneeIds)})` : ""}`,
					points: "",
					isPrivate: c.item.isPrivate,
					note: "",
				});
			const rate = data.displayCurrency
				? money.latestRates?.[data.displayCurrency]
				: undefined;
			const csv = moneyCsv({
				scopeName: scope?.name ?? graph.trip.name,
				home,
				rows,
				summary,
				balances: net,
				names,
				display:
					data.displayCurrency && rate
						? { currency: data.displayCurrency, rate }
						: null,
			});
			const slug = (s: string) =>
				s
					.toLowerCase()
					.normalize("NFKD")
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "")
					.slice(0, 40) || "trip";
			return {
				filename: `${slug(graph.trip.name)}${scope ? `-${slug(scope.name)}` : ""}-money-${todayUtc()}.csv`,
				csv,
			};
		},
	);

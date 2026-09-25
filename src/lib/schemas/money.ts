/**
 * E5 money inputs (EXTENSIONS §8, overridden by ADDENDUM §6 and §7.3):
 * integer minor units per currency, `equal` or `exact` splits, optional
 * itemized lines with proportional fees, one or more payments per expense
 * (each with its own payers and paid date), points with an optional source
 * programme and cash value, refunds linked to their original, and budgets.
 * WP-Money owns the functions; F owns these shapes and the tables.
 */
import { z } from "zod";
import { Id, IsoDate, Tz } from "./common";
import {
	BUDGET_KIND_VALUES,
	EXPENSE_CATEGORY_VALUES,
	SPLIT_MODE_VALUES,
} from "./enums";
import { BundleTarget } from "./targets";

/** ISO 4217 code, upper case. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "expected ISO 4217");

/** An amount in the currency's minor units (JPY/KRW/VND have 0 decimals). */
export const MinorAmount = z
	.number()
	.int()
	.min(-1_000_000_000_000)
	.max(1_000_000_000_000);

export const PayerInput = z
	.object({ memberId: Id, amountMinor: MinorAmount })
	.strict();
export type PayerInput = z.infer<typeof PayerInput>;

/** One payment on an expense (deposits, partial payments, the final bill). */
export const PaymentInput = z
	.object({
		id: Id.optional(),
		paidAt: z.iso.datetime({ offset: true }),
		paidTz: Tz,
		currency: CurrencyCode,
		amountMinor: MinorAmount,
		/** Several payers = pooled cash; amounts sum to the payment's amount. */
		payers: z.array(PayerInput).min(1).max(8),
		/** "cash", "card", "Venmo"… */
		method: z.string().trim().max(60).optional(),
		/** Manual rate override (home per unit of `currency`). */
		fxRate: z.number().positive().max(1e9).optional(),
	})
	.strict();
export type PaymentInput = z.infer<typeof PaymentInput>;

export const SplitInput = z
	.object({
		mode: z.enum(SPLIT_MODE_VALUES),
		/** `equal`: who is included; `exact`: each person's amount. */
		shares: z
			.array(
				z
					.object({ memberId: Id, amountMinor: MinorAmount.optional() })
					.strict(),
			)
			.min(1)
			.max(20),
	})
	.strict();
export type SplitInput = z.infer<typeof SplitInput>;

/** Itemize: a line and who had it (shared lines split equally among them). */
export const LineInput = z
	.object({
		label: z.string().trim().min(1).max(80),
		amountMinor: MinorAmount,
		memberIds: z.array(Id).min(1).max(20),
	})
	.strict();
export type LineInput = z.infer<typeof LineInput>;

/** Tax, service charge or tip: a % of each person's subtotal, or a fixed amount spread proportionally. */
export const FeeInput = z
	.object({
		label: z.string().trim().min(1).max(40),
		kind: z.enum(["percent", "fixed"]),
		percent: z.number().min(0).max(100).optional(),
		amountMinor: MinorAmount.optional(),
	})
	.strict()
	.refine(
		(f) =>
			f.kind === "percent"
				? f.percent !== undefined
				: f.amountMinor !== undefined,
		{
			message: "a percent fee needs percent, a fixed fee needs amountMinor",
		},
	);
export type FeeInput = z.infer<typeof FeeInput>;

/** A points/miles cost: never enters cash balances. */
export const PointsInput = z
	.object({
		program: z.string().trim().min(1).max(60),
		points: z.number().int().positive().max(100_000_000),
		/** Where the points came from (e.g. 200k Chase UR via a transfer bonus). */
		sourceProgram: z.string().trim().min(1).max(60).optional(),
		sourcePoints: z.number().int().positive().max(100_000_000).optional(),
		/** The booking's equivalent cash price, for cents per point. */
		cashValueMinor: MinorAmount.optional(),
		cashValueCurrency: CurrencyCode.optional(),
	})
	.strict();
export type PointsInput = z.infer<typeof PointsInput>;

export const EXPENSE_LIMITS = {
	payments: 20,
	lines: 50,
	fees: 10,
	title: 120,
	note: 2000,
} as const;

/** `createExpense` input (WP-Money; policy `{ direct: 'manageExpenses' }`). */
export const ExpenseInput = z
	.object({
		tripId: Id,
		id: Id.optional(),
		/** Where it hangs; a stay is its leg. `trip` = Trip-wide. */
		target: BundleTarget,
		title: z.string().trim().max(EXPENSE_LIMITS.title).optional(),
		category: z.enum(EXPENSE_CATEGORY_VALUES).optional(),
		/** The planned (total) amount. Negative only on a refund. */
		amountMinor: MinorAmount.optional(),
		currency: CurrencyCode.optional(),
		points: PointsInput.optional(),
		/** When a planned cost is expected to be paid. */
		expectedOn: IsoDate.optional(),
		payments: z.array(PaymentInput).max(EXPENSE_LIMITS.payments).optional(),
		split: SplitInput.optional(),
		lines: z.array(LineInput).max(EXPENSE_LIMITS.lines).optional(),
		fees: z.array(FeeInput).max(EXPENSE_LIMITS.fees).optional(),
		/** Visible only to its creator; excluded from splits and balances. */
		isPrivate: z.boolean().optional(),
		/** A refund line of that expense (split back in the same proportions). */
		refundOfId: Id.optional(),
		/** The shopping item it was bought for. */
		listItemId: Id.optional(),
		/** "Tax-free / refund pending". */
		taxFreePending: z.boolean().optional(),
		/** Manual rate override for the planned amount. */
		fxRate: z.number().positive().max(1e9).optional(),
		note: z.string().max(EXPENSE_LIMITS.note).optional(),
	})
	.strict()
	.refine((e) => e.amountMinor !== undefined || e.points !== undefined, {
		message: "an expense needs an amount or points",
	})
	.refine((e) => (e.amountMinor === undefined) === (e.currency === undefined), {
		message: "send amount and currency together",
	});
export type ExpenseInput = z.infer<typeof ExpenseInput>;

export const SettlementInput = z
	.object({
		tripId: Id,
		id: Id.optional(),
		fromMemberId: Id,
		toMemberId: Id,
		amountMinor: MinorAmount.positive(),
		currency: CurrencyCode,
		settledAt: z.iso.datetime({ offset: true }),
		settledTz: Tz,
		method: z.string().trim().max(60).optional(),
		note: z.string().max(500).optional(),
		/** Optional context tag: "settled in Kyoto" / "on Day 6". */
		scope: z
			.union([
				z.object({ nodeId: Id }).strict(),
				z.object({ dayId: Id }).strict(),
			])
			.optional(),
		fxRate: z.number().positive().max(1e9).optional(),
	})
	.strict()
	.refine((s) => s.fromMemberId !== s.toMemberId, {
		message: "a settlement is between two people",
	});
export type SettlementInput = z.infer<typeof SettlementInput>;

/** ADDENDUM §7.1: a budget line (trip default when `memberId` is null). */
export const BudgetLineInput = z
	.object({
		tripId: Id,
		/** null = the trip root. */
		nodeId: Id.nullable(),
		/** null = all categories. */
		category: z.enum(EXPENSE_CATEGORY_VALUES).nullable(),
		/** null = the trip default (owner/editors); else the member's own line (that member only). */
		memberId: Id.nullable(),
		/** In the trip's home currency, minor units. */
		amountMinor: MinorAmount.nonnegative(),
		kind: z.enum(BUDGET_KIND_VALUES),
	})
	.strict();
export type BudgetLineInput = z.infer<typeof BudgetLineInput>;

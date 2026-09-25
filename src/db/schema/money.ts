/**
 * E5 money (EXTENSIONS §8.1, overridden by ADDENDUM §6 and §7.1–§7.3).
 *
 * - Amounts are integer MINOR units of their currency (JPY/KRW/VND: 0 decimals).
 * - An expense holds its planned amount; its payments (each with a paid date,
 *   payers and currency) make it partially paid, then paid. The unpaid
 *   remainder counts as planned. Status is derived, never stored.
 * - Home-currency conversions are stored per expense (planned: latest rate)
 *   and per payment (at its paid date); `fx_manual` rows are never re-converted.
 * - Target, list-item and scope FKs are hand-written in 0003_money_fks.sql with
 *   `ON DELETE SET NULL (<col>)`, so deleting a leg or day leaves the expense
 *   "Trip-wide" and history never vanishes. Member FKs are NO ACTION: members
 *   with money rows are retired (`status = 'removed'`), never deleted.
 * - Privacy: `is_private` rows are visible only to `created_by` and stay out
 *   of splits and balances; every F read filters them. Guests never reach money.
 */
import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	date,
	foreignKey,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { createdAt, deletedAt, pk, sortKey, updatedAt } from "./_columns";
import { user } from "./auth";
import { budgetKind, expenseCategory, feeKind, splitMode } from "./enums";
import { nodes } from "./nodes";
import { tripMembers, tripRef } from "./trips";

const CURRENCY_RE = sql.raw(`'^[A-Z]{3}$'`);
/** Minor units as a JS number (safe to ±9e15). */
const minor = () => bigint({ mode: "number" });

/** Home-currency conversion columns (expenses, payments, settlements). */
const fxCols = () => ({
	homeCurrency: text(),
	homeAmountMinor: minor(),
	/** Home units per 1 unit of the original currency. */
	fxRate: numeric({ precision: 24, scale: 12, mode: "number" }),
	fxDate: date({ mode: "string" }),
	/**
	 * 'same' | 'currency-api' | 'frankfurter' | 'manual' | 'pending' (no rate
	 * was known at write time: `home_amount_minor` is null until the daily FX
	 * job fills it).
	 */
	fxSource: text(),
	fxManual: boolean().notNull().default(false),
});

export const expenses = pgTable(
	"expenses",
	{
		id: pk(),
		tripId: tripRef(),
		/** node | leg (incl. stays) | item | day | none (Trip-wide). FKs: 0003, SET NULL. */
		nodeId: uuid(),
		legId: uuid(),
		itemId: uuid(),
		dayId: uuid(),
		/** The shopping item it was bought for (FK: 0003, SET NULL). */
		listItemId: uuid(),
		/** A refund of that expense (negative amount; same split proportions). */
		refundOfId: uuid(),
		/** Server default: the target's name, else the category label. */
		title: text().notNull(),
		category: expenseCategory().notNull().default("fees_other"),
		/** The planned total. Null = points only. Negative only on refunds. */
		amountMinor: minor(),
		currency: text(),
		...fxCols(),
		points: integer(),
		pointsProgram: text(),
		sourcePoints: integer(),
		sourceProgram: text(),
		/** The booking's equivalent cash price (cents per point). */
		cashValueMinor: minor(),
		cashValueCurrency: text(),
		/** A planned cost's expected payment date. */
		expectedOn: date({ mode: "string" }),
		splitMode: splitMode().notNull().default("equal"),
		isPrivate: boolean().notNull().default(false),
		taxFreePending: boolean().notNull().default(false),
		note: text(),
		createdBy: text().references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		deletedAt: deletedAt(),
	},
	(t) => [
		unique("expenses_trip_id_id_uq").on(t.tripId, t.id),
		index("expenses_trip_live_idx")
			.on(t.tripId)
			.where(sql`${t.deletedAt} is null`),
		index("expenses_node_idx").on(t.nodeId),
		index("expenses_leg_idx").on(t.legId),
		index("expenses_item_idx").on(t.itemId),
		index("expenses_day_idx").on(t.dayId),
		index("expenses_list_item_idx").on(t.listItemId),
		index("expenses_refund_of_idx").on(t.refundOfId),
		check(
			"expenses_target_ck",
			sql`num_nonnulls(${t.nodeId}, ${t.legId}, ${t.itemId}, ${t.dayId}) <= 1`,
		),
		check(
			"expenses_money_ck",
			sql`(${t.amountMinor} is null) = (${t.currency} is null)`,
		),
		check(
			"expenses_sign_ck",
			sql`${t.amountMinor} is null or ${t.amountMinor} >= 0 or ${t.refundOfId} is not null`,
		),
		check(
			"expenses_some_cost_ck",
			sql`${t.amountMinor} is not null or ${t.points} is not null`,
		),
		check(
			"expenses_points_ck",
			sql`(${t.points} is null) = (${t.pointsProgram} is null) and (${t.points} is null or ${t.points} > 0)`,
		),
		check(
			"expenses_source_points_ck",
			sql`(${t.sourcePoints} is null) = (${t.sourceProgram} is null) and (${t.sourcePoints} is null or ${t.sourcePoints} > 0)`,
		),
		check(
			"expenses_cash_value_ck",
			sql`(${t.cashValueMinor} is null) = (${t.cashValueCurrency} is null)`,
		),
		check(
			"expenses_currency_ck",
			sql`(${t.currency} is null or ${t.currency} ~ ${CURRENCY_RE})
			and (${t.homeCurrency} is null or ${t.homeCurrency} ~ ${CURRENCY_RE})
			and (${t.cashValueCurrency} is null or ${t.cashValueCurrency} ~ ${CURRENCY_RE})`,
		),
		check(
			"expenses_text_ck",
			sql`char_length(${t.title}) between 1 and 120 and (${t.note} is null or char_length(${t.note}) <= 2000)`,
		),
		check(
			"expenses_no_self_refund_ck",
			sql`${t.refundOfId} is null or ${t.refundOfId} <> ${t.id}`,
		),
		foreignKey({
			name: "expenses_refund_of_fk",
			columns: [t.tripId, t.refundOfId],
			foreignColumns: [t.tripId, t.id],
		}).onDelete("cascade"),
	],
);

/** One payment on an expense (deposit, partial, final). */
export const expensePayments = pgTable(
	"expense_payments",
	{
		id: pk(),
		tripId: uuid().notNull(),
		expenseId: uuid().notNull(),
		paidAt: timestamp({ withTimezone: true }).notNull(),
		/** The zone the payment was made in (shown as local time). */
		paidTz: text().notNull(),
		currency: text().notNull(),
		amountMinor: minor().notNull(),
		...fxCols(),
		/** "cash", "card", "Venmo"… */
		method: text(),
		createdBy: text().references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		unique("expense_payments_trip_id_id_uq").on(t.tripId, t.id),
		// Target of the payment-receipt FK on attachments (hand-written in 0006).
		unique("expense_payments_trip_expense_id_uq").on(
			t.tripId,
			t.expenseId,
			t.id,
		),
		foreignKey({
			name: "expense_payments_expense_fk",
			columns: [t.tripId, t.expenseId],
			foreignColumns: [expenses.tripId, expenses.id],
		}).onDelete("cascade"),
		index("expense_payments_expense_idx").on(t.expenseId),
		check(
			"expense_payments_currency_ck",
			sql`${t.currency} ~ ${CURRENCY_RE} and (${t.homeCurrency} is null or ${t.homeCurrency} ~ ${CURRENCY_RE})`,
		),
		check(
			"expense_payments_method_ck",
			sql`${t.method} is null or char_length(${t.method}) <= 60`,
		),
	],
);

/** Who paid how much of one payment (pooled cash = several rows). */
export const expensePaymentPayers = pgTable(
	"expense_payment_payers",
	{
		tripId: uuid().notNull(),
		paymentId: uuid().notNull(),
		memberId: uuid().notNull(),
		amountMinor: minor().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.paymentId, t.memberId] }),
		foreignKey({
			name: "expense_payment_payers_payment_fk",
			columns: [t.tripId, t.paymentId],
			foreignColumns: [expensePayments.tripId, expensePayments.id],
		}).onDelete("cascade"),
		// CASCADE (0010): a member row only goes with its trip (or its user's
		// account, which retires the member first: `deleteUserAccount`); the app
		// retires members, never deletes them (`retireMember`). As NO ACTION it
		// failed whole-trip deletes, depending on which cascade came first.
		foreignKey({
			name: "expense_payment_payers_member_fk",
			columns: [t.tripId, t.memberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		index("expense_payment_payers_member_idx").on(t.memberId),
	],
);

/** The split: who is included (`equal`) or each person's amount (`exact`). */
export const expenseShares = pgTable(
	"expense_shares",
	{
		tripId: uuid().notNull(),
		expenseId: uuid().notNull(),
		memberId: uuid().notNull(),
		/** `exact` only. */
		amountMinor: minor(),
	},
	(t) => [
		primaryKey({ columns: [t.expenseId, t.memberId] }),
		foreignKey({
			name: "expense_shares_expense_fk",
			columns: [t.tripId, t.expenseId],
			foreignColumns: [expenses.tripId, expenses.id],
		}).onDelete("cascade"),
		// CASCADE (0010), like expense_payment_payers_member_fk.
		foreignKey({
			name: "expense_shares_member_fk",
			columns: [t.tripId, t.memberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		index("expense_shares_member_idx").on(t.memberId),
	],
);

/** Itemized lines ("who had what"). When present, they drive the split. */
export const expenseLines = pgTable(
	"expense_lines",
	{
		id: pk(),
		tripId: uuid().notNull(),
		expenseId: uuid().notNull(),
		label: text().notNull(),
		amountMinor: minor().notNull(),
		position: sortKey().notNull(),
	},
	(t) => [
		unique("expense_lines_trip_id_id_uq").on(t.tripId, t.id),
		foreignKey({
			name: "expense_lines_expense_fk",
			columns: [t.tripId, t.expenseId],
			foreignColumns: [expenses.tripId, expenses.id],
		}).onDelete("cascade"),
		index("expense_lines_expense_idx").on(t.expenseId),
		check(
			"expense_lines_label_ck",
			sql`char_length(${t.label}) between 1 and 80`,
		),
	],
);

export const expenseLineMembers = pgTable(
	"expense_line_members",
	{
		tripId: uuid().notNull(),
		lineId: uuid().notNull(),
		memberId: uuid().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.lineId, t.memberId] }),
		foreignKey({
			name: "expense_line_members_line_fk",
			columns: [t.tripId, t.lineId],
			foreignColumns: [expenseLines.tripId, expenseLines.id],
		}).onDelete("cascade"),
		// CASCADE (0010), like expense_payment_payers_member_fk.
		foreignKey({
			name: "expense_line_members_member_fk",
			columns: [t.tripId, t.memberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		index("expense_line_members_member_idx").on(t.memberId),
	],
);

/** Tax, service charge, tip on an itemized expense: spread by subtotal. */
export const expenseFees = pgTable(
	"expense_fees",
	{
		id: pk(),
		tripId: uuid().notNull(),
		expenseId: uuid().notNull(),
		label: text().notNull(),
		kind: feeKind().notNull(),
		/** `percent` fees. */
		percent: numeric({ precision: 7, scale: 4, mode: "number" }),
		/** `fixed` fees. */
		amountMinor: minor(),
		position: sortKey().notNull(),
	},
	(t) => [
		foreignKey({
			name: "expense_fees_expense_fk",
			columns: [t.tripId, t.expenseId],
			foreignColumns: [expenses.tripId, expenses.id],
		}).onDelete("cascade"),
		index("expense_fees_expense_idx").on(t.expenseId),
		check(
			"expense_fees_value_ck",
			sql`(${t.kind} = 'percent' and ${t.percent} is not null and ${t.percent} between 0 and 100)
			or (${t.kind} = 'fixed' and ${t.amountMinor} is not null)`,
		),
		check(
			"expense_fees_label_ck",
			sql`char_length(${t.label}) between 1 and 40`,
		),
	],
);

/** A recorded transfer between two people (trip-wide settle-up). */
export const settlements = pgTable(
	"settlements",
	{
		id: pk(),
		tripId: tripRef(),
		fromMemberId: uuid().notNull(),
		toMemberId: uuid().notNull(),
		amountMinor: minor().notNull(),
		currency: text().notNull(),
		...fxCols(),
		settledAt: timestamp({ withTimezone: true }).notNull(),
		settledTz: text().notNull(),
		/** "cash", "Venmo", "bank"… */
		method: text(),
		note: text(),
		/** Optional context tags (FKs: 0003, SET NULL). */
		nodeId: uuid(),
		dayId: uuid(),
		/**
		 * ADDENDUM §7.3 "edits after settlement are allowed and flagged": every
		 * member's net position (home minor units, `home_currency`) right after
		 * this settlement. A member's latest settlement snapshot vs. today's
		 * balance gives "Balance changed since your last settlement: +$6.20";
		 * the cause comes from `expense.*` activity rows newer than `created_at`.
		 */
		netAfter: jsonb().$type<Record<string, number>>(),
		createdBy: text().references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
		deletedAt: deletedAt(),
	},
	(t) => [
		unique("settlements_trip_id_id_uq").on(t.tripId, t.id),
		// CASCADE (0010), like expense_payment_payers_member_fk: a transfer
		// with one side gone means nothing.
		foreignKey({
			name: "settlements_from_member_fk",
			columns: [t.tripId, t.fromMemberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "settlements_to_member_fk",
			columns: [t.tripId, t.toMemberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		index("settlements_trip_live_idx")
			.on(t.tripId)
			.where(sql`${t.deletedAt} is null`),
		check(
			"settlements_ck",
			sql`${t.fromMemberId} <> ${t.toMemberId} and ${t.amountMinor} > 0`,
		),
		check(
			"settlements_currency_ck",
			sql`${t.currency} ~ ${CURRENCY_RE} and (${t.homeCurrency} is null or ${t.homeCurrency} ~ ${CURRENCY_RE})`,
		),
		check(
			"settlements_scope_ck",
			sql`num_nonnulls(${t.nodeId}, ${t.dayId}) <= 1`,
		),
	],
);

/**
 * Daily FX rates (ADDENDUM §7.3: a free no-key source covering every trip
 * currency, e.g. the fawazahmed0 currency-api; Frankfurter as a cross-check).
 * `rate` = units of `quote` per 1 `base` on `date`.
 */
export const fxRates = pgTable(
	"fx_rates",
	{
		date: date({ mode: "string" }).notNull(),
		base: text().notNull(),
		quote: text().notNull(),
		rate: numeric({ precision: 24, scale: 12, mode: "number" }).notNull(),
		source: text().notNull(),
		fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.date, t.base, t.quote] }),
		check(
			"fx_rates_ck",
			sql`${t.rate} > 0 and ${t.base} ~ ${CURRENCY_RE} and ${t.quote} ~ ${CURRENCY_RE}`,
		),
	],
);

/**
 * ADDENDUM §7.1 budget lines: (scope × category) → amount in the trip's home
 * currency. `member_id` null = the trip default (owner/editors); else that
 * member's own line (set only by that member). One line per combination.
 */
export const budgetLines = pgTable(
	"budget_lines",
	{
		id: pk(),
		tripId: tripRef(),
		/** Null = the trip root. */
		nodeId: uuid(),
		/** Null = all categories. */
		category: expenseCategory(),
		/** Null = trip default. */
		memberId: uuid(),
		amountMinor: minor().notNull(),
		kind: budgetKind().notNull().default("total"),
		/**
		 * Member lines only: the trip default's amount when this line was last set
		 * or its notice dismissed. A default that differs now shows "Trip default
		 * is now $3,500; yours stays $3,000 · Follow default" (ADDENDUM §7.1).
		 */
		defaultSeenMinor: minor(),
		createdBy: text().references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		unique("budget_lines_uq")
			.on(t.tripId, t.nodeId, t.category, t.memberId)
			.nullsNotDistinct(),
		foreignKey({
			name: "budget_lines_node_fk",
			columns: [t.tripId, t.nodeId],
			foreignColumns: [nodes.tripId, nodes.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "budget_lines_member_fk",
			columns: [t.tripId, t.memberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		index("budget_lines_member_idx").on(t.memberId),
		check("budget_lines_amount_ck", sql`${t.amountMinor} >= 0`),
		check(
			"budget_lines_default_seen_ck",
			sql`${t.defaultSeenMinor} is null or ${t.memberId} is not null`,
		),
	],
);

/**
 * Every member's trip-wide net position in the trip's home currency (integer
 * minor units; + = is owed), for the one inbox's "Balance changed since your
 * last settlement" item (ADDENDUM §7.3, EXTENSIONS §8.2). It follows the
 * money rules the WP-Money engine implements for the Money tab:
 *
 * - paid − owed, plus settlements (from += amount, to −= amount);
 * - only what was actually paid counts (each payment at its own home amount;
 *   several payers split a payment by their amounts); the unpaid remainder
 *   is planned and stays out of balances;
 * - what was paid is owed by the split: `equal` among the shares, `exact` in
 *   proportion to the share amounts, itemized lines by each person's
 *   subtotal (a line several people had splits equally; percentage and fixed
 *   fees are proportional to subtotals, so they don't change proportions);
 *   a refund splits back in its original's proportions;
 * - private expenses and points never enter balances (cash fees paid on a
 *   points booking are cash, so they do);
 * - rounding: largest remainder, leftover minor units to the payer, then by
 *   member order, so parts always sum exactly.
 *
 * Read-only and DB-only.
 */
import { sql } from "drizzle-orm";
import type { SqlExec } from "@/server/graph.server";

type Weights = Map<string, number>;

/** `total` split by `weights` (sum exact; leftover to `first`, then by key order). */
export function splitByWeights(
	total: number,
	weights: Weights,
	first: readonly string[] = [],
): Map<string, number> {
	const out = new Map<string, number>();
	const entries = [...weights].filter(([, w]) => w > 0);
	const sum = entries.reduce((s, [, w]) => s + w, 0);
	if (!entries.length || sum <= 0) return out;
	const sign = total < 0 ? -1 : 1;
	const abs = Math.abs(total);
	let given = 0;
	for (const [m, w] of entries) {
		const part = Math.floor((abs * w) / sum);
		out.set(m, part);
		given += part;
	}
	const order = [
		...first.filter((m) => out.has(m)),
		...entries.map(([m]) => m).filter((m) => !first.includes(m)),
	];
	for (let i = 0; given < abs; i++, given++) {
		const m = order[i % order.length] as string;
		out.set(m, (out.get(m) ?? 0) + 1);
	}
	if (sign < 0) for (const [m, v] of out) out.set(m, -v);
	return out;
}

type ExpenseRow = {
	id: string;
	splitMode: "equal" | "exact";
	refundOfId: string | null;
	createdAt: string;
};

export type TripNets = {
	/** The trip's home currency (`settings.currency`). */
	currency: string;
	/** memberId → net (home minor units; + = is owed). Members without money rows are absent. */
	nets: Record<string, number>;
};

export async function memberNets(
	exec: SqlExec,
	tripId: string,
): Promise<TripNets> {
	const rows = async <T>(q: ReturnType<typeof sql>) =>
		(await exec.execute(q)).rows as T[];
	const [trip] = await rows<{ currency: string | null }>(sql`
		select settings->>'currency' as currency from trips where id = ${tripId}`);
	const currency = trip?.currency ?? "USD";
	const expenses = await rows<ExpenseRow>(sql`
		select id::text as id, split_mode::text as "splitMode", refund_of_id::text as "refundOfId",
		       created_at as "createdAt"
		  from expenses
		 where trip_id = ${tripId} and deleted_at is null and not is_private
		 order by created_at, id`);
	const live = new Set(expenses.map((e) => e.id));
	const payments = await rows<{
		id: string;
		expenseId: string;
		amountMinor: number;
		currency: string;
		homeAmountMinor: number | null;
	}>(sql`
		select p.id::text as id, p.expense_id::text as "expenseId", p.amount_minor as "amountMinor",
		       p.currency, p.home_amount_minor as "homeAmountMinor"
		  from expense_payments p where p.trip_id = ${tripId}
		 order by p.paid_at, p.id`);
	const payers = await rows<{
		paymentId: string;
		memberId: string;
		amountMinor: number;
	}>(sql`
		select payment_id::text as "paymentId", member_id::text as "memberId", amount_minor as "amountMinor"
		  from expense_payment_payers where trip_id = ${tripId}
		 order by member_id`);
	const shares = await rows<{
		expenseId: string;
		memberId: string;
		amountMinor: number | null;
	}>(sql`
		select expense_id::text as "expenseId", member_id::text as "memberId", amount_minor as "amountMinor"
		  from expense_shares where trip_id = ${tripId}
		 order by member_id`);
	const lines = await rows<{
		expenseId: string;
		amountMinor: number;
		members: string[];
	}>(sql`
		select l.expense_id::text as "expenseId", l.amount_minor as "amountMinor",
		       coalesce(array_agg(lm.member_id::text order by lm.member_id)
		                filter (where lm.member_id is not null), '{}') as members
		  from expense_lines l left join expense_line_members lm on lm.line_id = l.id
		 where l.trip_id = ${tripId}
		 group by l.id, l.expense_id, l.amount_minor`);
	const settlements = await rows<{
		fromMemberId: string;
		toMemberId: string;
		amountMinor: number;
		currency: string;
		homeAmountMinor: number | null;
	}>(sql`
		select from_member_id::text as "fromMemberId", to_member_id::text as "toMemberId",
		       amount_minor as "amountMinor", currency, home_amount_minor as "homeAmountMinor"
		  from settlements where trip_id = ${tripId} and deleted_at is null`);

	const nets = new Map<string, number>();
	const add = (m: string, v: number) => nets.set(m, (nets.get(m) ?? 0) + v);
	const home = (amount: number, cur: string, homeAmount: number | null) =>
		homeAmount !== null && homeAmount !== undefined
			? Number(homeAmount)
			: cur === currency
				? Number(amount)
				: null;

	// Weights per expense (who owes what share of what was paid).
	const weightsOf = new Map<string, Weights>();
	for (const e of expenses) {
		const w: Weights = new Map();
		const itemized = lines.filter((l) => l.expenseId === e.id);
		if (itemized.length) {
			for (const l of itemized) {
				const n = l.members.length;
				for (const m of l.members)
					w.set(m, (w.get(m) ?? 0) + Number(l.amountMinor) / n);
			}
		} else {
			for (const s of shares.filter((x) => x.expenseId === e.id))
				w.set(
					s.memberId,
					e.splitMode === "exact" ? Math.max(Number(s.amountMinor ?? 0), 0) : 1,
				);
		}
		weightsOf.set(e.id, w);
	}

	const byExpense = new Map<string, typeof payments>();
	for (const p of payments) {
		if (!live.has(p.expenseId)) continue;
		const list = byExpense.get(p.expenseId) ?? [];
		list.push(p);
		byExpense.set(p.expenseId, list);
	}
	for (const e of expenses) {
		let paidHome = 0;
		const firstPayers: string[] = [];
		for (const p of byExpense.get(e.id) ?? []) {
			const h = home(p.amountMinor, p.currency, p.homeAmountMinor);
			if (h === null) continue;
			paidHome += h;
			const ps = payers.filter((x) => x.paymentId === p.id);
			const credit = splitByWeights(
				h,
				new Map(ps.map((x) => [x.memberId, Math.abs(Number(x.amountMinor))])),
			);
			for (const [m, v] of credit) {
				add(m, v);
				if (!firstPayers.includes(m)) firstPayers.push(m);
			}
		}
		if (paidHome === 0) continue;
		const weights =
			(e.refundOfId && weightsOf.get(e.refundOfId)?.size
				? weightsOf.get(e.refundOfId)
				: weightsOf.get(e.id)) ?? new Map();
		for (const [m, v] of splitByWeights(paidHome, weights, firstPayers))
			add(m, -v);
	}
	for (const s of settlements) {
		const h = home(s.amountMinor, s.currency, s.homeAmountMinor);
		if (h === null) continue;
		add(s.fromMemberId, h);
		add(s.toMemberId, -h);
	}
	return { currency, nets: Object.fromEntries(nets) };
}

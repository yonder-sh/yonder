/**
 * WP-Money client hooks: the trip's money (privacy-filtered by the server),
 * the view for the current scope or an inspector target, and the display
 * currency (ADDENDUM §7.2: original → home for all math → the viewer's
 * display currency, view-only, prefixed "≈"; "Local" inside a country).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { create } from "zustand";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import type { ListItemDto } from "@/features/lists/lists.functions";
import { tripListsQuery } from "@/features/lists/queries";
import { setUserPrefs } from "@/functions/prefs.functions";
import { mustRedact } from "@/lib/auth/roles";
import { currencyForCountry } from "@/lib/domain/currency";
import {
	balances,
	convertMinor,
	type EngineExpense,
	type ExpenseFacts,
	expenseFacts,
	formatMoney,
	formatMoneyShort,
	type MoneyCtx,
	type ScopeSummary,
	scopeSummary,
	settleUp,
	type Transfer,
} from "@/lib/engine/money";
import {
	expenseAnchor,
	inMoneyView,
	type MoneyAnchor,
	onTarget,
	scopeCountry,
} from "@/lib/engine/money-scope";
import { meKeys, tripKeys } from "@/lib/query/keys";
import { userPrefsQuery } from "@/lib/query/trip-queries";
import type { UserPrefs } from "@/lib/schemas/misc";
import type { BundleTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { ExpenseDto, MoneyDto } from "./money.functions";
import { tripMoneyQuery } from "./queries";
import { shoppingCosts, shoppingExpense } from "./shopping";

/**
 * Money for this trip: `listMoney` live, `scenario.money` in `/dev/fixture`
 * (loaded lazily, so the fixture never ships in the workspace chunk), and
 * nothing for guests (they never reach money).
 */
export function useMoneyData(): {
	data: MoneyDto | undefined;
	isLoading: boolean;
	isError: boolean;
	guest: boolean;
	/** Live and allowed (server queries may run). */
	enabled: boolean;
} {
	const { graph, mode } = useWorkspace();
	const guest = mustRedact(graph.me);
	const enabled = mode === "live" && !guest;
	const q = useQuery({ ...tripMoneyQuery(graph.trip.id), enabled });
	const fixture = useQuery({
		queryKey: ["fixture", "money"],
		queryFn: async (): Promise<MoneyDto> =>
			(await import("@/lib/fixtures/demo")).scenario.money,
		enabled: mode === "fixture" && !guest,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const live = mode === "live";
	return {
		data: guest ? undefined : live ? q.data : fixture.data,
		isLoading: !guest && (live ? q.isLoading : fixture.isLoading),
		isError: live ? q.isError : fixture.isError,
		guest,
		enabled,
	};
}

export type Row = {
	expense: ExpenseDto;
	facts: ExpenseFacts;
	anchor: MoneyAnchor;
};

/**
 * ADDENDUM §6 "shopping list link": an open shopping item with a rough price
 * and no expense yet shows as a planned cost (its assignees share it).
 */
export type ShoppingRow = {
	item: ListItemDto;
	amountMinor: number;
	currency: string;
	/** At home, at the latest rate (null = no rate). */
	homeMinor: number | null;
	anchor: MoneyAnchor;
};

export type MoneyView = {
	home: string;
	/** Planned costs from the shopping list (not yet bought or recorded). */
	shopping: ShoppingRow[];
	memberOrder: string[];
	ctx: MoneyCtx;
	/** Every visible expense (trip-wide), by id. */
	byId: ReadonlyMap<string, ExpenseDto>;
	/** The rows in view (scope/target), newest activity first. */
	rows: Row[];
	summary: ScopeSummary;
	/** Trip-wide balances (+ = is owed) and the minimal transfers. */
	net: Record<string, number>;
	transfers: Transfer[];
};

function sortKey(e: ExpenseDto): string {
	const paid = e.payments.at(-1)?.paidAt;
	return paid ?? (e.expectedOn ? `${e.expectedOn}T00:00:00Z` : e.createdAt);
}

/**
 * The money view: rows in the current scope (the Money tab: scope, "Only",
 * day range) or on one inspector `target`, their summary, and the trip-wide
 * balances.
 */
export function useMoneyView(target?: BundleTarget): MoneyView | null {
	const { data, enabled } = useMoneyData();
	const { ix, graph, scope, only, days } = useWorkspace();
	const lists = useQuery({ ...tripListsQuery(graph.trip.id), enabled });
	return useMemo(() => {
		if (!data) return null;
		const memberOrder = graph.members.map((m) => m.id);
		const byId = new Map(data.expenses.map((e) => [e.id, e]));
		const ctx: MoneyCtx = { memberOrder, byId };
		const rows: Row[] = [];
		for (const e of data.expenses) {
			const anchor = expenseAnchor(ix, e.target);
			const inView = target
				? onTarget(ix, e.target, target, anchor)
				: inMoneyView(
						ix,
						e.target,
						{ scopeId: scope?.id ?? null, only, days },
						anchor,
					);
			if (!inView) continue;
			rows.push({ expense: e, facts: expenseFacts(e, ctx), anchor });
		}
		rows.sort((a, b) => (sortKey(b.expense) < sortKey(a.expense) ? -1 : 1));
		// Shopping items with a rough price, not bought and not yet an expense.
		const linked = new Set(
			data.expenses.map((e) => e.listItemId).filter((id): id is string => !!id),
		);
		const shopping: ShoppingRow[] = [];
		for (const c of shoppingCosts(
			lists.data ?? [],
			linked,
			data.homeCurrency,
			data.latestRates,
		)) {
			const li = c.item;
			const anchor = expenseAnchor(ix, li.target);
			const inView = target
				? onTarget(ix, li.target, target, anchor)
				: inMoneyView(
						ix,
						li.target,
						{ scopeId: scope?.id ?? null, only, days },
						anchor,
					);
			if (inView) shopping.push({ ...c, anchor });
		}
		const virtual: EngineExpense[] = shopping.map(shoppingExpense);
		const summary = scopeSummary(
			[...rows.map((r) => r.expense), ...virtual],
			ctx,
		);
		const net = balances(
			data.expenses.filter((e) => !e.isPrivate),
			data.settlements,
			ctx,
		);
		return {
			home: data.homeCurrency,
			shopping,
			memberOrder,
			ctx,
			byId,
			rows,
			summary,
			net,
			transfers: settleUp(net),
		};
	}, [data, lists.data, ix, graph.members, scope?.id, only, days, target]);
}

// ---------------------------------------------------------------------------
// Display currency (ADDENDUM §7.2)
// ---------------------------------------------------------------------------

export type Display = {
	home: string;
	/** What totals are shown in (home, a chosen ISO code, or the scope's local currency). */
	code: string;
	/** The stored preference: ISO, "local", or null (= home). */
	pref: string | null;
	/** Display units per 1 home unit; null = no rate (show home). */
	rate: number | null;
	/** Converted from home (≈) or not. */
	converted: boolean;
	/** home minor → display string ("≈ ¥52,000" when converted, else "$346.67"). */
	fmt(homeMinor: number, opts?: { short?: boolean; approx?: boolean }): string;
	/** Always in home: "$346.67". */
	fmtHome(homeMinor: number, opts?: { short?: boolean }): string;
	/**
	 * A scope total: exact when the display currency is the one currency
	 * every cost was in (`ScopeSummary.original`), else `fmt` ("≈ …").
	 */
	fmtTotal(
		homeMinor: number,
		original: { currency: string; minor: number } | null | undefined,
		opts?: { short?: boolean; approx?: boolean },
	): string;
	/**
	 * QA MONEY-19: the scope's exact amounts in the display currency (shares,
	 * nets, categories) when every cost is in it and the display converts,
	 * so an equal ¥1,500 split reads ¥500 each, never ¥501 via home cents.
	 */
	exactOf(s: ScopeSummary | null | undefined): ExactAmounts | null;
	/** home minor → display minor. */
	toDisplay(homeMinor: number): number;
	/** Units of `code` per 1 home unit, from the latest rates. */
	rateTo(code: string): number | null;
};

export type ExactAmounts = NonNullable<ScopeSummary["original"]>;

export function useDisplayCurrency(): Display {
	const { data } = useMoneyData();
	const { ix, scope, mode } = useWorkspace();
	const prefs = useQuery({ ...userPrefsQuery(), enabled: mode === "live" });
	const home = data?.homeCurrency ?? ix.settings.currency ?? "USD";
	const pref = prefs.data?.displayCurrency ?? null;
	return useMemo(() => {
		const local =
			pref === "local"
				? currencyForCountry(scopeCountry(ix, scope?.id ?? null), "")
				: "";
		const code = pref === "local" ? local || home : (pref ?? home);
		const rateTo = (c: string): number | null => {
			if (c === home) return 1;
			const r = data?.latestRates?.[c];
			return r && Number.isFinite(r) && r > 0 ? r : null;
		};
		const rate = rateTo(code);
		const shown = rate === null ? home : code;
		const converted = shown !== home;
		const toDisplay = (m: number) =>
			converted && rate !== null ? convertMinor(m, home, shown, rate) : m;
		const fmtHome = (m: number, o: { short?: boolean } = {}) =>
			o.short ? formatMoneyShort(m, home) : formatMoney(m, home);
		const fmt: Display["fmt"] = (m, o = {}) => {
			const v = toDisplay(m);
			const s = o.short ? formatMoneyShort(v, shown) : formatMoney(v, shown);
			return converted && o.approx !== false ? `≈ ${s}` : s;
		};
		return {
			home,
			code: shown,
			pref,
			rate,
			converted,
			toDisplay,
			rateTo,
			fmtHome,
			fmt,
			fmtTotal: (m, original, o = {}) =>
				converted && original && original.currency === shown
					? o.short
						? formatMoneyShort(original.minor, shown)
						: formatMoney(original.minor, shown)
					: fmt(m, o),
			exactOf: (s) =>
				converted && s?.original && s.original.currency === shown
					? s.original
					: null,
		} satisfies Display;
	}, [pref, ix, scope?.id, home, data?.latestRates]);
}

export function useSetDisplayCurrency() {
	const qc = useQueryClient();
	const { graph } = useWorkspace();
	return useTripMutation(
		(displayCurrency: string | null) =>
			setUserPrefs({ data: { displayCurrency } }),
		{
			keys: [meKeys.prefs],
			tripId: graph.trip.id,
			optimistic: (_qc, displayCurrency) =>
				qc.setQueryData(meKeys.prefs, (p?: UserPrefs) => ({
					...(p ?? {}),
					displayCurrency,
				})),
		},
	);
}

/**
 * The original amount in its currency, plus "≈ display" when it differs (a
 * single expense). A PAID cost shows what its payments came to at home (each
 * at its paid date, or the manual rate), not the plan at today's rate.
 */
export function originalAndApprox(
	e: Pick<
		ExpenseDto,
		"amountMinor" | "currency" | "homeAmountMinor" | "status" | "payments"
	>,
	d: Display,
): { original: string | null; approx: string | null } {
	if (e.amountMinor === null || !e.currency)
		return { original: null, approx: null };
	const original = formatMoney(e.amountMinor, e.currency);
	const paidHome =
		e.status === "paid" &&
		e.payments.length > 0 &&
		e.payments.every((p) => p.homeAmountMinor !== null)
			? e.payments.reduce((a, p) => a + (p.homeAmountMinor ?? 0), 0)
			: null;
	const homeMinor = paidHome ?? e.homeAmountMinor;
	if (e.currency === d.code || homeMinor === null)
		return { original, approx: null };
	return {
		original,
		approx: `≈ ${formatMoney(d.toDisplay(homeMinor), d.code)}`,
	};
}

// ---------------------------------------------------------------------------
// Local UI state (settle-up; the editor opens through `useUi().openAddExpense`)
// ---------------------------------------------------------------------------

type MoneyUi = {
	settleOpen: boolean;
	openSettle(v: boolean): void;
};

export const useMoneyUi = create<MoneyUi>((set) => ({
	settleOpen: false,
	openSettle: (settleOpen) => set({ settleOpen }),
}));

/** The money keys every money mutation refreshes. */
export function moneyKeys(tripId: string) {
	return [
		tripKeys.money(tripId),
		tripKeys.counts(tripId),
		tripKeys.activity(tripId),
		meKeys.inbox,
	];
}

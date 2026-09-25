/**
 * ADDENDUM §6 "shopping list link" (pure, isomorphic): an open shopping item
 * with a rough price and no expense yet is a planned cost (its assignees
 * share it). One definition for the Money tab (`useMoneyView`) and the CSV
 * export, so both show the same totals.
 */
import {
	convertMinor,
	type EngineExpense,
	isKnownCurrency,
	toMinor,
} from "@/lib/engine/money";
import { MENTION_TOKEN_RE } from "@/lib/notes/mentions";
import type { BundleTarget } from "@/lib/schemas/targets";

/** One line of list Markdown → plain text for a title ("Custom pillow"). */
export function plainText(md: string): string {
	return md
		.replace(new RegExp(MENTION_TOKEN_RE.source, "gi"), "@$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`~]/g, "")
		.trim()
		.slice(0, 120);
}

/** The fields of a list item this needs (`ListItemDto` satisfies it). */
export type ShoppingItemLike = {
	id: string;
	list: string;
	status: string;
	target: BundleTarget;
	text: string;
	priceAmount: number | null;
	priceCurrency: string | null;
	isPrivate: boolean;
	assigneeIds: readonly string[];
};

export type ShoppingCost<T extends ShoppingItemLike = ShoppingItemLike> = {
	item: T;
	amountMinor: number;
	currency: string;
	/** At home, at the latest rate (null = no rate). */
	homeMinor: number | null;
};

/**
 * Open, priced shopping items that no expense links to yet. `rates` are the
 * latest `code → units per 1 home` (`MoneyDto.latestRates`).
 */
export function shoppingCosts<T extends ShoppingItemLike>(
	items: readonly T[],
	linkedIds: ReadonlySet<string>,
	home: string,
	rates: Readonly<Record<string, number>> | undefined,
): ShoppingCost<T>[] {
	const out: ShoppingCost<T>[] = [];
	for (const li of items) {
		if (li.list !== "shopping" || li.status !== "open" || linkedIds.has(li.id))
			continue;
		if (
			!li.priceAmount ||
			!li.priceCurrency ||
			!isKnownCurrency(li.priceCurrency)
		)
			continue;
		const amountMinor = toMinor(li.priceAmount, li.priceCurrency);
		const rate = li.priceCurrency === home ? 1 : rates?.[li.priceCurrency];
		out.push({
			item: li,
			amountMinor,
			currency: li.priceCurrency,
			homeMinor: rate
				? convertMinor(amountMinor, li.priceCurrency, home, 1 / rate)
				: null,
		});
	}
	return out;
}

/** A shopping cost as a planned expense for the summary engine. */
export function shoppingExpense(r: ShoppingCost): EngineExpense {
	return {
		id: `list:${r.item.id}`,
		category: "shopping",
		amountMinor: r.amountMinor,
		currency: r.currency,
		homeAmountMinor: r.homeMinor,
		splitMode: "equal",
		shares: r.item.assigneeIds.map((memberId) => ({
			memberId,
			amountMinor: null,
		})),
		lines: [],
		fees: [],
		payments: [],
		isPrivate: r.item.isPrivate,
		refundOfId: null,
		points: null,
	};
}

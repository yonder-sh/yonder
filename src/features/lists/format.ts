/** Small display helpers for list rows (pure, isomorphic). */
import { MENTION_TOKEN_RE } from "@/lib/notes/mentions";

/** One line of plain text from a row's Markdown (tokens → "@Name", no punctuation). */
export function plainOf(md: string): string {
	return (
		md
			.replace(
				new RegExp(MENTION_TOKEN_RE.source, "gi"),
				(_m, label: string) => `@${label.replace(/\\(.)/g, "$1")}`,
			)
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			// Markdown markup only: emphasis/code/strike markers and a leading # or >.
			.replace(/(\*\*|__|~~|`)/g, "")
			.replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$)/g, "$1$2")
			.replace(/^\s*(#{1,6}|>)\s+/, "")
			.replace(/\s+/g, " ")
			.trim()
	);
}

/** Decimal places of a currency's minor unit (JPY/KRW/VND 0, USD 2). */
export function minorDigits(currency: string): number {
	try {
		return (
			new Intl.NumberFormat("en", {
				style: "currency",
				currency,
			}).resolvedOptions().maximumFractionDigits ?? 2
		);
	} catch {
		return 2;
	}
}

/** "¥30,000", "$12.50", "₫250,000". */
export function formatPrice(amount: number, currency: string | null): string {
	if (!currency) return amount.toLocaleString("en");
	try {
		return new Intl.NumberFormat("en", {
			style: "currency",
			currency,
			currencyDisplay: "narrowSymbol",
			maximumFractionDigits: minorDigits(currency),
		}).format(amount);
	} catch {
		return `${amount} ${currency}`;
	}
}

/** A major-unit amount → integer minor units in `currency`. */
export function toMinorUnits(amount: number, currency: string): number {
	return Math.round(amount * 10 ** minorDigits(currency));
}

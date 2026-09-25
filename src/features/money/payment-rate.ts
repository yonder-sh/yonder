/**
 * ADDENDUM §7.3 "FX converts each payment at its own paid date" (pure): what
 * the editor's rate field shows for a payment with no rate of its own.
 */
import { formatDayDate } from "@/lib/format";

type SavedPayment = {
	id: string;
	currency: string;
	paidAt: string;
	paidTz: string;
	fxRate: number | null;
	fxDate: string | null;
	fxManual: boolean;
};

/** `YYYY-MM-DD` of an instant in a zone. */
function dateIn(iso: string, tz: string): string {
	const d = new Date(iso);
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

/**
 * The automatic rate (home per 1 unit of the payment's currency) and where it
 * comes from:
 * - a saved payment whose currency and paid date are unchanged: the rate it
 *   was converted at ("that day's rate", or "rate of 30 Jun" when the source
 *   had a gap);
 * - paid today or later: today's rate (the latest, `latestPerHome` = units of
 *   the currency per 1 home);
 * - an earlier date not saved yet: unknown here (the paid date's rate is
 *   looked up on save).
 */
export function autoPaymentRate(
	p: { id?: string; currency: string; date: string },
	saved: readonly SavedPayment[],
	latestPerHome: number | null,
	today: string,
): { rate: number | null; label: string } {
	const s = p.id ? saved.find((x) => x.id === p.id) : undefined;
	if (
		s &&
		!s.fxManual &&
		s.fxRate !== null &&
		s.currency === p.currency &&
		dateIn(s.paidAt, s.paidTz) === p.date
	)
		return {
			rate: s.fxRate,
			label:
				s.fxDate && s.fxDate !== p.date
					? `rate of ${formatDayDate(s.fxDate, { weekday: false })}`
					: "that day's rate",
		};
	if (p.date >= today)
		return {
			rate: latestPerHome ? 1 / latestPerHome : null,
			label: "today's rate",
		};
	return { rate: null, label: "that day's rate, set on save" };
}

/** A rate for a placeholder: 7 significant digits, no trailing zeros ("0.006142925"). */
export function formatRate(rate: number): string {
	return String(Number(rate.toPrecision(7)));
}

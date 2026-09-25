/**
 * Action Timeline → due-dated todos (SPEC §17.3 step 8, ADDENDUM §8 and §10).
 * Pure: parsing the sheet's "Time (ET)" text, the row → target and due-kind
 * mapping, and the RELATIVE booking-window rules whose semantics the sheet
 * documents (ADDENDUM §10 "booking windows that move").
 */
import type { DueKind } from "@/lib/schemas/enums";
import { normName } from "./text";

export const SHEET_TZ = "America/New_York";

/**
 * "8:00 PM" → 20:00, "End of day" → 23:59, "9:00 PM (eve before)" → 21:00
 * one day earlier. Unparseable or blank → no time.
 */
export function parseEtTime(
	text: string | null | undefined,
): { time: string; dayOffset: number } | null {
	if (!text) return null;
	const t = text.trim();
	const dayOffset = /\(eve(?:ning)? before\)/iu.test(t) ? -1 : 0;
	if (/^end of day\b/iu.test(t)) return { time: "23:59", dayOffset };
	const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/iu.exec(t);
	if (!m) return null;
	let h = Number(m[1]);
	const min = Number(m[2] ?? "0");
	if (h < 1 || h > 12 || min > 59) return null;
	const pm = m[3]?.toLowerCase() === "pm";
	if (h === 12) h = pm ? 12 : 0;
	else if (pm) h += 12;
	return {
		time: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
		dayOffset,
	};
}

/** `YYYY-MM-DD` ± days (calendar arithmetic, zone-free). */
export function addDaysIso(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` minus `months` calendar months; the day is `dayOfMonth` when
 * given, else the same day, clamped to the month's last day (WP-Lists'
 * `effectiveDue` uses the same rule).
 */
export function minusMonthsIso(
	date: string,
	months: number,
	dayOfMonth?: number,
): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const idx = y * 12 + (m - 1) - months;
	const ny = Math.floor(idx / 12);
	const nm = (idx % 12) + 1;
	const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
	const nd = Math.min(dayOfMonth ?? d, last);
	return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/** Absolute `dueDate`/`dueTime` from a sheet row (ET, the sheet's zone). */
export function absoluteDue(
	opens: string | null | undefined,
	timeEt: string | null | undefined,
): { dueDate: string | null; dueTime: string | null; dueTz: string | null } {
	const date = opens && /^\d{4}-\d{2}-\d{2}$/.test(opens) ? opens : null;
	if (!date) return { dueDate: null, dueTime: null, dueTz: null };
	const t = parseEtTime(timeEt);
	if (!t) return { dueDate: date, dueTime: null, dueTz: null };
	return {
		dueDate: addDaysIso(date, t.dayOffset),
		dueTime: t.time,
		dueTz: SHEET_TZ,
	};
}

// ---------------------------------------------------------------------------
// Row → target
// ---------------------------------------------------------------------------

/** Where an Action Timeline todo attaches (the SPEC §17.3 step 8 table). */
export type ActionTarget =
	| { kind: "root" }
	| { kind: "place"; name: string }
	| { kind: "node"; key: "ryokan" | "Kyoto" | "Japan" | "Sa Pa" | "Hoi An" }
	| { kind: "leg"; key: "fujiExcursion" };

/** The attraction name inside "Ghibli Park tickets", "JAL Sky Museum tour", "Shibuya Sky (sunset slot)". */
export function attractionName(what: string): string {
	const first = what.replace(/\([^)]*\)/gu, " ").split(/\s\+\s/u)[0] ?? what;
	return first
		.replace(/\b(tickets?|tour)\b/giu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function actionTarget(what: string, type: string | null): ActionTarget {
	const w = normName(what);
	if (w.startsWith("mt. fuji ryokan")) return { kind: "node", key: "ryokan" };
	if (w.startsWith("ryokan with private onsen (kyoto)"))
		return { kind: "node", key: "Kyoto" };
	if (w === "hotels — japan") return { kind: "node", key: "Japan" };
	if (w.startsWith("hotels — korea")) return { kind: "root" };
	if (w.startsWith("fuji excursion train"))
		return { kind: "leg", key: "fujiExcursion" };
	if (w.startsWith("hanoi ↔ lao cai") || w.startsWith("hanoi <-> lao cai"))
		return { kind: "node", key: "Sa Pa" };
	if (w.startsWith("hoi an tailors")) return { kind: "node", key: "Hoi An" };
	if (type === "Attraction")
		return { kind: "place", name: attractionName(what) };
	return { kind: "root" };
}

/**
 * E4 kind: a row whose note says DEADLINE is `due`; "Other" rows are things
 * to do on the day (`on`, "order on day 1 of the Hoi An block"); everything
 * else is a booking window that `opens`.
 */
export function actionDueKind(
	type: string | null,
	notes: string | null,
): DueKind {
	if (notes && /\bdeadline\b/iu.test(notes)) return "due";
	if (type === "Other") return "on";
	return "opens";
}

// ---------------------------------------------------------------------------
// Relative booking windows (ADDENDUM §10)
// ---------------------------------------------------------------------------

/** A relative window without its anchor item (the importer fills `itemId`). */
export type WindowRule =
	| { kind: "days"; days: number; time: string; tz: string }
	| {
			kind: "months";
			months: number;
			dayOfMonth?: number;
			time: string;
			tz: string;
	  };

export type KnownWindow = {
	rule: WindowRule;
	/** What the item anchor is: the attraction's own item, or the leg's departure item. */
	anchor: "place" | "leg" | "flight";
	/** For the report: where the rule comes from. */
	why: string;
};

/**
 * The windows whose semantics are known (ADDENDUM §10); every other row stays
 * absolute or TBD. `null` = no known rule for this row.
 */
export function knownWindow(
	what: string,
	type: string | null,
): KnownWindow | null {
	const w = normName(what);
	if (type === "Flight" && w.startsWith("ana ")) {
		return {
			rule: { kind: "days", days: 355, time: "09:00", tz: "Asia/Tokyo" },
			anchor: "flight",
			why: "ANA releases award seats 355 days out at 09:00 JST (sheet: 9 AM JST = 8 PM ET the evening before)",
		};
	}
	if (w.startsWith("fuji excursion train")) {
		return {
			rule: { kind: "months", months: 1, time: "10:00", tz: "Asia/Tokyo" },
			anchor: "leg",
			why: "JR East opens reserved seats at 10:00 JST one month before travel (sheet note)",
		};
	}
	if (w.startsWith("ghibli museum")) {
		return {
			rule: {
				kind: "months",
				months: 1,
				dayOfMonth: 10,
				time: "10:00",
				tz: "Asia/Tokyo",
			},
			anchor: "place",
			why: "released the month before (sheet); the museum sells the next month's tickets from the 10th at 10:00 JST",
		};
	}
	if (w.startsWith("jal sky museum")) {
		return {
			rule: { kind: "months", months: 1, time: "09:00", tz: "Asia/Tokyo" },
			anchor: "place",
			why: "reservations open ~1 month ahead (sheet; approximate, confirm the exact release time)",
		};
	}
	return null;
}

/** The date/time a relative rule gives for an anchor day (the snapshot stored next to the rule). */
export function resolveWindow(
	rule: WindowRule,
	anchorDate: string,
): { dueDate: string; dueTime: string; dueTz: string } {
	const dueDate =
		rule.kind === "days"
			? addDaysIso(anchorDate, -rule.days)
			: minusMonthsIso(anchorDate, rule.months, rule.dayOfMonth);
	return { dueDate, dueTime: rule.time, dueTz: rule.tz };
}

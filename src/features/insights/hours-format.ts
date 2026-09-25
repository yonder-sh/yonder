/**
 * Words for opening hours (DESIGN §12 voice: plain, short, 24-hour, mono
 * numbers): the week grid, the rules in words, the source line and the
 * sentence behind each issue. Pure.
 */
import {
	type EffectiveHours,
	type HoursIssue,
	shortDate,
	WEEKDAY_SHORT,
} from "@/lib/engine/hours";
import type {
	HoursException,
	HoursPeriod,
	OpeningHours,
} from "@/lib/schemas/hours";

export const WEEKDAY_LONG = [
	"Sundays",
	"Mondays",
	"Tuesdays",
	"Wednesdays",
	"Thursdays",
	"Fridays",
	"Saturdays",
];
const NTH = {
	1: "1st",
	2: "2nd",
	3: "3rd",
	4: "4th",
	5: "5th",
	[-1]: "last",
} as Record<number, string>;
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** Monday first, the way a week reads in every trip country. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export function rangeText(p: Pick<HoursPeriod, "open" | "close">): string {
	if (p.open === "00:00" && p.close === "24:00") return "Open 24h";
	return `${p.open}–${p.close}`;
}

export type WeekRow = {
	/** 0 Sun … 6 Sat, 7 holidays. */
	day: number;
	label: string;
	text: string;
	state: "open" | "closed" | "unknown" | "always";
	lastEntry?: string;
};

/**
 * One row per weekday (Mon first) plus a holidays row when day 7 has hours
 * or holidays are closed.
 */
export function weekRows(h: OpeningHours): WeekRow[] {
	const rows: WeekRow[] = [];
	const days: number[] = [...WEEK_ORDER];
	if (h.closedOnHolidays || h.periods.some((p) => p.day === 7)) days.push(7);
	for (const day of days) {
		const label = day === 7 ? "Holidays" : (WEEKDAY_SHORT[day] ?? "");
		if (day === 7 && h.closedOnHolidays) {
			rows.push({ day, label, text: "Closed", state: "closed" });
			continue;
		}
		if (h.alwaysOpen) {
			rows.push({ day, label, text: "Open 24h", state: "always" });
			continue;
		}
		const list = h.periods.filter((p) => p.day === day);
		if (list.length) {
			const lastEntry = list.find((p) => p.lastEntry)?.lastEntry;
			rows.push({
				day,
				label,
				text: list.map(rangeText).join(", "),
				state: "open",
				...(lastEntry ? { lastEntry } : {}),
			});
		} else if (
			h.closedDays?.includes(day) ||
			(h.periods.length > 0 && day !== 7)
		)
			rows.push({ day, label, text: "Closed", state: "closed" });
		else rows.push({ day, label, text: "—", state: "unknown" });
	}
	return rows;
}

export type WeekRun = {
	/** "Mon–Sat", "Sun", "Daily". */
	days: string;
	text: string;
	state: WeekRow["state"];
};

/**
 * The week as runs of equal days, Monday first: Mon–Sat 10:00–20:00 + Sun
 * 10:00–19:00; Daily 11:00–21:00; Daily Open 24h.
 */
export function weekRunRows(h: OpeningHours): WeekRun[] {
	if (h.alwaysOpen)
		return [{ days: "Daily", text: "Open 24h", state: "always" }];
	const rows = weekRows(h).filter((r) => r.day <= 6);
	const runs: { from: WeekRow; to: WeekRow }[] = [];
	for (const r of rows) {
		const last = runs.at(-1);
		if (last && last.to.text === r.text) last.to = r;
		else runs.push({ from: r, to: r });
	}
	return runs
		.filter((x) => x.from.state !== "unknown")
		.map((x) => ({
			days:
				runs.length === 1
					? "Daily"
					: x.from === x.to
						? x.from.label
						: `${x.from.label}–${x.to.label}`,
			text: x.from.text,
			state: x.from.state,
		}));
}

/** One run in words: "Mon–Sat 10:00–20:00", "Closed Wed", "Open 24h". */
export function runText(r: WeekRun): string {
	return r.state === "always"
		? r.text
		: r.state === "closed"
			? `Closed ${r.days}`
			: `${r.days} ${r.text}`;
}

/** ["Mon–Sat 10:00–20:00", "Sun 10:00–19:00"], ["Closed Wed"], ["Hours unknown"]. */
export function weekRuns(h: OpeningHours): string[] {
	const runs = weekRunRows(h);
	if (!runs.length) return ["Hours unknown"];
	return runs.map(runText);
}

/** `weekRuns` in one line: "Mon–Sat 10:00–20:00 · Sun 10:00–19:00". */
export const weekSummary = (h: OpeningHours): string => weekRuns(h).join(" · ");

/** "Closed 2nd Tue · Last entry 60 min before close". */
export function rulesInWords(
	eh: Pick<EffectiveHours, "hours" | "approxClosures">,
): string[] {
	const h = eh.hours;
	const out: string[] = [];
	for (const n of h.closedNth ?? [])
		out.push(`Closed ${NTH[n.nth] ?? ""} ${WEEKDAY_SHORT[n.day] ?? ""}`);
	if (h.lastEntryBeforeCloseMin)
		out.push(`Last entry ${h.lastEntryBeforeCloseMin} min before close`);
	if (!h.periods.length && !h.alwaysOpen && h.closedDays?.length)
		out.push(
			`Hours unknown · closed ${listJoin(h.closedDays.map((d) => WEEKDAY_LONG[d] ?? ""))}`,
		);
	for (const d of eh.approxClosures ?? [])
		out.push(`Maybe closed ${WEEKDAY_LONG[d] ?? ""} (unconfirmed)`);
	return out;
}

/** "Tue 5 Oct 2027": a special date with its year. */
export function dateWithYear(date: string): string {
	const s = shortDate(date);
	return s === date ? date : `${s} ${date.slice(0, 4)}`;
}

/** "Closed Tue 5 Oct 2027 · Sports day", "Tue 5 Oct 2027 10:00–15:00". */
export function exceptionText(e: HoursException): string {
	const d = dateWithYear(e.date);
	const what =
		e.closed || !e.periods?.length
			? `Closed ${d}`
			: `${d} ${e.periods.map(rangeText).join(", ")}`;
	return e.label ? `${what} · ${e.label}` : what;
}

export type HoursChange = { text: string; removed?: true };

export type HoursDiff = {
	/**
	 * The suggested week as runs when it differs from the current week (or
	 * there are no hours yet, or nothing else changed); null when the week
	 * stays the same.
	 */
	week: WeekRun[] | null;
	/** Special dates, holiday hours, rules and the note that are new or gone. */
	changes: HoursChange[];
};

const weekKey = (h: OpeningHours) =>
	JSON.stringify(
		weekRows(h)
			.filter((r) => r.day <= 6)
			.map((r) => [r.text, r.state, r.lastEntry ?? ""]),
	);
const exceptionKey = (e: HoursException) =>
	JSON.stringify([
		e.closed || !e.periods?.length,
		e.closed ? [] : (e.periods ?? []),
		e.label ?? "",
	]);

/**
 * What a suggested `node.hours` changes against the hours shown now
 * (COLLAB-R2-08): the week only when it differs, plus each special date,
 * holiday row, rule and note that is added, changed or removed, so a
 * suggestion that only closes one date reads "Closed Tue 5 Oct 2027".
 */
export function hoursDiff(
	before: OpeningHours | null | undefined,
	after: OpeningHours,
): HoursDiff {
	const changes: HoursChange[] = [];
	let week: WeekRun[] | null = null;
	if (!before || weekKey(before) !== weekKey(after)) {
		week = weekRunRows(after);
		if (!week.length && before && weekRunRows(before).length)
			changes.push({ text: "Hours unknown" });
	}
	// Holiday hours (day 7).
	const hol = (h: OpeningHours | null | undefined) =>
		h ? weekRows(h).find((r) => r.day === 7) : undefined;
	const hb = hol(before);
	const ha = hol(after);
	if (ha && (hb?.text !== ha.text || hb?.lastEntry !== ha.lastEntry))
		changes.push({ text: `Holidays ${ha.text}` });
	else if (hb && !ha)
		changes.push({ text: `Holidays ${hb.text}`, removed: true });
	// Special dates, in date order.
	const eb = new Map((before?.exceptions ?? []).map((e) => [e.date, e]));
	const ea = new Map((after.exceptions ?? []).map((e) => [e.date, e]));
	const dates = [...new Set([...eb.keys(), ...ea.keys()])].sort();
	for (const date of dates) {
		const b = eb.get(date);
		const a = ea.get(date);
		if (a && (!b || exceptionKey(a) !== exceptionKey(b)))
			changes.push({ text: exceptionText(a) });
		else if (b && !a) changes.push({ text: exceptionText(b), removed: true });
	}
	// Rules ("Closed 2nd Tue", "Last entry 60 min before close").
	const rb = before ? rulesInWords({ hours: before }) : [];
	const ra = rulesInWords({ hours: after });
	for (const r of ra) if (!rb.includes(r)) changes.push({ text: r });
	for (const r of rb)
		if (!ra.includes(r)) changes.push({ text: r, removed: true });
	// The note.
	const nb = before?.note?.trim() || "";
	const na = after.note?.trim() || "";
	if (na && na !== nb) changes.push({ text: `Note: ${na}` });
	else if (nb && !na) changes.push({ text: `Note: ${nb}`, removed: true });
	if (!week && !changes.length) week = weekRunRows(after);
	return { week, changes };
}

/** `hoursDiff` in one line, for the suggestion's accessible description. */
export function hoursDiffText(d: HoursDiff): string {
	const parts = [
		...(d.week ?? []).map(runText),
		...d.changes.map((c) => (c.removed ? `Removes “${c.text}”` : c.text)),
	];
	return parts.length ? parts.join(" · ") : "Hours unknown";
}

export function listJoin(xs: readonly string[]): string {
	if (xs.length <= 1) return xs.join("");
	return `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

/** "3 Sep" of an ISO instant (the day part only; never a host-zone conversion). */
export function shortIsoDay(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const SOURCE_NAME = {
	google: "Google",
	manual: "Manual",
	osm: "OpenStreetMap",
} as const;

/**
 * The source line under the hours: "Manual · 3 Sep", "Google · 3 Sep",
 * "OpenStreetMap · 3 Sep", "From the sheet". (OSM hours show it with their
 * links and attribution: `OsmHoursSource`.)
 */
export function sourceLabel(eh: EffectiveHours): string {
	if (eh.source === "sheet") return "From the sheet";
	const day = shortIsoDay(eh.hours.updatedAt);
	return `${SOURCE_NAME[eh.source]}${day ? ` · ${day}` : ""}`;
}

/** The sentence a tooltip shows for one issue. */
export function issueSentence(
	issue: HoursIssue,
	ctx: { place: string; start?: string; end?: string; weekday?: string },
): string {
	const approx = issue.hedged ? "about " : "";
	switch (issue.kind) {
		case "closed": {
			const rest = issue.label.replace(/^Closed\s*/, "");
			if (rest.startsWith("· "))
				return `${ctx.place} is closed that day (${rest.slice(2)}).`;
			const nth = /^(1st|2nd|3rd|4th|5th|last) (\w+)$/.exec(rest);
			if (nth)
				return `${ctx.place} is closed on the ${nth[1]} ${ctx.weekday?.replace(/s$/, "") ?? nth[2]} of the month.`;
			if (/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/.test(rest))
				return `${ctx.place} is closed on ${ctx.weekday ?? rest}.`;
			return `${ctx.place} is closed on ${rest}.`;
		}
		case "after_close":
			return issue.label.startsWith("Last entry")
				? `Last entry is ${approx}${issue.label.replace(/^Last entry ~?/, "")}${ctx.start ? `; this visit starts at ${ctx.start}` : ""}.`
				: `${ctx.place} closes at ${approx}${issue.close ?? ""}${ctx.start ? `; this visit starts at ${ctx.start}` : ""}.`;
		case "closes_during":
			return `${ctx.place} closes at ${approx}${issue.close ?? ""}${ctx.end ? `, before this visit ends at ${ctx.end}` : ""}.`;
		case "before_open":
			return `Opens at ${approx}${issue.open ?? ""}${ctx.start ? `; this visit starts at ${ctx.start}` : ""}.`;
		case "maybe_closed":
			return `Some sources say ${ctx.place} is closed on ${ctx.weekday ?? "this day"}. Worth checking.`;
		case "after_dark":
			return `${issue.label.replace("After dark · sunset", "Sunset is at")}, so it will be dark.`;
	}
}

/** "Itoya closed Wed" / "Itoya closes 19:00" for the day header chip. */
export function dayChipLabel(place: string, issue: HoursIssue): string {
	return `${place} ${issue.label.charAt(0).toLowerCase()}${issue.label.slice(1).replace(/ · .*$/, "")}`;
}

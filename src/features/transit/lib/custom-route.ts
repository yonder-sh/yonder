/**
 * Custom route builder rules (DESIGN §8.2; QA TR-07, MT-05), pure so they
 * can be tested without the form:
 *
 * - a picked N02 station is stored as "Shinjuku (新宿)", like estimate stops;
 * - the rail look-up after both stations are picked fills the minutes, stops
 *   and track shape, but never replaces what the person wrote: a typed line
 *   name ("Fuji Excursion 7") keeps its own chip, operator and colour instead
 *   of the network's guess ("JR Chuo").
 */
import type { LineString, TransitSegment } from "@/lib/schemas/legs";

/** "Shinjuku (新宿)" — English first when the network knows it. */
export function stationLabel(s: { name: string; nameEn?: string }): string {
	return (s.nameEn ? `${s.nameEn} (${s.name})` : s.name).slice(0, 200);
}

/** The ride fields of a builder step that a rail look-up may fill. */
export type RideFields = {
	mode: string;
	line: string;
	lineShort?: string;
	/** Set when the line was picked from the N02 list (not typed). */
	lineKey?: string;
	agency?: string;
	color?: string;
	textColor?: string;
	minutes: string;
	/** The minutes came from the rail network (overwritten on a new pick). */
	autoMinutes?: boolean;
	stopCount?: number;
	geometry?: LineString;
};

/** Merges a `railRide` answer into a step (see the file header). */
export function mergeRide<S extends RideFields>(
	s: S,
	r: { segment: TransitSegment; durationMin: number },
): S {
	const typedLine = s.line.trim() !== "" && !s.lineKey;
	const keepMinutes = s.minutes !== "" && !s.autoMinutes;
	const seg = r.segment;
	return {
		...s,
		mode: s.mode === "train" ? seg.mode : s.mode,
		line: s.line || (seg.lineName ?? ""),
		lineShort: typedLine ? s.lineShort : (s.lineShort ?? seg.lineShort),
		agency: typedLine ? s.agency : (s.agency ?? seg.agency),
		color: typedLine ? s.color : (s.color ?? seg.color),
		textColor: typedLine ? s.textColor : (s.textColor ?? seg.textColor),
		stopCount: seg.stopCount,
		geometry: seg.geometry,
		minutes: keepMinutes ? s.minutes : String(r.durationMin),
		autoMinutes: keepMinutes ? s.autoMinutes : true,
	} as S;
}

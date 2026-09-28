/**
 * Today's words (boards P15–P18): "35 min behind", "Leave by 16:40 · 5 min
 * walk", "Tight before Bar Benfiddich · 20:00, booked", "Shorten dinner to
 * 1 h". Pure; times in the stop's own zone.
 */
import type {
	TodayFix,
	TodayPace,
	TodayRisk,
	TodayStop,
} from "@/lib/engine/today";
import type { LegMode } from "@/lib/engine/types";
import { formatTime } from "@/lib/format";

/** 35 → "35 min", 60 → "1 h", 160 → "2 h 40". */
export function spokenMin(minutes: number): string {
	const m = Math.max(0, Math.round(minutes));
	const h = Math.floor(m / 60);
	const r = m % 60;
	if (!h) return `${r} min`;
	return r ? `${h} h ${String(r).padStart(2, "0")}` : `${h} h`;
}

/** "35 min behind", "30 min ahead", "On time". */
export function paceLabel(pace: TodayPace): string {
	if (pace.kind === "on_time") return "On time";
	return `${spokenMin(pace.minutes)} ${pace.kind}`;
}

/** "5 min walk", "20 min by transit", "15 min by car" (on foot when unknown). */
export function travelWords(minutes: number, mode: LegMode | null): string {
	const t = spokenMin(minutes);
	if (mode === "walk" || !mode) return `${t} walk`;
	if (mode === "other") return `${t} by car`;
	return `${t} by transit`;
}

/** The travel into a stop: "5 min walk", "20 min by transit", "Nozomi 7 at 10:03" (where you board). */
export function travelLine(stop: TodayStop): string | null {
	const d = stop.departure;
	if (d) return `${d.name} at ${formatTime(d.depMs, d.tz)}`;
	if (!stop.travelMin) return null;
	return travelWords(stop.travelMin, stop.mode);
}

/** A custom stop's title reads as a word in a sentence ("Shorten dinner"); a place keeps its name. */
export function inSentence(name: string, isPlace: boolean): string {
	return isPlace ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

/** "Shorten dinner to 1 h", "Skip Bic Camera". */
export function fixLabel(fix: TodayFix, isPlace: boolean): string {
	const name = inSentence(fix.name, isPlace);
	return fix.kind === "shorten"
		? `Shorten ${name} to ${spokenMin(fix.toMin)}`
		: `Skip ${name}`;
}

/** "Tight before Bar Benfiddich · 20:00, booked", "Late for NH 9 · leaves 10:30". */
export function riskTitle(risk: TodayRisk): string {
	const lead = risk.late ? "Late for" : "Tight before";
	const at = risk.departure
		? `leaves ${formatTime(risk.departure.depMs, risk.tz)}`
		: `${formatTime(risk.at, risk.tz)}${risk.booked ? ", booked" : ""}`;
	return `${lead} ${risk.name} · ${at}`;
}

/** "You'd arrive 19:55: 5 min spare instead of 40." / "You'd arrive 20:10: 10 min late." */
export function riskLine(risk: TodayRisk): string {
	const arrive = formatTime(risk.arrive, risk.tz);
	if (risk.late)
		return `You'd arrive ${arrive}: ${spokenMin(-risk.spareMin)} late.`;
	const planned =
		risk.plannedSpareMin < 60
			? String(risk.plannedSpareMin)
			: spokenMin(risk.plannedSpareMin);
	return `You'd arrive ${arrive}: ${spokenMin(risk.spareMin)} spare instead of ${planned}.`;
}

/** The stop's time moved from the plan (to the minute, as shown). */
export function moved(stop: TodayStop): boolean {
	return (
		formatTime(stop.start, stop.tz) !== formatTime(stop.plannedStart, stop.tz)
	);
}

import { cn } from "cn";
import { flightTimes } from "@/lib/engine/flights";
import type { GraphLeg, ScheduledLeg } from "@/lib/engine/types";
import { formatDistance, formatDuration, formatFlight } from "@/lib/format";
import { type LegDetails, readLegDetails } from "@/lib/schemas/legs";
import { TESTID } from "@/lib/testids";
import { LineChip, ModeGlyph } from "./glyphs";

export { flightOwnMinutes } from "@/lib/engine/flights";

/**
 * A leg's line chips (up to `max`), else its label as one neutral chip: a
 * manual route "Shiraito → Shin-Fuji → Nagoya" or an `other` leg "Bus →
 * Shiraito Falls". Nothing for flights or legs without either.
 */
export function LegChips({
	details,
	max = 3,
}: {
	details: LegDetails | null;
	max?: number;
}) {
	const lines =
		details?.kind === "transit"
			? (details.route?.segments ?? []).filter((s) => s.lineShort ?? s.lineName)
			: [];
	const label =
		lines.length > 0
			? null
			: details?.kind === "transit"
				? (details.route?.label ?? null)
				: details?.kind === "other"
					? (details.label ?? null)
					: null;
	return (
		<>
			{lines.slice(0, max).map((s) => (
				<LineChip
					key={`${s.lineShort ?? s.lineName}:${s.from?.name ?? ""}:${s.departAt ?? ""}`}
					name={s.lineShort ?? s.lineName ?? ""}
					color={s.color}
					textColor={s.textColor}
				/>
			))}
			{label ? (
				<span
					data-testid={TESTID.legSummaryLabel}
					className="max-w-[16rem] truncate rounded-sm border border-border px-1 text-[11px] leading-4 text-foreground"
				>
					{label}
				</span>
			) : null}
		</>
	);
}

/**
 * One leg in one line (SPEC §12.6): mode glyph, minutes ("est." when
 * computed), distance, line chips, flight number. Used by Plan rows, ghosts,
 * bands, inspectors and map tooltips. A flight names its own time ("NH 9
 * JFK→HND 14h", as on the ticket), never the plan's total with the airport
 * time around it (QA VIS3-05).
 */
export function LegSummary({
	leg,
	schedule,
	compact,
	className,
}: {
	leg: GraphLeg | null;
	schedule?: ScheduledLeg | null;
	compact?: boolean;
	className?: string;
}) {
	const details = leg ? readLegDetails(leg.details) : null;
	// A flight's own time; without both times the great-circle estimate (FB-18).
	const flight =
		details?.kind === "flight" ? flightTimes(details.flight) : null;
	const minutes =
		flight?.minutes ??
		schedule?.minutes ??
		leg?.durationMin ??
		leg?.estimateMin ??
		null;
	const estimate = flight
		? flight.estimate
		: (schedule?.estimate ??
			(leg
				? leg.durationMin === null ||
					(leg.source === "estimate" && !leg.isEdited)
				: true));
	const unset = !leg?.mode;
	return (
		<span
			className={cn(
				"inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground",
				className,
			)}
		>
			<ModeGlyph mode={leg?.mode ?? null} />
			{unset && schedule?.suggestion?.estimateMin == null ? (
				<span>Not set</span>
			) : null}
			{unset && schedule?.suggestion?.estimateMin != null ? (
				// DESIGN §7.1 "Estimate (unset) leg": the estimated minutes with
				// "est." (the suggested mode is offered by the accept chips).
				<span className="font-mono tnum">
					~{formatDuration(schedule.suggestion.estimateMin, { compact })} est.
				</span>
			) : null}
			{!unset && details?.kind === "flight" ? (
				<span className="truncate">{formatFlight(details.flight)}</span>
			) : null}
			{!unset && !compact ? <LegChips details={details} /> : null}
			{!unset && minutes !== null ? (
				<span className="font-mono tnum">
					{flight?.estimate ? "~" : ""}
					{formatDuration(minutes, { compact })}
					{estimate ? " est." : ""}
				</span>
			) : null}
			{!unset && !compact && flight?.untimed ? <span>times TBD</span> : null}
			{!unset && !compact && leg?.distanceM ? (
				<span className="font-mono tnum">{formatDistance(leg.distanceM)}</span>
			) : null}
		</span>
	);
}

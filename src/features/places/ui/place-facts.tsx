/**
 * Small read-only facts about a place, shared by the rate screen and the
 * overview: the Time Needed chip (the cool ramp, CATEGORIES.md §5), the
 * category chip, a compact opening-hours summary, and "where it is on the
 * plan".
 */
import { cn } from "cn";
import type { CSSProperties } from "react";
import { CategoryDot, TypeGlyph } from "@/components/common/glyphs";
import {
	NODE_TYPES,
	PLACE_CATEGORIES,
	TIME_NEEDED,
	timeNeededOf,
} from "@/lib/domain/taxonomy";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { effectiveHours } from "@/lib/engine/hours";
import type { GraphNode } from "@/lib/engine/types";
import { formatDayDate, formatDuration } from "@/lib/format";
import { occurrencesOf } from "../lib/node-facts";

export function TimeNeededChip({
	minutes,
	className,
}: {
	minutes: number | null;
	className?: string;
}) {
	const key = timeNeededOf(minutes);
	if (!key || minutes === null) return null;
	const t = TIME_NEEDED[key];
	return (
		<span
			title={`Time needed: ${formatDuration(minutes)}`}
			style={
				{
					"--tn-bg": t.light.bg,
					"--tn-fg": t.light.fg,
					"--tn-bg-d": t.dark.bg,
					"--tn-fg-d": t.dark.fg,
				} as CSSProperties
			}
			className={cn(
				"inline-flex h-[22px] items-center rounded-full px-2 text-xs font-medium whitespace-nowrap",
				"bg-[var(--tn-bg)] text-[var(--tn-fg)] dark:bg-[var(--tn-bg-d)] dark:text-[var(--tn-fg-d)]",
				className,
			)}
		>
			{t.label}
		</span>
	);
}

export function KindChip({
	node,
	className,
}: {
	node: GraphNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-[22px] items-center gap-1.5 rounded-full bg-muted px-2 text-xs whitespace-nowrap",
				className,
			)}
		>
			{node.type === "place" ? (
				<CategoryDot category={node.category ?? "other"} />
			) : (
				<TypeGlyph type={node.type} className="size-3" />
			)}
			{node.type === "place"
				? PLACE_CATEGORIES[node.category ?? "other"].label
				: NODE_TYPES[node.type].label}
		</span>
	);
}

const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A compact week of opening hours (structured when known, else the text we have). */
export function HoursSummary({
	node,
	ix,
	className,
}: {
	node: GraphNode;
	ix: GraphIndex;
	className?: string;
}) {
	const eff = effectiveHours(node, ix.trip.settings);
	if (eff?.hours) {
		const h = eff.hours;
		if (h.alwaysOpen)
			return <p className={cn("text-[13px]", className)}>Open 24 hours</p>;
		if (h.periods.length) {
			return (
				<dl
					className={cn(
						"grid grid-cols-[36px_1fr] gap-x-2 gap-y-0.5 font-mono text-xs tnum",
						className,
					)}
				>
					{WEEK.map((d) => {
						const ps = h.periods.filter((p) => p.day === d);
						const closed = !ps.length || h.closedDays?.includes(d as number);
						return (
							<div key={d} className="contents">
								<dt className="text-muted-foreground">{DAY_NAMES[d]}</dt>
								<dd className={cn(closed && "text-muted-foreground")}>
									{closed
										? "Closed"
										: ps.map((p) => `${p.open}–${p.close}`).join(", ")}
								</dd>
							</div>
						);
					})}
				</dl>
			);
		}
	}
	const weekdays = node.details.hours?.weekdayDescriptions;
	if (weekdays?.length)
		return (
			<ul
				className={cn("grid gap-0.5 text-xs text-muted-foreground", className)}
			>
				{weekdays.map((l) => (
					<li key={l}>{l}</li>
				))}
			</ul>
		);
	if (node.details.openHoursText)
		return (
			<p className={cn("text-[13px] text-foreground/90", className)}>
				{node.details.openHoursText}
			</p>
		);
	return null;
}

/** "Day 4 · Thu 7 Oct" (+2 more) or null when it's only an idea. */
export function scheduledLabel(ix: GraphIndex, nodeId: string): string | null {
	const occ = occurrencesOf(ix, nodeId);
	const first = occ[0];
	const day = first ? ix.day(first.dayId) : undefined;
	if (!first || !day) return null;
	const more = occ.length > 1 ? ` (+${occ.length - 1})` : "";
	return `Day ${ix.dayNumber(day.id)} · ${formatDayDate(day.date)}${more}`;
}

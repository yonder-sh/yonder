/**
 * A day with nothing on it, in a list of days: one line, "Sat 19 Oct ·
 * Nothing planned · + Add". The date selects the day (its full header then
 * shows); the line stays a drop target (its `DaySection` is the droppable).
 */
import { isIdea } from "@/features/outline/ideas";
import { dayWhere } from "@/lib/engine/day-place";
import type { GraphDay } from "@/lib/engine/types";
import { formatDayDate } from "@/lib/format";
import { copyAnchorId } from "@/lib/realtime/cursor-protocol";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { AddMenu } from "./AddMenu";
import { dayCity } from "./DayHeader";
import { PLAN_TESTID } from "./testids";

export function EmptyDayLine({
	day,
	over,
	copy,
}: {
	day: GraphDay;
	/** A card or place is dragged over it. */
	over: boolean;
	copy?: string;
}) {
	const { ix, nav } = useWorkspace();
	const n = ix.dayNumber(day.id);
	const city = dayCity(ix, day.id);
	const cityId = dayWhere(ix, day.id).placeId;
	const ideas = cityId
		? ix.outline.filter((node) => isIdea(ix, node, cityId)).length
		: 0;
	return (
		<div
			data-testid={PLAN_TESTID.dayEmpty}
			data-day-id={day.id}
			data-cursor-anchor={copyAnchorId(`dayh:${day.id}`, copy)}
			className={cn(
				"mx-2 flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-transparent px-2 text-meta transition-colors",
				over && "border-dashed border-primary bg-primary/5",
			)}
		>
			<button
				type="button"
				onClick={() => nav.select({ kind: "day", id: day.id })}
				aria-label={`${formatDayDate(day.date)}, Day ${n}`}
				title="Show this day"
				className="shrink-0 rounded-sm font-medium tnum outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
			>
				{formatDayDate(day.date)}
			</button>
			<span className="min-w-0 truncate text-muted-foreground">
				{over ? (
					"Drop to plan it here"
				) : (
					<>
						<span className="max-sm:hidden">
							Day <span className="tnum">{n}</span>
							{city ? ` · ${city}` : ""} ·{" "}
						</span>
						Nothing planned
					</>
				)}
			</span>
			<span className="ml-auto flex shrink-0 items-center gap-1">
				{ideas > 0 && !over ? (
					<button
						type="button"
						onClick={() => nav.fillDay(day.date)}
						aria-label={`Fill ${formatDayDate(day.date)} from ${ideas} ${ideas === 1 ? "idea" : "ideas"}`}
						className="rounded-sm px-1.5 text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
					>
						<span className="tnum">{ideas}</span>{" "}
						{ideas === 1 ? "idea" : "ideas"}
					</button>
				) : null}
				<AddMenu
					dayId={day.id}
					variant="row"
					label="Add"
					ariaLabel="Add to this day"
					className="h-7 px-2"
				/>
			</span>
		</div>
	);
}

/**
 * One Yonder (D02): the Plan without a day in view lists its days, one row
 * each (date, city and title, the first stops, how many), under their
 * country or city. A row opens its day; an empty one offers its ideas.
 */
import { Plane, Plus } from "lucide-react";
import { Chip } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { isIdea } from "@/features/outline/ideas";
import { dayWhere } from "@/lib/engine/day-place";
import { formatDayDate, formatDayShort } from "@/lib/format";
import { copyAnchorId } from "@/lib/realtime/cursor-protocol";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { dayCity, titleBesideCity } from "./DayHeader";
import { PLAN_TESTID } from "./testids";
import { itemName } from "./use-plan-actions";

const SHOWN = 4;

export function DayRow({
	dayId,
	only = null,
	copy,
}: {
	dayId: string;
	/** A day in two bands: this band's stops. */
	only?: ReadonlySet<string> | null;
	/** That drawing's anchor copy (`copyAnchorId`). */
	copy?: string;
}) {
	const { ix, sel, nav } = useWorkspace();
	const day = ix.day(dayId);
	if (!day) return null;
	const n = ix.dayNumber(dayId);
	const all = ix.itemsByDay.get(dayId) ?? [];
	const items = only ? all.filter((i) => only.has(i.id)) : all;
	const empty = items.length === 0;
	// The one rule: where you sleep ("Tokyo → Kyoto" on a travel day).
	const cityId = dayWhere(ix, dayId).placeId;
	const city = dayCity(ix, dayId);
	const names = items.map((i) => itemName(ix, i));
	const more = names.length - SHOWN;
	const flight = items.some((i) => ix.node(i.nodeId)?.category === "airport");
	const ideas =
		empty && cityId
			? ix.outline.filter((node) => isIdea(ix, node, cityId)).length
			: 0;
	const selected = sel?.kind === "day" && sel.id === dayId;
	const open = () => nav.setDays({ from: day.date, to: day.date });
	const fill = () => nav.fillDay(day.date);
	const [weekday, date] = formatDayShort(day.date).split(" ");
	return (
		<div
			data-testid={PLAN_TESTID.dayRow}
			data-day-id={dayId}
			// The day's own anchor: a cursor here lands on that day's section at a finer lens.
			data-cursor-anchor={copyAnchorId(`day:${dayId}`, copy)}
			className={cn(
				"flex min-h-14 items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
				empty ? "border-dashed" : "bg-card hover:border-foreground/20",
				selected && "border-primary bg-primary/5",
			)}
		>
			<button
				type="button"
				onClick={open}
				aria-label={`${formatDayDate(day.date)}, Day ${n}: open the day`}
				className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span className="flex w-9 shrink-0 flex-col items-center leading-none">
					<span className="text-2xs font-medium text-muted-foreground uppercase">
						{weekday}
					</span>
					<span className="font-display text-xl leading-6 font-semibold tnum">
						{date}
					</span>
				</span>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="flex min-w-0 items-baseline gap-2">
						<span className="shrink-0 font-semibold">{city ?? `Day ${n}`}</span>
						<span className="min-w-0 truncate text-muted-foreground">
							{titleBesideCity(day.title, city ?? null) ??
								(empty ? "No stops yet" : "")}
						</span>
					</span>
					{empty ? null : (
						<span className="truncate text-meta text-muted-foreground">
							{names.slice(0, SHOWN).join(" · ")}
							{more > 0 ? ` · +${more}` : ""}
						</span>
					)}
					{ideas > 0 ? (
						<span className="text-meta text-primary">
							{ideas} {ideas === 1 ? "idea" : "ideas"} in{" "}
							{ix.node(cityId)?.name}
						</span>
					) : null}
				</span>
			</button>
			{flight ? (
				<Chip size="sm" className="shrink-0">
					<Plane aria-hidden />
					flight
				</Chip>
			) : null}
			{empty ? (
				ideas > 0 ? (
					<Button
						variant="outline"
						size="sm"
						className="shrink-0"
						onClick={fill}
					>
						<Plus />
						Fill this day
					</Button>
				) : null
			) : (
				<span className="shrink-0 text-meta text-muted-foreground tnum">
					{items.length} {items.length === 1 ? "stop" : "stops"}
				</span>
			)}
		</div>
	);
}

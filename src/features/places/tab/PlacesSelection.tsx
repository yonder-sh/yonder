/**
 * The table's selection bar (One Yonder D06): the ticked places' count and
 * names, then Add to day… · Rate… · Not going (Bring back when they're all
 * out) · ✕. Each acts on every ticked place and clears the ticks.
 */
import { CalendarPlus, Star, X } from "lucide-react";
import { RatingMenu } from "@/components/kit";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { SchedulePicker } from "../ui/schedule-picker";
import type { PlaceRow } from "./model";
import { PLACES_TAB_TESTID } from "./testids";
import { usePlaceActions } from "./use-place-actions";

export function PlacesSelectionBar({
	rows,
	onClear,
}: {
	/** The ticked places on show. */
	rows: PlaceRow[];
	onClear: () => void;
}) {
	const { ix, schedule } = useWorkspace();
	const act = usePlaceActions();
	if (!rows.length) return null;
	const out = rows.every((r) => r.status === "dropped");
	const onBar =
		"border-background/25 bg-transparent text-background hover:bg-background/15 hover:text-background";
	return (
		<div
			data-testid={PLACES_TAB_TESTID.selectionBar}
			className="absolute inset-x-4 bottom-4 z-[3] flex flex-wrap items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-background shadow-float sm:inset-x-6"
		>
			<span className="shrink-0 font-semibold tnum">
				{rows.length} selected
			</span>
			<span className="min-w-0 flex-1 truncate text-meta opacity-80">
				{rows.map((r) => r.name).join(", ")}
			</span>
			{ix.days.length && !out ? (
				<SchedulePicker
					ix={ix}
					schedule={schedule}
					allowUnscheduled={false}
					onPick={async (p) => {
						if (!p.dayId) return;
						for (const r of rows) await act.addToDay(r, p.dayId, p.label);
						onClear();
					}}
				>
					<Button
						size="sm"
						disabled={!act.canEdit}
						data-testid={PLACES_TAB_TESTID.selectionDay}
					>
						<CalendarPlus />
						Add to day…
					</Button>
				</SchedulePicker>
			) : null}
			{act.canRate ? (
				<RatingMenu
					value={null}
					label={`Rate the ${rows.length} selected`}
					align="end"
					onChange={(p) => {
						for (const r of rows) act.rate(r.id, p);
						onClear();
					}}
					trigger={
						<span
							data-testid={PLACES_TAB_TESTID.selectionRate}
							className={cn(
								buttonVariants({ size: "sm", variant: "outline" }),
								onBar,
							)}
						>
							<Star />
							Rate…
						</span>
					}
				/>
			) : null}
			<Button
				size="sm"
				variant="outline"
				disabled={!act.canEdit}
				data-testid={PLACES_TAB_TESTID.selectionDrop}
				className={onBar}
				onClick={() => {
					for (const r of rows)
						if ((r.status === "dropped") === out) act.toggleDropped(r);
					onClear();
				}}
			>
				{out ? "Bring back" : "Not going"}
			</Button>
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label="Clear the selection"
				className="text-background hover:bg-background/15 hover:text-background"
				onClick={onClear}
			>
				<X />
			</Button>
		</div>
	);
}

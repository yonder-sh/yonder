/**
 * "Schedule…" targets (DESIGN §8.1 split button menu): "After Itoya", "End of
 * Day 4", any day of the trip (searchable, with the day's city), or
 * "Unscheduled". Shared by the palette and the rate screen.
 */
import { CalendarPlus, Inbox } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { ScheduleResult } from "@/lib/engine/types";
import { formatDayDate } from "@/lib/format";
import type { Sel } from "@/lib/workspace/search";
import type { AddPlaceRequest } from "@/lib/workspace/ui-store";
import { cityDayTable } from "../lib/days";

export type SchedulePick = {
	dayId: string | null;
	afterItemId?: string;
	label: string;
};

/** The day's city ("Tokyo"), for day lists. */
export function dayCities(
	ix: GraphIndex,
	schedule: ScheduleResult | null,
): Map<string, string> {
	const out = new Map<string, string>();
	for (const r of cityDayTable(ix, schedule, null).rows)
		for (const d of r.dayIds) out.set(d, r.name);
	return out;
}

function itemLabel(ix: GraphIndex, itemId: string): string {
	const it = ix.item(itemId);
	return it?.title ?? ix.node(it?.nodeId)?.name ?? "the selected stop";
}

/**
 * Where "Schedule" goes without asking: the request's position, else after
 * the selected item, else the end of the first day in the day range.
 */
export function defaultSchedulePick(
	ix: GraphIndex,
	opts: {
		request?: AddPlaceRequest | null;
		sel?: Sel | null;
		days?: { from: string } | null;
	},
): SchedulePick | null {
	const r = opts.request;
	if (r?.afterItemId && ix.item(r.afterItemId)?.dayId) {
		const it = ix.item(r.afterItemId);
		return {
			dayId: it?.dayId ?? null,
			afterItemId: r.afterItemId,
			label: `After ${itemLabel(ix, r.afterItemId)}`,
		};
	}
	if (r?.dayId && ix.day(r.dayId))
		return { dayId: r.dayId, label: `End of Day ${ix.dayNumber(r.dayId)}` };
	if (opts.sel?.kind === "item") {
		const it = ix.item(opts.sel.id);
		if (it?.dayId)
			return {
				dayId: it.dayId,
				afterItemId: it.id,
				label: `After ${itemLabel(ix, it.id)}`,
			};
	}
	if (opts.sel?.kind === "day" && ix.day(opts.sel.id))
		return {
			dayId: opts.sel.id,
			label: `End of Day ${ix.dayNumber(opts.sel.id)}`,
		};
	if (opts.days) {
		const day = ix.dayOfDate(opts.days.from);
		if (day)
			return { dayId: day.id, label: `End of Day ${ix.dayNumber(day.id)}` };
	}
	return null;
}

export function SchedulePicker({
	ix,
	schedule,
	onPick,
	suggestions = [],
	children,
	align = "end",
	allowUnscheduled = true,
}: {
	ix: GraphIndex;
	schedule: ScheduleResult | null;
	onPick: (p: SchedulePick) => void;
	suggestions?: SchedulePick[];
	/** The trigger (a button). */
	children: ReactNode;
	align?: "start" | "end";
	allowUnscheduled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const cities = useMemo(
		() => (open ? dayCities(ix, schedule) : new Map<string, string>()),
		[open, ix, schedule],
	);
	const pick = (p: SchedulePick) => {
		setOpen(false);
		onPick(p);
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent
				align={align}
				className="w-72 p-0"
				onKeyDown={(e) => e.stopPropagation()}
			>
				<Command>
					<CommandInput placeholder="Day, date or city…" />
					<CommandList className="max-h-[min(60vh,360px)]">
						<CommandEmpty>No such day.</CommandEmpty>
						{suggestions.length ? (
							<CommandGroup>
								{suggestions.map((s) => (
									<CommandItem
										key={`${s.dayId}:${s.afterItemId ?? ""}`}
										value={`__s ${s.label}`}
										onSelect={() => pick(s)}
									>
										<CalendarPlus className="size-4" strokeWidth={1.5} />
										{s.label}
									</CommandItem>
								))}
							</CommandGroup>
						) : null}
						<CommandGroup heading="Days">
							{ix.days.map((d) => {
								const n = ix.dayNumber(d.id);
								const city = cities.get(d.id);
								return (
									<CommandItem
										key={d.id}
										value={`day ${n} ${formatDayDate(d.date)} ${city ?? ""} ${d.title ?? ""}`}
										onSelect={() =>
											pick({ dayId: d.id, label: `End of Day ${n}` })
										}
									>
										<span className="w-12 shrink-0 font-mono text-xs tnum text-muted-foreground">
											Day {n}
										</span>
										<span className="shrink-0">{formatDayDate(d.date)}</span>
										<span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
											{d.title ?? city ?? ""}
										</span>
									</CommandItem>
								);
							})}
						</CommandGroup>
						{allowUnscheduled ? (
							<CommandGroup>
								<CommandItem
									value="__unscheduled"
									onSelect={() => pick({ dayId: null, label: "Unscheduled" })}
								>
									<Inbox className="size-4" strokeWidth={1.5} />
									Unscheduled
								</CommandItem>
							</CommandGroup>
						) : null}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/**
 * Time needed (docs/PLACES.md §1): the place's own estimate, editable in the
 * table and the drawer; a scheduled place shows its planned stop's duration
 * instead; "not set" until someone fills it.
 */
import { cn } from "cn";
import { CalendarCheck, Clock } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { formatDuration, parseDuration } from "@/lib/format";
import type { PlaceRow } from "./model";
import { PLACES_TAB_TESTID } from "./testids";

const PRESETS = [30, 60, 90, 120, 180, 240, 540];

export function TimeNeededLabel({ row }: { row: PlaceRow }) {
	if (row.timeMin === null)
		return <span className="text-xs text-muted-foreground/70">not set</span>;
	return (
		<span className="inline-flex items-center gap-1 font-mono text-[13px] tnum">
			{row.timeSource === "planned" ? (
				<CalendarCheck
					className="size-3 text-muted-foreground"
					strokeWidth={1.5}
					aria-label="planned"
				/>
			) : null}
			{formatDuration(row.timeMin)}
		</span>
	);
}

/** The editor: presets, a typed duration ("1h30", "90", "2.5h"), Clear. */
export function TimeNeededEditor({
	row,
	onSet,
	disabled,
	className,
	align = "start",
}: {
	row: PlaceRow;
	onSet: (minutes: number | null) => void;
	disabled?: boolean;
	className?: string;
	align?: "start" | "end";
}) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const planned = row.timeSource === "planned";
	const own = row.node.timeNeededMin;
	const commit = (m: number | null) => {
		setOpen(false);
		onSet(m);
	};
	const typed = draft.trim() ? parseDuration(draft) : undefined;
	return (
		<Popover
			open={open}
			onOpenChange={(v) => {
				setOpen(v);
				if (v) setDraft(own !== null ? formatDuration(own) : "");
			}}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					data-testid={PLACES_TAB_TESTID.timeCell}
					data-minutes={row.timeMin ?? ""}
					title={
						planned
							? "From its planned stop. Set the place's own estimate here."
							: "Time needed at the place"
					}
					onClick={(e) => e.stopPropagation()}
					className={cn(
						"inline-flex h-7 cursor-pointer items-center rounded-md px-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent",
						className,
					)}
				>
					<TimeNeededLabel row={row} />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align={align}
				className="w-64 p-3"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<p className="flex items-center gap-1.5 text-sm font-medium">
					<Clock className="size-3.5" strokeWidth={1.5} />
					Time needed at {row.name}
				</p>
				{planned ? (
					<p className="mt-1 text-xs text-muted-foreground">
						On the plan for {formatDuration(row.timeMin)}. This sets the place's
						own estimate.
					</p>
				) : null}
				<div className="mt-2 flex flex-wrap gap-1">
					{PRESETS.map((m) => (
						<Button
							key={m}
							size="xs"
							variant={own === m ? "default" : "outline"}
							className="font-mono tnum"
							onClick={() => commit(m)}
						>
							{m === 540 ? "Full day" : formatDuration(m)}
						</Button>
					))}
				</div>
				<form
					className="mt-2 flex items-center gap-1.5"
					onSubmit={(e) => {
						e.preventDefault();
						if (typed) commit(typed);
					}}
				>
					<Input
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder="1h30"
						aria-label="Time needed"
						aria-invalid={typed === null || undefined}
						data-testid={PLACES_TAB_TESTID.timeInput}
						className="h-8 flex-1 font-mono text-[13px] tnum"
					/>
					<Button size="sm" type="submit" disabled={!typed}>
						Set
					</Button>
				</form>
				{own !== null ? (
					<Button
						size="xs"
						variant="ghost"
						className="mt-1 text-muted-foreground"
						onClick={() => commit(null)}
					>
						Clear (not set)
					</Button>
				) : null}
			</PopoverContent>
		</Popover>
	);
}

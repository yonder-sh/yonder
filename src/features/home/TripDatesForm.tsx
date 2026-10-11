/**
 * A trip's start and end: pick → preview what moves → apply (or suggest).
 * Trip settings' Dates row and Change dates' "Start & end" both use it.
 * `expectedVersion` is the version the shown preview was computed at (what
 * the user reviewed; QA NOTE-VERSION-CONFLICT).
 */
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type DayNotesChoice,
	DayNotesChoiceField,
} from "@/components/common/day-notes-choice";
import { useEditGuard } from "@/components/common/edit-guard";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import { previewTripDates, setTripDates } from "@/functions/trips.functions";
import { errorCode } from "@/lib/errors";
import { formatDayDate } from "@/lib/format";
import { meKeys, tripKeys } from "@/lib/query/keys";
import { cn } from "@/lib/utils";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { DateRangeField } from "./date-fields";
import { HOME_TESTID } from "./testids";

export function TripDatesForm({
	id,
	field = (f) => f,
	reviewClassName,
	onDone,
}: {
	id: string;
	/** Wraps the range field (a labelled row in Trip settings). */
	field?: (f: ReactNode) => ReactNode;
	reviewClassName?: string;
	/** After the dates changed. */
	onDone?: () => void;
}) {
	const { graph, mode } = useWorkspace();
	const trip = graph.trip;
	const [from, setFrom] = useState<string | null>(trip.startDate);
	const [to, setTo] = useState<string | null>(trip.endDate);
	const [dayNotes, setDayNotes] = useState<DayNotesChoice>("keep");
	const { disabled } = useEditGuard();
	useEffect(() => {
		setFrom(trip.startDate);
		setTo(trip.endDate);
	}, [trip.startDate, trip.endDate]);
	const changed =
		!!from && !!to && (from !== trip.startDate || to !== trip.endDate);
	const preview = useQuery({
		// With the graph's version: a change that refreshes the graph refreshes
		// the preview too, so it never shows (or sends) an older review.
		queryKey: ["trip-dates-preview", trip.id, from, to, trip.version],
		queryFn: () =>
			previewTripDates({
				data: { tripId: trip.id, startDate: from ?? "", endDate: to ?? "" },
			}),
		enabled: changed && mode === "live",
		staleTime: 10_000,
	});
	const apply = useTripMutation(
		(v: {
			startDate: string;
			endDate: string;
			expectedVersion: number;
			dayNotes?: DayNotesChoice;
		}) => setTripDates({ data: { tripId: trip.id, ...v } }),
		{
			tripId: trip.id,
			keys: [
				tripKeys.graph(trip.id),
				tripKeys.lists(trip.id),
				tripKeys.counts(trip.id),
				meKeys.trips,
			],
			onSuccess: () => {
				toast.success("Dates changed");
				onDone?.();
			},
		},
	);
	const p = preview.data;
	const items = p?.affectedItems ?? [];
	return (
		<div className="grid gap-2">
			{field(
				<DateRangeField
					id={id}
					from={from}
					to={to}
					disabled={disabled}
					testId={HOME_TESTID.settingsDates}
					onChange={(a, b) => {
						setFrom(a);
						setTo(b);
					}}
				/>,
			)}
			{changed ? (
				<div
					className={cn(
						"grid gap-2 rounded-lg bg-muted/60 p-3 text-meta",
						reviewClassName,
					)}
				>
					{p?.blockedBy ? <p className="text-warning">{p.blockedBy}</p> : null}
					{!p?.blockedBy && p?.notedDays?.length ? (
						<DayNotesChoiceField
							dates={p.notedDays ?? []}
							value={dayNotes}
							onChange={setDayNotes}
						/>
					) : null}
					{p?.blockedBy ? null : items.length ? (
						<p>
							{items.length} {items.length === 1 ? "stop" : "stops"} on{" "}
							{p?.removedDays
								.slice(0, 3)
								.map((d) => formatDayDate(d))
								.join(", ")}
							{(p?.removedDays.length ?? 0) > 3 ? "…" : ""} move to Ideas.
							Nothing is deleted.
							<span className="mt-1 block truncate text-muted-foreground">
								{items
									.slice(0, 4)
									.map((i) => i.title)
									.join(" · ")}
								{items.length > 4 ? ` +${items.length - 4}` : ""}
							</span>
						</p>
					) : (
						<p className="text-muted-foreground">
							{preview.isPending ? "Checking what moves…" : "No stops move."}
						</p>
					)}
					<div className="flex gap-2">
						<Button
							type="button"
							size="sm"
							data-testid={HOME_TESTID.datesConfirm}
							disabled={
								disabled ||
								apply.isPending ||
								preview.isPending ||
								// A refetch (after a CONFLICT) is a new review: wait for it.
								preview.isFetching ||
								!!p?.blockedBy
							}
							onClick={() => {
								if (!from || !to) return;
								apply.mutate(
									{
										startDate: from,
										endDate: to,
										expectedVersion: p?.version ?? trip.version,
										...(p?.notedDays?.length ? { dayNotes } : {}),
									},
									{
										// "Review again": the next click sends the fresh preview's version.
										onError: (e) => {
											if (errorCode(e) === "CONFLICT") void preview.refetch();
										},
									},
								);
							}}
						>
							{mode === "live" && useUi.getState().suggesting
								? "Suggest these dates"
								: "Change dates"}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => {
								setFrom(trip.startDate);
								setTo(trip.endDate);
							}}
						>
							Keep the current dates
						</Button>
					</div>
				</div>
			) : null}
		</div>
	);
}

/**
 * E2 "Try other dates…" (EXTENSIONS §5): a 560px Dialog (a bottom sheet on
 * phones) with a −7…+7 stepper and "Shift so Day 1 is…" (a shift, not a range
 * change), the summary ("Day 1 becomes Mon 4 Oct"), the impact sections
 * (`DateImpactList`, instant, client-side) and `Shift by +1 day` — or
 * `Suggest shift` for suggesters and in suggest mode. The draft lives in
 * `useUi().dateDraft`, so it survives navigation: a row selects its entity and
 * closes the dialog, and `WhatIfChip` → Review brings it back. Applying sends
 * `expectedVersion` (a concurrent edit → CONFLICT, re-review) and toasts
 * "Trip shifted +1 day · Undo". `previewTripDates` (debounced 300 ms) only
 * supplies `blockedBy`.
 *
 * `expectedVersion` is the version the user REVIEWED, not the live graph's at
 * click time: someone else's edit refreshes the graph (and the impact list)
 * under the open dialog, and that must still refuse the shift. The reviewed
 * version is taken when the dialog opens, moves forward when the user steps
 * the delta (a fresh look) or after a CONFLICT (the notice asks for one), and
 * counts the user's own "Mark booked" edits (each bumps the trip by one).
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { CalendarDays, Minus, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { undoToast } from "@/components/common/undo-toast";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { updateItem } from "@/functions/items.functions";
import { previewTripDates, shiftTripDates } from "@/functions/trips.functions";
import { shortDate } from "@/lib/engine/hours";
import { addDays, daysBetween } from "@/lib/engine/time";
import type { TripGraph } from "@/lib/engine/types";
import { errorCode } from "@/lib/errors";
import { tripKeys } from "@/lib/query/keys";
import { useFormPresence } from "@/lib/realtime/form-presence";
import { TESTID } from "@/lib/testids";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { useUi } from "@/lib/workspace/ui-store";
import { DateImpactList, dayMonth } from "./DateImpactList";
import { useLatestMount } from "./latest-mount";
import { INSIGHTS_TESTID } from "./testids";
import { isoOfPicked, pickerDate, SHEET_ON_MOBILE } from "./ui";
import { useDraftImpact } from "./use-date-draft-impact";

const MAX_STEP = 7;
/** The reviewed version only moves forward. */
const laterVersion = (reviewed: number | null, seen: number) =>
	reviewed === null ? seen : Math.max(reviewed, seen);
const plural = (n: number) =>
	`${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"}`;

export function ShiftTripDialog() {
	const open = useUi((s) => s.shiftOpen);
	// FB-24: followers see "Dennis opened 'Try other dates'".
	useFormPresence(open ? { k: "shift", m: "edit" } : null);
	const setOpen = useUi((s) => s.openShiftTrip);
	const ws = useWorkspaceOptional();
	const live = useLatestMount("shift-trip-dialog");
	if (!live) return null;
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				className={cn(SHEET_ON_MOBILE, "sm:max-w-[560px]")}
				data-testid={TESTID.shiftTripDialog}
			>
				{ws ? (
					<ShiftBody onClose={() => setOpen(false)} />
				) : (
					<DialogHeader className="p-5">
						<DialogTitle>Try other dates</DialogTitle>
						<DialogDescription>Open a trip first.</DialogDescription>
					</DialogHeader>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Toggles later than `ms` after the last change (the preview is only for `blockedBy`). */
function useDebounced<T>(value: T, ms: number): T {
	const [v, setV] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setV(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return v;
}

function ShiftBody({ onClose }: { onClose: () => void }) {
	const ws = useWorkspaceOptional();
	const draft = useUi((s) => s.dateDraft);
	const setDraft = useUi((s) => s.setDateDraft);
	const guard = useEditGuard();
	const [pickOpen, setPickOpen] = useState(false);
	const [conflict, setConflict] = useState(false);
	const delta = draft?.deltaDays ?? 0;
	const impact = useDraftImpact(delta);
	const graph = ws?.graph;
	const tripId = graph?.trip.id ?? "";
	const version = graph?.trip.version;
	// The trip version the user reviewed (see the header). Never moves back.
	const [reviewed, setReviewed] = useState<number | null>(version ?? null);
	useEffect(() => {
		if (reviewed === null && version !== undefined) setReviewed(version);
	}, [reviewed, version]);
	// After a CONFLICT the notice is up and the list recomputes from the
	// refetched graph: that is the re-review, so the next click may apply.
	useEffect(() => {
		if (conflict && version !== undefined)
			setReviewed((r) => laterVersion(r, version));
	}, [conflict, version]);
	const debounced = useDebounced(delta, 300);
	const preview = useQuery({
		queryKey: [
			...tripKeys.trip(tripId),
			"preview-shift",
			debounced,
			graph?.trip.version,
		] as const,
		queryFn: () => previewTripDates({ data: { tripId, deltaDays: debounced } }),
		enabled: !!ws && ws.mode === "live" && debounced !== 0 && ws.access.canEdit,
		staleTime: 30_000,
	});
	const shift = useTripMutation(
		(v: { tripId: string; deltaDays: number; expectedVersion?: number }) =>
			shiftTripDates({ data: v }),
		{ keys: [tripKeys.graph(tripId), tripKeys.lists(tripId)], tripId },
	);
	const book = useTripMutation(
		(v: { itemId: string }) =>
			updateItem({ data: { itemId: v.itemId, patch: { fixedDate: true } } }),
		{
			keys: [tripKeys.graph(tripId)],
			tripId,
			// The user's own edit bumps the trip by one; it isn't a concurrent change.
			onSuccess: () => setReviewed((r) => (r === null ? r : r + 1)),
			// The row moves to Needs rebooking at once (the impact recomputes).
			optimistic: (qc, v) =>
				qc.setQueryData<TripGraph>(tripKeys.graph(tripId), (g) =>
					g
						? {
								...g,
								items: g.items.map((i) =>
									i.id === v.itemId ? { ...i, fixedDate: true } : i,
								),
							}
						: g,
				),
		},
	);
	if (!ws || !graph) return null;

	const first = ws.ix.days[0];
	const day1 = first?.date ?? graph.trip.startDate ?? null;
	const suggesting = ws.access.mode === "suggest";
	const setDelta = (d: number) => {
		setConflict(false);
		// A new delta is a fresh look at the current trip.
		setReviewed((r) => laterVersion(r, graph.trip.version));
		setDraft(d === 0 ? null : { deltaDays: d });
	};
	const step = (d: number) =>
		setDelta(Math.max(-MAX_STEP, Math.min(MAX_STEP, delta + d)));
	const blockedBy = debounced === delta ? preview.data?.blockedBy : undefined;

	const apply = () => {
		const expectedVersion = reviewed ?? graph.trip.version;
		setConflict(false);
		shift.mutate(
			{ tripId, deltaDays: delta, expectedVersion },
			{
				// The graph refetches (the hook invalidates it); the impact recomputes.
				onError: (e) => setConflict(errorCode(e) === "CONFLICT"),
				onSuccess: (r) => {
					setDraft(null);
					onClose();
					if (r && typeof r === "object" && "proposed" in r) return;
					const back = r as { version: number | null };
					undoToast(`Trip shifted ${plural(delta)}`, () =>
						shift.mutate({
							tripId,
							deltaDays: -delta,
							...(back.version !== null
								? { expectedVersion: back.version }
								: {}),
						}),
					);
				},
			},
		);
	};

	return (
		<>
			<DialogHeader className="gap-1 border-b px-5 pt-5 pb-4 text-left">
				<DialogTitle className="text-[17px] leading-6 font-semibold">
					Try other dates
				</DialogTitle>
				<DialogDescription className="text-[13px]">
					Move every day together and see what changes before you commit.
				</DialogDescription>
			</DialogHeader>
			<div className="grid gap-4 border-b px-5 py-4">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-3">
					<div className="inline-flex items-center rounded-full border bg-card p-0.5 shadow-xs">
						<Button
							variant="ghost"
							size="icon"
							aria-label="One day earlier"
							data-testid={INSIGHTS_TESTID.shiftMinus}
							disabled={delta <= -MAX_STEP}
							onClick={() => step(-1)}
							className="size-8 rounded-full"
						>
							<Minus className="size-4" />
						</Button>
						<output
							data-testid={INSIGHTS_TESTID.shiftDelta}
							data-delta={delta}
							aria-live="polite"
							className={cn(
								"min-w-[5.5rem] text-center font-mono text-[14px] font-semibold tnum",
								delta === 0 ? "text-muted-foreground" : "text-primary",
							)}
						>
							{delta === 0 ? "0 days" : plural(delta)}
						</output>
						<Button
							variant="ghost"
							size="icon"
							aria-label="One day later"
							data-testid={INSIGHTS_TESTID.shiftPlus}
							disabled={delta >= MAX_STEP}
							onClick={() => step(1)}
							className="size-8 rounded-full"
						>
							<Plus className="size-4" />
						</Button>
					</div>
					{day1 ? (
						<Popover open={pickOpen} onOpenChange={setPickOpen}>
							<PopoverTrigger asChild>
								<Button
									variant="ghost"
									size="sm"
									data-testid={INSIGHTS_TESTID.shiftDay1}
									className="h-8 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground"
								>
									<CalendarDays className="size-4" strokeWidth={1.75} />
									Shift so Day 1 is…
								</Button>
							</PopoverTrigger>
							<PopoverContent className="w-auto p-0" align="start">
								<Calendar
									mode="single"
									weekStartsOn={1}
									defaultMonth={pickerDate(addDays(day1, delta))}
									selected={pickerDate(addDays(day1, delta))}
									onSelect={(d) => {
										if (!d) return;
										setDelta(daysBetween(day1, isoOfPicked(d)));
										setPickOpen(false);
									}}
								/>
							</PopoverContent>
						</Popover>
					) : null}
				</div>
				<div
					data-testid={INSIGHTS_TESTID.shiftSummary}
					className="grid gap-0.5"
				>
					<p className="font-display text-[19px] leading-6 font-semibold">
						{!day1
							? "This trip has no dates yet."
							: delta === 0
								? `Day 1 is ${shortDate(day1)}`
								: `Day 1 becomes ${shortDate(addDays(day1, delta))}`}
					</p>
					{impact && day1 ? (
						<p className="text-[13px] text-muted-foreground">
							<span className="tnum">
								{dayMonth(impact.range.from)} – {dayMonth(impact.range.to)}
							</span>
							{impact.weekdays ? ` · ${impact.weekdays}` : ""}
							{delta !== 0 && graph.trip.startDate ? (
								<span className="text-muted-foreground/80">
									{" "}
									· was {dayMonth(graph.trip.startDate)}
								</span>
							) : null}
						</p>
					) : null}
					{impact?.startsInPast && delta !== 0 ? (
						<p className="mt-1 flex items-center gap-1.5 text-[13px] font-medium text-warning">
							<TriangleAlert className="size-3.5" aria-hidden /> The trip would
							start before today.
						</p>
					) : null}
					{conflict ? (
						<p
							role="alert"
							data-testid={INSIGHTS_TESTID.shiftConflict}
							className="mt-1 flex items-center gap-1.5 text-[13px] font-medium text-warning"
						>
							<TriangleAlert className="size-3.5" aria-hidden /> The trip
							changed while you were looking. Review again, then shift.
						</p>
					) : null}
					{blockedBy ? (
						<p className="mt-1 flex items-center gap-1.5 text-[13px] font-medium text-warning">
							<TriangleAlert className="size-3.5" aria-hidden /> {blockedBy}
						</p>
					) : null}
				</div>
			</div>
			<div className="min-h-[8rem] flex-1 overflow-y-auto px-4 py-4">
				{delta === 0 ? (
					<p className="px-1 text-[13px] text-muted-foreground">
						Step a few days either way. Bookings, pinned times, stays and
						opening hours update as you go.
					</p>
				) : impact ? (
					<DateImpactList
						impact={impact}
						onSelect={onClose}
						markGuard={guard}
						onMarkBooked={(itemId) => book.mutate({ itemId })}
					/>
				) : (
					<div className="grid gap-2">
						<Skeleton className="h-8 w-full" />
						<Skeleton className="h-8 w-2/3" />
					</div>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-2 border-t bg-background px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
				{draft ? (
					<Button
						variant="ghost"
						size="sm"
						data-testid={INSIGHTS_TESTID.shiftDiscard}
						onClick={() => {
							setDraft(null);
							onClose();
						}}
						className="h-8 px-2 text-muted-foreground"
					>
						Discard what-if
					</Button>
				) : null}
				<span className="flex-1" />
				<Button variant="ghost" size="sm" className="h-8" onClick={onClose}>
					{draft ? "Keep exploring" : "Close"}
				</Button>
				<Button
					size="sm"
					data-testid={INSIGHTS_TESTID.shiftApply}
					disabled={
						guard.disabled ||
						delta === 0 ||
						shift.isPending ||
						book.isPending ||
						!!blockedBy
					}
					title={guard.reason ?? blockedBy ?? undefined}
					onClick={apply}
					className="h-8 px-4 max-sm:h-10 max-sm:w-full"
				>
					{shift.isPending
						? "Shifting…"
						: suggesting
							? "Suggest shift"
							: delta === 0
								? "Shift"
								: `Shift by ${plural(delta)}`}
				</Button>
			</div>
		</>
	);
}

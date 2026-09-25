/**
 * "Dennis reminded you to rate 12 places · Rate now · ×": one line at the
 * top of the trip's tabs while you have an unread reminder and places left
 * (anyone without push hears about it here). Closing it marks it read.
 */
import { BellRing, X } from "lucide-react";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { RATING_TESTID } from "./rating-testids";
import { useFlowTally } from "./use-flow";
import { useDismissReminder, useRateReminders } from "./use-rating-people";

export function ReminderLine() {
	const { nav, tab, search } = useWorkspace();
	const mine = useRateReminders()?.mine ?? null;
	const left = useFlowTally(null).toRate ?? 0;
	const dismiss = useDismissReminder();
	// Already on the Rate step: the feed says it all.
	const rating = tab === "places" && search.pv === "rate";
	if (!mine || !left || rating) return null;
	return (
		<div
			data-testid={RATING_TESTID.reminderLine}
			role="status"
			className="flex min-h-8 shrink-0 items-center gap-2 border-b bg-primary/5 px-4 py-1 text-[13px]"
		>
			<BellRing
				className="size-3.5 shrink-0 text-primary"
				strokeWidth={1.75}
				aria-hidden
			/>
			<span className="min-w-0 flex-1">
				{mine.byName} reminded you to rate {left}{" "}
				{left === 1 ? "place" : "places"}
			</span>
			<button
				type="button"
				data-testid={RATING_TESTID.reminderRate}
				className="shrink-0 cursor-pointer font-medium text-primary hover:underline"
				onClick={() =>
					nav.openPlaces({
						scopeId: null,
						patch: { pv: "rate", pst: undefined, talk: undefined },
					})
				}
			>
				Rate now
			</button>
			<button
				type="button"
				data-testid={RATING_TESTID.reminderClose}
				aria-label="Close"
				className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
				onClick={() => dismiss.mutate()}
			>
				<X className="size-3.5" />
			</button>
		</div>
	);
}

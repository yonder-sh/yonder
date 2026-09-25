/**
 * E2: "What-if +1 day · Review · ✕" in the TopBar while a date draft is set
 * (WP-Shell mounts it after the trip title). Primary tint, not amber: a
 * what-if isn't a conflict (ADDENDUM §10). Review reopens the dialog with the
 * same draft; ✕ discards it.
 */
import { CalendarClock, X } from "lucide-react";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { INSIGHTS_TESTID } from "./testids";

export function WhatIfChip() {
	const draft = useUi((s) => s.dateDraft);
	const setDraft = useUi((s) => s.setDateDraft);
	const openShift = useUi((s) => s.openShiftTrip);
	if (!draft) return null;
	const n = draft.deltaDays;
	const label = `What-if ${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"}`;
	return (
		<span
			data-testid={TESTID.whatIfChip}
			data-delta={n}
			className="inline-flex h-7 shrink-0 items-center rounded-full bg-primary/10 pr-0.5 pl-2.5 text-xs font-medium text-primary ring-1 ring-primary/25 ring-inset"
		>
			<CalendarClock
				className="mr-1.5 size-3.5 shrink-0"
				strokeWidth={1.75}
				aria-hidden
			/>
			<span className="whitespace-nowrap">{label}</span>
			<span aria-hidden className="mx-1.5 opacity-40">
				·
			</span>
			<button
				type="button"
				data-testid={INSIGHTS_TESTID.whatIfReview}
				onClick={() => openShift(true)}
				className="rounded-sm underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			>
				Review
			</button>
			<button
				type="button"
				aria-label="Discard the what-if"
				data-testid={INSIGHTS_TESTID.whatIfClear}
				onClick={() => setDraft(null)}
				className="ml-1 inline-flex size-6 items-center justify-center rounded-full hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			>
				<X className="size-3.5" strokeWidth={2} />
			</button>
		</span>
	);
}

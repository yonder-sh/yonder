/**
 * The Overview's next-step card (the flow, owner 2026-09-25): one quiet line
 * for the next thing to do with the trip's places, linking into that step
 * of the Places tab: "★ 12 places to rate [Start rating]", else "4
 * shortlisted places aren't on a day yet [Schedule]", else "Add the places
 * you want to go [Add places]" (Review, with the add dialog open). It sits
 * in the Overview's dark hero, under the planning line (which keeps the
 * Must coverage: nothing repeats here).
 */
import { cn } from "cn";
import { CalendarPlus, Plus, Star } from "lucide-react";
import type { MouseEvent } from "react";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { type CardStep, nextStepCard, viewOfStep } from "./flow";
import { PLACES_TAB_TESTID } from "./testids";
import { useFlowTally } from "./use-flow";
import { lastReviewView } from "./use-places";

const ICON = { rate: Star, schedule: CalendarPlus, add: Plus } as const;

export function NextStepCard({
	steps,
	className,
}: {
	/** Only these steps (e.g. not "add" where the page already offers it). */
	steps?: readonly CardStep[];
	className?: string;
}) {
	const { nav } = useWorkspace();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const t = useFlowTally(null);
	const card = nextStepCard(t, t);
	if (!card || (steps && !steps.includes(card.step))) return null;
	const opts = {
		scopeId: null,
		patch: {
			pv:
				card.step === "add"
					? lastReviewView.current
					: viewOfStep(card.step, lastReviewView.current),
			pst: undefined,
			talk: undefined,
		},
	};
	const Icon = ICON[card.step];
	return (
		<div
			data-testid={PLACES_TAB_TESTID.nextStep}
			data-step={card.step}
			className={cn(
				"flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.04] py-2 pr-2 pl-3.5",
				className,
			)}
		>
			<Icon
				aria-hidden
				className={cn(
					"size-4 shrink-0",
					card.step === "rate" ? "fill-glow text-glow" : "text-white/60",
				)}
				strokeWidth={1.75}
			/>
			<p className="min-w-0 flex-1 text-sm text-white/85">{card.text}</p>
			<a
				href={nav.hrefPlaces(opts)}
				onClick={(e: MouseEvent) => {
					if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
					e.preventDefault();
					nav.openPlaces(opts);
					if (card.step === "add") openAddPlace({ mode: "search" });
				}}
				className="inline-flex h-8 shrink-0 items-center rounded-lg border border-white/20 px-3 text-[13px] font-medium text-white transition-colors hover:bg-white/10"
			>
				{card.action}
			</a>
		</div>
	);
}

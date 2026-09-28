/**
 * The Places tab's small pieces (docs/PLACES.md §1c "pills vs dots"): pills
 * where a rating stands alone (the score chip, the drawer's ratings, the
 * rating buttons), dot + label in dense lists (table cells, phone rows, the
 * map's side list). Colours come from `PRIORITIES` (light and dark pairs)
 * through CSS variables, so they follow the theme without JS.
 */

import { Pin, Scale } from "lucide-react";
import { Chip, type ChipTone, RATING_FILL, ratingVars } from "@/components/kit";
import { cn } from "@/lib/utils";
import type { StatusInfo } from "./lifecycle";
import { formatScore, scoreTier } from "./score";
import { PLACES_TAB_TESTID } from "./testids";

/** The group score as a pill on its tier's colour ("+6"). */
export function ScoreChip({
	score,
	prefix,
	className,
	size = "md",
}: {
	score: number;
	/** "Score +6" in the drawer's header. */
	prefix?: string;
	className?: string;
	size?: "sm" | "md";
}) {
	const tier = scoreTier(score);
	return (
		<span
			data-testid={PLACES_TAB_TESTID.scoreChip}
			data-score={score}
			title={`Group score ${formatScore(score)} (Must +3 … Nah −2; unrated counts as 0)`}
			style={ratingVars(tier)}
			className={cn(
				"inline-flex shrink-0 items-center rounded-full font-semibold whitespace-nowrap tnum",
				RATING_FILL,
				size === "sm" ? "h-5 px-1.5 text-2xs" : "h-6 px-2 text-xs",
				className,
			)}
		>
			{prefix ? `${prefix} ` : ""}
			{formatScore(score)}
		</span>
	);
}

const STATUS_TONE: Record<StatusInfo["status"], ChipTone> = {
	idea: "neutral",
	shortlist: "accent",
	scheduled: "good",
	dropped: "neutral",
};

/** Idea · Shortlist (pinned / suggested) · Scheduled · Dropped. */
export function StatusChip({
	info,
	className,
	long = false,
	reason,
}: {
	info: StatusInfo;
	className?: string;
	/** "Shortlist · suggested" instead of the short "Suggested". */
	long?: boolean;
	/** Why it is (or isn't) on the shortlist: the tooltip (`bar.ts`). */
	reason?: string | null;
}) {
	const label =
		info.status === "shortlist"
			? info.pinned
				? long
					? "Shortlist · pinned"
					: "Shortlist"
				: long
					? "Shortlist · suggested"
					: "Suggested"
			: info.status === "idea"
				? "Idea"
				: info.status === "scheduled"
					? "On a day"
					: info.autoDropped
						? "Not going · all Nah"
						: "Not going";
	const suggested = info.status === "shortlist" && !info.pinned;
	return (
		<Chip
			tone={suggested ? "outline" : STATUS_TONE[info.status]}
			icon={info.pinned ? Pin : undefined}
			data-testid={PLACES_TAB_TESTID.statusChip}
			data-status={info.status}
			data-pinned={info.pinned || undefined}
			title={reason ?? undefined}
			className={cn(info.status === "dropped" && "line-through", className)}
		>
			{label}
		</Chip>
	);
}

/** The Split marker: keen and against on the same place. */
export function SplitMark({ className }: { className?: string }) {
	return (
		<Chip
			tone="warn"
			size="sm"
			icon={Scale}
			data-testid={PLACES_TAB_TESTID.splitMark}
			title="A disagreement: someone is keen, someone isn't."
			className={className}
		>
			Split
		</Chip>
	);
}

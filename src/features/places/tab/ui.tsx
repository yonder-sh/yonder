/**
 * The Places tab's small pieces (docs/PLACES.md §1c "pills vs dots"): pills
 * where a rating stands alone (the score chip, the drawer's ratings, the
 * rating buttons), dot + label in dense lists (table cells, phone rows, the
 * map's side list). Colours come from `PRIORITIES` (light and dark pairs)
 * through CSS variables, so they follow the theme without JS.
 */
import { cn } from "cn";
import { Pin, Scale } from "lucide-react";
import type { ReactNode } from "react";
import { priorityDotVars } from "@/components/common/priority-dot";
import type { Priority } from "@/lib/schemas/enums";
import { PRIORITY_FILL, priorityVars } from "../ui/priority";
import type { StatusInfo } from "./lifecycle";
import { formatScore, scoreTier } from "./score";
import { PLACES_TAB_TESTID } from "./testids";

/** A bare 8px rating dot (next to an avatar on a board card). */
export function RatingDot({
	priority,
	className,
}: {
	priority: Priority;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			style={priorityDotVars(priority)}
			className={cn(
				"inline-block size-2 shrink-0 rounded-full bg-(--pd) dark:bg-(--pd-dark)",
				className,
			)}
		/>
	);
}

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
			style={priorityVars(tier)}
			className={cn(
				"inline-flex shrink-0 items-center rounded-full font-mono font-semibold whitespace-nowrap tnum",
				PRIORITY_FILL,
				size === "sm" ? "h-5 px-1.5 text-[11px]" : "h-[22px] px-2 text-xs",
				className,
			)}
		>
			{prefix ? `${prefix} ` : ""}
			{formatScore(score)}
		</span>
	);
}

const STATUS_STYLE: Record<StatusInfo["status"], string> = {
	idea: "bg-muted text-muted-foreground",
	shortlist: "bg-primary/10 text-primary",
	scheduled:
		"bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
	dropped: "bg-muted text-muted-foreground line-through",
};

/** Idea · Shortlist (pinned / suggested) · Scheduled · Dropped. */
export function StatusChip({
	info,
	className,
	long = false,
}: {
	info: StatusInfo;
	className?: string;
	/** "Shortlist · suggested" instead of the short "Suggested". */
	long?: boolean;
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
					? "Scheduled"
					: info.autoDropped
						? "Dropped · all Nah"
						: "Dropped";
	return (
		<span
			data-testid={PLACES_TAB_TESTID.statusChip}
			data-status={info.status}
			data-pinned={info.pinned || undefined}
			className={cn(
				"inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap",
				STATUS_STYLE[info.status],
				info.status === "shortlist" &&
					!info.pinned &&
					"bg-transparent ring-1 ring-primary/30 ring-inset",
				className,
			)}
		>
			{info.pinned ? <Pin className="size-3" strokeWidth={2} /> : null}
			{label}
		</span>
	);
}

/** The Split marker: keen and against on the same place. */
export function SplitMark({ className }: { className?: string }) {
	return (
		<span
			data-testid={PLACES_TAB_TESTID.splitMark}
			title="Split: someone is keen, someone isn't. Talk about it."
			className={cn(
				"inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-warning-wash px-1.5 text-[11px] font-medium text-warning",
				className,
			)}
		>
			<Scale className="size-3" strokeWidth={2} />
			Split
		</span>
	);
}

/** A section heading inside the drawer ("RATINGS"). */
export function SectionLabel({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<h3
			className={cn(
				"text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase",
				className,
			)}
		>
			{children}
		</h3>
	);
}

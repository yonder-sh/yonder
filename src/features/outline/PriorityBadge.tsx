/**
 * The priority badge (DESIGN §2.4): the label on its tier colour, light and
 * dark; Nah is struck through. Not rated is a quiet muted "–" with no outline:
 * ADDENDUM §10 keeps dashed lines for proposals and estimates only (it
 * overrides DESIGN §2.4's dashed pill). The Ideas bin shows the max over
 * members (SPEC §7.3), one badge per row (ADDENDUM §10 "fewer badges").
 */
import { cn } from "cn";
import type { CSSProperties } from "react";
import { PRIORITIES } from "@/lib/domain/taxonomy";
import type { Priority } from "@/lib/engine/types";

export function PriorityBadge({
	priority,
	className,
	title,
}: {
	priority: Priority | null;
	className?: string;
	title?: string;
}) {
	if (!priority)
		return (
			<span
				title={title ?? "Not rated"}
				className={cn(
					"inline-flex h-[18px] w-[22px] shrink-0 items-center justify-center text-[11px] leading-none text-muted-foreground/70",
					className,
				)}
			>
				<span aria-hidden>–</span>
				<span className="sr-only">Not rated</span>
			</span>
		);
	const p = PRIORITIES[priority];
	return (
		<span
			title={title ?? p.label}
			data-priority={priority}
			className={cn(
				"inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[11px] leading-none font-medium whitespace-nowrap",
				"bg-(--pb-bg) text-(--pb-fg) dark:bg-(--pb-bg-dark) dark:text-(--pb-fg-dark)",
				p.strike && "line-through",
				className,
			)}
			style={
				{
					"--pb-bg": p.light.bg,
					"--pb-fg": p.light.fg,
					"--pb-bg-dark": p.dark.bg,
					"--pb-fg-dark": p.dark.fg,
				} as CSSProperties
			}
		>
			{p.label}
		</span>
	);
}

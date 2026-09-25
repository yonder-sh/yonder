/**
 * A rating in a dense list, as "dot + label" (PLACES §1c): an 8px dot in the
 * level's `dot` colour (light and dark from `PRIORITIES`, through CSS
 * variables, so it follows the theme without JS) and the label in the normal
 * text colour. Outline rows, the Ideas bin, table cells and phone lists use
 * it; a rating that stands alone (the inspector badge, the rating buttons)
 * keeps its filled pill (`PriorityBadge`). Not rated is a quiet "–".
 */
import { cn } from "cn";
import type { CSSProperties } from "react";
import { PRIORITIES } from "@/lib/domain/taxonomy";
import type { Priority } from "@/lib/schemas/enums";

export function priorityDotVars(p: Priority): CSSProperties {
	const d = PRIORITIES[p];
	return {
		"--pd": d.light.dot,
		"--pd-dark": d.dark.dot,
	} as CSSProperties;
}

export function PriorityDot({
	priority,
	className,
	title,
}: {
	priority: Priority | null | undefined;
	className?: string;
	title?: string;
}) {
	if (!priority)
		return (
			<span
				title={title ?? "Not rated"}
				data-priority=""
				className={cn(
					"inline-flex h-[18px] shrink-0 items-center text-[12px] leading-none text-muted-foreground/70",
					className,
				)}
			>
				<span aria-hidden>–</span>
				<span className="sr-only">Not rated</span>
			</span>
		);
	const d = PRIORITIES[priority];
	return (
		<span
			title={title ?? d.label}
			data-priority={priority}
			style={priorityDotVars(priority)}
			className={cn(
				"inline-flex h-[18px] shrink-0 items-center gap-1.5 text-[12px] leading-none whitespace-nowrap text-foreground",
				className,
			)}
		>
			<span
				aria-hidden
				className="size-2 shrink-0 rounded-full bg-(--pd) dark:bg-(--pd-dark)"
			/>
			<span className={cn(d.strike && "line-through")}>{d.label}</span>
		</span>
	);
}

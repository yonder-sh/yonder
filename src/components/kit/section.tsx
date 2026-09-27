/**
 * Section headers (One Yonder kit): the one caps label ("WHEN & TRAVEL") and
 * the sections of a details pane or a card, one style everywhere. The label
 * is the `eyebrow` utility (styles.css), so a heading that isn't a component
 * can still match.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The caps label on its own. */
export function Eyebrow({
	children,
	as: Comp = "h3",
	className,
	id,
}: {
	children: ReactNode;
	as?: "h2" | "h3" | "h4" | "p" | "span" | "div";
	className?: string;
	id?: string;
}) {
	return (
		<Comp id={id} className={cn("eyebrow", className)}>
			{children}
		</Comp>
	);
}

/** A caps label with an optional action on the right ("NOTES ··· +"). */
export function SectionHeader({
	children,
	action,
	as,
	className,
	id,
}: {
	children: ReactNode;
	action?: ReactNode;
	as?: "h2" | "h3" | "h4" | "p";
	className?: string;
	id?: string;
}) {
	return (
		<div className={cn("flex min-h-7 items-center gap-2", className)}>
			<Eyebrow as={as} id={id} className="flex-1">
				{children}
			</Eyebrow>
			{action ? (
				<div className="flex shrink-0 items-center gap-1">{action}</div>
			) : null}
		</div>
	);
}

/**
 * A section: header and content, divided from the one before by a hairline
 * (`divided`). The details pane is a scroll of these.
 */
export function Section({
	title,
	action,
	children,
	divided = true,
	className,
	testId,
	name,
}: {
	title: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	divided?: boolean;
	className?: string;
	testId?: string;
	/** `data-section`: what a link scrolls to ("notes"). */
	name?: string;
}) {
	return (
		<section
			data-testid={testId}
			data-section={name}
			// minmax(0,1fr): a wide child (a table) scrolls or truncates inside
			// the column instead of widening the pane.
			className={cn(
				"grid grid-cols-[minmax(0,1fr)] gap-2 py-4",
				divided && "border-t",
				className,
			)}
		>
			<SectionHeader action={action}>{title}</SectionHeader>
			{children}
		</section>
	);
}

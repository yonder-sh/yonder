/**
 * Priority badges and pickers (DESIGN §2.4; CATEGORIES.md §4): the label is
 * always shown; "Not rated" is a quiet "–" in a hairline ring (solid: ADDENDUM
 * §10 keeps dashed lines for proposals and estimates only). Colours come from
 * `PRIORITIES` (light and dark pairs) through CSS variables, so the badge
 * follows the theme without JS.
 */
import { cn } from "cn";
import { Check, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PRIORITIES, PRIORITY_ORDER } from "@/lib/domain/taxonomy";
import type { Priority } from "@/lib/schemas/enums";

export function priorityVars(p: Priority): CSSProperties {
	const d = PRIORITIES[p];
	return {
		"--pb-bg": d.light.bg,
		"--pb-fg": d.light.fg,
		"--pb-dot": d.light.dot,
		"--pb-bg-d": d.dark.bg,
		"--pb-fg-d": d.dark.fg,
		"--pb-dot-d": d.dark.dot,
	} as CSSProperties;
}

/** The coloured fill classes for a priority (use with `priorityVars`). */
export const PRIORITY_FILL =
	"bg-[var(--pb-bg)] text-[var(--pb-fg)] dark:bg-[var(--pb-bg-d)] dark:text-[var(--pb-fg-d)]";

export function PriorityBadge({
	priority,
	size = "md",
	className,
	title,
}: {
	priority: Priority | null | undefined;
	size?: "sm" | "md";
	className?: string;
	title?: string;
}) {
	const h =
		size === "sm" ? "h-[18px] px-1.5 text-[11px]" : "h-[22px] px-2 text-xs";
	if (!priority)
		return (
			<span
				title={title ?? "Not rated"}
				data-priority=""
				className={cn(
					"inline-flex shrink-0 items-center justify-center rounded-full border border-border font-medium text-muted-foreground/70",
					h,
					size === "sm" ? "min-w-7" : "min-w-9",
					className,
				)}
			>
				–
			</span>
		);
	const def = PRIORITIES[priority];
	return (
		<span
			title={title}
			data-priority={priority}
			style={priorityVars(priority)}
			className={cn(
				"inline-flex shrink-0 items-center rounded-full font-medium whitespace-nowrap",
				PRIORITY_FILL,
				def.strike && "line-through",
				h,
				className,
			)}
		>
			{def.label}
		</span>
	);
}

/**
 * A member's rating as a badge that opens a menu of the six levels (and
 * Clear). `disabled` keeps it visible (EditGuard wraps it for the reason).
 */
export function PriorityPicker({
	value,
	onChange,
	disabled,
	trigger,
	label,
	align = "start",
}: {
	value: Priority | null | undefined;
	onChange: (p: Priority | null) => void;
	disabled?: boolean;
	trigger?: ReactNode;
	/** Accessible name ("Dennis's rating for Itoya"). */
	label: string;
	align?: "start" | "end";
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				disabled={disabled}
				aria-label={label}
				className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-60"
			>
				{trigger ?? <PriorityBadge priority={value} />}
			</DropdownMenuTrigger>
			<DropdownMenuContent align={align} className="w-52">
				{PRIORITY_ORDER.map((p, i) => (
					<DropdownMenuItem key={p} onSelect={() => onChange(p)}>
						<PriorityBadge priority={p} />
						{value === p ? <Check className="ml-1 size-3.5" /> : null}
						<DropdownMenuShortcut className="font-mono">
							{i + 1}
						</DropdownMenuShortcut>
					</DropdownMenuItem>
				))}
				{value ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => onChange(null)}>
							<X className="size-3.5" />
							Clear rating
							<DropdownMenuShortcut className="font-mono">
								0
							</DropdownMenuShortcut>
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

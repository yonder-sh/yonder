/**
 * The six rating buttons (docs/PLACES.md §1b, §1c: pills where a rating
 * stands alone). `filled` is the feed's big thumb-zone set, every button on
 * its tier colour; `outline` is the drawer's quieter set. After you rate,
 * `reveal` puts the others' avatars on the buttons they picked (the feed's
 * reveal) and dims the rest.
 */
import { cn } from "cn";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { MemberAvatar } from "@/components/common/member";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { PRIORITIES, PRIORITY_ORDER } from "@/lib/domain/taxonomy";
import type { Priority } from "@/lib/schemas/enums";
import { PRIORITY_FILL, priorityVars } from "../ui/priority";
import { PLACES_TAB_TESTID } from "./testids";

export function RatingButtons({
	value,
	onRate,
	disabled,
	reason,
	variant = "outline",
	reveal,
	keys = true,
	className,
	label = "Your rating",
}: {
	value: Priority | null;
	onRate: (p: Priority | null) => void;
	disabled?: boolean;
	reason?: string | null;
	variant?: "filled" | "outline";
	/** Others' picks: priority → member ids (shown once revealed). */
	reveal?: Partial<Record<Priority, string[]>> | null;
	/** Show the 1–6 key hints. */
	keys?: boolean;
	className?: string;
	label?: string;
}) {
	const reduce = useReducedMotion();
	const filled = variant === "filled";
	const buttons = (
		<fieldset
			className={cn(
				"m-0 grid min-w-0 grid-cols-3 gap-2 border-0 p-0",
				className,
			)}
		>
			<legend className="sr-only">{label}</legend>
			{PRIORITY_ORDER.map((p, i) => {
				const on = value === p;
				const def = PRIORITIES[p];
				const who = reveal?.[p] ?? [];
				const dim = filled && value !== null && !on;
				return (
					<button
						key={p}
						type="button"
						aria-pressed={on}
						disabled={disabled}
						data-testid={PLACES_TAB_TESTID.feedButton}
						data-priority={p}
						data-picked-by={who.join(" ") || undefined}
						onClick={() => onRate(on ? null : p)}
						style={priorityVars(p)}
						className={cn(
							"relative flex cursor-pointer items-center justify-center gap-1.5 rounded-xl text-[13px] font-semibold transition-[opacity,transform,box-shadow] duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[.97] disabled:cursor-not-allowed",
							filled
								? cn(
										"h-[52px] rounded-[14px] text-sm",
										PRIORITY_FILL,
										on &&
											"scale-[1.03] shadow-[0_0_0_3px_var(--background),0_0_0_5px_var(--foreground)]",
										dim && "opacity-45",
										disabled && !on && "opacity-60",
									)
								: cn(
										"h-10 border",
										on
											? cn(PRIORITY_FILL, "border-transparent shadow-sm")
											: "border-border bg-background hover:border-[var(--pb-bg)] hover:bg-[color-mix(in_oklab,var(--pb-bg)_14%,transparent)] dark:hover:border-[var(--pb-bg-d)]",
										disabled && "opacity-60",
									),
							def.strike && on && "line-through",
						)}
					>
						{!filled && !on ? (
							<span
								aria-hidden="true"
								className="size-2 rounded-full bg-[var(--pb-bg)] ring-1 ring-black/10 dark:bg-[var(--pb-bg-d)]"
							/>
						) : null}
						{p === "sure_why_not" && filled ? "Sure" : def.label}
						{keys ? (
							<span
								aria-hidden="true"
								className={cn(
									"font-mono text-[10px] leading-none opacity-60 max-md:hidden",
								)}
							>
								{i + 1}
							</span>
						) : null}
						<AnimatePresence>
							{who.length ? (
								<motion.span
									key="who"
									data-testid={PLACES_TAB_TESTID.feedReveal}
									className="pointer-events-none absolute -top-2.5 -right-1.5 flex -space-x-1.5"
									initial={reduce ? false : { scale: 0.4, opacity: 0, y: 6 }}
									animate={{ scale: 1, opacity: 1, y: 0 }}
									exit={reduce ? undefined : { scale: 0.4, opacity: 0 }}
									transition={{ type: "spring", stiffness: 520, damping: 22 }}
								>
									{who.slice(0, 3).map((m) => (
										<MemberAvatar
											key={m}
											memberId={m}
											size={20}
											className="ring-2 ring-background"
										/>
									))}
								</motion.span>
							) : null}
						</AnimatePresence>
					</button>
				);
			})}
		</fieldset>
	);
	if (!disabled || !reason) return buttons;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div>{buttons}</div>
			</TooltipTrigger>
			<TooltipContent>{reason}</TooltipContent>
		</Tooltip>
	);
}

/**
 * Ratings (One Yonder kit; PLACES §1c, DESIGN §2.4), one set for every
 * screen, replacing seven look-alikes:
 * - `RatingPill`: a rating that stands alone, on its tier colour. Nah is
 *   struck through; not rated is a quiet "–".
 * - `RatingDot`: dense lists, a dot with the label (or the dot alone).
 * - `RatingButtons`: the six buttons, each in its own colour (`filled`, the
 *   default; the chosen one gets a ring and a check, the rest step back) or
 *   the quieter `outline` set. `reveal` puts others' avatars on their picks.
 * - `RatingMenu`: a pill that opens the six levels (and Clear).
 * - `PersonRating`: someone's avatar with their rating's dot.
 * Colours come from `PRIORITIES` (light and dark pairs) through CSS
 * variables, so they follow the theme without JS.
 */
import { cn } from "cn";
import { Check, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { MemberAvatar } from "@/components/common/member";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { PRIORITIES, PRIORITY_ORDER } from "@/lib/domain/taxonomy";
import type { Priority } from "@/lib/schemas/enums";

/** The CSS variables a rating's fill, ink and dot read (light and dark). */
export function ratingVars(p: Priority): CSSProperties {
	const d = PRIORITIES[p];
	return {
		"--rt-bg": d.light.bg,
		"--rt-fg": d.light.fg,
		"--rt-dot": d.light.dot,
		"--rt-bg-d": d.dark.bg,
		"--rt-fg-d": d.dark.fg,
		"--rt-dot-d": d.dark.dot,
	} as CSSProperties;
}

/** Fill classes for a rating (with `ratingVars`). */
export const RATING_FILL =
	"bg-(--rt-bg) text-(--rt-fg) dark:bg-(--rt-bg-d) dark:text-(--rt-fg-d)";
const RATING_DOT = "bg-(--rt-dot) dark:bg-(--rt-dot-d)";

const PILL_SIZE = {
	sm: "h-[18px] px-1.5 text-[11px]",
	md: "h-[22px] px-2 text-xs",
	lg: "h-7 px-2.5 text-meta",
} as const;

export function RatingPill({
	level,
	size = "md",
	className,
	title,
	children,
}: {
	level: Priority | null | undefined;
	size?: keyof typeof PILL_SIZE;
	className?: string;
	title?: string;
	/** Another label on the tier's colour ("+6" for a score). */
	children?: ReactNode;
}) {
	if (!level)
		return (
			<span
				title={title ?? "Not rated"}
				data-priority=""
				className={cn(
					"inline-flex shrink-0 items-center justify-center font-medium text-muted-foreground/70",
					PILL_SIZE[size],
					className,
				)}
			>
				<span aria-hidden>–</span>
				<span className="sr-only">Not rated</span>
			</span>
		);
	const d = PRIORITIES[level];
	return (
		<span
			title={title ?? d.label}
			data-priority={level}
			style={ratingVars(level)}
			className={cn(
				"inline-flex shrink-0 items-center rounded-full font-medium whitespace-nowrap",
				RATING_FILL,
				d.strike && !children && "line-through",
				PILL_SIZE[size],
				className,
			)}
		>
			{children ?? d.label}
		</span>
	);
}

export function RatingDot({
	level,
	label = true,
	className,
	title,
}: {
	level: Priority | null | undefined;
	/** Show the label after the dot (dense lists); false for the dot alone. */
	label?: boolean;
	className?: string;
	title?: string;
}) {
	if (!level)
		return label ? (
			<span
				title={title ?? "Not rated"}
				data-priority=""
				className={cn(
					"inline-flex h-[18px] shrink-0 items-center text-xs leading-none text-muted-foreground/70",
					className,
				)}
			>
				<span aria-hidden>–</span>
				<span className="sr-only">Not rated</span>
			</span>
		) : null;
	const d = PRIORITIES[level];
	const dot = (
		<span
			aria-hidden
			style={label ? undefined : ratingVars(level)}
			className={cn(
				"inline-block size-2 shrink-0 rounded-full",
				RATING_DOT,
				!label && className,
			)}
		/>
	);
	if (!label) return dot;
	return (
		<span
			title={title ?? d.label}
			data-priority={level}
			style={ratingVars(level)}
			className={cn(
				"inline-flex h-[18px] shrink-0 items-center gap-1.5 text-xs leading-none whitespace-nowrap text-foreground",
				className,
			)}
		>
			{dot}
			<span className={cn(d.strike && "line-through")}>{d.label}</span>
		</span>
	);
}

export function RatingButtons({
	value,
	onRate,
	disabled,
	reason,
	variant = "filled",
	reveal,
	keys = true,
	className,
	label = "Your rating",
	buttonTestId,
	revealTestId,
}: {
	value: Priority | null;
	onRate: (p: Priority | null) => void;
	disabled?: boolean;
	/** Why they're disabled (a tooltip). */
	reason?: string | null;
	variant?: "filled" | "outline";
	/** Others' picks: rating → member ids (shown once revealed). */
	reveal?: Partial<Record<Priority, string[]>> | null;
	/** Show the 1–6 key hints (not on touch screens). */
	keys?: boolean;
	className?: string;
	label?: string;
	buttonTestId?: string;
	revealTestId?: string;
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
						data-testid={buttonTestId}
						data-priority={p}
						data-picked-by={who.join(" ") || undefined}
						onClick={() => onRate(on ? null : p)}
						style={ratingVars(p)}
						className={cn(
							"relative flex cursor-pointer items-center justify-center gap-1.5 rounded-xl text-sm font-semibold transition-[opacity,transform,box-shadow] duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[.97] disabled:cursor-not-allowed",
							filled
								? cn(
										"h-12 pointer-coarse:h-[52px]",
										RATING_FILL,
										on &&
											"shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--foreground)]",
										dim && "opacity-60",
										disabled && !on && "opacity-60",
									)
								: cn(
										"h-10 border",
										on
											? cn(RATING_FILL, "border-transparent shadow-xs")
											: "border-border bg-background hover:border-(--rt-bg) hover:bg-[color-mix(in_oklab,var(--rt-bg)_14%,transparent)] dark:hover:border-(--rt-bg-d)",
										disabled && "opacity-60",
									),
							def.strike && on && "line-through",
						)}
					>
						{on ? (
							<Check aria-hidden className="size-4" strokeWidth={2.4} />
						) : !filled ? (
							<span
								aria-hidden
								className={cn(
									"size-2 rounded-full ring-1 ring-black/10",
									RATING_DOT,
								)}
							/>
						) : null}
						{p === "sure_why_not" && filled ? "Sure" : def.label}
						{keys ? (
							<span
								aria-hidden
								className="text-[10px] leading-none opacity-60 tnum pointer-coarse:hidden"
							>
								{i + 1}
							</span>
						) : null}
						<AnimatePresence>
							{who.length ? (
								<motion.span
									key="who"
									data-testid={revealTestId}
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

/** A rating pill that opens the six levels (and Clear). */
export function RatingMenu({
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
				{trigger ?? <RatingPill level={value} />}
			</DropdownMenuTrigger>
			<DropdownMenuContent align={align} className="w-52">
				{PRIORITY_ORDER.map((p, i) => (
					<DropdownMenuItem key={p} onSelect={() => onChange(p)}>
						<RatingPill level={p} />
						{value === p ? <Check className="ml-1 size-3.5" /> : null}
						<DropdownMenuShortcut className="tnum">
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
							<DropdownMenuShortcut className="tnum">0</DropdownMenuShortcut>
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Someone's avatar with their rating's dot (a board card, a group line). */
export function PersonRating({
	memberId,
	level,
	className,
}: {
	memberId: string;
	level: Priority;
	className?: string;
}) {
	return (
		<span className={cn("inline-flex items-center gap-1", className)}>
			<MemberAvatar memberId={memberId} size={16} ring={false} />
			<RatingDot level={level} label={false} />
		</span>
	);
}

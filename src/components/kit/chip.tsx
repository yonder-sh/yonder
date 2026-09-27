/**
 * The one chip (One Yonder kit): a label with an optional icon, in one of
 * seven tones. Colour carries meaning only (DESIGN §1): `selected` is the
 * picked filter, `accent` a quiet highlight (a day, a count), `good` done or
 * booked, `warn` a conflict, `now` the now/next moment, `danger` a delete.
 * Use a Button for actions; a chip only says something.
 */
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

export const chipVariants = cva(
	"inline-flex shrink-0 items-center gap-1 rounded-full font-medium whitespace-nowrap [&_svg]:shrink-0",
	{
		variants: {
			tone: {
				neutral: "bg-muted text-muted-foreground",
				outline: "border border-border bg-background text-foreground",
				selected: "bg-foreground text-background",
				accent: "bg-accent text-accent-foreground",
				good: "bg-good-wash text-good",
				warn: "bg-warning-wash text-warning",
				now: "bg-glow/20 text-glow-foreground dark:text-glow",
				danger: "bg-destructive/10 text-destructive",
			},
			size: {
				sm: "h-5 px-1.5 text-2xs [&_svg]:size-3",
				md: "h-6 px-2 text-xs [&_svg]:size-3.5",
				lg: "h-7 px-2.5 text-meta [&_svg]:size-4",
			},
		},
		defaultVariants: { tone: "neutral", size: "md" },
	},
);

export type ChipTone = NonNullable<VariantProps<typeof chipVariants>["tone"]>;

export function Chip({
	tone,
	size,
	icon: Icon,
	className,
	children,
	...props
}: React.ComponentProps<"span"> &
	VariantProps<typeof chipVariants> & { icon?: LucideIcon }) {
	return (
		<span
			data-slot="chip"
			data-tone={tone ?? "neutral"}
			className={cn(chipVariants({ tone, size }), className)}
			{...props}
		>
			{Icon ? <Icon aria-hidden strokeWidth={2} /> : null}
			{children}
		</span>
	);
}

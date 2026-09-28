/**
 * The one on/off filter pill (One Yonder kit): "Everyone's", "Near Shibuya",
 * "Shortlist 12", a closed weekday, a person. Off is an outline; on takes the
 * kit's selected look (the Chip `selected` tone, a foreground fill). A toggle
 * button (`aria-pressed`); for one of a few views, use Segmented.
 */

import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { type AvatarPerson, MemberAvatar } from "@/components/common/member";
import { cn } from "@/lib/utils";

const SIZE = {
	sm: "h-(--control-sm) gap-1 px-2.5 text-xs [&>svg]:size-3.5",
	md: "h-(--control) gap-1.5 px-3 text-meta [&>svg]:size-4",
} as const;

export type FilterPillSize = keyof typeof SIZE;

export function FilterPill({
	pressed,
	onPressedChange,
	icon: Icon,
	memberId,
	user,
	count,
	size = "md",
	onClick,
	className,
	children,
	...props
}: Omit<React.ComponentProps<"button">, "type"> & {
	pressed: boolean;
	/** Called with the flipped state on every click. */
	onPressedChange?: (pressed: boolean) => void;
	icon?: LucideIcon;
	/** A person's avatar in front, instead of an icon (with no label, pass an aria-label). */
	memberId?: string;
	user?: AvatarPerson;
	/** A count after the label ("Shortlist 12"). */
	count?: number | null;
	size?: FilterPillSize;
}) {
	const avatar = Boolean(memberId || user);
	return (
		<button
			{...props}
			type="button"
			aria-pressed={pressed}
			data-slot="filter-pill"
			data-state={pressed ? "on" : "off"}
			onClick={(e) => {
				onClick?.(e);
				onPressedChange?.(!pressed);
			}}
			className={cn(
				"inline-flex shrink-0 cursor-pointer items-center rounded-full border font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>svg]:shrink-0",
				SIZE[size],
				pressed
					? "border-foreground bg-foreground text-background enabled:hover:bg-foreground/90"
					: "border-border bg-background text-foreground enabled:hover:bg-accent",
				avatar && (size === "sm" ? "pl-1" : "pl-1.5"),
				className,
			)}
		>
			{avatar ? (
				// The label names the person; the avatar's initials would repeat it.
				<span aria-hidden className="inline-flex shrink-0">
					<MemberAvatar
						memberId={memberId}
						user={user}
						size={20}
						ring={false}
					/>
				</span>
			) : Icon ? (
				<Icon aria-hidden strokeWidth={1.75} />
			) : null}
			{children}
			{count != null ? (
				<span data-slot="filter-pill-count" className="text-xs tnum opacity-70">
					{count}
				</span>
			) : null}
		</button>
	);
}

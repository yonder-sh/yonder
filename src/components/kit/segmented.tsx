/**
 * The one segmented control (One Yonder kit): a few mutually exclusive views
 * ("Days · Cities & nights", "Shortlist · Disagreements · Not going"). The
 * picked one sits on a raised thumb in a muted track. A radio group: arrows
 * move between options, and the value is never empty.
 */

import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
	value: T;
	label: ReactNode;
	/** A count after the label ("Shortlist 4"). */
	count?: number | null;
	disabled?: boolean;
	testId?: string;
};

export function Segmented<T extends string>({
	value,
	onValueChange,
	options,
	label,
	size = "md",
	full = false,
	disabled,
	testId,
	className,
}: {
	value: T;
	onValueChange: (v: T) => void;
	options: readonly SegmentedOption<T>[];
	/** The group's accessible name. */
	label: string;
	size?: "sm" | "md";
	/** Stretch across its container (phones). */
	full?: boolean;
	disabled?: boolean;
	testId?: string;
	className?: string;
}) {
	return (
		<ToggleGroupPrimitive.Root
			type="single"
			value={value}
			onValueChange={(v) => {
				if (v) onValueChange(v as T);
			}}
			aria-label={label}
			disabled={disabled}
			data-testid={testId}
			data-slot="segmented"
			className={cn(
				"inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5",
				full && "flex w-full",
				className,
			)}
		>
			{options.map((o) => (
				<ToggleGroupPrimitive.Item
					key={o.value}
					value={o.value}
					disabled={o.disabled}
					data-testid={o.testId}
					data-value={o.value}
					className={cn(
						"inline-flex items-center justify-center gap-1.5 rounded-md px-3 font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
						"data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs dark:data-[state=on]:bg-accent",
						size === "sm"
							? "h-6 text-xs pointer-coarse:h-8"
							: "h-7 text-meta pointer-coarse:h-9",
						full && "flex-1",
					)}
				>
					{o.label}
					{o.count != null ? (
						<span className="text-xs text-muted-foreground tnum">
							{o.count}
						</span>
					) : null}
				</ToggleGroupPrimitive.Item>
			))}
		</ToggleGroupPrimitive.Root>
	);
}

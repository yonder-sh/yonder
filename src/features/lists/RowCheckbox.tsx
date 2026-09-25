/**
 * A list row's checkbox (DESIGN §7.3): a 16px box inside a larger hit area,
 * 44×44 on phones (QA MOB-07 "todo checkboxes") and 28×28 from `md`. Negative
 * margins keep the row's layout as if only the box were there, so the box
 * sits exactly where the plain 16px checkbox did.
 */
import { cn } from "cn";
import { CheckIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type * as React from "react";

export function RowCheckbox({
	className,
	...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			className={cn(
				"group/check grid shrink-0 place-items-center rounded-md outline-none disabled:cursor-not-allowed",
				// Hit area: 44px on phones, 28px from md; the 16px box keeps its place (2px from the top).
				"-mx-3.5 -mt-3 -mb-3.5 size-11 md:-mx-1.5 md:-mt-1 md:-mb-1.5 md:size-7",
				className,
			)}
			{...props}
		>
			<span
				aria-hidden
				className={cn(
					"grid size-4 place-content-center rounded-[4px] border border-muted-foreground/50 shadow-xs transition-shadow",
					"group-focus-visible/check:border-ring group-focus-visible/check:ring-[3px] group-focus-visible/check:ring-ring/50",
					"group-disabled/check:opacity-50",
					"group-data-[state=checked]/check:border-foreground group-data-[state=checked]/check:bg-foreground group-data-[state=checked]/check:text-background",
					"dark:bg-input/30 dark:group-data-[state=checked]/check:bg-foreground",
				)}
			>
				<CheckboxPrimitive.Indicator className="grid place-content-center text-current transition-none">
					<CheckIcon className="size-3.5" />
				</CheckboxPrimitive.Indicator>
			</span>
		</CheckboxPrimitive.Root>
	);
}

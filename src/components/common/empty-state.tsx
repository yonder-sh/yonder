import { cn } from "cn";
import type { ReactNode } from "react";
import { TESTID } from "@/lib/testids";

/**
 * DESIGN §12: every empty state is ONE line (Parkinsans 17/500) and ONE
 * action. No illustrations. `lead`: what the tab is for, above the line.
 */
export function EmptyState({
	line,
	action,
	lead,
	className,
}: {
	line: ReactNode;
	action?: ReactNode;
	lead?: ReactNode;
	className?: string;
}) {
	return (
		<div
			data-testid={TESTID.emptyState}
			className={cn(
				"flex flex-col items-center justify-center gap-4 px-6 py-10 text-center",
				className,
			)}
		>
			{lead ? <div className="-mb-2 max-w-sm">{lead}</div> : null}
			<p className="font-display text-[17px] leading-6 font-medium text-foreground text-balance">
				{line}
			</p>
			{action ? <div>{action}</div> : null}
		</div>
	);
}

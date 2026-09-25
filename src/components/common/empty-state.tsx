import { cn } from "cn";
import type { ReactNode } from "react";
import { TESTID } from "@/lib/testids";

/**
 * DESIGN §12: every empty state is ONE line (Parkinsans 17/500) and ONE
 * action. No illustrations.
 */
export function EmptyState({
	line,
	action,
	className,
}: {
	line: ReactNode;
	action?: ReactNode;
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
			<p className="font-display text-[17px] leading-6 font-medium text-foreground text-balance">
				{line}
			</p>
			{action ? <div>{action}</div> : null}
		</div>
	);
}

import { cn } from "cn";
import type { ReactNode } from "react";
import { TESTID } from "@/lib/testids";

/**
 * Used only by functional stubs (SPEC §12.6): a quiet, dashed frame that says
 * which package replaces it, around whatever minimal content the stub shows.
 */
export function StubPanel({
	name,
	owner,
	children,
	className,
}: {
	name: string;
	owner?: string;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<section
			data-testid={TESTID.stubPanel}
			data-stub={name}
			aria-label={name}
			className={cn(
				"rounded-lg border border-dashed border-border/80 p-3 text-sm",
				className,
			)}
		>
			<header className="mb-2 flex items-center justify-between gap-2 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
				<span>{name}</span>
				{owner ? (
					<span className="font-mono font-medium tracking-normal normal-case">
						{owner}
					</span>
				) : null}
			</header>
			{children}
		</section>
	);
}

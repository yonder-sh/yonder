import type { ReactNode } from "react";
import { RouteSketch } from "./route-sketch";
import { YonderLockup } from "./yonder-lockup";

/**
 * The split layout shared by /login and /welcome (DESIGN §10.1):
 * form on the left (max 360 wide, vertically centred), the route sketch on the
 * right at ≥ 1024 px; below that, a 120 px strip of the sketch on top.
 */
export function AuthShell({
	title,
	subtitle,
	children,
	footer,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	children: ReactNode;
	footer?: ReactNode;
}) {
	return (
		<div className="flex min-h-svh flex-col bg-background text-foreground lg:grid lg:grid-cols-2">
			<div className="relative h-[120px] shrink-0 overflow-hidden border-b bg-[color-mix(in_oklch,var(--primary)_7%,var(--background))] lg:hidden">
				<RouteSketch />
			</div>
			<main className="flex flex-1 flex-col px-8 py-8 lg:py-12">
				<YonderLockup className="h-7 self-start" />
				<div className="flex flex-1 items-center">
					<div className="mx-auto w-full max-w-[360px] py-10">
						<h1 className="font-display text-[2rem] leading-[1.19] font-semibold tracking-[-0.02em] text-pretty">
							{title}
						</h1>
						{subtitle ? (
							<p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
						) : null}
						<div className="mt-8">{children}</div>
					</div>
				</div>
				{footer ? (
					<div className="text-xs text-muted-foreground">{footer}</div>
				) : null}
			</main>
			<aside className="relative hidden overflow-hidden border-l bg-[color-mix(in_oklch,var(--primary)_7%,var(--background))] lg:block">
				<RouteSketch />
			</aside>
		</div>
	);
}

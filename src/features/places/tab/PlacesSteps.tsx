/**
 * The Places tab's three steps (owner, 2026-09-25): **1 Rate · 2 Review ·
 * 3 Schedule**, each with its count ("12 to rate", "48 places", "9
 * shortlisted · 4 not on a day"). The step with work waiting for you has
 * the apricot "next" dot (DESIGN §1: now / next). The step is the URL's
 * view (`pv`), so it deep-links and follows like the rest of the tab.
 */
import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import {
	FLOW_STEPS,
	type FlowStep,
	type FlowTally,
	STEP_LABEL,
	stepCounts,
} from "./flow";
import { PLACES_TAB_TESTID } from "./testids";

export function PlacesSteps({
	step,
	tally,
	next,
	onStep,
	phone = false,
	children,
}: {
	step: FlowStep;
	tally: FlowTally;
	/** The step with work waiting for you (the dot). */
	next: FlowStep | null;
	onStep: (s: FlowStep) => void;
	phone?: boolean;
	/** Extra controls at the end of the bar ("Add a place", wide mode). */
	children?: ReactNode;
}) {
	const counts = stepCounts(tally, { short: phone });
	return (
		<nav
			aria-label="Plan your places"
			data-testid={PLACES_TAB_TESTID.steps}
			data-step={step}
			className={cn(
				"flex shrink-0 items-stretch border-b",
				phone ? "px-1.5" : "gap-1 px-3",
			)}
		>
			<ol className="flex min-w-0 flex-1 items-stretch">
				{FLOW_STEPS.map((s, i) => {
					const on = s === step;
					return (
						// The phone sizes steps by their words, so each label fits at 390 px.
						<li
							key={s}
							className={cn(
								"flex min-w-0 items-stretch",
								phone ? "flex-auto" : "flex-1",
							)}
						>
							{i ? (
								<ChevronRight
									aria-hidden
									className={cn(
										"shrink-0 self-center text-muted-foreground/50",
										phone ? "-mx-1 size-3.5" : "size-4",
									)}
								/>
							) : null}
							<button
								type="button"
								data-testid={PLACES_TAB_TESTID.step}
								data-step={s}
								data-next={next === s || undefined}
								aria-current={on ? "step" : undefined}
								onClick={() => onStep(s)}
								className={cn(
									"group relative flex min-w-0 flex-1 cursor-pointer items-center rounded-md text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
									phone ? "gap-1.5 px-1.5 py-2" : "gap-2.5 px-3 py-2.5",
									on
										? "text-foreground"
										: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
								)}
							>
								<span
									className={cn(
										"relative grid shrink-0 place-items-center rounded-full font-mono font-semibold tnum transition-colors",
										phone ? "size-6 text-xs" : "size-7 text-[13px]",
										on
											? "bg-primary text-primary-foreground"
											: "border border-border bg-background text-muted-foreground group-hover:text-foreground",
									)}
								>
									{i + 1}
									{next === s ? (
										<span
											data-testid={PLACES_TAB_TESTID.stepDot}
											title="Waiting for you"
											className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-glow ring-2 ring-background"
										/>
									) : null}
								</span>
								<span className="flex min-w-0 flex-col">
									<span
										className={cn(
											"truncate font-semibold",
											phone ? "text-[13px] leading-4" : "text-sm leading-5",
										)}
									>
										{STEP_LABEL[s]}
									</span>
									<span
										data-testid={PLACES_TAB_TESTID.stepCount}
										title={counts[s]}
										className={cn(
											"truncate text-muted-foreground",
											phone ? "text-[11px] leading-4" : "text-xs leading-4",
										)}
									>
										{counts[s]}
									</span>
								</span>
								{/* The current step's underline, like a tab. */}
								{on ? (
									<span
										aria-hidden
										className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary"
									/>
								) : null}
							</button>
						</li>
					);
				})}
			</ol>
			{children ? (
				<div className="flex shrink-0 items-center gap-1.5 pl-2">
					{children}
				</div>
			) : null}
		</nav>
	);
}

/**
 * The Places page's header (One Yonder D06): "Places" and its views as one
 * segmented control, **All places · Rate · Schedule**, each with its count
 * ("125", "47 left"; the full line in its title). The view with work
 * waiting for you has the apricot "next" dot (DESIGN §1: now / next). The
 * view is the URL's (`pv`), so it deep-links and follows like the rest of
 * the tab. Actions ("Show map", "Add a place") end the row.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
	type FlowStep,
	type FlowTally,
	STEP_LABEL,
	stepBadges,
	stepCounts,
} from "./flow";
import { PLACES_TAB_TESTID } from "./testids";

/** D06's order: the places first, then rating, then onto the days. */
const ORDER: readonly FlowStep[] = ["review", "rate", "decide", "schedule"];

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
	/** The row's actions ("Show map", "Add a place"). */
	children?: ReactNode;
}) {
	const counts = stepCounts(tally, { short: phone });
	const badges = stepBadges(tally);
	return (
		<nav
			aria-label="Plan your places"
			data-testid={PLACES_TAB_TESTID.steps}
			data-step={step}
			className={cn(
				"flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2",
				phone ? "px-3 pt-3 pb-2" : "px-4 pt-4 pb-3 sm:px-6",
			)}
		>
			{phone ? null : (
				<h2 className="font-display text-2xl leading-8 font-semibold">
					Places
				</h2>
			)}
			<ol
				className={cn(
					"flex h-(--control) min-w-0 items-stretch gap-0.5 rounded-lg bg-muted p-0.5",
					phone && "flex-1",
				)}
			>
				{ORDER.map((s) => {
					const on = s === step;
					return (
						<li key={s} className={cn("flex min-w-0", phone && "flex-1")}>
							<button
								type="button"
								data-testid={PLACES_TAB_TESTID.step}
								data-step={s}
								data-next={next === s || undefined}
								aria-current={on ? "step" : undefined}
								title={`${STEP_LABEL[s]} · ${counts[s]}`}
								onClick={() => onStep(s)}
								className={cn(
									"relative flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
									phone ? "px-1.5" : "px-3",
									on
										? "bg-background text-foreground shadow-xs"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<span className="truncate">{STEP_LABEL[s]}</span>
								{/* A phone's 390px keeps only the words (the counts are in the title). */}
								{badges[s] && !phone ? (
									<span
										data-testid={PLACES_TAB_TESTID.stepCount}
										className={cn(
											"text-xs font-normal tnum",
											on && s === "rate"
												? "rounded-full bg-primary/10 px-1.5 text-primary"
												: "text-muted-foreground",
										)}
									>
										{badges[s]}
									</span>
								) : null}
								{next === s ? (
									<span
										data-testid={PLACES_TAB_TESTID.stepDot}
										title="Waiting for you"
										className="absolute top-1 right-1 size-1.5 rounded-full bg-glow"
									/>
								) : null}
							</button>
						</li>
					);
				})}
			</ol>
			{children ? (
				<div className="ml-auto flex shrink-0 items-center gap-2">
					{children}
				</div>
			) : null}
		</nav>
	);
}

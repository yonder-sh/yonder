/**
 * FB-05 (owner feedback), now into the Places tab (docs/PLACES.md §1b: the
 * old Rate screen is the tab's Rate view). The workspace chrome leads to it
 * from:
 * - the top bar's "Rate" (desktop and tablet; icon-only at md),
 * - "Rate places" in the trip-title menu and the phone's ⋯ menu,
 * - Still to plan's unrated counts (`StillToPlan.tsx`);
 * - ⌘K "Rate places" is WP-Places' palette (`AddPlaceDialog`, same target).
 *
 * Inside a scope that has places to rate it opens on that scope ("Rate places
 * in Tokyo"), else on the whole trip. The top bar's Rate shows how many are
 * left for you there (the flow, owner 2026-09-25); the phone has the Places
 * tab's floating Rate pill instead.
 */
import { Star } from "lucide-react";
import { type MouseEvent, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { rateableNodes } from "@/features/places/lib/rate";
import { useFlowTally } from "@/features/places/tab/use-flow";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { SHELL_TESTID } from "./testids";

export type RateTarget = {
	/** The scope the feed opens on (null: the whole trip). */
	scopeId: string | null;
	/** "Rate places" or "Rate places in Tokyo". */
	label: string;
	href: string;
	go: () => void;
};

/** Where "Rate" leads from here (the current scope, or the whole trip). */
export function useRateTarget(): RateTarget {
	const { ix, graph, scope, nav } = useWorkspace();
	return useMemo(() => {
		// The feed's set: live places only (no proposal ghosts).
		const liveIds = new Set(graph.nodes.map((n) => n.id));
		const inScope =
			scope &&
			liveIds.has(scope.id) &&
			rateableNodes(ix, scope.id, { liveIds }).length > 0
				? scope
				: null;
		const opts = {
			scopeId: inScope?.id ?? null,
			// The whole pile: the Add step's status pills stay with it.
			patch: { pv: "rate" as const, pst: undefined, talk: undefined },
		};
		return {
			scopeId: opts.scopeId,
			label: inScope ? `Rate places in ${inScope.name}` : "Rate places",
			href: nav.hrefPlaces(opts),
			go: () => nav.openPlaces(opts),
		};
	}, [ix, graph.nodes, scope, nav]);
}

/** A plain click navigates in place; a modified one opens the href. */
function onLink(go: () => void) {
	return (e: MouseEvent) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
			return;
		e.preventDefault();
		go();
	};
}

/** The top bar's "Rate" (a ghost button, like ⌘K; `compact` keeps the icon only). */
export function RateButton({ compact = false }: { compact?: boolean }) {
	const t = useRateTarget();
	const left = useFlowTally(t.scopeId).toRate ?? 0;
	return (
		<Button variant="ghost" size="sm" asChild>
			<a
				href={t.href}
				onClick={onLink(t.go)}
				title={t.label}
				data-testid={SHELL_TESTID.rateButton}
				data-count={left}
			>
				<Star />
				<span className={compact ? "sr-only" : undefined}>Rate</span>
				{left ? (
					<span
						className="font-mono text-xs text-muted-foreground tnum"
						title={`${left} to rate`}
					>
						{left}
					</span>
				) : null}
			</a>
		</Button>
	);
}

/** "Rate places" in the trip-title menu and the phone's ⋯ menu. */
export function RateMenuItem() {
	const t = useRateTarget();
	return (
		<DropdownMenuItem
			data-testid={SHELL_TESTID.rateMenuItem}
			onSelect={() => t.go()}
		>
			<Star /> {t.label}
		</DropdownMenuItem>
	);
}

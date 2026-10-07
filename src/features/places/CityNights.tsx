/**
 * Nights from the route (owner, 2026-10-07: one way to say how long in each
 * city, Cities & nights). A city's overview shows its nights; a country or
 * region lists its cities' nights. Both open Cities & nights to change them.
 */

import { nightsByPlace } from "@/lib/engine/day-place";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { PLACES_TESTID } from "./testids";

const nightsText = (n: number) => `${n} ${n === 1 ? "night" : "nights"}`;

function ChangeNights() {
	const { nav } = useWorkspace();
	const askSplit = useUi((s) => s.askSplit);
	return (
		<button
			type="button"
			data-testid={PLACES_TESTID.changeNights}
			className="text-meta text-primary hover:underline"
			onClick={() => {
				nav.setTab("plan");
				askSplit(true);
			}}
		>
			Cities & nights
		</button>
	);
}

/** "3 nights · Cities & nights" for one city. */
export function CityNightsLine({ nodeId }: { nodeId: string }) {
	const { ix } = useWorkspace();
	const n = nightsByPlace(ix).find((r) => r.placeId === nodeId)?.nights ?? 0;
	return (
		<span
			className="flex flex-wrap items-baseline gap-x-2"
			data-testid={PLACES_TESTID.cityNights}
		>
			<span className={n ? "tnum" : "text-muted-foreground"}>
				{n ? nightsText(n) : "None yet"}
			</span>
			<ChangeNights />
		</span>
	);
}

/** The route's cities inside a country or region, with their nights. */
export function ScopeNights({ scopeId }: { scopeId: string }) {
	const { ix, nav } = useWorkspace();
	const rows = nightsByPlace(ix, scopeId);
	return (
		<div className="grid gap-1" data-testid={PLACES_TESTID.scopeNights}>
			{rows.length ? (
				<ul className="grid gap-0.5">
					{rows.map((r) => (
						<li
							key={r.placeId}
							className="flex items-baseline justify-between gap-2 text-meta"
						>
							<button
								type="button"
								onClick={() => nav.select({ kind: "node", id: r.placeId })}
								className="min-w-0 truncate text-left hover:underline"
							>
								{ix.node(r.placeId)?.name}
							</button>
							<span className="tnum text-muted-foreground">
								{nightsText(r.nights)}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p className="text-meta text-muted-foreground">No nights here yet.</p>
			)}
			<div>
				<ChangeNights />
			</div>
		</div>
	);
}

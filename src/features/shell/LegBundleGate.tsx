/**
 * A leg has no bundle until its row exists (SPEC §6.5, R2). When the selected
 * leg has no row yet, the inspector's Media / Lists / Notes tabs stay enabled
 * for anyone who can edit (or suggest) and show this gate: one click runs
 * `ensureLeg(target)` (idempotent, `{ direct: 'propose' }`), the graph
 * refetches (this tab invalidates it itself), and the real panel with
 * `{ kind: 'leg', legId }` replaces the gate. Viewers see the plain empty
 * state. See CONTRACTS §4.1.
 */
import { EmptyState } from "@/components/common/empty-state";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import { ensureLeg } from "@/functions/legs.functions";
import { tripKeys } from "@/lib/query/keys";
import type { LegTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";

const WHAT = {
	media: "photos and links",
	lists: "to-dos and shopping",
	notes: "notes",
} as const;

export function LegBundleGate({
	target,
	tab,
}: {
	target: LegTarget;
	tab: keyof typeof WHAT;
}) {
	const { graph, access, mode } = useWorkspace();
	const ensure = useTripMutation(() => ensureLeg({ data: { target } }), {
		keys: [tripKeys.graph(graph.trip.id)],
		tripId: graph.trip.id,
	});
	const canStart = access.canEdit && mode === "live";
	return (
		<EmptyState
			line={`No ${WHAT[tab]} on this stretch yet.`}
			action={
				canStart ? (
					<Button
						size="sm"
						variant="outline"
						disabled={ensure.isPending}
						onClick={() => ensure.mutate(undefined)}
						data-testid="leg-bundle-start"
					>
						Add {WHAT[tab]}
					</Button>
				) : null
			}
		/>
	);
}

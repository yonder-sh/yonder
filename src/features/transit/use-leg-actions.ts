/**
 * Leg actions other packages call (SPEC §12.5 `useLegActions()`), e.g. the
 * Plan's one-click "Use transit ~1h43" accept chip.
 *
 * `accept(target, mode)` stores the suggested mode with the estimate's
 * minutes (`source: 'estimate'`) through `setLeg` (a proposal in suggest
 * mode), then — for editors, online — refines it in the background: the walk
 * chain for walks (Google/OSRM), the provider chain for transit (Google
 * outside Japan, the N02 estimate in Japan; fastest option chosen). Refining
 * is edit-only and never overrides a choice made meanwhile.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { setLeg } from "@/functions/legs.functions";
import { tripKeys } from "@/lib/query/keys";
import type { LegMode } from "@/lib/schemas/enums";
import { isProposed } from "@/lib/schemas/proposals";
import type { LegTarget } from "@/lib/schemas/targets";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { legKeyOf } from "./lib/endpoints";
import { estimateWalk, getTransitOptions } from "./transit.functions";

export function useLegActions(): {
	accept(target: LegTarget, mode: LegMode): Promise<void>;
} {
	const { schedule, graph, access, mode: wsMode } = useWorkspace();
	const qc = useQueryClient();
	const accept = useCallback(
		async (target: LegTarget, mode: LegMode) => {
			const s = schedule.legs[legKeyOf(target)];
			const suggestion = s?.suggestion;
			const est = suggestion?.mode === mode ? suggestion.estimateMin : null;
			const tripId = graph.trip.id;
			const refresh = () =>
				Promise.all([
					qc.invalidateQueries({ queryKey: tripKeys.graph(tripId) }),
					qc.invalidateQueries({ queryKey: tripKeys.legs(tripId) }),
				]);
			const res = await setLeg({
				data: {
					target,
					patch: {
						mode,
						durationMin: est ?? null,
						estimateMin: est ?? null,
						source: "estimate",
						// A distance is a measured walk's; the walk chain sets it.
						...(mode === "walk" ? {} : { distanceM: null }),
					},
				},
			});
			// The graph is invalidated here: this tab skips its own live event.
			await refresh();
			if (isProposed(res)) {
				await qc.invalidateQueries({ queryKey: tripKeys.proposals(tripId) });
				return;
			}
			const editor =
				wsMode === "live" &&
				access.mode === "edit" &&
				!useUi.getState().suggesting &&
				(typeof navigator === "undefined" || navigator.onLine !== false);
			if (!editor) return;
			try {
				if (mode === "walk")
					await estimateWalk({ data: { target, apply: true } });
				else if (mode === "transit")
					await getTransitOptions({
						data: {
							target,
							departAt: (s?.start ?? new Date()).toISOString(),
						},
					});
				else return;
				await refresh();
			} catch {
				// The estimate stays; the inspector offers "Find routes".
			}
		},
		[schedule, graph.trip.id, qc, access.mode, wsMode],
	);
	return { accept };
}

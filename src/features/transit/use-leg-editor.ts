/**
 * Everything the leg editor needs for one target: the leg (graph + row with
 * alternatives), its ends, its schedule, and the mutations (each invalidates
 * the graph and leg queries of this tab — the live event skips it).
 */
import { useMemo } from "react";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { ensureLeg, setLeg, setLegAssignees } from "@/functions/legs.functions";
import { mustRedact } from "@/lib/auth/roles";
import type { LegMode, LegSource } from "@/lib/schemas/enums";
import type {
	FixedTimes,
	FlightDetails,
	LegDetails,
	TransitBooking,
	TransitRoute,
} from "@/lib/schemas/legs";
import { readLegDetails } from "@/lib/schemas/legs";
import type { LegTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { legEnds, touchesJapan } from "./lib/endpoints";
import { legKeys, useLegRow } from "./queries";
import {
	chooseTransitOption,
	deleteCustomRoute,
	estimateWalk,
	getTransitOptions,
	lockTransitTimes,
	resetLegEstimate,
	saveCustomRoute,
	saveFlight,
	saveTransitDetails,
	updateCustomRoute,
} from "./transit.functions";

export type LegPatch = {
	mode?: LegMode | null;
	durationMin?: number | null;
	distanceM?: number | null;
	source?: LegSource;
	estimateMin?: number | null;
	isEdited?: boolean;
	details?: LegDetails;
};

export function useLegEditor(target: LegTarget) {
	const ws = useWorkspace();
	const { ix, schedule, graph, access } = ws;
	const tripId = graph.trip.id;
	const leg =
		(target.kind === "pair"
			? ix.legByPair.get(`${target.fromItemId}>${target.toItemId}`)
			: ix.legByStay.get(`${target.dayId}:${target.end}`)) ?? null;
	const details = leg ? readLegDetails(leg.details) : null;
	const ends = useMemo(() => legEnds(ix, target), [ix, target]);
	const sched = schedule.legs[ends.key] ?? null;
	const rowQuery = useLegRow(target);
	const alternatives: TransitRoute[] = rowQuery.data?.alternatives ?? [];
	const keys = legKeys(tripId);
	const opts = { keys, tripId };
	const live = ws.mode === "live";
	const redacted = mustRedact({ role: access.role, isGuest: access.isGuest });

	const patch = useTripMutation(
		(v: { patch: LegPatch; expectedUpdatedAt?: string }) =>
			setLeg({ data: { target, ...v } }),
		opts,
	);
	const walk = useTripMutation(
		() => estimateWalk({ data: { target, apply: true } }),
		opts,
	);
	/** `refresh`: the person asked ("Refresh routes"), so skip provider caches. */
	const fetchOptions = useTripMutation(
		(v: { departAt: string; refresh?: boolean }) =>
			getTransitOptions({
				data: {
					target,
					departAt: v.departAt,
					...(v.refresh ? { refresh: true } : {}),
				},
			}),
		opts,
	);
	const choose = useTripMutation(
		(optionId: string) => chooseTransitOption({ data: { target, optionId } }),
		opts,
	);
	const lock = useTripMutation(
		(optionId: string) => lockTransitTimes({ data: { target, optionId } }),
		opts,
	);
	const saveRoute = useTripMutation(
		(route: TransitRoute) => saveCustomRoute({ data: { target, route } }),
		opts,
	);
	const updateRoute = useTripMutation(
		(v: { routeId: string; route: TransitRoute; expectedUpdatedAt?: string }) =>
			updateCustomRoute({ data: { target, ...v } }),
		opts,
	);
	const deleteRoute = useTripMutation(
		(routeId: string) => deleteCustomRoute({ data: { target, routeId } }),
		opts,
	);
	const saveDetails = useTripMutation(
		(v: {
			fixed?: FixedTimes | null;
			booking?: TransitBooking | null;
			expectedUpdatedAt?: string;
		}) => saveTransitDetails({ data: { target, ...v } }),
		opts,
	);
	const flight = useTripMutation(
		(v: { flight: FlightDetails; expectedUpdatedAt?: string }) =>
			saveFlight({ data: { target, ...v } }),
		opts,
	);
	const reset = useTripMutation(
		() => resetLegEstimate({ data: { target } }),
		opts,
	);
	const travellers = useTripMutation(async (memberIds: string[]) => {
		const legId = leg?.id ?? (await ensureLeg({ data: { target } })).legId;
		return setLegAssignees({ data: { legId, memberIds } });
	}, opts);
	const ensure = async (): Promise<string> =>
		leg?.id ?? (await ensureLeg({ data: { target } })).legId;

	return {
		ws,
		target,
		tripId,
		leg,
		details,
		ends,
		sched,
		row: rowQuery.data ?? null,
		rowLoading: rowQuery.isLoading,
		alternatives,
		japan: touchesJapan(ends),
		live,
		redacted,
		patch,
		walk,
		fetchOptions,
		choose,
		lock,
		saveRoute,
		updateRoute,
		deleteRoute,
		saveDetails,
		flight,
		reset,
		travellers,
		ensure,
	};
}

export type LegEditor = ReturnType<typeof useLegEditor>;

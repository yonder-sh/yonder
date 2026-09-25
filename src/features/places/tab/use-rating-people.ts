/**
 * The people who rate, in the UI: who was reminded lately (and your own
 * reminder), "Remind", and leaving someone's ratings out or counting them
 * again (`rating.functions.ts`).
 */
import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { can, canRateOwn } from "@/lib/auth/roles";
import type { GraphMember, TripGraph } from "@/lib/engine/types";
import { tripKeys } from "@/lib/query/keys";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	dismissRateReminder,
	getRateReminders,
	type RateReminders,
	remindToRate,
	setRatingsCounted,
} from "../rating.functions";

/** Under `sharing`: a reminder's live event refreshes it. */
export const remindersQuery = (tripId: string) =>
	queryOptions({
		queryKey: [...tripKeys.sharing(tripId), "rate-reminders"] as const,
		queryFn: (): Promise<RateReminders> =>
			getRateReminders({ data: { tripId } }),
		staleTime: 60_000,
	});

export function useRateReminders(): RateReminders | undefined {
	const { graph, mode } = useWorkspace();
	return useQuery({
		...remindersQuery(graph.trip.id),
		enabled: mode === "live",
	}).data;
}

/** Why someone gets no Remind: you, no account, left out, or nothing left. */
export function remindable(
	m: Pick<GraphMember, "id" | "status" | "userId" | "ratingsCounted" | "role">,
	me: string | null,
	left: number,
): boolean {
	return (
		m.id !== me &&
		m.status === "active" &&
		!!m.userId &&
		m.ratingsCounted !== false &&
		m.role !== "viewer" &&
		left > 0
	);
}

/** You may remind people: you rate on this trip, and it's live. */
export function useCanRemind(): boolean {
	const { access, mode } = useWorkspace();
	return mode === "live" && canRateOwn(access);
}

export function useRemind() {
	const { graph } = useWorkspace();
	const qc = useQueryClient();
	const key = remindersQuery(graph.trip.id).queryKey;
	return useMutation({
		mutationFn: (v: { memberId: string; name: string }) =>
			remindToRate({ data: { tripId: graph.trip.id, memberId: v.memberId } }),
		onSuccess: (r, v) => {
			qc.setQueryData<RateReminders>(key, (old) => ({
				recent: [
					...(old?.recent ?? []).filter((x) => x.memberId !== v.memberId),
					{ memberId: v.memberId, at: r.at },
				],
				mine: old?.mine ?? null,
			}));
			toast.success(`Reminded ${v.name}`);
		},
		onSettled: () => qc.invalidateQueries({ queryKey: key }),
	});
}

export function useDismissReminder() {
	const { graph } = useWorkspace();
	const qc = useQueryClient();
	const key = remindersQuery(graph.trip.id).queryKey;
	return useMutation({
		mutationFn: () => dismissRateReminder({ data: { tripId: graph.trip.id } }),
		onMutate: () =>
			qc.setQueryData<RateReminders>(key, (old) =>
				old ? { ...old, mine: null } : old,
			),
		onSettled: () => qc.invalidateQueries({ queryKey: key }),
	});
}

/** Owners and editors leave someone's ratings out (like the shortlist level). */
export function useCanCountRatings(): boolean {
	const { access, mode } = useWorkspace();
	return (
		mode === "live" &&
		can(access, "tripSettings") &&
		access.mode === "edit" &&
		access.canEdit
	);
}

export function useSetRatingsCounted() {
	const { graph } = useWorkspace();
	const tripId = graph.trip.id;
	return useTripMutation(
		(v: { memberId: string; counted: boolean }) =>
			setRatingsCounted({ data: v }),
		{
			keys: [tripKeys.graph(tripId)],
			optimistic: (qc, v) =>
				qc.setQueryData<TripGraph>(tripKeys.graph(tripId), (g) =>
					g
						? {
								...g,
								members: g.members.map((m) =>
									m.id === v.memberId ? { ...m, ratingsCounted: v.counted } : m,
								),
							}
						: g,
				),
		},
	);
}

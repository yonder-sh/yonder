/**
 * Whether a trip can be read offline, and from when (SPEC §12.5
 * `useOfflineAvailability(tripId)`, §16.4): the persisted graph's
 * `dataUpdatedAt` (restored from IndexedDB by the persister) — and only for
 * the saved trip (the one kept offline, QA PWA-05). Re-renders when the
 * graph refetches.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { tripKeys } from "@/lib/query/keys";
import { readSavedTrips } from "./saved-trips";

export function useOfflineAvailability(tripId: string | null | undefined): {
	available: boolean;
	savedAt: number | null;
} {
	const qc = useQueryClient();
	const subscribe = useCallback(
		(cb: () => void) => {
			const key = tripId ? JSON.stringify(tripKeys.graph(tripId)) : null;
			// Only the graph query matters, and never synchronously: a query
			// created or removed while another component renders (a card's
			// useQuery, the purge when a guest is cut off) would otherwise set
			// this banner's state during that render (React's warning, found at
			// integration).
			return qc.getQueryCache().subscribe((e) => {
				if (key && JSON.stringify(e.query.queryKey) !== key) return;
				queueMicrotask(cb);
			});
		},
		[qc, tripId],
	);
	const savedAt = useSyncExternalStore(
		subscribe,
		() =>
			tripId
				? qc.getQueryState(tripKeys.graph(tripId))?.dataUpdatedAt || null
				: null,
		() => null,
	);
	const kept =
		!!tripId &&
		typeof window !== "undefined" &&
		readSavedTrips().some((t) => t.tripId === tripId);
	return { available: kept && savedAt !== null, savedAt };
}

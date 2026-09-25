/**
 * Keeps the last trip's small PDFs readable offline (ADDENDUM §9). Mounted by
 * the Media tab, the inspector's media panel and the cover strip; WP-Shell
 * may also mount `<MediaOfflineSync />` once in the workspace so the sync
 * runs without opening Media (CONTRACT_REQUESTS.md).
 */
import { useEffect } from "react";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useTripMedia } from "../queries";
import { syncTripDocs } from "./doc-cache";

export function useDocOfflineSync(): void {
	const { graph, mode, connection } = useWorkspace();
	const { data } = useTripMedia();
	const tripId = graph.trip.id;
	useEffect(() => {
		if (mode !== "live" || connection === "offline" || !data.length) return;
		const run = () => void syncTripDocs(tripId, data).catch(() => {});
		const w = window as Window & {
			requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
			cancelIdleCallback?: (id: number) => void;
		};
		if (w.requestIdleCallback) {
			const id = w.requestIdleCallback(run, { timeout: 4_000 });
			return () => w.cancelIdleCallback?.(id);
		}
		const t = window.setTimeout(run, 1_500);
		return () => window.clearTimeout(t);
	}, [tripId, data, mode, connection]);
}

export function MediaOfflineSync(): null {
	useDocOfflineSync();
	return null;
}

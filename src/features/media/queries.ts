/** WP-Media queries, built on `tripKeys` so live `media` events reach them (SPEC §12.2). */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { tripKeys } from "@/lib/query/keys";
import { persistedQuery } from "@/lib/query/persister";
import type { AttachmentTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { listTripMedia, type MediaDto } from "./media.functions";
import { withGhosts } from "./proposed";

export const tripMediaQuery = (tripId: string) =>
	persistedQuery({
		queryKey: tripKeys.media(tripId),
		queryFn: (): Promise<MediaDto[]> => listTripMedia({ data: { tripId } }),
	});

export function sameTarget(a: AttachmentTarget, b: AttachmentTarget): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

const NONE: MediaDto[] = [];

/**
 * The trip's media in the live workspace (nothing from the server in fixture
 * mode), plus open link proposals as ghost tiles (E7), one tile per id
 * (`withGhosts`, COLLAB-R3-05).
 */
export function useTripMedia(): {
	data: MediaDto[];
	isLoading: boolean;
	isError: boolean;
} {
	const { graph, mode, proposals } = useWorkspace();
	const q = useQuery({
		...tripMediaQuery(graph.trip.id),
		enabled: mode === "live",
	});
	const rows = q.data ?? NONE;
	// Link suggestions this tab has drawn as ghosts. Once one is accepted it
	// keeps a plain tile while the media refetch that brings its row is under
	// way (the proposals can land first); after that it is forgotten, so a
	// later refetch never resurrects a link deleted since.
	const drawn = useRef(new Set<string>());
	const fetching = q.isFetching;
	useEffect(() => {
		for (const p of proposals.list) {
			if (p.op !== "attachment.link") continue;
			if (p.status === "open") drawn.current.add(p.id);
			else if (!fetching) drawn.current.delete(p.id);
		}
	}, [proposals.list, fetching]);
	const data = useMemo(() => {
		if (!proposals.show) return rows;
		const bridge = fetching
			? new Set(
					proposals.list
						.filter((p) => p.status === "accepted" && drawn.current.has(p.id))
						.map((p) => p.id),
				)
			: undefined;
		return withGhosts(rows, proposals.list, bridge);
	}, [rows, proposals.show, proposals.list, fetching]);
	return {
		data,
		isLoading: mode === "live" && q.isLoading,
		isError: q.isError,
	};
}

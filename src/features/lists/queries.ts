/** WP-Lists list queries, built on `tripKeys` (SPEC §12.2). */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { tripKeys } from "@/lib/query/keys";
import { persistedQuery } from "@/lib/query/persister";
import type { ProposalDto } from "@/lib/schemas/proposals";
import type { BundleTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { type ListItemDto, listTripListItems } from "./lists.functions";

export const tripListsQuery = (tripId: string) =>
	persistedQuery({
		queryKey: tripKeys.lists(tripId),
		queryFn: (): Promise<ListItemDto[]> =>
			listTripListItems({ data: { tripId } }),
	});

export function sameTarget(a: BundleTarget, b: BundleTarget): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** A proposed create drawn as a ghost row (E7). */
export type GhostRow = ListItemDto & { ghostOf: string };

export function isGhost(r: ListItemDto): r is GhostRow {
	return "ghostOf" in r;
}

/**
 * E7 overlay for lists (EXTENSIONS §1.4 `applyListProposals`): open
 * `list.create` proposals become ghost rows (dashed, the author's colour);
 * everything else is drawn from the marks (`useProposalMarks('list:<id>')`).
 * Private rows never become proposals, so no ghost is ever private. A
 * suggestion to share the author's private to-do (`fromPrivateId`, QA
 * SEC-R3-01) stands in for that row in the author's own list while it's open.
 */
export function applyListProposals(
	rows: readonly ListItemDto[],
	proposals: readonly ProposalDto[],
): ListItemDto[] {
	const ghosts: GhostRow[] = [];
	const shared = new Set<string>();
	for (const p of proposals) {
		if (p.status !== "open" || p.op !== "list.create") continue;
		const pl = p.payload as Record<string, unknown>;
		const id = typeof pl.id === "string" ? pl.id : p.id;
		if (rows.some((r) => r.id === id)) continue;
		if (typeof pl.fromPrivateId === "string") shared.add(pl.fromPrivateId);
		const target = (pl.target ?? { kind: "trip" }) as BundleTarget;
		const str = (k: string) =>
			typeof pl[k] === "string" ? (pl[k] as string) : null;
		const num = (k: string) =>
			typeof pl[k] === "number" ? (pl[k] as number) : null;
		ghosts.push({
			id,
			ghostOf: p.id,
			target,
			list: pl.list === "shopping" ? "shopping" : "todo",
			text: str("text") ?? "",
			note: str("note"),
			url: str("url"),
			status: "open",
			dueDayId: str("dueDayId"),
			dueDate: str("dueDate"),
			dueTime: str("dueTime"),
			dueTz: str("dueTz"),
			dueKind:
				pl.dueKind === "opens" || pl.dueKind === "on" ? pl.dueKind : "due",
			dueRule: null,
			quantity: num("quantity"),
			priceAmount: num("priceAmount"),
			priceCurrency: str("priceCurrency"),
			position: "~",
			isPrivate: false,
			assigneeIds: Array.isArray(pl.assigneeIds)
				? (pl.assigneeIds as string[])
				: [],
			extraTargetNodeIds: Array.isArray(pl.extraTargetNodeIds)
				? (pl.extraTargetNodeIds as string[])
				: [],
			createdAt: p.createdAt,
			updatedAt: p.updatedAt,
			doneAt: null,
			mine: false,
		});
	}
	if (!ghosts.length) return [...rows];
	const kept = shared.size
		? rows.filter((r) => !(r.isPrivate && shared.has(r.id)))
		: rows;
	return [...kept, ...ghosts];
}

/** The trip's list items (plus proposal ghosts for people who see suggestions). */
export function useListItems(): { items: ListItemDto[]; loading: boolean } {
	const { graph, mode, proposals } = useWorkspace();
	const q = useQuery({
		...tripListsQuery(graph.trip.id),
		enabled: mode === "live",
	});
	const items = useMemo(
		() =>
			proposals.show
				? applyListProposals(q.data ?? [], proposals.list)
				: (q.data ?? []),
		[q.data, proposals.show, proposals.list],
	);
	return { items, loading: mode === "live" && q.isPending };
}

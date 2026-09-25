/**
 * E7 marks for the Outline (EXTENSIONS §1.4 WP-Outline, §3.7): the origin rows
 * of proposed moves (`from:node:<oldParentId>` marks; `from:node:root` for a
 * move out of the top level), and proposed places the simulating overlay did
 * NOT insert into `ix` (a stacked or conflicted `node.create`), so every open
 * suggestion stays visible. Applied creates are ordinary rows in `ix` wrapped
 * in `ProposalGhost`; `ghostNodes` skips them, so the two never double up.
 * Pure: no React.
 */
import { NODE_TYPES, PLACE_CATEGORIES } from "@/lib/domain/taxonomy";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { MarkKey, ProposalMark } from "@/lib/engine/proposals";
import type { GraphNode, NodeType, PlaceCategory } from "@/lib/engine/types";
import type { ProposalDto } from "@/lib/schemas/proposals";
import type { GhostNode } from "./tree-rows";

const isType = (v: unknown): v is NodeType =>
	typeof v === "string" && Object.hasOwn(NODE_TYPES, v);
const isCategory = (v: unknown): v is PlaceCategory =>
	typeof v === "string" && Object.hasOwn(PLACE_CATEGORIES, v);

/** Open `node.create` proposals whose node isn't in the graph, as ghost nodes. */
export function ghostNodes(
	ix: GraphIndex,
	list: readonly ProposalDto[],
): GhostNode[] {
	const out: GhostNode[] = [];
	for (const p of list) {
		if (p.status !== "open" || p.op !== "node.create" || !p.entityId) continue;
		if (ix.node(p.entityId)) continue;
		const pl = p.payload as Record<string, unknown>;
		const type = isType(pl.type) ? pl.type : null;
		const name = typeof pl.name === "string" ? pl.name.trim() : "";
		if (!type || !name) continue;
		const parentId = typeof pl.parentId === "string" ? pl.parentId : null;
		// A ghost under a parent that's gone (or another ghost) has nowhere to hang.
		if (parentId && !ix.node(parentId)) continue;
		const node: GraphNode = {
			id: p.entityId,
			parentId,
			type,
			category:
				type === "place"
					? isCategory(pl.category)
						? pl.category
						: "other"
					: null,
			status: "active",
			name,
			localName: typeof pl.localName === "string" ? pl.localName : null,
			slug: "",
			description: null,
			position: "",
			lat: typeof pl.lat === "number" ? pl.lat : null,
			lng: typeof pl.lng === "number" ? pl.lng : null,
			tz: null,
			countryCode: null,
			address: null,
			googlePlaceId: null,
			bbox: null,
			timeNeededMin: null,
			details: {},
			priorities: {},
			ratingComments: {},
			updatedAt: p.createdAt,
		};
		out.push({ node, proposalId: p.id });
	}
	return out;
}

/** `from:node:<parentId>` marks, keyed by the old parent id (or "root"). */
export function originsByParent(
	marks: ReadonlyMap<MarkKey, readonly ProposalMark[]>,
): Map<string, ProposalMark[]> {
	const out = new Map<string, ProposalMark[]>();
	for (const [key, list] of marks) {
		if (!key.startsWith("from:node:")) continue;
		const parentId = key.slice("from:node:".length);
		out.set(parentId, [...(out.get(parentId) ?? []), ...list]);
	}
	return out;
}

/** The node id a `node:<id>` mark key points at. */
export function nodeIdOfMark(key: MarkKey | undefined): string | null {
	return key?.startsWith("node:") ? key.slice("node:".length) : null;
}

/**
 * Someone else's proposed create on this node (EXTENSIONS §3.7 "Other
 * people's drags get 'Suggested by Maya — review it first'"): the node only
 * exists in the overlay, so only its author may move or schedule it (an
 * amend or a chained suggestion). Null when it's real or the viewer's own.
 */
export function othersProposedCreate(
	marks: readonly ProposalMark[] | undefined,
	meMemberId: string | null,
): ProposalMark | null {
	const lead = marks?.find((m) => m.kind === "create" && !m.stacked);
	if (!lead) return null;
	return lead.author.memberId && lead.author.memberId === meMemberId
		? null
		: lead;
}

/** "Maya" of "Maya Chen" (the marks carry the author's full name). */
export const firstNameOf = (name: string) =>
	name.trim().split(/\s+/)[0] || "Someone";

/** The server's wording for the same refusal: "Suggested by Maya — review it first." */
export const reviewFirst = (m: ProposalMark) =>
	`Suggested by ${firstNameOf(m.author.name)} — review it first.`;

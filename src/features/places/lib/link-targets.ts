/**
 * D10 "Add · paste a link": the places a pasted link (a reel, a video, a
 * guide) can go on, in order: the ones its caption names, the open place, a
 * few nearby (the place or day in view), or, with a search, every place that
 * matches. Pure; the matching is the share page's (`namedIn`, `metres`).
 */
import { metres, namedIn, parentLabel } from "@/features/home/share-classify";
import {
	classifyUrl,
	displayHost,
	providerLabel,
} from "@/features/media/embeds";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphNode } from "@/lib/engine/types";
import { formatDayDate } from "@/lib/format";
import { placeWhere } from "../tab/model";
import { matchTripNodes } from "./trip-search";

export type LinkTarget = {
	node: GraphNode;
	why: "named" | "open" | "nearby" | "match";
};

/** How far "Nearby" looks from the place or day in view. */
const NEARBY_M = 2000;

/** What a link can go on (as on the share page): places and areas. */
function linkable(ix: GraphIndex): GraphNode[] {
	return ix.outline.filter((n) => n.type === "place" || n.type === "area");
}

/** Where "Nearby" measures from: the open place, else the day's stops, else a small scope. */
function anchorsOf(
	ix: GraphIndex,
	open: GraphNode | undefined,
	dayId: string | null,
	scopeId: string | null,
): { lat: number; lng: number }[] {
	const at = (id: string | null | undefined) => {
		const c = ix.coordOf(id);
		return c ? [{ lat: c[1], lng: c[0] }] : [];
	};
	if (open) return at(open.id);
	if (dayId)
		return (ix.itemsByDay.get(dayId) ?? []).flatMap((it) => at(it.nodeId));
	const scope = ix.node(scopeId);
	return scope && (scope.type === "area" || scope.type === "place")
		? at(scope.id)
		: [];
}

export function linkTargets(
	ix: GraphIndex,
	opts: {
		/** The link's title and description (null until they arrive). */
		text: string | null;
		openId: string | null;
		/** The day in view. */
		dayId: string | null;
		scopeId: string | null;
		/** "Search your places…". */
		query: string;
		nearby?: number;
	},
): LinkTarget[] {
	const all = linkable(ix);
	if (opts.query.trim())
		return matchTripNodes(all, opts.query, 8).map((node) => ({
			node,
			why: "match",
		}));
	const places = all.filter((n) => n.type === "place");
	const out: LinkTarget[] = [];
	const seen = new Set<string>();
	const add = (node: GraphNode, why: LinkTarget["why"]) => {
		if (seen.has(node.id)) return;
		seen.add(node.id);
		out.push({ node, why });
	};
	for (const n of namedIn(opts.text, places)) add(n, "named");
	const open = ix.node(opts.openId);
	if (open) add(open, "open");
	const anchors = anchorsOf(ix, open, opts.dayId, opts.scopeId);
	if (anchors.length)
		places
			.flatMap((n) => {
				if (seen.has(n.id) || n.lat == null || n.lng == null) return [];
				if (n.ideaStatus === "dropped" || ix.isDropped(n.id)) return [];
				const at = { lat: n.lat, lng: n.lng };
				const m = Math.min(...anchors.map((a) => metres(a, at)));
				return m <= NEARBY_M ? [{ n, m }] : [];
			})
			.sort((a, b) => a.m - b.m)
			.slice(0, opts.nearby ?? 4)
			.forEach(({ n }) => {
				add(n, "nearby");
			});
	return out;
}

/** "Tokyo › Harajuku · on Wed 6 Oct": where a place is, and its first day. */
export function targetMeta(ix: GraphIndex, nodeId: string): string {
	const first = ix.ordered.find((it) => it.nodeId === nodeId && it.dayId);
	const day = ix.day(first?.dayId);
	return [placeWhere(ix, nodeId), day ? `on ${formatDayDate(day.date)}` : null]
		.filter(Boolean)
		.join(" · ");
}

/**
 * Where a new place from a link files: beside the open place (its area or
 * city), in an open area, else under the scope (a place's own parent).
 */
export function linkParent(
	ix: GraphIndex,
	scopeId: string | null,
	openId: string | null = null,
): string | null {
	const open = ix.node(openId);
	if (open?.type === "place") return open.parentId;
	if (open?.type === "area") return open.id;
	const n = ix.node(scopeId);
	return n?.type === "place" ? n.parentId : (n?.id ?? null);
}

/** "Tokyo › Harajuku" (the share page's parent label). */
export function filedUnder(ix: GraphIndex, parentId: string | null): string {
	return parentLabel(ix.outline, { parentId, create: [] }, ix.trip.name);
}

/** "TikTok video", "Instagram reel", "YouTube video", "Web page". */
export function linkKind(url: string): { label: string; social: boolean } {
	const c = classifyUrl(url);
	if (c.kind === "link") return { label: "Web page", social: false };
	if (c.provider === "instagram")
		return {
			label: c.igType === "p" ? "Instagram post" : "Instagram reel",
			social: true,
		};
	return { label: `${providerLabel(c.provider)} video`, social: true };
}

/** A new place's name when the link has no title: "TikTok video", "japan-guide.com". */
export function fallbackName(url: string): string {
	const k = linkKind(url);
	return k.social ? k.label : displayHost(url) || k.label;
}

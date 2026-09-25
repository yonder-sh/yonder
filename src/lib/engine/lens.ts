/**
 * Lenses (SPEC §8.2) and the pure half of navigation (§8.5).
 *
 * The lens is the granularity used to aggregate: country, region, city, area
 * or place. `repAt` picks the node that stands for a place at a lens, looking
 * only BELOW the scope, so area-under-area can aggregate (Asakusa › Kappabashi)
 * and a place filed directly under a city (Itoya) stays itself at area lens.
 */
import type { GraphIndex } from "./graph-index";
import type { Lens, NodeType, Rep } from "./types";

/** Coarse → fine. */
export const LENSES: readonly Lens[] = [
	"country",
	"region",
	"city",
	"area",
	"place",
];

export const RANK = {
	country: 0,
	region: 1,
	city: 2,
	area: 3,
	place: 4,
} as const satisfies Record<NodeType, number>;

/** The map zoom at which each lens is "natural" (§8.5). */
export const LENS_ZOOM = {
	country: 5,
	region: 7,
	city: 11,
	area: 14,
	place: 16,
} as const satisfies Record<Lens, number>;

/**
 * The node that stands for `nodeId` at `lens`, looking only at ancestors
 * strictly BELOW the scope (the whole path when the node is outside it).
 *
 * - `exact`: the OUTERMOST node of the lens type on that path.
 * - `finer`: the path skips the lens type; the first node finer than it (Itoya
 *   under Tokyo at area lens is Itoya itself), drawn as a smaller pin.
 * - `coarser`: scheduled at a coarse node ("Tokyo" at place lens), drawn with a
 *   dashed outline.
 */
export function repAt(
	ix: GraphIndex,
	nodeId: string,
	lens: Lens,
	scopeId: string | null,
): Rep {
	const self = ix.node(nodeId);
	if (!self) return { id: nodeId, mode: "coarser" };
	if (lens === "place")
		return { id: nodeId, mode: self.type === "place" ? "exact" : "coarser" };
	const full = ix.path(nodeId); // root → node
	const at = scopeId ? full.findIndex((n) => n.id === scopeId) : -1;
	const path = full.slice(at + 1); // strictly below the scope (whole path if outside it)
	const exact = path.find((n) => n.type === lens);
	if (exact) return { id: exact.id, mode: "exact" };
	const finer = path.find((n) => RANK[n.type] > RANK[lens]);
	if (finer) return { id: finer.id, mode: "finer" };
	return { id: nodeId, mode: "coarser" };
}

export interface LensOption {
	lens: Lens;
	enabled: boolean;
	/** `region` hides when no region exists in the scope subtree. */
	visible: boolean;
}

/**
 * Lens options for a scope (§8.2): `place` is always enabled; a level L is
 * enabled when it is finer than the scope's type, or equal to it when the scope
 * subtree has a node of that type below the scope. At the root everything is
 * enabled.
 */
export function lensOptions(
	ix: GraphIndex,
	scopeId: string | null,
): LensOption[] {
	const scope = scopeId ? ix.node(scopeId) : undefined;
	const below = scope ? ix.hierarchy.descendants(scope.id) : ix.outline;
	const typesBelow = new Set(below.map((n) => n.type));
	return LENSES.map((lens) => {
		const enabled =
			!scope ||
			lens === "place" ||
			RANK[lens] > RANK[scope.type] ||
			(lens === scope.type && typesBelow.has(lens));
		const visible = enabled && (lens !== "region" || typesBelow.has("region"));
		return { lens, enabled, visible };
	});
}

const usable = (opts: readonly LensOption[], lens: Lens) =>
	opts.some((o) => o.lens === lens && o.enabled && o.visible);

/** Countries the itinerary goes to: those holding scheduled items or stays. */
function itineraryCountries(ix: GraphIndex): number {
	let n = 0;
	for (const id of ix.scheduledNodeIds)
		if (ix.node(id)?.type === "country") n++;
	return n;
}

/**
 * The first enabled, visible level finer than the scope: `country` at the
 * root, `place` for a place scope. A trip whose itinerary stays in one
 * country opens at its cities instead (a single country dot says nothing).
 */
export function defaultLens(ix: GraphIndex, scopeId: string | null): Lens {
	const scope = scopeId ? ix.node(scopeId) : undefined;
	const floor = scope ? RANK[scope.type] : -1;
	const opts = lensOptions(ix, scopeId);
	if (!scope && itineraryCountries(ix) === 1 && usable(opts, "city"))
		return "city";
	return (
		opts.find((o) => o.enabled && o.visible && RANK[o.lens] > floor)?.lens ??
		"place"
	);
}

/** The URL's lens if it is usable for the scope, else the default. */
export function resolveLens(
	ix: GraphIndex,
	scopeId: string | null,
	requested: Lens | null | undefined,
): Lens {
	if (requested && usable(lensOptions(ix, scopeId), requested))
		return requested;
	return defaultLens(ix, scopeId);
}

/** `zoomIn(nodeId)`: the level after the current one if usable in the new scope, else its default. */
export function lensAfterZoomIn(
	ix: GraphIndex,
	current: Lens,
	newScopeId: string,
): Lens {
	const next = LENSES[LENSES.indexOf(current) + 1];
	if (next && usable(lensOptions(ix, newScopeId), next)) return next;
	return defaultLens(ix, newScopeId);
}

/** `zoomOut()`: the level before the current one if usable in the parent scope, else its default. */
export function lensAfterZoomOut(
	ix: GraphIndex,
	current: Lens,
	parentScopeId: string | null,
): Lens {
	const prev = LENSES[LENSES.indexOf(current) - 1];
	if (prev && usable(lensOptions(ix, parentScopeId), prev)) return prev;
	return defaultLens(ix, parentScopeId);
}

/** `[` (-1, coarser) and `]` (+1, finer), skipping disabled and hidden levels. Stays put at the ends. */
export function stepLens(
	ix: GraphIndex,
	scopeId: string | null,
	current: Lens,
	dir: 1 | -1,
): Lens {
	const opts = lensOptions(ix, scopeId);
	for (
		let i = LENSES.indexOf(current) + dir;
		i >= 0 && i < LENSES.length;
		i += dir
	) {
		const lens = LENSES[i] as Lens;
		if (usable(opts, lens)) return lens;
	}
	return current;
}

/** Show the "Show areas / Show places" chip: the map is zoomed well past the lens (§8.5). */
export function suggestsFinerLens(mapZoom: number, lens: Lens): boolean {
	return lens !== "place" && mapZoom > LENS_ZOOM[lens] + 2.5;
}

/**
 * "Set location" for a node without coordinates (the palette's `locate`
 * mode, QA HIER-12). Pure.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphNode } from "@/lib/engine/types";
import type { UpdateNodeVars } from "../mutations";
import type { PlacePreview } from "./providers";

/**
 * Where a search for the node should look: its nearest ancestor with a
 * position (Bar Kuro → Golden Gai → Shinjuku → Tokyo), else null.
 */
export function locateBiasNode(
	ix: Pick<GraphIndex, "path" | "coordOf">,
	nodeId: string | null | undefined,
): string | null {
	if (!nodeId) return null;
	const ancestors = ix.path(nodeId).slice(0, -1).reverse();
	return ancestors.find((a) => ix.coordOf(a.id) !== null)?.id ?? null;
}

/**
 * The patch "Use this location" saves on `node`.
 *
 * A picked search result is that place: its position, address and provider
 * refs. A pin (pasted coordinates, a dropped pin) is only a spot: the node
 * keeps its own identity, never the refs of whatever business is nearest
 * (HIER-12: Bar Kuro must not become "Blue Dragon"). The reverse-geocoded
 * address only fills an address the node doesn't have.
 */
export function locationPatch(
	node: Pick<GraphNode, "type" | "address">,
	preview: PlacePreview,
	pin: { lat: number; lng: number } | null,
): UpdateNodeVars["patch"] {
	if (pin)
		return {
			lat: pin.lat,
			lng: pin.lng,
			...(preview.address && !node.address?.trim()
				? { address: preview.address.slice(0, 500) }
				: {}),
		};
	return {
		lat: preview.lat,
		lng: preview.lng,
		...(preview.address ? { address: preview.address.slice(0, 500) } : {}),
		...(preview.provider === "google" && preview.ref !== "pin"
			? { googlePlaceId: preview.ref }
			: {}),
		...(preview.osmRef ? { osmRef: preview.osmRef } : {}),
		...(preview.countryCode &&
		/^[A-Z]{2}$/.test(preview.countryCode) &&
		node.type === "country"
			? { countryCode: preview.countryCode }
			: {}),
	};
}

/**
 * Whether a new place made from a pin may carry the reverse-geocoded
 * place's provider identity (osmRef, Google id, hours): only while it keeps
 * that place's name. Renamed, it's a different place at that spot.
 */
export function pinKeepsIdentity(
	preview: Pick<PlacePreview, "name">,
	name: string,
): boolean {
	return !name.trim() || name.trim() === preview.name.trim();
}

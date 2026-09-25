/**
 * Marker stacking for the map's HTML markers (pins, clusters, chips). Pure.
 */
import type { PinView } from "./map-data";

/**
 * Marker stacking. Always integers: CSS drops a fractional `z-index`
 * ("10.99"), which left every visited pin under the hollow ideas, so a click
 * on Tokyo opened Urayasu. Order from the bottom: ideas, edge chips, spider
 * legs, visited pins (lower numbers on top), cluster chips, the hovered pin,
 * the selected pin. The map container isolates them (`map.css`), so none of
 * them climbs over the map chips or the inspector.
 */
export const MARKER_Z = {
	idea: 5,
	edgeChip: 8,
	spider: 9,
	visited: 10,
	cluster: 1200,
	hovered: 1300,
	selected: 1400,
} as const;
/** Pin numbers past this share the lowest visited layer. */
const Z_RANKS = 1000;

export function pinZIndex(
	pin: Pick<PinView, "hollow" | "number">,
	selected: boolean,
	hovered: boolean,
): number {
	if (selected) return MARKER_Z.selected;
	if (hovered) return MARKER_Z.hovered;
	if (pin.hollow) return MARKER_Z.idea;
	const n = Math.round(pin.number ?? Z_RANKS);
	return MARKER_Z.visited + Z_RANKS - Math.min(Z_RANKS, Math.max(1, n));
}

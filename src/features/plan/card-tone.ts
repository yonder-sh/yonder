/**
 * A Plan card's colour (owner, 2026-09-25: "it needs more colour"): a place
 * takes its map pin's family (`pinStyle`), so the card matches its pin; an
 * airport, station or port takes its travel mode's colour; an area or city a
 * muted bar; a block without a place none. `plan.css` paints the 4px bar, the
 * faint tint and the icon from `data-family`.
 */
import { type PinFamily, pinStyle } from "@/lib/domain/taxonomy";
import type { NodeType, PlaceCategory } from "@/lib/schemas/enums";

export type CardTone =
	| PinFamily
	| "flight"
	| "rail"
	| "ferry"
	| "area"
	| "none";

/** Stops are travel: they read in their mode's colour, like the rails around them. */
const STOP_TONE: Partial<Record<PlaceCategory, CardTone>> = {
	airport: "flight",
	station: "rail",
	port: "ferry",
};

export function cardTone(
	node: { type: NodeType; category?: PlaceCategory | null } | null | undefined,
): CardTone {
	if (!node) return "none";
	if (node.type !== "place") return "area";
	const stop = node.category ? STOP_TONE[node.category] : undefined;
	return stop ?? pinStyle(node).family ?? "area";
}

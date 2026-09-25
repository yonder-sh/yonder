/**
 * MAP-07 (DESIGN §9.2 "linked row hovered = hover state"): hovering a card or
 * a leg row in the Plan sets `useUi().hover`, which the map draws on the pin
 * or edge. Leaving clears it only if it is still ours, so moving straight
 * from one row to the next never flickers.
 */
import { type HoverTarget, useUi } from "@/lib/workspace/ui-store";

export function setPlanHover(target: HoverTarget, on: boolean): void {
	const { hover, setHover } = useUi.getState();
	const same = hover?.kind === target.kind && hover.id === target.id;
	if (on) {
		if (!same) setHover(target);
	} else if (same) setHover(null);
}

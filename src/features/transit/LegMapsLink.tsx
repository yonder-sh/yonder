/**
 * "Open in Google Maps" for a leg (ADDENDUM §5; FB-03): every non-flight leg
 * whose two ends have a location links to Google Maps directions in the
 * leg's own mode — transit, walking, driving (taxi, car, other) or cycling;
 * an unset leg follows its suggestion. For rows other packages own (WP-Plan's
 * leg rows and the item overview's Travel rows, map popups):
 *
 *   <LegMapsLink target={{ kind: "pair", fromItemId, toItemId }} compact />
 *
 * `compact` shows "Google Maps ↗"; `iconOnly` just the ↗ (the accessible name
 * is always "Open in Google Maps"). Renders nothing for flights, and when an
 * end has no location.
 */

import type { LegTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { GoogleMapsLink } from "./components/bits";
import { legEnds, mapsTravelMode } from "./lib/endpoints";

export function LegMapsLink({
	target,
	compact,
	iconOnly,
	className,
}: {
	target: LegTarget;
	compact?: boolean;
	iconOnly?: boolean;
	className?: string;
}) {
	const { ix, schedule } = useWorkspace();
	const ends = legEnds(ix, target);
	if (!ends.from || !ends.to) return null;
	const leg =
		target.kind === "pair"
			? ix.legByPair.get(`${target.fromItemId}>${target.toItemId}`)
			: ix.legByStay.get(`${target.dayId}:${target.end}`);
	const mode = mapsTravelMode(
		leg,
		schedule.legs[ends.key]?.suggestion?.mode ?? null,
	);
	if (!mode) return null;
	return (
		<GoogleMapsLink
			ends={ends}
			mode={mode}
			compact={compact}
			iconOnly={iconOnly}
			className={className}
		/>
	);
}

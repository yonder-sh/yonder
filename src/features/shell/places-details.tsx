/**
 * docs/PLACES.md §2: on the Places tab, a selected place opens its Places
 * details (score, status, ratings, where it fits) wherever the shell shows a
 * selection (the map-side inspector, the tablet sheet, the phone drawer);
 * anything else keeps the usual inspector.
 */
import { PlacesSelectionDetails } from "@/features/places/tab/PlacesTab";
import { InspectorBody } from "./InspectorBody";

export function PlacesDetailsOr({ onClose }: { onClose: () => void }) {
	return (
		<PlacesSelectionDetails onClose={onClose}>
			<InspectorBody onClose={onClose} />
		</PlacesSelectionDetails>
	);
}

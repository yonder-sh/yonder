/**
 * DESIGN §4.4 placement (xl/lg): floats over the map, 12px inset, 420 wide
 * (380 at lg), radius 16, shadow-float; 160ms fade + 8px slide in. Esc closes
 * it (the Esc chain in use-workspace-hotkeys.ts). It also tells the map how
 * much room it covers (`mapPadding`).
 */
import { useEffect } from "react";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { InspectorBody } from "./InspectorBody";
import { PlacesDetailsOr } from "./places-details";

export function FloatingInspector({ width = 420 }: { width?: number }) {
	const { sel, nav, tab } = useWorkspace();
	const setMapPadding = useUi((s) => s.setMapPadding);
	const open = sel !== null;
	useEffect(() => {
		setMapPadding({
			top: 24,
			bottom: 24,
			left: 24,
			right: open ? width + 24 : 24,
		});
	}, [open, width, setMapPadding]);
	if (!open) return null;
	return (
		<aside
			data-testid={TESTID.inspector}
			aria-label="Details"
			className="absolute top-3 right-3 bottom-3 z-30 flex flex-col overflow-hidden rounded-2xl bg-card shadow-float animate-in fade-in-0 slide-in-from-right-2 duration-150"
			style={{ width }}
		>
			{/* docs/PLACES.md §2: with the map showing, a place's details open here. */}
			{tab === "places" ? (
				<PlacesDetailsOr onClose={() => nav.select(null)} />
			) : (
				<InspectorBody onClose={() => nav.select(null)} />
			)}
		</aside>
	);
}

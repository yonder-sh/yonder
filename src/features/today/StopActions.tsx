/**
 * A stop's Directions and Address in its details while the trip is on
 * (board P11): the phone's maps app, and "Show this to the driver". Also on
 * a stay's or airport's own sheet.
 */
import { Languages, Navigation } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { pairKey } from "@/lib/engine/graph-index";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { DriverSheet } from "./DriverSheet";
import { directionsUrl, travelBy } from "./lib/directions";
import { TODAY_TESTID } from "./testids";

const PRACTICAL = new Set(["lodging", "airport"]);

export function StopActions({
	itemId,
	nodeId,
}: {
	itemId?: string;
	/** A place's own sheet: only a stay or an airport. */
	nodeId?: string;
}) {
	const { ix, underway } = useWorkspace();
	const [open, setOpen] = useState(false);
	const item = itemId ? ix.item(itemId) : undefined;
	const node = item?.nodeId
		? ix.node(item.nodeId)
		: nodeId
			? ix.node(nodeId)
			: undefined;
	const coord = node ? ix.coordOf(node.id) : null;
	const shown = item
		? !!item.dayId
		: !!node?.category && PRACTICAL.has(node.category);
	if (!underway || !shown || !node || !coord) return null;
	const prev = itemId ? ix.prevLocated(itemId) : null;
	const by = travelBy(
		prev && itemId
			? (ix.legByPair.get(pairKey(prev.id, itemId))?.mode ?? null)
			: null,
	);
	return (
		<div className="flex gap-2 px-4 pt-3">
			<Button asChild size="lg" className="flex-1">
				<a
					href={directionsUrl(coord, by)}
					target="_blank"
					rel="noopener noreferrer"
					data-testid={TODAY_TESTID.stopDirections}
				>
					<Navigation />
					Directions
				</a>
			</Button>
			<Button
				variant="outline"
				size="lg"
				data-testid={TODAY_TESTID.stopAddress}
				onClick={() => setOpen(true)}
			>
				<Languages />
				Address
			</Button>
			<DriverSheet
				node={open ? node : null}
				by={by}
				onClose={() => setOpen(false)}
			/>
		</div>
	);
}

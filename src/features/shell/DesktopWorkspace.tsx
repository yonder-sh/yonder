/**
 * DESIGN §5 desktop layouts:
 * - xl ≥ 1280: Outline 264 (hidden to a rail from its header or ⌘\; the popover takes over) | centre 520 (resizable 440–720, persisted) | map with the floating inspector (420)
 * - lg: Outline in a popover (top bar), centre 460, map, floating inspector (380)
 * - md: centre 55% | map 45%, inspector in a right Sheet (420)
 * - The map hides from its corner or ⌘⇧\ (md and up): the centre takes its
 *   width, a rail at the right edge brings it back, the inspector docks
 *   beside the centre (the md Sheet stays), and the pane sizes wait in
 *   storage for its return. The Places tab is then wide.
 * - The Overview tab (docs/OVERVIEW.md) takes the centre, the map's and the
 *   inspector's space as one scrolling page, at every width; a selection
 *   shows in the right Sheet.
 */
import { useMemo } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { GuestNudge } from "@/features/home/GuestNudge";
import { OfflineBanner } from "@/features/offline/OfflineBanner";
import { IdeasBin } from "@/features/outline/IdeasBin";
import { Outline } from "@/features/outline/Outline";
import {
	useIsPlacesRow,
	usePlacesMapView,
} from "@/features/places/tab/PlacesTab";
import { BRAND } from "@/lib/brand";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { CenterPanel } from "./CenterPanel";
import { SpotlightBar } from "./cursors/presence-ui";
import { FollowBar } from "./FollowBar";
import { InspectorBody } from "./InspectorBody";
import { MapRegion } from "./MapRegion";
import { MapRail, OutlineHideButton, OutlineRail } from "./PanelToggles";
import { pixelLayoutStorage } from "./pane-layout";
import { PlacesDetailsOr } from "./places-details";
import { useShell } from "./shell-store";
import { TopBar } from "./TopBar";
import { SHELL_TESTID } from "./testids";
import type { Breakpoint } from "./use-breakpoint";

/** The Overview tab is on screen: it takes the map's space too. */
function useOverviewTakesAll(): boolean {
	const { tab } = useWorkspace();
	return tab === "overview";
}

/** `--outline-w` and the hidden Outline's rail (`PanelToggles`, w-10). */
const OUTLINE_PX = 264;
const RAIL_PX = 40;

function safeStorage(): Storage | undefined {
	try {
		return typeof window === "undefined" ? undefined : window.localStorage;
	} catch {
		return undefined;
	}
}

/**
 * md: the inspector in a right Sheet. Like the floating inspector and the
 * phone drawer, the close control is InspectorBody's own (next to the title,
 * below any cover photo); Radix's corner ✕ would sit on the cover, ink on a
 * dark photo, and vanish (VIS-13).
 */
export function InspectorSheet({
	placesDocked = false,
}: {
	/** The Places tab docks its own places' details (wide mode). */
	placesDocked?: boolean;
} = {}) {
	const { sel, nav, tab } = useWorkspace();
	const places = tab === "places" && sel?.kind === "node";
	const docked = useIsPlacesRow(placesDocked && places ? sel.id : null);
	return (
		<Sheet
			open={sel !== null && !docked}
			onOpenChange={(open) => !open && nav.select(null)}
		>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[420px] gap-0 p-0 sm:max-w-[420px]"
				data-testid={TESTID.inspector}
			>
				<SheetTitle className="sr-only">Details</SheetTitle>
				{/* docs/PLACES.md §2: the Places tab's details for its places. */}
				{places ? (
					<PlacesDetailsOr onClose={() => nav.select(null)} />
				) : (
					<InspectorBody onClose={() => nav.select(null)} />
				)}
			</SheetContent>
		</Sheet>
	);
}

/**
 * lg/xl with the map hidden: the inspector docks beside the centre, as the
 * Places tab docks its places' details (those it leaves to the tab).
 */
function DockedInspector({ width }: { width: number }) {
	const { sel, nav, tab } = useWorkspace();
	const places = tab === "places" && sel?.kind === "node";
	const docked = useIsPlacesRow(places ? sel.id : null);
	if (!sel || docked) return null;
	return (
		<aside
			data-testid={TESTID.inspector}
			aria-label="Details"
			className="flex shrink-0 flex-col overflow-hidden border-l bg-card animate-in fade-in-0 slide-in-from-right-2 duration-150 motion-reduce:animate-none"
			style={{ width }}
		>
			{places ? (
				<PlacesDetailsOr onClose={() => nav.select(null)} />
			) : (
				<InspectorBody onClose={() => nav.select(null)} />
			)}
		</aside>
	);
}

export function DesktopWorkspace({ bp }: { bp: Exclude<Breakpoint, "sm"> }) {
	const outlineCollapsed = useShell((s) => s.outlineCollapsed);
	const mapHidden = useShell((s) => s.mapHidden);
	// docs/PLACES.md §1: the Places tab's Map view stands in for the side map.
	const placesMap = usePlacesMapView();
	const overview = useOverviewTakesAll();
	// The centre's width in pixels: the group is the window less the xl left column.
	const storage = useMemo(
		() =>
			pixelLayoutStorage(safeStorage(), () =>
				typeof window === "undefined"
					? 0
					: window.innerWidth -
						(bp !== "xl"
							? 0
							: useShell.getState().outlineCollapsed
								? RAIL_PX
								: OUTLINE_PX),
			),
		[bp],
	);
	const { defaultLayout, onLayoutChanged } = useDefaultLayout({
		id: `${BRAND.storage.layout}:${bp}`,
		storage,
	});
	return (
		// `relative overflow-hidden`: an absolute element with no positioned
		// ancestor (an sr-only label in a scrolling list) can't stretch the page,
		// as on the phone layout.
		<div className="relative flex h-svh flex-col overflow-hidden bg-background">
			<TopBar bp={bp} />
			<FollowBar />
			<SpotlightBar />
			<OfflineBanner />
			<GuestNudge />
			<div className="flex min-h-0 flex-1">
				{bp !== "xl" ? null : outlineCollapsed ? (
					<OutlineRail />
				) : (
					<aside
						aria-label="Outline"
						data-testid={SHELL_TESTID.outlineAside}
						className="flex w-[var(--outline-w)] shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground animate-in fade-in-0 slide-in-from-left-2 duration-150 motion-reduce:animate-none"
					>
						<Outline headerEnd={<OutlineHideButton />} />
						<IdeasBin />
					</aside>
				)}
				{overview ? (
					<>
						<div className="h-full min-w-0 flex-1">
							<CenterPanel />
						</div>
						<InspectorSheet />
					</>
				) : mapHidden || placesMap ? (
					<>
						<div className="h-full min-w-0 flex-1">
							<CenterPanel />
						</div>
						{bp === "md" ? (
							<InspectorSheet placesDocked />
						) : (
							<DockedInspector width={bp === "xl" ? 420 : 380} />
						)}
						{/* The Places Map view is the map here: nothing to bring back. */}
						{placesMap ? null : <MapRail />}
					</>
				) : bp === "md" ? (
					// The centre's box matches the hidden-map layout's: hiding keeps its state.
					<>
						<div className="h-full w-[55%] min-w-0 border-r">
							<CenterPanel />
						</div>
						<div className="h-full min-w-0 flex-1">
							<MapRegion variant="desktop" inspector={null} hideable />
						</div>
						<InspectorSheet />
					</>
				) : (
					<ResizablePanelGroup
						id={`workspace-${bp}`}
						defaultLayout={defaultLayout}
						onLayoutChanged={onLayoutChanged}
						className="min-w-0 flex-1"
					>
						<ResizablePanel
							id="center"
							defaultSize={bp === "xl" ? 520 : 460}
							// The Outline coming and going widens the map, not the centre.
							groupResizeBehavior="preserve-pixel-size"
							minSize={440}
							maxSize={720}
						>
							<CenterPanel />
						</ResizablePanel>
						<ResizableHandle className="hover:bg-primary/40 hover:after:w-[3px]" />
						<ResizablePanel id="map" minSize={320}>
							<MapRegion
								variant="desktop"
								inspector={bp === "xl" ? 420 : 380}
								hideable
							/>
						</ResizablePanel>
					</ResizablePanelGroup>
				)}
			</div>
		</div>
	);
}

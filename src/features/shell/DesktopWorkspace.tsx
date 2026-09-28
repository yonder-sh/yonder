/**
 * DESIGN §5 desktop layouts:
 * - xl ≥ 1280: centre 520 (resizable 440–720, persisted) | map | details
 * - lg: centre 460, map, details
 * - One Yonder: no Outline column; the top bar's Where picker moves around
 *   (its Organize places has the tree), and the Plan lists the ideas.
 * - The details (lg/xl, owner 2026-09-26): a selection's panel docks as a
 *   pane at the right edge (`DetailsPane`: resizable, folds to a rail), the
 *   map giving up the width. Without room for the list, the map and the
 *   pane, the map folds (its rail's "Show the map" folds the pane instead).
 *   Your own map setting stays as it is.
 * - md: centre 55% | map 45%, inspector in a right Sheet (420)
 * - The map hides from its corner or ⌘⇧\ (md and up): the centre takes its
 *   width, a rail at the right edge brings it back, the inspector docks
 *   beside the centre (the md Sheet stays), and the pane sizes wait in
 *   storage for its return. The Places tab is then wide.
 * - The Overview tab (docs/OVERVIEW.md) takes the centre, the map's and the
 *   inspector's space as one scrolling page, at every width; a selection
 *   shows in the right Sheet.
 */
import { useMemo, useRef, useSyncExternalStore } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { GuestNudge } from "@/features/home/GuestNudge";
import { OfflineBanner } from "@/features/offline/OfflineBanner";
import {
	useIsPlacesRow,
	usePlacesMapView,
	usePlacesWide,
} from "@/features/places/tab/PlacesTab";
import { FillDay } from "@/features/plan/FillDay";
import { BRAND } from "@/lib/brand";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { CenterPanel } from "./CenterPanel";
import { SpotlightBar } from "./cursors/presence-ui";
import { DetailsPane, useDetailsFold, useDetailsWidth } from "./DetailsPane";
import { FollowBar } from "./FollowBar";
import { InspectorBody } from "./InspectorBody";
import { MapRegion } from "./MapRegion";
import { MapRail } from "./PanelToggles";
import { pixelLayoutStorage } from "./pane-layout";
import { useShell } from "./shell-store";
import { TopBar } from "./TopBar";
import type { Breakpoint } from "./use-breakpoint";

/** The Overview tab is on screen: it takes the map's space too. */
function useOverviewTakesAll(): boolean {
	const { tab } = useWorkspace();
	return tab === "overview";
}

/** A folded pane's rail (`PanelToggles`, w-10) and the 1px divider. */
const RAIL_PX = 40;
const DIVIDER_PX = 1;
/** From here the tabs sit in the top bar's row (the mockups' 1440 laptop). */
const TABS_IN_TOP_BAR_PX = 1440;
/** The centre's and the map's narrowest (their panels' `minSize`). */
const CENTER_MIN = 440;
const MAP_MIN = 320;

function subscribeResize(cb: () => void) {
	window.addEventListener("resize", cb);
	return () => window.removeEventListener("resize", cb);
}

function useWindowWidth(): number {
	return useSyncExternalStore(
		subscribeResize,
		() => window.innerWidth,
		() => 1440,
	);
}

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
export function InspectorSheet() {
	const { sel, nav } = useWorkspace();
	return (
		<Sheet
			open={sel !== null}
			onOpenChange={(open) => !open && nav.select(null)}
		>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[420px] gap-0 p-0 sm:max-w-[420px]"
				data-testid={TESTID.inspector}
			>
				<SheetTitle className="sr-only">Details</SheetTitle>
				<InspectorBody onClose={() => nav.select(null)} />
			</SheetContent>
		</Sheet>
	);
}

export function DesktopWorkspace({ bp }: { bp: Exclude<Breakpoint, "sm"> }) {
	const mapHidden = useShell((s) => s.mapHidden);
	// docs/PLACES.md §1: the Places tab's Map view stands in for the side map.
	const placesMap = usePlacesMapView();
	// One Yonder (D06): the Places tab is a page, the map's width included.
	const { sel, search, days, tab } = useWorkspace();
	// …and so are Money (D11: the balance first, no map) and Lists (D12).
	const placesWide = usePlacesWide() || tab === "money" || tab === "lists";
	const overview = useOverviewTakesAll();
	// D04: a day's ideas in the map's place ("Fill this day").
	const filling = !!search.fill && !!days && tab === "plan";
	const winW = useWindowWidth();
	// One Yonder: a laptop-wide window takes the tabs into the top bar's row.
	const tabsTop = winW >= TABS_IN_TOP_BAR_PX;
	const detailsW = useDetailsWidth(bp === "xl" ? "xl" : "lg");
	const { folded: collapsed, fold } = useDetailsFold();
	// The Places Map view shows its own place's panel beside its map.
	const mapPlace = useIsPlacesRow(
		placesMap && sel?.kind === "node" ? sel.id : null,
	);
	const details =
		(bp === "lg" || bp === "xl") && !overview && sel !== null && !mapPlace;
	const mapShown = !(mapHidden || placesMap || placesWide);
	// What's left for the pane beside a left column this wide, with or without the map.
	const room = (left: number, map: boolean) =>
		winW - left - DIVIDER_PX - CENTER_MIN - (map ? MAP_MIN : 0);
	const paneW = collapsed ? RAIL_PX : detailsW;
	const tight = details && !collapsed && room(0, mapShown) < paneW;
	// No room for the list, the map and the pane: the map folds.
	const foldMap = tight && mapShown;
	const withMap = mapShown && !foldMap;
	const left = 0;
	const docked = details;
	// The centre's width in pixels: the panes share the window less the xl
	// left column, the details and the divider.
	const shared = useRef({ left, pane: 0 });
	shared.current = { left, pane: docked ? paneW : 0 };
	const storage = useMemo(
		() =>
			pixelLayoutStorage(safeStorage(), () => {
				if (typeof window === "undefined") return 0;
				const { left, pane } = shared.current;
				return window.innerWidth - left - pane - DIVIDER_PX;
			}),
		[],
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
			<TopBar bp={bp} tabs={tabsTop} />
			<FollowBar />
			<SpotlightBar />
			<OfflineBanner />
			<GuestNudge />
			<div className="flex min-h-0 flex-1">
				{overview ? (
					<>
						<div className="h-full min-w-0 flex-1">
							<CenterPanel tabs={!tabsTop} />
						</div>
						<InspectorSheet />
					</>
				) : filling ? (
					<>
						<div className="h-full w-[min(560px,45%)] min-w-0 shrink-0 border-r">
							<CenterPanel tabs={!tabsTop} />
						</div>
						<div className="h-full min-w-0 flex-1">
							<FillDay />
						</div>
						{bp === "md" ? (
							<InspectorSheet />
						) : details ? (
							<DetailsPane width={detailsW} maxWidth={detailsW} />
						) : null}
					</>
				) : mapHidden || placesMap || placesWide || foldMap ? (
					<>
						<div className="h-full min-w-0 flex-1">
							<CenterPanel tabs={!tabsTop} />
						</div>
						{bp === "md" ? (
							<InspectorSheet />
						) : details ? (
							<DetailsPane
								width={detailsW}
								maxWidth={detailsW + room(left, false)}
							/>
						) : null}
						{/* The Places tab is a page with a Map view of its own:
						    nothing to bring back. Folded for the details, showing
						    the map folds them instead. */}
						{placesMap || placesWide ? null : (
							<MapRail onShow={foldMap ? fold : undefined} />
						)}
					</>
				) : bp === "md" ? (
					// The centre's box matches the hidden-map layout's: hiding keeps its state.
					<>
						<div className="h-full w-[55%] min-w-0 border-r">
							<CenterPanel tabs={!tabsTop} />
						</div>
						<div className="h-full min-w-0 flex-1">
							<MapRegion variant="desktop" hideable />
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
							<CenterPanel tabs={!tabsTop} />
						</ResizablePanel>
						<ResizableHandle className="hover:bg-primary/40 hover:after:w-[3px]" />
						<ResizablePanel id="map" minSize={320}>
							<MapRegion variant="desktop" hideable />
						</ResizablePanel>
					</ResizablePanelGroup>
				)}
				{withMap && bp !== "md" && !overview && docked ? (
					<DetailsPane
						width={detailsW}
						maxWidth={detailsW + room(left, true)}
					/>
				) : null}
			</div>
		</div>
	);
}

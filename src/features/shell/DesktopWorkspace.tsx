/**
 * DESIGN §5 desktop layouts:
 * - xl ≥ 1280: Outline 264 (⌘\ collapses it; the popover takes over) | centre 520 (resizable 440–720, persisted) | map with the floating inspector (420)
 * - lg: Outline in a popover (top bar), centre 460, map, floating inspector (380)
 * - md: centre 55% | map 45%, inspector in a right Sheet (420)
 * - The Overview tab (docs/OVERVIEW.md) takes the centre, the map's and the
 *   inspector's space as one scrolling page, at every width; a selection
 *   shows in the right Sheet.
 */
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
	usePlacesTakesMap,
} from "@/features/places/tab/PlacesTab";
import { BRAND } from "@/lib/brand";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { CenterPanel } from "./CenterPanel";
import { SpotlightBar } from "./cursors/presence-ui";
import { FollowBar } from "./FollowBar";
import { InspectorBody } from "./InspectorBody";
import { MapRegion } from "./MapRegion";
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

export function DesktopWorkspace({ bp }: { bp: Exclude<Breakpoint, "sm"> }) {
	const outlineCollapsed = useShell((s) => s.outlineCollapsed);
	// docs/PLACES.md §1: the Places tab can take the map's space ("wide").
	const wide = usePlacesTakesMap();
	const overview = useOverviewTakesAll();
	const { defaultLayout, onLayoutChanged } = useDefaultLayout({
		id: `${BRAND.storage.layout}:${bp}`,
		storage: safeStorage(),
	});
	return (
		<div className="flex h-svh flex-col bg-background">
			<TopBar bp={bp} />
			<FollowBar />
			<SpotlightBar />
			<OfflineBanner />
			<GuestNudge />
			<div className="flex min-h-0 flex-1">
				{bp === "xl" && !outlineCollapsed ? (
					<aside
						aria-label="Outline"
						data-testid={SHELL_TESTID.outlineAside}
						className="flex w-[var(--outline-w)] shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground animate-in fade-in-0 slide-in-from-left-2 duration-150 motion-reduce:animate-none"
					>
						<Outline />
						<IdeasBin />
					</aside>
				) : null}
				{overview ? (
					<>
						<div className="h-full min-w-0 flex-1">
							<CenterPanel />
						</div>
						<InspectorSheet />
					</>
				) : wide ? (
					<>
						<div className="h-full min-w-0 flex-1">
							<CenterPanel />
						</div>
						{bp === "md" ? <InspectorSheet placesDocked /> : null}
					</>
				) : bp === "md" ? (
					<>
						<div className="h-full w-[55%] min-w-0 border-r">
							<CenterPanel />
						</div>
						<div className="h-full min-w-0 flex-1">
							<MapRegion variant="desktop" inspector={null} />
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
							/>
						</ResizablePanel>
					</ResizablePanelGroup>
				)}
			</div>
		</div>
	);
}

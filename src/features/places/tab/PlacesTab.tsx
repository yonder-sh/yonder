/**
 * The Places tab (docs/PLACES.md §1–§3): every place in the scope, one
 * filtered set in four views — Table, Board, Map and Rate — with grouping,
 * sort and filters shared by all of them (and kept in the URL, so they
 * deep-link and follow). Opening a place docks its details beside the table
 * or board (the content narrows and keeps scrolling; nothing is covered).
 *
 * Wide mode (the tab takes the map's space) is the shell's layout; with the
 * map showing, the details open over the map instead (the shell's floating
 * inspector slot shows the same `PlaceDetails`).
 */
import { cn } from "cn";
import { lazy, type ReactNode, Suspense, useMemo, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { PlaceFilterSummary } from "@/features/outline/FilterMenu";
import { useViewPrefs } from "@/features/shell/view-prefs";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { isRateable } from "../lib/rate";
import { PlaceDetails } from "./PlaceDetails";
import { PlacesBoard } from "./PlacesBoard";
import { PlacesList } from "./PlacesList";
import { PlacesTable } from "./PlacesTable";
import { PlacesToolbar } from "./PlacesToolbar";
import { PLACES_TAB_TESTID } from "./testids";
import { PlaceActionsProvider } from "./use-place-actions";
import { type PlacesData, usePlaces } from "./use-places";

const PlacesMap = lazy(() => import("./PlacesMap"));
const RateFeed = lazy(() => import("./RateFeed"));

/**
 * Wide mode: remembered per person (view prefs), on by default because the
 * table wants the width. The Map view is always wide (one map at a time).
 */
export function usePlacesWide(): [boolean, (v: boolean) => void] {
	const { mode } = useWorkspace();
	const { prefs, setPrefs } = useViewPrefs({ enabled: mode === "live" });
	return [
		prefs.placesWide ?? true,
		(v: boolean) => setPrefs({ placesWide: v }),
	];
}

/** The shell asks: does the Places tab take the map's space right now? */
export function usePlacesTakesMap(): boolean {
	const { tab, search } = useWorkspace();
	const [wide] = usePlacesWide();
	return tab === "places" && (wide || search.pv === "map");
}

function Empty({ data }: { data: PlacesData }) {
	const { scope, graph, nav } = useWorkspace();
	const where = scope?.name ?? graph.trip.name;
	const none = data.rows.length === 0;
	return (
		<div className="grid flex-1 place-items-center p-6">
			<EmptyState
				line={
					none ? `No places in ${where} yet.` : "No places match these filters."
				}
				action={
					none ? null : (
						<button
							type="button"
							className="cursor-pointer text-sm text-primary hover:underline"
							onClick={() =>
								nav.setPlaces({ pst: undefined, talk: undefined, f: undefined })
							}
						>
							Show every place
						</button>
					)
				}
			/>
		</div>
	);
}

function Body({
	data,
	wide,
	phone,
}: {
	data: PlacesData;
	wide: boolean;
	phone: boolean;
}) {
	const { sel, nav } = useWorkspace();
	const view = data.state.view;
	const row = sel?.kind === "node" ? data.byId.get(sel.id) : undefined;
	if (view === "rate")
		return (
			<Suspense fallback={<div className="flex-1 bg-black" />}>
				<RateFeed data={data} />
			</Suspense>
		);
	if (view === "map")
		return (
			<Suspense fallback={<div className="flex-1 bg-basemap-land" />}>
				<PlacesMap data={data} />
			</Suspense>
		);
	const empty = data.visible.length === 0;
	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex min-w-0 flex-1 flex-col">
				{empty ? (
					<Empty data={data} />
				) : view === "board" ? (
					<PlacesBoard data={data} />
				) : phone ? (
					<PlacesList data={data} />
				) : (
					<PlacesTable data={data} />
				)}
			</div>
			{/* Docked, never over the columns; with the map showing it opens there. */}
			{row && wide ? (
				<aside
					aria-label="Place details"
					className="flex w-[min(400px,45%)] shrink-0 flex-col border-l bg-card animate-in fade-in-0 slide-in-from-right-2 duration-150 motion-reduce:animate-none"
				>
					<PlaceDetails
						row={row}
						data={data}
						onClose={() => nav.select(null)}
						className="h-full"
					/>
				</aside>
			) : null}
		</div>
	);
}

export function PlacesTab({ phone = false }: { phone?: boolean }) {
	const [q, setQ] = useState("");
	const data = usePlaces(q);
	const [wide, setWide] = usePlacesWide();
	const takesMap = usePlacesTakesMap();
	return (
		<PlaceActionsProvider>
			<div
				data-testid={PLACES_TAB_TESTID.tab}
				data-view={data.state.view}
				className={cn("flex h-full min-h-0 flex-col")}
			>
				<PlacesToolbar
					data={data}
					q={q}
					onQ={setQ}
					wide={phone ? null : wide}
					onWide={setWide}
					compact={phone || !takesMap}
				/>
				<PlaceFilterSummary count={data.visible.length} />
				<Body data={data} wide={takesMap && !phone} phone={phone} />
			</div>
		</PlaceActionsProvider>
	);
}

/**
 * The details where the shell shows a selection when the Places tab doesn't
 * dock them itself (the map-side inspector, the tablet sheet, the phone's
 * drawer). `children` (the usual inspector) when the selection isn't one of
 * the tab's places.
 */
export function PlacesSelectionDetails({
	onClose,
	children,
}: {
	onClose: () => void;
	children?: ReactNode;
}) {
	const data = usePlaces("");
	const { sel } = useWorkspace();
	const row = sel?.kind === "node" ? data.byId.get(sel.id) : undefined;
	if (!row) return <>{children}</>;
	return (
		<PlaceActionsProvider>
			<PlaceDetails
				row={row}
				data={data}
				onClose={onClose}
				className="min-h-0 flex-1"
			/>
		</PlaceActionsProvider>
	);
}

/** Is `nodeId` one of the Places tab's places here (the tab docks its details)? */
export function useIsPlacesRow(nodeId: string | null): boolean {
	const { ix, graph, scope } = useWorkspace();
	return useMemo(() => {
		if (!nodeId) return false;
		const node = graph.nodes.find((n) => n.id === nodeId);
		return (
			!!node &&
			isRateable(node) &&
			nodeId !== scope?.id &&
			ix.isWithin(nodeId, scope?.id ?? null)
		);
	}, [nodeId, graph.nodes, ix, scope?.id]);
}

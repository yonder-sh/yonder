/**
 * The Places tab (docs/PLACES.md §1–§4): every place in the scope, led by
 * the planning flow (owner, 2026-09-25) as three steps — **1 Rate · 2
 * Review · 3 Schedule** — each with its count, and "Add a place" at the end
 * of the steps' bar on every step:
 * - Rate: the endless feed, full height;
 * - Review: one filtered set in three views (Table, Board, Map) with
 *   grouping, sort and filters shared by all of them (and kept in the URL,
 *   so they deep-link and follow);
 * - Schedule: "Schedule next" (per stay window, with fit hints); before
 *   any day has a city, the day split between the cities.
 * With no places yet, every step shows the empty state that teaches the flow.
 * The step is the URL's view (`pv`); with none the tab picks the most useful
 * one (`pickStep`) and writes it in. Opening a place docks its details
 * beside the table, board or schedule (the content narrows and keeps
 * scrolling; nothing is covered).
 *
 * Wide mode (the tab takes the map's space) is the shell's layout; with the
 * map showing, the details open over the map instead (the shell's floating
 * inspector slot shows the same `PlaceDetails`).
 */
import { cn } from "cn";
import { Maximize2, Minimize2 } from "lucide-react";
import {
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useMemo,
	useState,
} from "react";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { PlaceFilterSummary } from "@/features/outline/FilterMenu";
import { TabPurpose } from "@/features/shell/TabPurpose";
import { useViewPrefs } from "@/features/shell/view-prefs";
import { canRateOwn } from "@/lib/auth/roles";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { isRateable } from "../lib/rate";
import {
	type FlowStep,
	flowTally,
	nextStep,
	pickStep,
	viewOfStep,
} from "./flow";
import { PlaceDetails } from "./PlaceDetails";
import { PlacesBoard } from "./PlacesBoard";
import { PlacesList } from "./PlacesList";
import { PlacesSteps } from "./PlacesSteps";
import { PlacesTable } from "./PlacesTable";
import { AddPlaceButton, PlacesToolbar, RatingProgress } from "./PlacesToolbar";
import { ScheduleNext } from "./ScheduleNext";
import { PLACES_TAB_TESTID } from "./testids";
import { PlaceActionsProvider } from "./use-place-actions";
import {
	lastReviewView,
	type PlacesData,
	usePlaces,
	usePlacesState,
} from "./use-places";

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

/** No places yet: adding, the flow in three lines, and the way in. */
function FlowEmpty() {
	const { scope, graph } = useWorkspace();
	const where = scope?.name ?? graph.trip.name;
	const steps = [
		["Rate", "them together, Must to Nah."],
		["Review", "the group's scores. The favourites make the shortlist."],
		["Schedule", "the shortlist onto the days you're in each city."],
	] as const;
	return (
		<div
			data-testid={PLACES_TAB_TESTID.flowEmpty}
			className="grid flex-1 place-items-center overflow-y-auto p-6"
		>
			<div className="flex max-w-md flex-col items-start gap-4">
				<TabPurpose tab="places" className="text-[15px] text-foreground" />
				<div className="flex flex-col gap-1">
					<p className="font-display text-[17px] leading-6 font-medium text-balance">
						No places in {where} yet.
					</p>
					<p className="text-sm text-muted-foreground">
						Add every place anyone wants to go: search, or paste links and
						TikToks. Then:
					</p>
				</div>
				<ol className="flex flex-col gap-2 text-sm text-muted-foreground">
					{steps.map(([step, text], i) => (
						<li key={step} className="flex items-baseline gap-2.5">
							<span className="grid size-5 shrink-0 translate-y-0.5 place-items-center rounded-full border font-mono text-[11px] font-semibold text-foreground tnum">
								{i + 1}
							</span>
							<span>
								<span className="font-medium text-foreground">{step}</span>{" "}
								{text}
							</span>
						</li>
					))}
				</ol>
				<AddPlaceButton label="Add the first place" />
			</div>
		</div>
	);
}

function Empty({ data }: { data: PlacesData }) {
	const { nav } = useWorkspace();
	if (data.rows.length === 0) return <FlowEmpty />;
	return (
		<div className="grid flex-1 place-items-center p-6">
			<EmptyState
				line="No places match these filters."
				action={
					<button
						type="button"
						className="cursor-pointer text-sm text-primary hover:underline"
						onClick={() =>
							nav.setPlaces({ pst: undefined, talk: undefined, f: undefined })
						}
					>
						Show every place
					</button>
				}
			/>
		</div>
	);
}

/** Rate: the feed, full height (desktop: under the group's progress). */
function RateStep({ data, phone }: { data: PlacesData; phone: boolean }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{phone ? null : (
				<div className="flex shrink-0 items-center border-b px-4 py-1.5">
					<RatingProgress data={data} />
				</div>
			)}
			<Suspense fallback={<div className="flex-1 bg-black" />}>
				<RateFeed data={data} />
			</Suspense>
		</div>
	);
}

function Body({
	data,
	step,
	wide,
	phone,
	onStep,
	tally,
}: {
	data: PlacesData;
	step: FlowStep;
	wide: boolean;
	phone: boolean;
	onStep: (s: FlowStep) => void;
	tally: ReturnType<typeof flowTally>;
}) {
	const { sel, nav } = useWorkspace();
	const view = data.state.view;
	const row = sel?.kind === "node" ? data.byId.get(sel.id) : undefined;
	if (data.rows.length === 0) return <FlowEmpty />;
	if (step === "rate") return <RateStep data={data} phone={phone} />;
	if (step === "review" && view === "map")
		return (
			<Suspense fallback={<div className="flex-1 bg-basemap-land" />}>
				<PlacesMap data={data} />
			</Suspense>
		);
	const empty = data.visible.length === 0;
	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex min-w-0 flex-1 flex-col">
				{step === "schedule" ? (
					<ScheduleNext
						data={data}
						tally={tally}
						onRate={() => onStep("rate")}
					/>
				) : empty ? (
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

/** Wide mode's toggle (the Map view always takes the map's space). */
function WideToggle({
	wide,
	onWide,
}: {
	wide: boolean;
	onWide: (v: boolean) => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-8"
					aria-pressed={wide}
					aria-label={wide ? "Show the map" : "Wide: hide the map"}
					data-testid={PLACES_TAB_TESTID.wide}
					onClick={() => onWide(!wide)}
				>
					{wide ? (
						<Minimize2 className="size-4" strokeWidth={1.5} />
					) : (
						<Maximize2 className="size-4" strokeWidth={1.5} />
					)}
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				{wide ? "Show the map" : "Wide: hide the map"}
			</TooltipContent>
		</Tooltip>
	);
}

export function PlacesTab({ phone = false }: { phone?: boolean }) {
	const [q, setQ] = useState("");
	// The search belongs to the Review step's list; the feed and the schedule are the whole scope.
	const urlStep = usePlacesState().step;
	const data = usePlaces(urlStep === "rate" || urlStep === "schedule" ? "" : q);
	const { access, ix, sel, search, nav } = useWorkspace();
	const [wide, setWide] = usePlacesWide();
	const takesMap = usePlacesTakesMap();
	const tally = useMemo(
		() =>
			flowTally(data.rows, {
				me: access.memberId,
				canRate: canRateOwn(access),
			}),
		[data.rows, access],
	);
	const ctx = { canEdit: access.mode !== "read", hasDays: ix.days.length > 0 };
	const next = nextStep(tally, ctx);
	// No step in the URL: the most useful one, written in right away (so it
	// holds while the counts change, deep-links and follows).
	const step =
		data.state.step ??
		pickStep(tally, {
			...ctx,
			phone,
			focus:
				sel?.kind === "node" || !!search.pst || !!search.talk || !!search.f,
		});
	const pv = search.pv;
	useEffect(() => {
		if (!pv) nav.setPlaces({ pv: viewOfStep(step, lastReviewView.current) });
	}, [pv, step, nav]);
	if (step === "review") lastReviewView.current = data.state.view;
	const onStep = (s: FlowStep) => {
		if (s === step) return;
		// The Rate feed and the schedule are the whole scope: the Review
		// step's status pills and "Talk about it" stay with it.
		nav.setPlaces({
			pv: viewOfStep(s, lastReviewView.current),
			...(s === "review" ? {} : { pst: undefined, talk: undefined }),
		});
	};
	const mapView = step === "review" && data.state.view === "map";
	return (
		<PlaceActionsProvider>
			<div
				data-testid={PLACES_TAB_TESTID.tab}
				data-view={viewOfStep(step, data.state.view)}
				data-step={step}
				className={cn("flex h-full min-h-0 flex-col")}
			>
				<PlacesSteps
					step={step}
					tally={tally}
					next={next}
					onStep={onStep}
					phone={phone}
				>
					{/* Adding is an action on every step, not a step of its own. */}
					<AddPlaceButton iconOnly={phone || !takesMap} />
					{/* The Map view always takes the map's space (one map at a time). */}
					{phone || mapView ? null : (
						<WideToggle wide={wide} onWide={setWide} />
					)}
				</PlacesSteps>
				{step === "review" && data.rows.length > 0 ? (
					<PlacesToolbar
						data={data}
						q={q}
						onQ={setQ}
						compact={phone || !takesMap}
					/>
				) : null}
				{step === "schedule" ? null : (
					<PlaceFilterSummary count={data.visible.length} />
				)}
				<Body
					data={data}
					step={step}
					wide={takesMap && !phone}
					phone={phone}
					onStep={onStep}
					tally={tally}
				/>
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

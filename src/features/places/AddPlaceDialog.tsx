/**
 * The ⌘K palette and add-place flow (SPEC §12.5 `AddPlaceDialog()`, DESIGN
 * §8.1), opened with `useUi().openAddPlace({ mode, … })` from ⌘K, "+", the
 * FAB, empty states and the New trip flow.
 *
 * Groups: **In this trip** (Enter jumps, ⌘Enter schedules), **Places** from
 * Google or OpenStreetMap, **Actions** (Drop a pin…, a new node by name, Go to
 * Day N, a pasted Google Maps link). Picking a place opens the preview (a
 * right pane ≥ 768px, full-screen below): photo or map, name, category,
 * address, the filing chip (`TreePicker` per segment), category chips, and
 * Save to Ideas / Schedule (a split button). Modes: `search`, `schedule`
 * (Schedule is the default action), `locate` ("Use this location" for a node
 * without coordinates) and `first` ("Where to first?": countries and cities).
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import {
	ArrowLeft,
	CalendarDays,
	ChevronDown,
	CornerDownLeft,
	Link2,
	MapPin,
	Plus,
	Route,
	Search,
	Star,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import {
	CategoryDot,
	CategoryIcon,
	FlagEmoji,
	TypeGlyph,
} from "@/components/common/glyphs";
import { TreePicker } from "@/components/common/tree-picker";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
	Command,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { can } from "@/lib/auth/roles";
import {
	NODE_TYPES,
	PLACE_CATEGORIES,
	PLACE_GROUPS,
	type PlaceGroup,
} from "@/lib/domain/taxonomy";
import { canNest } from "@/lib/engine/tree";
import type { GraphLeg, GraphNode } from "@/lib/engine/types";
import { humanError } from "@/lib/errors";
import { formatDayDate } from "@/lib/format";
import { newId } from "@/lib/ids";
import { useFormPresence } from "@/lib/realtime/form-presence";
import type { NodeType, PlaceCategory } from "@/lib/schemas/enums";
import type { LegTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { type AddPlaceRequest, useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { resultKind } from "./lib/categorize";
import { findDuplicate } from "./lib/filing";
import { locateBiasNode, locationPatch, pinKeepsIdentity } from "./lib/locate";
import { parseMapsUrl } from "./lib/maps-url";
import type {
	PlacePreview,
	PlaceProvider,
	PlaceSearchResult,
} from "./lib/providers";
import { rateableNodes } from "./lib/rate";
import {
	isPlaceSearch,
	looksLikeUrl,
	matchesRateCommand,
	matchTripLegs,
	matchTripNodes,
	parseDayQuery,
	parseLatLngQuery,
} from "./lib/trip-search";
import { useCreateItem, useCreateNodePath, useUpdateNode } from "./mutations";
import {
	getPlacePreview,
	resolveSharedLink,
	reverseGeocode,
	searchPlaces,
} from "./places.functions";
import { stepOfView } from "./tab/flow";
import { PLACES_TESTID } from "./testids";
import { MiniMap } from "./ui/mini-map";
import { type ResultPin, ResultsMap } from "./ui/results-map";
import {
	defaultSchedulePick,
	type SchedulePick,
	SchedulePicker,
} from "./ui/schedule-picker";

/** Where focus goes when the palette closes (A11Y-02: never to `<body>`). */
type AfterClose = "return" | "inspector";

/** Places › Review lists what's added: a new place opens there, in its details. */
function opensAdded(ws: ReturnType<typeof useWorkspace>): boolean {
	return ws.tab === "places" && stepOfView(ws.search.pv) === "review";
}

/**
 * Focus after the palette: the Inspector it opened, else where focus was
 * before (a button that opened it), else the ⌘K button — never `<body>`.
 * The Inspector renders after the URL changes, so it is looked up for a
 * short while.
 */
function restoreFocus(target: AfterClose, before: HTMLElement | null) {
	const fallback = () => {
		const el =
			before?.isConnected && before !== document.body
				? before
				: document.querySelector<HTMLElement>(
						`[data-testid="${TESTID.commandButton}"]`,
					);
		el?.focus({ preventScroll: true });
	};
	if (target !== "inspector") return fallback();
	let tries = 0;
	const tick = () => {
		const insp = document.querySelector<HTMLElement>(
			`[data-testid="${TESTID.inspector}"]`,
		);
		if (insp) {
			// A Sheet (md, phones) moves focus into itself.
			if (insp.contains(document.activeElement)) return;
			if (!insp.hasAttribute("tabindex")) insp.setAttribute("tabindex", "-1");
			insp.focus({ preventScroll: true });
			return;
		}
		if (++tries < 12) setTimeout(tick, 50);
		else fallback();
	};
	tick();
}

export function AddPlaceDialog() {
	const request = useUi((s) => s.addPlace);
	const close = useUi((s) => s.openAddPlace);
	// FB-24: "Dennis is adding a place…" (on the day it goes to), or setting
	// a place's location.
	useFormPresence(
		request
			? {
					k: "place",
					m: request.mode === "locate" ? "edit" : "add",
					t:
						request.mode === "locate" && request.nodeId
							? `tree:${request.nodeId}`
							: request.dayId
								? `dayh:${request.dayId}`
								: request.parentId
									? `tree:${request.parentId}`
									: null,
				}
			: null,
	);
	// A fresh palette per open (query, session token, selection).
	const [openCount, setOpenCount] = useState(0);
	const wasOpen = useRef(false);
	useEffect(() => {
		if (request && !wasOpen.current) setOpenCount((n) => n + 1);
		wasOpen.current = request !== null;
	}, [request]);
	// What had focus when the palette opened (before it moves focus inside):
	// a hotkey leaves `<body>`, a button keeps itself.
	const before = useRef<HTMLElement | null>(null);
	const after = useRef<AfterClose>("return");
	const opened = useRef(false);
	useLayoutEffect(() => {
		if (request && !opened.current) {
			const el = document.activeElement;
			before.current =
				el instanceof HTMLElement && el !== document.body ? el : null;
			after.current = "return";
		}
		opened.current = request !== null;
	}, [request]);
	return (
		<Dialog open={request !== null} onOpenChange={(o) => !o && close(null)}>
			{request ? (
				<Palette
					key={openCount}
					request={request}
					onClose={(then) => {
						after.current = then ?? "return";
						close(null);
					}}
					onCloseAutoFocus={(e) => {
						e.preventDefault();
						restoreFocus(after.current, before.current);
					}}
				/>
			) : null}
		</Dialog>
	);
}

type Selection =
	| { kind: "result"; provider: PlaceProvider; result: PlaceSearchResult }
	| { kind: "pin"; lat: number; lng: number }
	| { kind: "link"; url: string };

const DEBOUNCE_MS = 300;

function toLatLng(
	c: [number, number] | null,
): { lat: number; lng: number } | null {
	return c ? { lat: c[1], lng: c[0] } : null;
}

function useDebounced<T>(value: T, ms: number): T {
	const [v, setV] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setV(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return v;
}

/** Keys that move cmdk's highlight: the user has picked where it is. */
function steersHighlight(e: {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
}): boolean {
	return (
		e.key === "ArrowDown" ||
		e.key === "ArrowUp" ||
		e.key === "Home" ||
		e.key === "End" ||
		(e.ctrlKey && ["n", "p", "j", "k"].includes(e.key))
	);
}

/**
 * Highlights the first option the way cmdk's own Home key does, so its
 * `aria-activedescendant` and scroll follow (VIS3-01). cmdk highlights the
 * first option when the text changes, but options that arrive later (the
 * OpenStreetMap results) are inserted ABOVE the highlight, which then stays
 * on "Drop a pin…".
 */
function highlightFirstOption(root: HTMLElement | null) {
	const home = new KeyboardEvent("keydown", { key: "Home", bubbles: true });
	OURS.add(home);
	root?.dispatchEvent(home);
}
/** The Home presses `highlightFirstOption` makes (not the user's). */
const OURS = new WeakSet<Event>();

function Palette({
	request,
	onClose,
	onCloseAutoFocus,
}: {
	request: AddPlaceRequest;
	/** `"inspector"`: the close opened the Inspector, which takes the focus. */
	onClose: (then?: AfterClose) => void;
	onCloseAutoFocus: (e: Event) => void;
}) {
	const ws = useWorkspace();
	const navigate = useNavigate();
	const { ix, graph, nav, access, scope } = ws;
	const tripId = graph.trip.id;
	const mode = request.mode;
	const locating = mode === "locate" ? ix.node(request.nodeId) : undefined;
	const [q, setQ] = useState(locating?.name ?? "");
	const [selected, setSelected] = useState<Selection | null>(null);
	const [pinning, setPinning] = useState(false);
	const sessionToken = useMemo(() => newId(), []);
	const canSearch =
		ws.mode === "live" && can(access, "searchPlaces") && access.canEdit;
	const debounced = useDebounced(q.trim(), DEBOUNCE_MS);
	// A pasted "lat, lng" is a spot, not a search (HIER-12).
	const coords = mode === "first" ? null : parseLatLngQuery(q);

	// Bias: the request's parent, else the scope, else nothing (`first`).
	// Setting a location looks around the node's own parent (Bar Kuro: Golden
	// Gai), not wherever the view happens to be.
	const biasNode =
		(mode === "locate" ? locateBiasNode(ix, request.nodeId) : null) ??
		request.parentId ??
		scope?.id ??
		null;
	const biasLngLat = mode === "first" ? null : ix.coordOf(biasNode);
	const biasAt = biasLngLat ? { lat: biasLngLat[1], lng: biasLngLat[0] } : null;
	const search = useQuery({
		queryKey: [
			"places",
			"search",
			tripId,
			mode === "first" ? "first" : "any",
			debounced,
			biasAt ? `${biasAt.lat.toFixed(2)},${biasAt.lng.toFixed(2)}` : "",
		],
		queryFn: async () => {
			const base = {
				tripId,
				q: debounced,
				sessionToken,
				...(biasAt
					? { bias: { lat: biasAt.lat, lng: biasAt.lng, radiusM: 30_000 } }
					: {}),
			};
			if (mode !== "first") return searchPlaces({ data: base });
			// "Where to first?": countries, then cities ("Kyoto" the city, not the station).
			const [countries, cities] = await Promise.all([
				searchPlaces({ data: { ...base, level: "country" } }),
				searchPlaces({ data: { ...base, level: "city" } }),
			]);
			const seen = new Set<string>();
			return {
				provider: countries.provider,
				results: [...countries.results.slice(0, 3), ...cities.results].filter(
					(r) => !seen.has(r.ref) && seen.add(r.ref),
				),
			};
		},
		enabled: canSearch && isPlaceSearch(debounced, mode !== "first"),
		placeholderData: keepPreviousData,
		staleTime: 5 * 60_000,
		retry: false,
	});
	const provider = search.data?.provider;
	// `keepPreviousData` holds the last results while the next search loads,
	// but text that isn't a search (a pasted "lat, lng", a link, a cleared
	// box) shows none: "Use this location" must be the first, chosen option,
	// not the stale "Bar Kuro" hits from Ningbo and Vancouver (HIER-12).
	const searching = canSearch && isPlaceSearch(q, mode !== "first");
	const results = useMemo(() => {
		const all = searching ? (search.data?.results ?? []) : [];
		if (mode !== "first") return all;
		return all.filter((r) =>
			["country", "region", "city"].includes(resultKind(r.types).level),
		);
	}, [search.data, mode, searching]);

	const tripHits = useMemo(
		() =>
			mode === "locate" || mode === "first" || coords
				? []
				: q.trim()
					? matchTripNodes(ix.outline, q, results.length ? 5 : 8)
					: [],
		[ix, q, mode, results.length, coords],
	);
	// Named legs ("Fuji Excursion (Shinjuku → Kawaguchiko)", HIER-10).
	const legHits = useMemo(
		() =>
			mode === "locate" || mode === "first" || coords || !q.trim()
				? []
				: matchTripLegs(
						graph.legs.filter((l) => ix.leg(l.id)),
						(l) => ix.legDetails(l),
						q,
						3,
					),
		[ix, graph.legs, q, mode, coords],
	);
	const dayQuery = parseDayQuery(q);
	const dayHit =
		dayQuery !== null && dayQuery >= 1 ? ix.days[dayQuery - 1] : undefined;
	const mapsLink = looksLikeUrl(q) && parseMapsUrl(q.trim()) ? q.trim() : null;
	// EMPTY-05 / DESIGN §12: a finished search that found nothing says so
	// (the Actions group always has items, so cmdk's own empty never shows).
	const settled =
		!canSearch ||
		q.trim().length < 2 ||
		(debounced === q.trim() && !search.isFetching && !search.isError);
	const noMatches =
		!!q.trim() &&
		!coords &&
		!mapsLink &&
		!dayHit &&
		settled &&
		tripHits.length === 0 &&
		legHits.length === 0 &&
		results.length === 0;

	const title =
		mode === "first"
			? "Where to first?"
			: mode === "locate"
				? `Set location for ${locating?.name ?? "this place"}`
				: mode === "schedule"
					? "Add a place to the plan"
					: "Search, add or jump";
	const placeholder = !canSearch
		? "Find a place in this trip…"
		: mode === "first"
			? "A country or a city…"
			: "Search places, or type Day 4…";

	const showPreview = selected !== null || pinning;
	// The results on a map, numbered as in the list, to pick the right one.
	const pins = useMemo<ResultPin[]>(
		() =>
			results.flatMap((r, i) =>
				r.lat !== undefined && r.lng !== undefined
					? [{ ref: r.ref, n: i + 1, title: r.title, lat: r.lat, lng: r.lng }]
					: [],
			),
		[results],
	);
	const showMap = pins.length > 0 && !showPreview;
	// Phones: the list or the map, one at a time.
	const [phoneMap, setPhoneMap] = useState(false);
	const pickResult = (ref: string) => {
		const r = results.find((x) => x.ref === ref);
		if (!r) return;
		setPinning(false);
		setSelected({ kind: "result", provider: provider ?? "photon", result: r });
	};

	// ---- the rate screen (FB-05: ⌘K "rate" finds it) -----------------------
	const rateScope = scope && scope.type !== "place" ? scope : null;
	const showRate =
		mode === "search" &&
		ws.mode === "live" &&
		!coords &&
		(!q.trim() || matchesRateCommand(q));
	const toRate = useMemo(() => {
		if (!showRate) return [];
		// Suggestions nobody accepted yet aren't rated (as on the rate screen).
		const liveIds = new Set(graph.nodes.map((n) => n.id));
		return rateableNodes(ix, rateScope?.id ?? null, { liveIds });
	}, [showRate, graph.nodes, ix, rateScope?.id]);
	const me = access.memberId;
	const unratedByMe = me
		? toRate.filter((n) => n.priorities[me] === undefined).length
		: 0;
	// docs/PLACES.md §1b: the Places tab's Rate feed at that scope.
	const openRate = () => {
		onClose();
		nav.openPlaces({
			scopeId: rateScope?.id ?? null,
			patch: { pv: "rate" },
		});
	};
	const rateItem = toRate.length ? (
		<CommandItem
			value="action:rate"
			data-testid={PLACES_TESTID.paletteRate}
			onSelect={openRate}
		>
			<Star strokeWidth={1.5} />
			<span className="truncate">
				Rate places{rateScope ? ` in ${rateScope.name}` : ""}
			</span>
			<span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
				{unratedByMe
					? `${unratedByMe} unrated`
					: `${toRate.length} ${toRate.length === 1 ? "place" : "places"}`}
			</span>
		</CommandItem>
	) : null;

	// ---- the highlight (VIS3-01) ------------------------------------------
	// Options that arrive after the text changed (search results, trip hits)
	// take the highlight unless the user already moved it (keys, pointer).
	const commandRef = useRef<HTMLDivElement>(null);
	const steered = useRef(false);
	// The highlighted result (keys or pointer), for its pin on the map. The
	// dialog's content mounts after the palette, so the list arrives by ref.
	const [highlight, setHighlight] = useState<string | null>(null);
	const [cmdRoot, setCmdRoot] = useState<HTMLDivElement | null>(null);
	const setCommandRef = useCallback((el: HTMLDivElement | null) => {
		commandRef.current = el;
		setCmdRoot(el);
	}, []);
	useEffect(() => {
		const root = cmdRoot;
		if (!root) return;
		const read = () => {
			const v = root
				.querySelector('[cmdk-item][data-selected="true"]')
				?.getAttribute("data-value");
			setHighlight(v?.startsWith("place:") ? v.slice(6) : null);
		};
		read();
		const obs = new MutationObserver(read);
		obs.observe(root, {
			subtree: true,
			attributes: true,
			attributeFilter: ["data-selected"],
		});
		return () => obs.disconnect();
	}, [cmdRoot]);
	const optionsKey = [
		tripHits.map((n) => n.id).join(),
		legHits.map((h) => h.leg.id).join(),
		results.map((r) => r.ref).join(),
		rateItem && q.trim() ? "rate" : "",
	].join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the options change.
	useLayoutEffect(() => {
		if (!steered.current) highlightFirstOption(commandRef.current);
	}, [optionsKey]);

	// ---- actions --------------------------------------------------------
	const createNamed = useCreateNodePath(tripId);
	const parentForNew = request.parentId ?? scope?.id ?? null;
	const newType: NodeType | null = (() => {
		if (mode === "first") return "country";
		const parent = parentForNew ? ix.node(parentForNew) : null;
		if (!parent) return "country";
		const order: NodeType[] = ["place", "area", "city", "region", "country"];
		return order.find((t) => canNest(parent.type, t)) ?? null;
	})();
	const addNamed = () => {
		const name = q.trim();
		if (!name || !newType) return;
		const id = newId();
		const chain = [
			...(parentForNew ? ix.path(parentForNew).map((n) => ({ id: n.id })) : []),
			{
				type: newType,
				name,
				...(newType === "place" ? { category: "other" as const } : {}),
			},
		];
		const open = newType === "place" && opensAdded(ws);
		createNamed.mutate(
			{ chain, ids: [id] },
			{
				onSuccess: () => {
					if (open) {
						onClose("inspector");
						nav.select({ kind: "node", id });
						toast(`Added ${name}`);
						return;
					}
					onClose();
					toast(`Added ${name}`, {
						action: {
							label: "Show",
							onClick: () => nav.select({ kind: "node", id }),
						},
					});
				},
				onError: (e) => toast.error(humanError(e)),
			},
		);
	};

	const jumpToLeg = (target: LegTarget) => {
		onClose("inspector");
		nav.select({ kind: "leg", target });
	};

	const jumpTo = (n: GraphNode) => {
		onClose(n.type === "place" ? "inspector" : "return");
		if (n.type === "place") nav.select({ kind: "node", id: n.id });
		else nav.zoomIn(n.id);
	};

	const createItem = useCreateItem(tripId);
	const scheduleExisting = (n: GraphNode) => {
		const pick = defaultSchedulePick(ix, {
			request,
			sel: ws.sel,
			days: ws.days,
		});
		if (!pick || !access.canEdit) return jumpTo(n);
		const id = newId();
		createItem.mutate(
			{
				id,
				dayId: pick.dayId,
				nodeId: n.id,
				...(pick.afterItemId ? { afterItemId: pick.afterItemId } : {}),
			},
			{
				onSuccess: () => {
					onClose();
					toast(`${n.name} · ${pick.label}`, {
						action: {
							label: "Show",
							onClick: () => nav.select({ kind: "item", id }),
						},
					});
				},
				onError: (e) => toast.error(humanError(e)),
			},
		);
	};

	return (
		<DialogContent
			data-testid={TESTID.addPlaceDialog}
			showCloseButton={false}
			onCloseAutoFocus={onCloseAutoFocus}
			onEscapeKeyDown={(e) => {
				if (selected || pinning) {
					e.preventDefault();
					setSelected(null);
					setPinning(false);
				}
			}}
			className={cn(
				"gap-0 overflow-hidden p-0 shadow-float transition-[max-width] duration-200",
				"max-sm:top-0 max-sm:left-0 max-sm:h-svh max-sm:max-h-none max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0",
				showPreview || showMap ? "sm:max-w-[920px]" : "sm:max-w-[640px]",
			)}
		>
			<DialogTitle className="sr-only">{title}</DialogTitle>
			<DialogDescription className="sr-only">
				Find a place in this trip, search for a new one, or jump to a day.
			</DialogDescription>
			<Command
				ref={setCommandRef}
				shouldFilter={false}
				loop
				onKeyDown={(e) => {
					if (!OURS.has(e.nativeEvent) && steersHighlight(e))
						steered.current = true;
				}}
				className="flex h-full max-h-[min(640px,85svh)] flex-col rounded-none bg-popover max-sm:max-h-none"
			>
				{mode === "first" || mode === "locate" ? (
					<div className="px-4 pt-4 pb-1">
						<p
							className={cn(
								mode === "first"
									? "font-display text-[22px] leading-7 font-semibold"
									: "text-[15px] font-semibold",
							)}
						>
							{title}
						</p>
					</div>
				) : null}
				<div
					className={cn(
						"flex items-center border-b [&_[data-slot=command-input-wrapper]]:h-12 [&_[data-slot=command-input-wrapper]]:flex-1 [&_[data-slot=command-input-wrapper]]:border-b-0 [&_[data-slot=command-input-wrapper]]:px-4",
						showPreview && "max-sm:hidden",
					)}
				>
					<CommandInput
						data-testid={PLACES_TESTID.paletteInput}
						value={q}
						onValueChange={(v) => {
							setQ(v);
							setSelected(null);
							setPinning(false);
							// New text: cmdk highlights the first option again.
							steered.current = false;
						}}
						placeholder={placeholder}
						className="h-12 text-base"
					/>
					{search.isFetching ? <Spinner className="mr-3 size-4" /> : null}
					<button
						type="button"
						onClick={() => onClose()}
						className="mr-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent sm:hidden"
					>
						Cancel
					</button>
				</div>
				{showMap ? (
					<fieldset
						aria-label="Show results as"
						className="flex gap-1 border-b px-3 py-1.5 sm:hidden"
					>
						{(["List", "Map"] as const).map((v) => {
							const on = (v === "Map") === phoneMap;
							return (
								<button
									key={v}
									type="button"
									aria-pressed={on}
									onClick={() => setPhoneMap(v === "Map")}
									className={cn(
										"h-7 rounded-md px-3 text-xs font-medium",
										on
											? "bg-accent text-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{v}
								</button>
							);
						})}
					</fieldset>
				) : null}
				<div className="flex min-h-0 flex-1">
					<CommandList
						onPointerMove={(e) => {
							// cmdk highlights the option under the pointer.
							if ((e.target as HTMLElement).closest("[cmdk-item]"))
								steered.current = true;
						}}
						className={cn(
							"max-h-none min-h-0 flex-1 overflow-y-auto",
							showPreview && "max-w-[340px] border-r max-sm:hidden",
							showMap && "sm:max-w-[340px] sm:border-r",
							showMap && phoneMap && "max-sm:hidden",
						)}
					>
						{noMatches ? (
							<div
								role="status"
								data-testid={PLACES_TESTID.paletteEmpty}
								className="px-4 pt-5 pb-3 text-center"
							>
								<p className="font-display text-[15px] font-medium">
									{canSearch
										? "No matches. Try a broader name, or drop a pin."
										: "No places in this trip match."}
								</p>
							</div>
						) : null}
						{coords && !coords.ok ? (
							<p
								role="alert"
								data-testid={PLACES_TESTID.coordsError}
								className="px-4 pt-4 pb-2 text-[13px] text-destructive"
							>
								{coords.error}
							</p>
						) : null}
						{!q.trim() && !showPreview ? (
							<EmptyHints canSearch={canSearch} mode={mode} />
						) : null}

						{rateItem && q.trim() ? (
							<CommandGroup heading="Go to">{rateItem}</CommandGroup>
						) : null}

						{tripHits.length || legHits.length ? (
							<CommandGroup heading="In this trip">
								{tripHits.map((n) => (
									<CommandItem
										key={n.id}
										value={`trip:${n.id}`}
										data-testid={PLACES_TESTID.paletteTripResult}
										onSelect={() => jumpTo(n)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
												e.preventDefault();
												scheduleExisting(n);
											}
										}}
									>
										<TypeGlyph type={n.type} category={n.category} />
										<span className="truncate">{n.name}</span>
										<span className="ml-auto truncate pl-2 text-xs text-muted-foreground">
											{ix
												.path(n.id)
												.slice(0, -1)
												.map((a) => a.name)
												.join(" › ")}
										</span>
									</CommandItem>
								))}
								{legHits.map((h) => (
									<CommandItem
										key={h.leg.id}
										value={`leg:${h.leg.id}`}
										data-testid={PLACES_TESTID.paletteTripLeg}
										onSelect={() => jumpToLeg(h.target)}
									>
										<Route
											className="text-muted-foreground"
											strokeWidth={1.5}
										/>
										<span className="truncate">{h.title}</span>
										<span className="ml-auto shrink-0 truncate pl-2 text-xs text-muted-foreground">
											{legMeta(ix, h.leg)}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						) : null}

						{results.length ? (
							<CommandGroup
								heading={
									provider === "google" ? "Places" : "Places · OpenStreetMap"
								}
							>
								{results.map((r, i) => {
									const kind = resultKind(r.types);
									const active =
										selected?.kind === "result" &&
										selected.result.ref === r.ref;
									return (
										<CommandItem
											key={r.ref}
											value={`place:${r.ref}`}
											data-testid={PLACES_TESTID.paletteResult}
											data-selected-preview={active || undefined}
											className={cn(active && "bg-accent")}
											onSelect={() => {
												setPinning(false);
												setSelected({
													kind: "result",
													provider: provider ?? "photon",
													result: r,
												});
											}}
										>
											{kind.level === "place" ? (
												kind.category ? (
													<CategoryIcon
														category={kind.category}
														className="text-muted-foreground"
													/>
												) : (
													<MapPin
														className="text-muted-foreground"
														strokeWidth={1.5}
													/>
												)
											) : (
												<TypeGlyph type={kind.level} />
											)}
											<span className="grid min-w-0">
												<span className="truncate">{r.title}</span>
												{r.subtitle ? (
													<span className="truncate text-xs text-muted-foreground">
														{r.subtitle}
													</span>
												) : null}
											</span>
											{/* Its pin's number on the results map. */}
											{r.lat !== undefined && r.lng !== undefined ? (
												<span className="ml-auto grid size-5 shrink-0 place-items-center rounded-full bg-muted font-mono text-[11px] text-muted-foreground tnum">
													{i + 1}
												</span>
											) : null}
										</CommandItem>
									);
								})}
							</CommandGroup>
						) : null}
						{search.isError && searching ? (
							<p className="px-4 py-3 text-[13px] text-muted-foreground">
								{humanError(search.error)}
							</p>
						) : null}

						<CommandGroup heading="Actions">
							{coords?.ok && canSearch ? (
								<CommandItem
									value="action:coords"
									data-testid={PLACES_TESTID.coordsResult}
									onSelect={() => {
										setPinning(false);
										setSelected({
											kind: "pin",
											lat: coords.lat,
											lng: coords.lng,
										});
									}}
								>
									<MapPin strokeWidth={1.5} />
									<span className="truncate">
										{mode === "locate" ? "Use this location" : "Pin at"}
										<span className="ml-1.5 font-mono text-xs tnum text-muted-foreground">
											{coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
										</span>
									</span>
								</CommandItem>
							) : null}
							{mapsLink && canSearch ? (
								<CommandItem
									value="action:link"
									onSelect={() => setSelected({ kind: "link", url: mapsLink })}
								>
									<Link2 strokeWidth={1.5} />
									Save the place in this Maps link
								</CommandItem>
							) : null}
							{!q.trim() && canSearch && mode !== "first" ? (
								<CommandItem
									value="action:paste"
									onSelect={async () => {
										// E8 on iOS (no share target): paste a Google Maps link.
										try {
											const text = (
												await navigator.clipboard.readText()
											).trim();
											if (looksLikeUrl(text) && parseMapsUrl(text)) {
												setQ(text);
												setSelected({ kind: "link", url: text });
												return;
											}
										} catch {
											// No clipboard access: the share page has a paste box.
										}
										// Any other link (a video, a guide): WP-Home's share page
										// saves it in one tap (EXTENSIONS §10 iOS path).
										onClose();
										void navigate({ to: "/share" });
									}}
								>
									<Link2 strokeWidth={1.5} />
									Paste link to save…
								</CommandItem>
							) : null}
							{dayHit ? (
								<CommandItem
									value="action:day"
									onSelect={() => {
										onClose("inspector");
										nav.select({ kind: "day", id: dayHit.id });
									}}
								>
									<CalendarDays strokeWidth={1.5} />
									Go to Day {dayQuery} · {formatDayDate(dayHit.date)}
								</CommandItem>
							) : null}
							{canSearch ? (
								<CommandItem
									value="action:pin"
									data-testid={PLACES_TESTID.dropPin}
									onSelect={() => {
										setSelected(null);
										setPinning(true);
									}}
								>
									<MapPin strokeWidth={1.5} />
									Drop a pin…
								</CommandItem>
							) : null}
							{q.trim() &&
							newType &&
							access.canEdit &&
							mode !== "locate" &&
							!coords &&
							!mapsLink ? (
								<CommandItem
									value="action:add"
									onSelect={addNamed}
									disabled={createNamed.isPending}
								>
									<Plus strokeWidth={1.5} />
									<span className="truncate">
										Add “{q.trim()}” as a new{" "}
										{NODE_TYPES[newType].label.toLowerCase()}
										{parentForNew ? ` in ${ix.node(parentForNew)?.name}` : ""}
									</span>
								</CommandItem>
							) : null}
							{q.trim() ? null : rateItem}
						</CommandGroup>
					</CommandList>

					{showMap ? (
						<ResultsMap
							pins={pins}
							active={highlight}
							onPick={pickResult}
							className={cn("min-w-0 flex-1", !phoneMap && "max-sm:hidden")}
						/>
					) : null}
					{showPreview ? (
						<div className="min-w-0 flex-1 overflow-y-auto">
							<button
								type="button"
								onClick={() => {
									setSelected(null);
									setPinning(false);
								}}
								className={cn(
									"flex items-center gap-1 px-4 pt-3 text-xs text-muted-foreground hover:text-foreground",
									// With a results map, desktop gets back to it too.
									!pins.length && "sm:hidden",
								)}
							>
								<ArrowLeft className="size-3.5" /> Back to results
							</button>
							{pinning && !selected ? (
								<DropPin
									start={
										biasAt ??
										toLatLng(ix.coordOf(null)) ?? { lat: 35.68, lng: 139.76 }
									}
									onUse={(at) => {
										setPinning(false);
										setSelected({ kind: "pin", ...at });
									}}
								/>
							) : selected ? (
								<PreviewPane
									key={
										selected.kind === "result"
											? selected.result.ref
											: selected.kind === "pin"
												? `${selected.lat},${selected.lng}`
												: selected.url
									}
									selection={selected}
									request={request}
									sessionToken={sessionToken}
									onDone={onClose}
								/>
							) : null}
						</div>
					) : null}
				</div>
				<div
					data-testid={PLACES_TESTID.providerFooter}
					className="flex items-center gap-3 border-t px-4 py-2 text-[11px] text-muted-foreground max-sm:pb-[max(env(safe-area-inset-bottom),8px)]"
				>
					{provider === "google" ? (
						<span>Powered by Google</span>
					) : (
						<span>
							Places ©{" "}
							<a
								href="https://www.openstreetmap.org/copyright"
								target="_blank"
								rel="noopener noreferrer"
								className="underline-offset-2 hover:underline"
							>
								OpenStreetMap contributors
							</a>
						</span>
					)}
					<span className="ml-auto hidden items-center gap-1 sm:inline-flex">
						<Kbd>
							<CornerDownLeft className="size-3" />
						</Kbd>
						{mode === "locate" ? "choose" : "open"}
						{tripHits.length && mode !== "locate" ? (
							<>
								<Kbd className="ml-2">⌘</Kbd>
								<Kbd>
									<CornerDownLeft className="size-3" />
								</Kbd>
								schedule
							</>
						) : null}
						<Kbd className="ml-2">Esc</Kbd>
						{showPreview ? "back" : "close"}
					</span>
				</div>
			</Command>
		</DialogContent>
	);
}

/** "Leg · Day 4" for a leg row in the palette. */
function legMeta(ix: ReturnType<typeof useWorkspace>["ix"], leg: GraphLeg) {
	const dayId =
		leg.kind === "pair" ? ix.item(leg.fromItemId)?.dayId : leg.stayDayId;
	const n = dayId ? ix.dayNumber(dayId) : 0;
	return n ? `Leg · Day ${n}` : "Leg";
}

function EmptyHints({
	canSearch,
	mode,
}: {
	canSearch: boolean;
	mode: AddPlaceRequest["mode"];
}) {
	return (
		<div className="grid gap-1 px-4 pt-5 pb-3 text-[13px] text-muted-foreground">
			<p className="flex items-center gap-2">
				<Search className="size-3.5" strokeWidth={1.5} />
				{mode === "first"
					? "Type a country or a city to start the trip."
					: canSearch
						? "Type a place, a shop, a temple — or “Day 4”."
						: "Type a place in this trip, or “Day 4”."}
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Drop a pin
// ---------------------------------------------------------------------------

function DropPin({
	start,
	onUse,
}: {
	start: { lat: number; lng: number };
	onUse: (at: { lat: number; lng: number }) => void;
}) {
	const [at, setAt] = useState(start);
	return (
		<div className="grid gap-3 p-4">
			<p className="text-[13px] text-muted-foreground">
				Move the map until the pin sits on the spot.
			</p>
			<MiniMap
				lat={start.lat}
				lng={start.lng}
				zoom={13}
				pick
				onCenter={setAt}
				className="h-[320px] overflow-hidden rounded-xl border"
				label="Map for dropping a pin"
			/>
			<div className="flex items-center gap-2">
				<span className="font-mono text-xs tnum text-muted-foreground">
					{at.lat.toFixed(5)}, {at.lng.toFixed(5)}
				</span>
				<Button
					className="ml-auto"
					size="sm"
					data-testid={PLACES_TESTID.dropPinUse}
					onClick={() => onUse(at)}
				>
					Use this spot
				</Button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const GROUP_ORDER = Object.keys(PLACE_GROUPS) as PlaceGroup[];

function CategoryChips({
	value,
	onChange,
}: {
	value: PlaceCategory;
	onChange: (c: PlaceCategory) => void;
}) {
	const byGroup = new Map<string, PlaceCategory[]>();
	for (const [k, c] of Object.entries(PLACE_CATEGORIES)) {
		const g = c.group ?? "other";
		byGroup.set(g, [...(byGroup.get(g) ?? []), k as PlaceCategory]);
	}
	const groups = [...GROUP_ORDER, "other"].filter((g) => byGroup.has(g));
	return (
		<div
			className="flex flex-wrap gap-1"
			data-testid={PLACES_TESTID.categoryChips}
		>
			{groups.flatMap((g) =>
				(byGroup.get(g) ?? []).map((c) => (
					<button
						key={c}
						type="button"
						aria-pressed={value === c}
						aria-label={`Category: ${PLACE_CATEGORIES[c].label}`}
						onClick={() => onChange(c)}
						className={cn(
							"inline-flex h-[22px] items-center gap-1 rounded-full border px-2 text-xs transition-colors",
							value === c
								? "border-primary bg-primary/10 text-foreground"
								: "border-transparent bg-muted text-muted-foreground hover:text-foreground",
						)}
					>
						<CategoryDot category={c} />
						{PLACE_CATEGORIES[c].label}
					</button>
				)),
			)}
		</div>
	);
}

type Filing = PlacePreview["filing"];

function FilingChip({
	filing,
	leafType,
	onChange,
}: {
	filing: Filing;
	leafType: NodeType;
	onChange: (parentId: string | null) => void;
}) {
	const { ix } = useWorkspace();
	const segs: { id?: string; name: string; isNew: boolean; type: string }[] = [
		...filing.existing.map((id) => {
			const n = ix.node(id);
			return {
				id,
				name: n?.name ?? "?",
				isNew: false,
				type: n?.type ?? "area",
			};
		}),
		...filing.create.map((c) => ({ name: c.name, isNew: true, type: c.type })),
	];
	const picker = (label: ReactNode, key: string, current: string | null) => (
		<TreePicker
			key={key}
			value={current}
			allowRoot={leafType === "country"}
			filter={(n) => n.type !== "place"}
			disabledReason={(n) =>
				canNest(n.type, leafType)
					? null
					: `A ${leafType} can't go inside a ${n.type}`
			}
			onChange={onChange}
			trigger={
				<button
					type="button"
					className="rounded px-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				>
					{label}
				</button>
			}
		/>
	);
	return (
		<div
			className="flex min-w-0 flex-wrap items-center gap-x-0.5 gap-y-1 text-[13px]"
			data-testid={PLACES_TESTID.filingChip}
		>
			<span className="mr-1 text-xs text-muted-foreground">Goes in</span>
			{segs.length === 0
				? picker(
						<span className="text-muted-foreground">Top level</span>,
						"root",
						null,
					)
				: segs.map((s, i) => (
						<span
							key={s.id ?? `new-${s.name}`}
							className="inline-flex items-center"
						>
							{i > 0 ? (
								<span
									className="px-0.5 text-muted-foreground"
									aria-hidden="true"
								>
									›
								</span>
							) : null}
							{picker(
								<>
									{s.name}
									{s.isNew ? (
										<span className="ml-1 text-[11px] text-muted-foreground italic">
											(new)
										</span>
									) : null}
								</>,
								s.id ?? `new-${i}`,
								s.id ?? filing.existing.at(-1) ?? null,
							)}
						</span>
					))}
		</div>
	);
}

function PreviewPhoto({
	preview,
	tripId,
}: {
	preview: PlacePreview;
	tripId: string;
}) {
	const photo = preview.photos[0];
	const [failed, setFailed] = useState(false);
	if (preview.provider === "google" && photo && !failed) {
		const src = `/api/places/photo/p?tripId=${encodeURIComponent(tripId)}&placeId=${encodeURIComponent(preview.ref)}&idx=0&w=720`;
		return (
			<figure className="grid gap-1">
				<img
					src={src}
					alt=""
					loading="lazy"
					referrerPolicy="no-referrer"
					onError={() => setFailed(true)}
					className="aspect-[2/1] w-full rounded-xl bg-muted object-cover"
				/>
				{photo.attributions.length ? (
					<figcaption className="truncate text-[11px] text-muted-foreground">
						Photo:{" "}
						{photo.attributions.map((a, i) => (
							<span key={a.name}>
								{i > 0 ? ", " : ""}
								{a.uri ? (
									<a
										href={a.uri}
										target="_blank"
										rel="noopener noreferrer nofollow"
										className="hover:underline"
									>
										{a.name}
									</a>
								) : (
									a.name
								)}
							</span>
						))}
					</figcaption>
				) : null}
			</figure>
		);
	}
	return (
		<MiniMap
			lat={preview.lat}
			lng={preview.lng}
			zoom={
				preview.level === "country" ? 4 : preview.level === "city" ? 10 : 15
			}
			type={preview.level ?? "place"}
			category={(preview.category as PlaceCategory | undefined) ?? null}
			className="aspect-[2/1] w-full overflow-hidden rounded-xl border"
			label={`Map of ${preview.name}`}
		/>
	);
}

function PreviewPane({
	selection,
	request,
	sessionToken,
	onDone,
}: {
	selection: Selection;
	request: AddPlaceRequest;
	sessionToken: string;
	onDone: (then?: AfterClose) => void;
}) {
	const ws = useWorkspace();
	const { ix, graph, nav, schedule } = ws;
	const tripId = graph.trip.id;
	const q = useQuery({
		queryKey: [
			"places",
			"preview",
			tripId,
			selection.kind,
			selection.kind === "result"
				? selection.result.ref
				: selection.kind === "pin"
					? `${selection.lat.toFixed(6)},${selection.lng.toFixed(6)}`
					: selection.url,
		],
		queryFn: async (): Promise<{
			preview: PlacePreview | null;
			existing?: { nodeId: string };
			query?: string;
		}> => {
			if (selection.kind === "result")
				return {
					preview: await getPlacePreview({
						data: {
							tripId,
							provider: selection.provider,
							ref: selection.result.ref,
							sessionToken,
						},
					}),
				};
			if (selection.kind === "pin") {
				const p = await reverseGeocode({
					data: { tripId, lat: selection.lat, lng: selection.lng },
				});
				return {
					preview: p ?? {
						provider: "photon",
						ref: "pin",
						name: "Dropped pin",
						lat: selection.lat,
						lng: selection.lng,
						photos: [],
						level: "place",
						filing: { existing: [], create: [] },
					},
				};
			}
			return resolveSharedLink({ data: { tripId, url: selection.url } });
		},
		staleTime: 10 * 60_000,
		retry: false,
	});
	if (q.isPending)
		return (
			<div className="grid gap-3 p-4" data-testid={PLACES_TESTID.previewCard}>
				<div className="aspect-video w-full animate-pulse rounded-xl bg-muted" />
				<div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
				<div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
			</div>
		);
	if (q.isError || !q.data?.preview)
		return (
			<div
				className="grid gap-2 p-6 text-center"
				data-testid={PLACES_TESTID.previewCard}
			>
				<p className="font-display text-[17px] font-medium">
					{q.isError ? humanError(q.error) : "Couldn't find that place."}
				</p>
				<p className="text-[13px] text-muted-foreground">
					Search by name, or drop a pin.
				</p>
			</div>
		);
	return (
		<PreviewBody
			preview={q.data.preview}
			request={request}
			onDone={onDone}
			pin={
				selection.kind === "pin"
					? { lat: selection.lat, lng: selection.lng }
					: null
			}
			knownExisting={q.data.existing?.nodeId}
			openAdded={opensAdded(ws)}
			ws={{ ix, graph, nav, schedule, sel: ws.sel, days: ws.days }}
		/>
	);
}

function PreviewBody({
	preview,
	request,
	onDone,
	pin,
	knownExisting,
	openAdded,
	ws,
}: {
	preview: PlacePreview;
	request: AddPlaceRequest;
	onDone: (then?: AfterClose) => void;
	/** A dropped pin or pasted coordinates: the exact spot (the preview is only what's nearest). */
	pin: { lat: number; lng: number } | null;
	knownExisting?: string;
	/** Saving a place to Ideas opens it (Places › Review). */
	openAdded: boolean;
	ws: Pick<
		ReturnType<typeof useWorkspace>,
		"ix" | "graph" | "nav" | "schedule" | "sel" | "days"
	>;
}) {
	const { ix, graph, nav, schedule } = ws;
	const tripId = graph.trip.id;
	const guard = useEditGuard();
	const fromPin = pin !== null;
	// "Set location" with a pin: the node keeps its own name and identity;
	// the preview only shows the spot and the nearest address (HIER-12).
	const locating = request.mode === "locate" ? ix.node(request.nodeId) : null;
	const locatePin = fromPin && !!locating;
	const level: NodeType = preview.level ?? "place";
	const [name, setName] = useState(preview.name);
	const [category, setCategory] = useState<PlaceCategory>(
		(preview.category as PlaceCategory | undefined) ?? "other",
	);
	const [parentOverride, setParentOverride] = useState<
		string | null | undefined
	>(undefined);
	const filing: Filing =
		parentOverride === undefined
			? preview.filing
			: {
					existing: parentOverride
						? ix.path(parentOverride).map((n) => n.id)
						: [],
					create: [],
				};
	const existing = useMemo(() => {
		if (locatePin) return undefined;
		if (knownExisting) return ix.node(knownExisting);
		return findDuplicate(
			ix.outline.map((n) => ({ ...n, status: n.status })),
			{
				googlePlaceId: preview.provider === "google" ? preview.ref : null,
				osmRef: preview.osmRef ?? null,
				name: preview.name,
				lat: preview.lat,
				lng: preview.lng,
			},
		) as GraphNode | undefined;
	}, [ix, preview, knownExisting, locatePin]);

	const createPath = useCreateNodePath(tripId);
	const createItem = useCreateItem(tripId);
	const update = useUpdateNode(tripId);
	const busy = createPath.isPending || createItem.isPending || update.isPending;
	const mode = request.mode;
	const pick = defaultSchedulePick(ix, {
		request,
		sel: ws.sel,
		days: ws.days,
	});
	const suggestions: SchedulePick[] = [];
	if (pick) suggestions.push(pick);
	if (pick?.afterItemId && pick.dayId)
		suggestions.push({
			dayId: pick.dayId,
			label: `End of Day ${ix.dayNumber(pick.dayId)}`,
		});

	const leaf = () => {
		// A pin renamed away from what's nearest is a different place there:
		// it doesn't take that place's ids or hours.
		const identity = !fromPin || pinKeepsIdentity(preview, name);
		const base = {
			type: level,
			name: name.trim() || preview.name,
			lat: preview.lat,
			lng: preview.lng,
			...(preview.address ? { address: preview.address.slice(0, 500) } : {}),
			...(preview.countryCode && /^[A-Z]{2}$/.test(preview.countryCode)
				? { countryCode: preview.countryCode }
				: {}),
			...(identity && preview.provider === "google" && preview.ref !== "pin"
				? { googlePlaceId: preview.ref }
				: {}),
			...(identity && preview.osmRef ? { osmRef: preview.osmRef } : {}),
			...(preview.bbox && level !== "place" ? { bbox: preview.bbox } : {}),
			...(identity && (preview.googleMapsUri || preview.openHoursText)
				? {
						details: {
							...(preview.googleMapsUri
								? { googleMapsUri: preview.googleMapsUri }
								: {}),
							...(preview.openHoursText
								? { openHoursText: preview.openHoursText.slice(0, 1000) }
								: {}),
						},
					}
				: {}),
		};
		return level === "place" ? { ...base, category } : base;
	};

	const save = (target: SchedulePick | "ideas") => {
		const leafId = newId();
		const ids = [...filing.create.map(() => newId()), leafId];
		const chain = [
			...filing.existing.map((id) => ({ id })),
			...filing.create.map((c) => ({
				type: c.type as NodeType,
				name: c.name,
				...(c.type === "country" && preview.countryCode
					? { countryCode: preview.countryCode }
					: {}),
			})),
			leaf(),
		];
		createPath.mutate(
			{ chain, ids },
			{
				onError: (e) => toast.error(humanError(e)),
				onSuccess: () => {
					const where =
						filing.create.at(-1)?.name ??
						ix.node(filing.existing.at(-1))?.name ??
						graph.trip.name;
					if (target === "ideas" && openAdded && level === "place") {
						onDone("inspector");
						nav.select({ kind: "node", id: leafId });
						toast(`Saved to ${where} ideas`);
						return;
					}
					if (target === "ideas") {
						onDone();
						if (mode === "first") nav.zoomTo(leafId);
						toast(`Saved to ${where} ideas`, {
							action: {
								label: "Show",
								onClick: () => nav.select({ kind: "node", id: leafId }),
							},
						});
						return;
					}
					const itemId = newId();
					createItem.mutate(
						{
							id: itemId,
							dayId: target.dayId,
							nodeId: leafId,
							...(target.afterItemId
								? { afterItemId: target.afterItemId }
								: {}),
						},
						{
							onError: (e) => toast.error(humanError(e)),
							onSuccess: () => {
								onDone();
								toast(`${name.trim() || preview.name} · ${target.label}`, {
									action: {
										label: "Show",
										onClick: () => nav.select({ kind: "item", id: itemId }),
									},
								});
							},
						},
					);
				},
			},
		);
	};

	const scheduleExisting = (n: GraphNode, target: SchedulePick) => {
		const itemId = newId();
		createItem.mutate(
			{
				id: itemId,
				dayId: target.dayId,
				nodeId: n.id,
				...(target.afterItemId ? { afterItemId: target.afterItemId } : {}),
			},
			{
				onError: (e) => toast.error(humanError(e)),
				onSuccess: () => {
					onDone();
					toast(`${n.name} · ${target.label}`, {
						action: {
							label: "Show",
							onClick: () => nav.select({ kind: "item", id: itemId }),
						},
					});
				},
			},
		);
	};

	const useLocation = () => {
		const node = ix.node(request.nodeId);
		if (!node) return;
		update.mutate(
			{ nodeId: node.id, patch: locationPatch(node, preview, pin) },
			{
				onError: (e) => toast.error(humanError(e)),
				onSuccess: () => {
					onDone();
					toast(`Location set for ${node.name}`);
				},
			},
		);
	};

	return (
		<div
			className="flex min-h-full flex-col"
			data-testid={PLACES_TESTID.previewCard}
		>
			<div className="grid flex-1 content-start gap-4 p-4">
				{locatePin && locating && pin ? (
					<>
						<MiniMap
							lat={pin.lat}
							lng={pin.lng}
							zoom={15}
							type={locating.type}
							category={locating.category ?? null}
							className="aspect-[2/1] w-full overflow-hidden rounded-xl border"
							label={`Map of ${locating.name}`}
						/>
						<div className="grid gap-1.5">
							<h3 className="text-xl leading-7 font-semibold text-balance">
								{locating.name}
							</h3>
							<p className="font-mono text-xs tnum text-muted-foreground">
								{pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
							</p>
							{preview.address ? (
								<p
									data-testid={PLACES_TESTID.pinAddress}
									className="text-[13px] text-muted-foreground"
								>
									Nearest address on the map: {preview.address}
									{locating.address?.trim()
										? ` (${locating.name} keeps its own address)`
										: ""}
								</p>
							) : null}
						</div>
					</>
				) : (
					<PreviewPhoto preview={preview} tripId={tripId} />
				)}
				{locatePin ? null : (
					<div className="grid gap-1.5">
						{fromPin ? (
							<input
								aria-label="Name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								maxLength={200}
								className="-mx-1 rounded-md bg-transparent px-1 text-xl leading-7 font-semibold outline-none hover:bg-accent/50 focus:bg-accent/50"
							/>
						) : (
							<h3 className="text-xl leading-7 font-semibold text-balance">
								{preview.name}
							</h3>
						)}
						<div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
							{level === "place" ? (
								<span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-muted px-2 text-xs text-foreground">
									<CategoryDot category={category} />
									{PLACE_CATEGORIES[category].label}
								</span>
							) : (
								<span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-muted px-2 text-xs text-foreground">
									<TypeGlyph type={level} />
									{NODE_TYPES[level].label}
								</span>
							)}
							{preview.countryCode ? (
								<FlagEmoji code={preview.countryCode} />
							) : null}
							{typeof preview.rating === "number" ? (
								<span className="font-mono text-xs tnum">
									★ {preview.rating.toFixed(1)}
									{preview.userRatingCount
										? ` · ${preview.userRatingCount}`
										: ""}
								</span>
							) : null}
						</div>
						{preview.address ? (
							<p className="text-[13px] text-muted-foreground">
								{preview.address}
							</p>
						) : null}
						{preview.openHoursText ? (
							<p className="line-clamp-2 text-xs text-muted-foreground">
								{preview.openHoursText}
							</p>
						) : null}
					</div>
				)}

				{existing ? (
					<div className="flex items-center gap-2 rounded-lg bg-primary/5 px-3 py-2 text-[13px]">
						<span className="min-w-0 flex-1">
							Already in {graph.trip.name}:{" "}
							<span className="font-medium">{existing.name}</span>
							<span className="text-muted-foreground">
								{" "}
								({ix.node(existing.parentId)?.name ?? "top level"})
							</span>
						</span>
						<Button
							size="xs"
							variant="ghost"
							onClick={() => {
								onDone("inspector");
								nav.select({ kind: "node", id: existing.id });
							}}
						>
							Open
						</Button>
					</div>
				) : null}

				{mode !== "locate" ? (
					<FilingChip
						filing={filing}
						leafType={level}
						onChange={(id) => setParentOverride(id)}
					/>
				) : null}
				{mode !== "locate" && level === "place" ? (
					<CategoryChips value={category} onChange={setCategory} />
				) : null}
			</div>
			<div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t bg-popover/95 px-4 py-3 backdrop-blur">
				{mode === "locate" ? (
					<EditGuard>
						<Button
							data-testid={PLACES_TESTID.useLocation}
							disabled={busy || guard.disabled}
							onClick={useLocation}
						>
							Use this location
						</Button>
					</EditGuard>
				) : (
					<>
						{existing && ix.days.length ? (
							<SchedulePicker
								ix={ix}
								schedule={schedule}
								suggestions={suggestions}
								onPick={(t) => scheduleExisting(existing, t)}
							>
								<Button
									variant="ghost"
									size="sm"
									disabled={busy || guard.disabled}
								>
									Schedule {existing.name}…
								</Button>
							</SchedulePicker>
						) : null}
						<EditGuard>
							<Button
								variant="outline"
								size="sm"
								data-testid={PLACES_TESTID.saveToIdeas}
								disabled={busy || guard.disabled}
								onClick={() => save("ideas")}
							>
								{mode === "first" ? "Add to trip" : "Save to Ideas"}
							</Button>
						</EditGuard>
						{mode !== "first" && ix.days.length && !pick ? (
							<SchedulePicker
								ix={ix}
								schedule={schedule}
								onPick={(t) => save(t)}
							>
								<Button
									size="sm"
									data-testid={PLACES_TESTID.schedule}
									disabled={busy || guard.disabled}
									title={guard.reason ?? undefined}
								>
									Schedule…
								</Button>
							</SchedulePicker>
						) : null}
						{mode !== "first" && ix.days.length && pick ? (
							<ButtonGroup>
								<EditGuard>
									<Button
										size="sm"
										data-testid={PLACES_TESTID.schedule}
										disabled={busy || guard.disabled}
										onClick={() => save(pick)}
									>
										Schedule · {pick.label}
									</Button>
								</EditGuard>
								<SchedulePicker
									ix={ix}
									schedule={schedule}
									suggestions={suggestions}
									onPick={(t) => save(t)}
								>
									<Button
										size="sm"
										aria-label="Choose where to schedule"
										data-testid={PLACES_TESTID.scheduleMenu}
										disabled={busy || guard.disabled}
										className="border-l border-primary-foreground/20 px-2"
									>
										<ChevronDown />
									</Button>
								</SchedulePicker>
							</ButtonGroup>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}

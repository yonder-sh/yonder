/**
 * The workspace's derived state, computed ONCE per render of the trip and
 * shared through context (SPEC §12.4): the graph index, the schedule (scope
 * independent), and the model for the current `{ scope, lens, days }` read
 * from the URL. `useWorkspace()` (use-workspace.ts) is the public hook.
 *
 * The provider is route-agnostic: the route passes how to read and write its
 * URL (`route`), so the same Workspace renders under `/t/$trip/…` (live) and
 * `/dev/fixture/…` (no backend).
 */
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
} from "react";
import { toast } from "sonner";
import { can, canRateOwn, type EditMode, editModeOf } from "@/lib/auth/roles";
import { type GraphIndex, indexGraph } from "@/lib/engine/graph-index";
import { lensOptions as lensOptionsOf, resolveLens } from "@/lib/engine/lens";
import {
	applyProposals,
	type MarkKey,
	type ProposalMark,
} from "@/lib/engine/proposals";
import { computeSchedule } from "@/lib/engine/schedule";
import { resolveSlugPath } from "@/lib/engine/tree";
import type {
	DayRange,
	GraphNode,
	Lens,
	Role,
	ScheduleResult,
	TripCounts,
	TripGraph,
	WorkspaceModel,
} from "@/lib/engine/types";
import { buildModel } from "@/lib/engine/visits";
import { bool, useFollowState } from "@/lib/realtime/view-ui";
import type { ProposalConflict, ProposalDto } from "@/lib/schemas/proposals";
import { parseFilter, type WorkspaceFilter } from "./filter";
import * as N from "./nav";
import {
	type InspectorTabParam,
	parseDays,
	parseSel,
	type Sel,
	splitScopePath,
	type Tab,
	tabOf,
	type WorkspaceSearch,
} from "./search";
import { useUi } from "./ui-store";

const R = N.REPLACES_HISTORY;

export type WorkspaceMode = "live" | "fixture";
export type ConnectionState =
	| "connecting"
	| "live"
	| "reconnecting"
	| "offline";

export interface WorkspaceRouteBinding {
	/** The scope's URL tail (`japan/tokyo`); '' = the trip root. */
	splat: string;
	search: WorkspaceSearch;
	/** Navigate within this workspace (the route knows its own path). */
	go(to: N.NavTarget, opts?: { replace?: boolean }): void;
	/** The href of a workspace location (links, Follow, share). */
	href(to: N.NavTarget): string;
}

/**
 * Why an edit affordance is disabled (tooltip text). `useEditGuard('edit-only')`
 * adds a feature-specific reason in suggest mode ("Photos need edit access").
 */
export type EditBlockReason = string;

export interface WorkspaceAccess {
	role: Role;
	/** Affordances enabled: `mode !== 'read'` and online. Suggest mode edits become proposals. */
	canEdit: boolean;
	isGuest: boolean;
	memberId: string | null;
	/** Why edit affordances are disabled (tooltip text), or null. */
	reason: EditBlockReason | null;
	/** EXTENSIONS §2.3: `edit` applies, `suggest` proposes, `read` is view-only. */
	mode: EditMode;
	canReview: boolean;
	canPropose: boolean;
	/**
	 * PLACES §1c: your OWN rating (and its comment) can be set now: a member
	 * with `rate` (raters too, whose mode is `read`), online.
	 */
	canRate: boolean;
}

/** E7 (EXTENSIONS §2.3): the open proposals and their marks. Empty for viewers. */
export interface WorkspaceProposals {
	list: ProposalDto[];
	marks: Map<MarkKey, ProposalMark[]>;
	conflicts: Map<string, ProposalConflict>;
	/** Draw ghosts (default: `canReview || canPropose`). */
	show: boolean;
	setShow(v: boolean): void;
	/** Open proposals. */
	count: number;
}

export interface WorkspaceNav {
	zoomIn(nodeId: string): void;
	zoomOut(): void;
	zoomTo(nodeId: string | null, opts?: { lens?: Lens }): void;
	setLens(l: Lens): void;
	stepLens(d: 1 | -1): void;
	select(sel: Sel | null): void;
	/** Push navigation: Back returns to the previous tab (QA MOB-02). */
	setTab(t: Tab): void;
	setDays(r: DayRange | null): void;
	extendDays(date: string): void;
	setOnly(v: boolean): void;
	setWho(memberId: string | null): void;
	/** The shared place filter (`f`, ADDENDUM §10; replace navigation). Null or empty clears it. */
	setFilter(f: WorkspaceFilter | null): void;
	/** The media filter (`mf`; replace navigation). Null clears it. */
	setMediaFilter(mf: WorkspaceSearch["mf"] | null): void;
	/** The Lists tab's list (`list`; replace navigation). Null = the default. */
	setList(list: WorkspaceSearch["list"] | null): void;
	/** The inspector's tab (`itab`, FB-21b; replace navigation). */
	setInspectorTab(tab: InspectorTabParam): void;
	/** The Places tab's view, grouping, sort and filters (replace navigation). */
	setPlaces(patch: N.PlacesPatch): void;
	/** Open the Places tab at a scope with a view and filters (push navigation). */
	openPlaces(opts?: { scopeId?: string | null; patch?: N.PlacesPatch }): void;
	/** The href of `openPlaces(opts)` (links, "open in a new tab"). */
	hrefPlaces(opts?: { scopeId?: string | null; patch?: N.PlacesPatch }): string;
	/** Esc: clear sel → clear days → zoom out. Returns false when nothing changed. */
	escape(): boolean;
	hrefForNode(nodeId: string | null): string;
}

export interface Workspace {
	mode: WorkspaceMode;
	connection: ConnectionState;
	graph: TripGraph;
	ix: GraphIndex;
	counts: TripCounts | undefined;
	access: WorkspaceAccess;
	scope: GraphNode | null;
	scopePath: GraphNode[];
	/** False when a URL segment didn't resolve (renamed or removed place). */
	scopeResolved: boolean;
	lens: Lens;
	lensOptions: { lens: Lens; enabled: boolean; visible: boolean }[];
	tab: Tab;
	days: DayRange | null;
	sel: Sel | null;
	only: boolean;
	who: string | null;
	/** The parsed shared place filter (`f`); `EMPTY_FILTER` when unset. */
	filter: WorkspaceFilter;
	search: WorkspaceSearch;
	/** `buildModel(ix, scope?.id ?? null, lens, days)`. */
	model: WorkspaceModel;
	/** `computeSchedule(ix)`: independent of scope and days. */
	schedule: ScheduleResult;
	/** E7 overlay: marks, conflicts and the "Show suggestions" switch. */
	proposals: WorkspaceProposals;
	nav: WorkspaceNav;
}

const WorkspaceContext = createContext<Workspace | null>(null);

export interface WorkspaceModelProviderProps {
	graph: TripGraph;
	counts?: TripCounts;
	mode: WorkspaceMode;
	connection: ConnectionState;
	route: WorkspaceRouteBinding;
	/** E7: open proposals (`listProposals`; `scenario.proposals` in fixture mode). */
	proposals?: ProposalDto[];
	children?: ReactNode;
}

const NO_PROPOSALS: ProposalDto[] = [];

export function accessOf(
	graph: TripGraph,
	connection: ConnectionState,
	suggesting = false,
): WorkspaceAccess {
	const { role, isGuest, memberId } = graph.me;
	const mode = editModeOf({ role, isGuest }, suggesting);
	const writer = mode !== "read";
	const offline = connection === "offline";
	return {
		role,
		isGuest,
		memberId,
		canEdit: writer && !offline,
		reason: !writer ? "View only" : offline ? "Offline — editing paused" : null,
		mode,
		canReview: can({ role, isGuest }, "reviewProposals"),
		canPropose: can({ role, isGuest }, "propose"),
		canRate: canRateOwn({ role, isGuest, memberId }) && !offline,
	};
}

export function WorkspaceModelProvider({
	graph,
	counts,
	mode,
	connection,
	route,
	proposals = NO_PROPOSALS,
	children,
}: WorkspaceModelProviderProps) {
	const suggesting = useUi((s) => s.suggesting);
	const access = useMemo(
		() => accessOf(graph, connection, suggesting),
		[graph, connection, suggesting],
	);
	const mayProposals = access.canReview || access.canPropose;
	// "Show suggestions" travels with my view.
	const [show, setShow] = useFollowState("suggest.show", true, bool);
	const overlay = useMemo(
		() => applyProposals(graph, mayProposals ? proposals : NO_PROPOSALS),
		[graph, proposals, mayProposals],
	);
	const proposalState = useMemo<WorkspaceProposals>(
		() => ({
			list: mayProposals ? proposals : NO_PROPOSALS,
			marks: show && mayProposals ? overlay.marks : new Map(),
			conflicts: overlay.conflicts,
			show: show && mayProposals,
			setShow,
			count: mayProposals
				? proposals.filter((p) => p.status === "open").length
				: 0,
		}),
		[mayProposals, proposals, overlay, show, setShow],
	);
	// EXTENSIONS §3.6: ix, model and schedule come from the overlay (ghosts
	// simulated) only while suggestions are shown; `graph` stays the server's.
	const shown = show && mayProposals;
	const ix = useMemo(
		() => indexGraph(shown ? overlay.graph : graph),
		[graph, overlay.graph, shown],
	);
	const schedule = useMemo(() => computeSchedule(ix), [ix]);

	const { splat, search, go, href } = route;
	const resolved = useMemo(
		() => resolveSlugPath(ix, splitScopePath(splat)),
		[ix, splat],
	);
	const scope = resolved.node;
	const scopeId = scope?.id ?? null;
	const lens = resolveLens(ix, scopeId, search.lens);
	const daysKey = search.days ?? "";
	const days = useMemo(() => parseDays(daysKey), [daysKey]);
	const model = useMemo(
		() => buildModel(ix, scopeId, lens, days),
		[ix, scopeId, lens, days],
	);
	const lensOptions = useMemo(() => lensOptionsOf(ix, scopeId), [ix, scopeId]);
	const sel = useMemo(() => parseSel(search.sel), [search.sel]);
	const filter = useMemo(() => parseFilter(search.f), [search.f]);

	const state: N.NavState = useMemo(
		() => ({ ix, scopeId, lens, search, days }),
		[ix, scopeId, lens, search, days],
	);

	const run = useCallback(
		(t: N.NavTarget | null, replace = false) => {
			if (t) go(t, { replace });
			return t !== null;
		},
		[go],
	);

	const nav = useMemo<WorkspaceNav>(
		() => ({
			zoomIn: (id) => run(N.zoomIn(state, id), R.zoomIn),
			zoomOut: () => run(N.zoomOut(state), R.zoomOut),
			zoomTo: (id, opts) => run(N.zoomTo(state, id, opts), R.zoomTo),
			setLens: (l) => run(N.setLens(state, l), R.setLens),
			stepLens: (d) => run(N.stepLens(state, d), R.stepLens),
			select: (s) => run(N.select(state, s), R.select),
			setTab: (t) => run(N.setTab(state, t), R.setTab),
			setDays: (r) => run(N.setDays(state, r), R.setDays),
			extendDays: (date) => run(N.extendDays(state, date), R.extendDays),
			setOnly: (v) => run(N.setOnly(state, v), R.setOnly),
			setWho: (m) => run(N.setWho(state, m), R.setWho),
			setFilter: (f) => run(N.setFilter(state, f), R.setFilter),
			setMediaFilter: (mf) =>
				run(N.setMediaFilter(state, mf), R.setMediaFilter),
			setList: (l) => run(N.setList(state, l), R.setList),
			setInspectorTab: (t) =>
				run(N.setInspectorTab(state, t), R.setInspectorTab),
			setPlaces: (p) => run(N.setPlaces(state, p), R.setPlaces),
			openPlaces: (o) => run(N.openPlaces(state, o), R.openPlaces),
			hrefPlaces: (o) => href(N.openPlaces(state, o)),
			escape: () => run(N.escapeChain(state), R.escape),
			hrefForNode: (id) =>
				href(id ? N.zoomIn(state, id) : N.zoomTo(state, null)),
		}),
		[state, run, href],
	);

	const value = useMemo<Workspace>(
		() => ({
			mode,
			connection,
			graph,
			ix,
			counts,
			access,
			scope,
			scopePath: resolved.path,
			scopeResolved: resolved.complete,
			lens,
			lensOptions,
			tab: tabOf(scopeId, search),
			days,
			sel,
			only: search.only === 1,
			who: search.who ?? null,
			filter,
			search,
			model,
			schedule,
			proposals: proposalState,
			nav,
		}),
		[
			mode,
			connection,
			graph,
			ix,
			counts,
			access,
			proposalState,
			scope,
			resolved,
			lens,
			lensOptions,
			search,
			days,
			sel,
			filter,
			model,
			schedule,
			nav,
			scopeId,
		],
	);

	// SPEC §7.1: a URL segment that no longer resolves (renamed or removed
	// place, or a rename in another tab) stops at the deepest resolved node:
	// replace the URL and say so once per bad path (the replace changes `splat`,
	// which resolves, so this runs once).
	const fixedSplat = resolved.complete
		? null
		: resolved.path.map((n) => n.slug).join("/");
	useEffect(() => {
		if (fixedSplat === null) return;
		go({ splat: fixedSplat, search }, { replace: true });
		toast("That place was renamed or removed", { id: "scope-unresolved" });
	}, [fixedSplat, go, search]);

	// TI-6-style introspection for every package's e2e tests (SPEC §12.4).
	useEffect(() => {
		if (import.meta.env.VITE_E2E !== "1" || typeof window === "undefined")
			return;
		(window as unknown as { __yonder?: unknown }).__yonder = {
			graph,
			ix,
			model,
			schedule,
			sel,
		};
	}, [graph, ix, model, schedule, sel]);

	return (
		<WorkspaceContext.Provider value={value}>
			{children}
		</WorkspaceContext.Provider>
	);
}

/** The workspace, or null outside a trip (components that also render elsewhere). */
export function useWorkspaceOptional(): Workspace | null {
	return useContext(WorkspaceContext);
}

/** The workspace; throws outside `<WorkspaceModelProvider>`. */
export function useWorkspaceContext(): Workspace {
	const ws = useContext(WorkspaceContext);
	if (!ws)
		throw new Error(
			"useWorkspace() must be used inside <WorkspaceModelProvider>",
		);
	return ws;
}

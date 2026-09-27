/**
 * The details pane (One Yonder: no inner tabs): cover strip, header (title +
 * chip + crumbs), the suggestion strip (`ProposalBar`, E7), then one scroll of
 * sections: the overview, Photos & links, Notes (and the notes inside a
 * place), To-dos & bookings, Expenses; and the recent-activity footer. The
 * overview dispatches on `sel` to the owning package's component (SPEC §12.5).
 * A link's `itab` scrolls to its section.
 * Used inside the floating panel (xl/lg), the right Sheet (md), the nested
 * mobile drawer (sm) and, the same panel on every tab (owner, 2026-09-26),
 * the Places tab's docked details and its map's side panel.
 *
 * A place (or a rateable area) gets the Places parts (`PlacePanel`): its
 * header names it with its local name, where it's filed and its category,
 * then status, score and the reason, and Pin · Add to day… · Drop · Google
 * Maps; its Overview leads with the ratings and where it fits. Keys 1–6 rate
 * it while the panel has focus.
 *
 * Bundle rules (SPEC §8.4): a node shows "Everything inside"; a located item
 * gets its place's bundle; the trip, legs, days and unlocated blocks their
 * own. The panels themselves (WP-Media, WP-Lists) own the "Only Tokyo", "This
 * visit only" and "Everything that day" toggles, keyed off `sel`, so the
 * shell hands them the default target and the tab counts show what each tab
 * opens with. A node with no children offers no "Everything inside / Only"
 * toggle (the shell's rule, `offersRollupChoice` in `bundle-target.ts`,
 * FB-12). Money is never rendered for link guests (EXTENSIONS §1.4).
 */
import { useQuery } from "@tanstack/react-query";
import { PanelRightClose, X } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Crumbs } from "@/components/common/crumbs";
import { TypeGlyph } from "@/components/common/glyphs";
import { Chip, Section } from "@/components/kit";
import { ListsPanel } from "@/features/lists/ListsPanel";
import { CoverStrip } from "@/features/media/CoverStrip";
import { MediaPanel } from "@/features/media/MediaPanel";
import { MoneyPanel } from "@/features/money/MoneyPanel";
import { NotesInside, useNotesInside } from "@/features/notes/NotesInside";
import { NotesPanel } from "@/features/notes/NotesPanel";
import { isRateable } from "@/features/places/lib/rate";
import { NodeOverview } from "@/features/places/NodeOverview";
import {
	PlaceHeadActions,
	PlaceHeadStatus,
	PlacePanelProvider,
	usePlaceKeys,
} from "@/features/places/tab/PlacePanel";
import { PLACES_TAB_TESTID } from "@/features/places/tab/testids";
import { CategorySelect } from "@/features/places/ui/category-select";
import { DayOverview } from "@/features/plan/DayOverview";
import { ItemOverview } from "@/features/plan/ItemOverview";
import { ProposalBar } from "@/features/suggest/ProposalBar";
import { ProposalOverview } from "@/features/suggest/ProposalOverview";
import { EdgeOverview } from "@/features/transit/EdgeOverview";
import { LegOverview } from "@/features/transit/LegOverview";
import { seesMoney } from "@/lib/auth/roles";
import { NODE_TYPES } from "@/lib/domain/taxonomy";
import type { GraphNode } from "@/lib/engine/types";
import { langFor } from "@/lib/format";
import { type ActivityTarget, activityQuery } from "@/lib/query/trip-queries";
import type { BundleTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { cn } from "@/lib/utils";
import { type Sel, serializeSel } from "@/lib/workspace/search";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { bundleTargetForSel } from "./bundle-target";
import { InspectorFormChips } from "./form-presence-ui";
import { timeAgo } from "./inbox-model";
import { inspectorHeader } from "./inspector-header";
import { LegBundleGate } from "./LegBundleGate";
import { rollupCounts, type TabCounts, targetCounts } from "./scope-counts";
import { INSPECTOR_TAB_TTL_MS, useShell } from "./shell-store";
import { TripOverview } from "./TripOverview";
import { SHELL_TESTID } from "./testids";

function Overview() {
	const { sel } = useWorkspace();
	if (!sel || sel.kind === "root") return <TripOverview />;
	switch (sel.kind) {
		case "node":
			return <NodeOverview nodeId={sel.id} />;
		case "item":
			return <ItemOverview itemId={sel.id} />;
		case "leg":
			return <LegOverview target={sel.target} />;
		case "edge":
			return <EdgeOverview fromRepId={sel.from} toRepId={sel.to} />;
		case "day":
			return <DayOverview dayId={sel.id} />;
		case "proposal":
			return <ProposalOverview proposalId={sel.id} />;
	}
}

/** The activity filter for the footer ("Recent · Maya moved it to Day 4"). */
function activityTargetOf(
	sel: Sel | null,
	target: BundleTarget | null,
): ActivityTarget | null {
	if (!sel || sel.kind === "root") return {};
	if (sel.kind === "item") return { itemId: sel.id };
	if (!target) return null;
	switch (target.kind) {
		case "node":
			return { nodeId: target.nodeId };
		case "leg":
			return { legId: target.legId };
		case "day":
			return { dayId: target.dayId };
		case "item":
			return { itemId: target.itemId };
		case "trip":
			return {};
	}
}

function Count({ n }: { n: number }) {
	if (!n) return null;
	return <span className="ml-1 font-normal tnum">{n}</span>;
}

type InspectorProps = {
	onClose?: () => void;
	/** Docked (DetailsPane): fold it to its rail, keeping the selection. */
	onCollapse?: () => void;
	className?: string;
	/** A bar above everything (the Places map's "← All places"). */
	top?: ReactNode;
};

export function InspectorBody(props: InspectorProps) {
	const { sel, ix } = useWorkspace();
	const node = sel?.kind === "node" ? ix.node(sel.id) : undefined;
	if (node && (node.type === "place" || isRateable(node)))
		return (
			<PlacePanelProvider nodeId={node.id}>
				<Body {...props} place={node} />
			</PlacePanelProvider>
		);
	return <Body {...props} />;
}

/** A place's header: its name, local name, where it's filed and category, then the Places parts. */
function PlaceHeader({ node }: { node: GraphNode }) {
	const { ix } = useWorkspace();
	return (
		<>
			<h2 className="font-display text-2xl leading-7 font-semibold text-balance">
				{node.name}
			</h2>
			{node.localName ? (
				<p
					className="text-sm text-muted-foreground"
					lang={langFor(
						node.countryCode ??
							ix.path(node.id).find((n) => n.countryCode)?.countryCode,
					)}
				>
					{node.localName}
				</p>
			) : null}
			<div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-meta text-muted-foreground">
				{node.parentId ? <Crumbs nodeIds={node.parentId} /> : null}
				{node.parentId ? <span aria-hidden>·</span> : null}
				{node.type === "place" ? (
					<CategorySelect
						node={node}
						className="-ml-1.5 h-6 text-meta text-muted-foreground"
					/>
				) : (
					<span>{NODE_TYPES[node.type].label}</span>
				)}
			</div>
		</>
	);
}

function Body({
	onClose,
	onCollapse,
	className,
	top,
	place,
}: InspectorProps & { place?: GraphNode }) {
	const ws = useWorkspace();
	const { sel, ix, graph } = ws;
	const header = inspectorHeader(ws);
	// A located item's is its place's bundle (the panels offer "This visit only").
	const target = bundleTargetForSel(ix, sel);
	const key = JSON.stringify(sel);
	// A leg without a row: the bundle tabs stay enabled and gate on ensureLeg.
	const pendingLeg = !target && sel?.kind === "leg" ? sel.target : null;
	const bundleTabs = target !== null || pendingLeg !== null;
	const showMoney = seesMoney(graph.me) && target !== null;
	const node = sel?.kind === "node" ? ix.node(sel.id) : undefined;
	const counts = useInspectorCounts(target);
	const scroller = useRef<HTMLDivElement>(null);
	useSectionLink(sel, scroller);
	const placeKeys = usePlaceKeys();
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a place's rating buttons are the keyboard entry; 1–6 are a shortcut
		<div
			className={cn("flex min-h-0 flex-1 flex-col outline-none", className)}
			// FB-17: people looking at the same selection share cursors in here.
			data-cursor-anchor={`insp:${serializeSel(sel) ?? "none"}`}
			data-testid={place ? PLACES_TAB_TESTID.drawer : undefined}
			data-place={place?.id}
			onKeyDown={placeKeys}
			tabIndex={place ? -1 : undefined}
		>
			{top}
			{target?.kind === "node" ? <CoverStrip target={target} /> : null}
			<div className="flex items-start gap-2 px-4 pt-4">
				<div className="min-w-0 flex-1">
					{place ? (
						<PlaceHeader node={place} />
					) : (
						<>
							<h2
								className={cn(
									"text-2xl leading-7 font-semibold text-balance",
									header.display && "font-display",
								)}
							>
								{header.title}
							</h2>
							<div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
								{header.chip ? (
									<Chip
										// A place's type is a word; times and dates are data (DESIGN §2.6).
										className={node ? "capitalize" : "tnum"}
									>
										{node ? (
											<TypeGlyph type={node.type} category={node.category} />
										) : null}
										{header.chip}
									</Chip>
								) : null}
								{node?.parentId ? <Crumbs nodeIds={node.parentId} /> : null}
								{node?.localName ? (
									<span className="text-xs text-muted-foreground">
										{node.localName}
									</span>
								) : null}
							</div>
						</>
					)}
					{/* FB-24: someone has an editor open on this. */}
					<InspectorFormChips
						sel={sel}
						title={typeof header.title === "string" ? header.title : null}
					/>
				</div>
				{onCollapse ? (
					<button
						type="button"
						onClick={onCollapse}
						aria-label="Fold the details"
						title="Fold the details"
						data-testid={SHELL_TESTID.detailsCollapse}
						className="-mt-0.5 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<PanelRightClose className="size-4" />
					</button>
				) : null}
				{onClose ? (
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						data-testid={TESTID.inspectorClose}
						className="-mt-0.5 -mr-1 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<X className="size-4" />
					</button>
				) : null}
			</div>
			{place ? (
				<div className="grid gap-2 px-4 pt-2">
					<PlaceHeadStatus />
					<PlaceHeadActions node={place} />
				</div>
			) : null}
			<div className="mt-3 empty:hidden">
				<ProposalBar sel={sel} />
			</div>
			<div
				key={key}
				ref={scroller}
				className="mt-3 min-h-0 flex-1 overflow-y-auto border-t px-4"
			>
				<div
					data-testid={SHELL_TESTID.detailsSection}
					data-section="overview"
					className="py-4"
				>
					<Overview />
				</div>
				{bundleTabs ? (
					<>
						<Section
							name="media"
							testId={SHELL_TESTID.detailsSection}
							title={
								<>
									Photos &amp; links
									<Count n={counts.media} />
								</>
							}
						>
							{target ? (
								<MediaPanel target={target} section />
							) : pendingLeg ? (
								<LegBundleGate target={pendingLeg} tab="media" />
							) : null}
						</Section>
						<Section
							name="notes"
							testId={SHELL_TESTID.detailsSection}
							title="Notes"
						>
							{target ? (
								<>
									<NotesPanel target={target} />
									<NotesInsideTarget target={target} />
								</>
							) : pendingLeg ? (
								<LegBundleGate target={pendingLeg} tab="notes" />
							) : null}
						</Section>
						<Section
							name="lists"
							testId={SHELL_TESTID.detailsSection}
							title={
								<>
									To-dos &amp; bookings
									<Count n={counts.lists} />
								</>
							}
						>
							{target ? (
								<ListsPanel target={target} />
							) : pendingLeg ? (
								<LegBundleGate target={pendingLeg} tab="lists" />
							) : null}
						</Section>
						{showMoney && target ? (
							<Section
								name="money"
								testId={SHELL_TESTID.detailsSection}
								title="Expenses"
							>
								{/* Its rows carry their own padding. */}
								<div className="-mx-4">
									<MoneyPanel target={target} />
								</div>
							</Section>
						) : null}
					</>
				) : null}
			</div>
			<ActivityFooter target={activityTargetOf(sel, target)} />
		</div>
	);
}

/** The notes inside a place or the trip, under its own note ("From places in Japan · 6"). */
function NotesInsideTarget({ target }: { target: BundleTarget }) {
	const { ix, graph } = useWorkspace();
	const scopeId =
		target.kind === "node"
			? target.nodeId
			: target.kind === "trip"
				? null
				: undefined;
	const sections = useNotesInside(scopeId);
	if (!sections.length) return null;
	const name =
		scopeId === null ? graph.trip.name : (ix.node(scopeId ?? "")?.name ?? "");
	return (
		<div className="mt-3">
			<p className="mb-1 text-meta text-muted-foreground">
				Inside {name} <span className="tnum">· {sections.length}</span>
			</p>
			<NotesInside sections={sections} limit={3} dense />
		</div>
	);
}

/**
 * A link's `itab` (FB-21b), or a "Still to plan" to-do's request for this
 * selection's Lists (PLAN-R2-05), scrolls that section into view. The request
 * holds while its selection stays and is dropped once the selection moves.
 */
function useSectionLink(
	sel: Sel | null,
	scroller: RefObject<HTMLDivElement | null>,
) {
	const { search } = useWorkspace();
	const selKey = sel ? (serializeSel(sel) ?? "root") : "none";
	const req = useShell((s) => s.inspectorTab);
	const clear = useShell((s) => s.clearInspectorTab);
	const pending =
		req && req.sel === selKey && Date.now() - req.at < INSPECTOR_TAB_TTL_MS
			? req.tab
			: null;
	const want = pending ?? search.itab ?? null;
	useEffect(() => {
		if (!want || want === "overview") return;
		// After the panels' first render, so the section sits where it will stay.
		const t = window.setTimeout(() => {
			scroller.current
				?.querySelector(`[data-section="${want}"]`)
				?.scrollIntoView({ block: "start" });
		}, 60);
		return () => window.clearTimeout(t);
	}, [want, selKey, scroller]);
	// The selection moved on: the request is spent.
	useEffect(() => {
		if (req && selKey !== req.sel && selKey !== req.from) clear();
	}, [req, selKey, clear]);
}

/**
 * Section counts for the selection (SPEC §8.4): Photos & links and To-dos
 * roll up over a place (a located item's too) and the trip.
 */
function useInspectorCounts(target: BundleTarget | null): TabCounts {
	const { ix, counts, lens } = useWorkspace();
	return useMemo(() => {
		if (!target) return { media: 0, lists: 0, notes: false };
		const own = targetCounts(counts, target);
		if (target.kind !== "node" && target.kind !== "trip") return own;
		const all = rollupCounts(ix, counts, {
			scopeId: target.kind === "node" ? target.nodeId : null,
			lens,
			includeDescendants: true,
			dayRange: null,
		});
		return { ...all, notes: own.notes };
	}, [target, ix, counts, lens]);
}

/** DESIGN §4.4 footer: "Recent · Maya moved to Day 4 · 2h ago" → the activity view. */
function ActivityFooter({ target }: { target: ActivityTarget | null }) {
	const { graph, mode } = useWorkspace();
	const setActivityOpen = useShell((s) => s.setActivityOpen);
	const [now] = useState(() => Date.now());
	const q = useQuery({
		...activityQuery(graph.trip.id, target ?? {}),
		enabled: mode === "live" && target !== null,
	});
	const last = q.data?.[0];
	if (!target || !last) return null;
	return (
		<button
			type="button"
			data-testid={SHELL_TESTID.activityFooter}
			onClick={() => setActivityOpen(true)}
			className="flex h-9 shrink-0 items-center gap-1.5 border-t px-4 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
		>
			<span className="font-medium">Recent</span>
			<span aria-hidden="true">·</span>
			<span className="min-w-0 truncate">
				{last.actorName} {last.summary}
			</span>
			<span aria-hidden="true">·</span>
			<span className="shrink-0 tnum">{timeAgo(last.at, now)}</span>
		</button>
	);
}

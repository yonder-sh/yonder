/**
 * DESIGN §4.4 inspector template: cover strip, header (title + chip + crumbs),
 * the suggestion strip (`ProposalBar`, E7), tabs Overview · Media 6 · Lists 2
 * · Notes · Money, scrollable content, and the recent-activity footer. The
 * Overview dispatches on `sel` to the owning package's component (SPEC §12.5).
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
import { cn } from "cn";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Crumbs } from "@/components/common/crumbs";
import { TypeGlyph } from "@/components/common/glyphs";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ListsPanel } from "@/features/lists/ListsPanel";
import { CoverStrip } from "@/features/media/CoverStrip";
import { MediaPanel } from "@/features/media/MediaPanel";
import { MoneyPanel } from "@/features/money/MoneyPanel";
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
import { mustRedact } from "@/lib/auth/roles";
import { NODE_TYPES } from "@/lib/domain/taxonomy";
import type { GraphNode } from "@/lib/engine/types";
import { langFor } from "@/lib/format";
import { type ActivityTarget, activityQuery } from "@/lib/query/trip-queries";
import type { BundleTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import {
	INSPECTOR_TABS,
	type InspectorTabParam,
	type Sel,
	serializeSel,
} from "@/lib/workspace/search";
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

function TabCount({ n }: { n: number }) {
	if (!n) return null;
	return (
		<span className="font-mono text-[11px] font-normal text-muted-foreground tnum">
			{n}
		</span>
	);
}

type InspectorProps = {
	onClose?: () => void;
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
			<h2 className="font-display text-[22px] leading-7 font-semibold text-balance">
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
			<div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground">
				{node.parentId ? <Crumbs nodeIds={node.parentId} /> : null}
				{node.parentId ? <span aria-hidden>·</span> : null}
				{node.type === "place" ? (
					<CategorySelect
						node={node}
						className="-ml-1.5 h-6 text-[13px] text-muted-foreground"
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
	const showMoney = !mustRedact(graph.me) && target !== null;
	const node = sel?.kind === "node" ? ix.node(sel.id) : undefined;
	const counts = useInspectorCounts(target);
	const [tab, setTab] = useInspectorTab(sel, bundleTabs, showMoney);
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
									"text-[22px] leading-7 font-semibold text-balance",
									header.display && "font-display",
								)}
							>
								{header.title}
							</h2>
							<div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
								{header.chip ? (
									<span
										className={cn(
											"inline-flex h-[22px] items-center gap-1 rounded-full bg-muted px-2 text-xs text-muted-foreground",
											// A place's type is a word; times and dates are data (DESIGN §2.6).
											node ? "capitalize" : "font-mono tnum",
										)}
									>
										{node ? (
											<TypeGlyph type={node.type} category={node.category} />
										) : null}
										{header.chip}
									</span>
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
			<Tabs
				key={key}
				value={tab}
				onValueChange={setTab}
				className="mt-3 flex min-h-0 flex-1 flex-col gap-0"
			>
				<TabsList
					className="mx-4 h-8 w-fit"
					data-testid={SHELL_TESTID.inspectorTabs}
				>
					<TabsTrigger value="overview" className="text-xs">
						Overview
					</TabsTrigger>
					<TabsTrigger
						value="media"
						className="gap-1 text-xs"
						disabled={!bundleTabs}
					>
						Media <TabCount n={counts.media} />
					</TabsTrigger>
					<TabsTrigger
						value="lists"
						className="gap-1 text-xs"
						disabled={!bundleTabs}
					>
						Lists <TabCount n={counts.lists} />
					</TabsTrigger>
					<TabsTrigger
						value="notes"
						className="gap-1 text-xs"
						disabled={!bundleTabs}
					>
						Notes
						{counts.notes ? (
							<span
								role="img"
								aria-label="has notes"
								className="size-1.5 rounded-full bg-muted-foreground/60"
							/>
						) : null}
					</TabsTrigger>
					{showMoney ? (
						<TabsTrigger value="money" className="text-xs">
							Money
						</TabsTrigger>
					) : null}
				</TabsList>
				<div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t px-4 py-4">
					<TabsContent value="overview">
						<Overview />
					</TabsContent>
					{target ? (
						<>
							{(["media", "lists", "notes"] as const).map((t) => (
								<TabsContent key={t} value={t}>
									{t === "media" ? (
										<MediaPanel target={target} />
									) : t === "lists" ? (
										<ListsPanel target={target} />
									) : (
										<NotesPanel target={target} />
									)}
								</TabsContent>
							))}
							{showMoney ? (
								<TabsContent value="money">
									<MoneyPanel target={target} />
								</TabsContent>
							) : null}
						</>
					) : pendingLeg ? (
						<>
							<TabsContent value="media">
								<LegBundleGate target={pendingLeg} tab="media" />
							</TabsContent>
							<TabsContent value="lists">
								<LegBundleGate target={pendingLeg} tab="lists" />
							</TabsContent>
							<TabsContent value="notes">
								<LegBundleGate target={pendingLeg} tab="notes" />
							</TabsContent>
						</>
					) : null}
				</div>
			</Tabs>
			<ActivityFooter target={activityTargetOf(sel, target)} />
		</div>
	);
}

/**
 * The inspector's tab, in the URL (`itab`, FB-21b): links open on it and
 * Follow mirrors it. Overview for each new selection (`nav.select` drops
 * `itab`), unless a "Still to plan" to-do asked for this selection's Lists
 * tab (`useShell().inspectorTab`, PLAN-R2-05): the request holds while its
 * selection stays and is written to the URL, and is dropped once the
 * selection moves elsewhere. A tab this selection can't show (Money for a
 * guest, a bundle tab without a target) reads as Overview.
 */
function useInspectorTab(
	sel: Sel | null,
	bundleTabs: boolean,
	showMoney: boolean,
): [string, (tab: string) => void] {
	const { search, nav } = useWorkspace();
	const selKey = sel ? (serializeSel(sel) ?? "root") : "none";
	const req = useShell((s) => s.inspectorTab);
	const clear = useShell((s) => s.clearInspectorTab);
	const usable = (t: string) =>
		t === "overview" || (t === "money" ? showMoney : bundleTabs);
	const pending =
		req &&
		req.sel === selKey &&
		Date.now() - req.at < INSPECTOR_TAB_TTL_MS &&
		usable(req.tab)
			? req.tab
			: null;
	const url = search.itab ?? "overview";
	// A request for what's selected (the same row clicked again) goes to the URL.
	useEffect(() => {
		if (pending && pending !== url) nav.setInspectorTab(pending);
	}, [pending, url, nav]);
	// The selection moved on: the request is spent.
	useEffect(() => {
		if (req && selKey !== req.sel && selKey !== req.from) clear();
	}, [req, selKey, clear]);
	const tab = pending ?? (usable(url) ? url : "overview");
	return [
		tab,
		(t: string) =>
			nav.setInspectorTab(
				(INSPECTOR_TABS as readonly string[]).includes(t)
					? (t as InspectorTabParam)
					: "overview",
			),
	];
}

/**
 * Tab counts for the selection, as each tab opens (SPEC §8.4): Media and
 * Lists roll up over a place (a located item's too) and the trip; the Notes
 * dot is the target's own note, the one the Notes tab shows.
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
			<span className="shrink-0 font-mono tnum">{timeAgo(last.at, now)}</span>
		</button>
	);
}

/**
 * Frozen contracts (SPEC §0 rule 5, §12.5, §13): the public component
 * signatures and the server functions' inputs and outputs. This file is only
 * type-checked (`pnpm typecheck`); it never runs. Changing a contract breaks
 * `tsc` here, which is the point: request the change in
 * `src/features/<x>/CONTRACT_REQUESTS.md` instead.
 *
 * Props may GAIN optional fields (the `satisfies` checks below still pass);
 * required props must not change.
 */
import type { HTMLAttributes, JSX, ReactNode } from "react";
import type {
	DragData,
	OverlayRender,
	useDnd,
} from "@/components/common/dnd/workspace-dnd";
import type { useEditGuard } from "@/components/common/edit-guard";
import type {
	ProposalGhost,
	proposalStyle,
} from "@/components/common/proposal-ghost";
import type { TimeInput } from "@/components/common/time";
import type { TreePicker } from "@/components/common/tree-picker";
import type { useTripMutation } from "@/components/common/use-trip-mutation";
import type { AccountMenu } from "@/features/home/AccountMenu";
import type { GuestNudge } from "@/features/home/GuestNudge";
import type { ProfileDialog } from "@/features/home/ProfileDialog";
import type { ShareDialog } from "@/features/home/ShareDialog";
import type { ShareInbox } from "@/features/home/ShareInbox";
import type { SharingDto } from "@/features/home/sharing.functions";
import type { TripSettingsDialog } from "@/features/home/TripSettingsDialog";
import type { ClimateCard } from "@/features/insights/ClimateCard";
import type { DateImpactList } from "@/features/insights/DateImpactList";
import type { DayHoursBadge } from "@/features/insights/DayHoursBadge";
import type { DaySun } from "@/features/insights/DaySun";
import type { HolidaysEditor } from "@/features/insights/HolidaysEditor";
import type { HoursChip } from "@/features/insights/HoursChip";
import type { HoursEditorDialog } from "@/features/insights/HoursEditorDialog";
import type { HoursTable } from "@/features/insights/HoursTable";
import type { ShiftTripDialog } from "@/features/insights/ShiftTripDialog";
import type { useDateDraftImpact } from "@/features/insights/use-date-draft-impact";
import type { useHoursIssues } from "@/features/insights/use-hours-issues";
import type { WhatIfChip } from "@/features/insights/WhatIfChip";
import type { ListsPanel } from "@/features/lists/ListsPanel";
import type { ListsTab } from "@/features/lists/ListsTab";
import type TripMap from "@/features/map/TripMap";
import type { CoverStrip } from "@/features/media/CoverStrip";
import type { MediaPanel } from "@/features/media/MediaPanel";
import type { MediaTab } from "@/features/media/MediaTab";
import type { useAttachDrop } from "@/features/media/use-attach-drop";
import type { AddExpenseDialog } from "@/features/money/AddExpenseDialog";
import type { MoneyPanel } from "@/features/money/MoneyPanel";
import type { MoneyTab } from "@/features/money/MoneyTab";
import type { MoneyDto } from "@/features/money/money.functions";
import type { useMoneyCounts } from "@/features/money/use-money-counts";
import type { MentionInput } from "@/features/notes/MentionInput";
import type { NotesPanel } from "@/features/notes/NotesPanel";
import type { NotesTab } from "@/features/notes/NotesTab";
import type { useNotePreview } from "@/features/notes/use-note-preview";
import type { InstallButton } from "@/features/offline/InstallButton";
import type { OfflineBanner } from "@/features/offline/OfflineBanner";
import type { registerServiceWorker } from "@/features/offline/register-sw";
import type {
	markTripSaved,
	removeTripOffline,
} from "@/features/offline/saved-trips";
import type { useOfflineAvailability } from "@/features/offline/use-offline-availability";
import type { IdeasBin } from "@/features/outline/IdeasBin";
import type { Outline } from "@/features/outline/Outline";
import type { OutlinePopover } from "@/features/outline/OutlinePopover";
import type { AddPlaceDialog } from "@/features/places/AddPlaceDialog";
import type { NodeOverview } from "@/features/places/NodeOverview";
import type { DayChips } from "@/features/plan/DayChips";
import type { DayOverview } from "@/features/plan/DayOverview";
import type { ItemOverview } from "@/features/plan/ItemOverview";
import type { NowNext } from "@/features/plan/NowNext";
import type { PlanTab } from "@/features/plan/PlanTab";
import type { DigestBanner } from "@/features/shell/DigestBanner";
import type { InboxBell } from "@/features/shell/InboxBell";
import type { Workspace } from "@/features/shell/Workspace";
import type { describeProposal } from "@/features/suggest/describe-proposal";
import type { GhostActions } from "@/features/suggest/GhostActions";
import type { NoteSuggestions } from "@/features/suggest/NoteSuggestions";
import type { ProposalBar } from "@/features/suggest/ProposalBar";
import type { ProposalOverview } from "@/features/suggest/ProposalOverview";
import type { ReviewDrawer } from "@/features/suggest/ReviewDrawer";
import type { SuggestModeControl } from "@/features/suggest/SuggestModeControl";
import type { AddFlightDialog } from "@/features/transit/AddFlightDialog";
import type { EdgeOverview } from "@/features/transit/EdgeOverview";
import type { LegOverview } from "@/features/transit/LegOverview";
import type { useLegActions } from "@/features/transit/use-leg-actions";
import type { Digest } from "@/functions/activity.functions";
import type { DayMutationResult } from "@/functions/days.functions";
import type {
	ActivityEntry,
	Capabilities,
	getTripGraph,
} from "@/functions/graph.functions";
import type { SequenceResult } from "@/functions/items.functions";
import type { LegWithAlternatives } from "@/functions/legs.functions";
import type { ResolveResult } from "@/functions/proposals.functions";
import type {
	CreateTripResult,
	PreviewTripDatesResult,
} from "@/functions/trips.functions";
import type { DateImpact } from "@/lib/engine/date-impact";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { HoursIssues } from "@/lib/engine/hours";
import type { MarkKey, ProposalMark } from "@/lib/engine/proposals";
import type {
	GraphItem,
	GraphNode,
	TripCounts,
	TripGraph,
} from "@/lib/engine/types";
import type {
	DisplayPrefs,
	getDisplayPrefs,
	setDisplayPrefs,
} from "@/lib/format";
import type { mediaPageUrl } from "@/lib/media-url";
import type { LegMode } from "@/lib/schemas/enums";
import type { InboxDto, InboxItem } from "@/lib/schemas/inbox";
import type { UserPrefs } from "@/lib/schemas/misc";
import type { ProposalDto, Proposed } from "@/lib/schemas/proposals";
import type { BundleTarget, LegTarget } from "@/lib/schemas/targets";
import type { WorkspaceFilter } from "@/lib/workspace/filter";
import type {
	FilterContext,
	filterContextOf,
	matchesFilter,
} from "@/lib/workspace/filter-match";
import type {
	WorkspaceNav as WorkspaceNavT,
	Workspace as WorkspaceT,
} from "@/lib/workspace/model-context";
import type { Sel, WorkspaceSearch } from "@/lib/workspace/search";
import type {
	AddExpenseRequest,
	AddFlightRequest,
	AddPlaceRequest,
} from "@/lib/workspace/ui-store";
import type { useProposalMarks } from "@/lib/workspace/use-proposals";
import type { FixtureOptions } from "@/server/fixture.server";
import type { WriteLegMeta } from "@/server/legs.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Equals<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
/** Compiles only when `T` is `true`. */
type Assert<T extends true> = T;
type Out<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;
type Component<P> = (props: P) => JSX.Element | null;

// ---------------------------------------------------------------------------
// §12.5 public components (each accepts at least these props)
// ---------------------------------------------------------------------------

export type ComponentContracts = [
	typeof Workspace extends Component<Record<string, never>> ? true : false,
	typeof Outline extends Component<Record<string, never>> ? true : false,
	typeof IdeasBin extends Component<Record<string, never>> ? true : false,
	typeof OutlinePopover extends Component<Record<string, never>> ? true : false,
	typeof PlanTab extends Component<Record<string, never>> ? true : false,
	typeof ItemOverview extends Component<{ itemId: string }> ? true : false,
	typeof DayOverview extends Component<{ dayId: string }> ? true : false,
	typeof DayChips extends Component<Record<string, never>> ? true : false,
	typeof NowNext extends Component<Record<string, never>> ? true : false,
	typeof TripMap extends Component<{ variant: "desktop" | "mobile" }>
		? true
		: false,
	typeof LegOverview extends Component<{ target: LegTarget }> ? true : false,
	typeof EdgeOverview extends Component<{ fromRepId: string; toRepId: string }>
		? true
		: false,
	typeof AddFlightDialog extends Component<Record<string, never>>
		? true
		: false,
	typeof AddPlaceDialog extends Component<Record<string, never>> ? true : false,
	typeof NodeOverview extends Component<{ nodeId: string }> ? true : false,
	typeof MediaTab extends Component<Record<string, never>> ? true : false,
	typeof MediaPanel extends Component<{ target: BundleTarget }> ? true : false,
	typeof CoverStrip extends Component<{ target: BundleTarget }> ? true : false,
	typeof ListsTab extends Component<Record<string, never>> ? true : false,
	typeof ListsPanel extends Component<{ target: BundleTarget }> ? true : false,
	typeof NotesTab extends Component<Record<string, never>> ? true : false,
	typeof NotesPanel extends Component<{ target: BundleTarget }> ? true : false,
	typeof MentionInput extends Component<{
		value: string;
		onChange: (v: string) => void;
	}>
		? true
		: false,
	typeof ShareDialog extends Component<Record<string, never>> ? true : false,
	typeof TripSettingsDialog extends Component<Record<string, never>>
		? true
		: false,
	typeof AccountMenu extends Component<Record<string, never>> ? true : false,
	typeof GuestNudge extends Component<Record<string, never>> ? true : false,
	typeof ProfileDialog extends Component<Record<string, never>> ? true : false,
	typeof OfflineBanner extends Component<Record<string, never>> ? true : false,
	typeof InstallButton extends Component<Record<string, never>> ? true : false,
	// ---- F-ext0 (EXTENSIONS §1.3, §2.3) ----
	typeof ProposalGhost extends Component<{
		marks: readonly ProposalMark[];
		children: ReactNode;
	}>
		? true
		: false,
	typeof HoursChip extends Component<{ itemId: string }> ? true : false,
	typeof DayHoursBadge extends Component<{ dayId: string }> ? true : false,
	typeof DaySun extends Component<{ dayId: string; compact?: boolean }>
		? true
		: false,
	typeof HoursTable extends Component<{ nodeId: string }> ? true : false,
	typeof HoursEditorDialog extends Component<Record<string, never>>
		? true
		: false,
	typeof ClimateCard extends Component<{ nodeId: string }> ? true : false,
	typeof ShiftTripDialog extends Component<Record<string, never>>
		? true
		: false,
	typeof WhatIfChip extends Component<Record<string, never>> ? true : false,
	typeof DateImpactList extends Component<{ impact: DateImpact }>
		? true
		: false,
	typeof HolidaysEditor extends Component<Record<string, never>> ? true : false,
	typeof MoneyTab extends Component<Record<string, never>> ? true : false,
	typeof MoneyPanel extends Component<{ target: BundleTarget }> ? true : false,
	typeof AddExpenseDialog extends Component<Record<string, never>>
		? true
		: false,
	typeof SuggestModeControl extends Component<Record<string, never>>
		? true
		: false,
	typeof ReviewDrawer extends Component<Record<string, never>> ? true : false,
	typeof ProposalBar extends Component<{ sel: Sel | null }> ? true : false,
	typeof ProposalOverview extends Component<{ proposalId: string }>
		? true
		: false,
	typeof NoteSuggestions extends Component<{
		target: BundleTarget;
		editor: unknown;
	}>
		? true
		: false,
	typeof GhostActions extends Component<{ proposalId: string }> ? true : false,
	typeof DigestBanner extends Component<Record<string, never>> ? true : false,
	// ADDENDUM §10: the one inbox bell (WP-Shell) replaced MentionBell (WP-Lists).
	typeof InboxBell extends Component<Record<string, never>> ? true : false,
	typeof ShareInbox extends Component<{ id?: string; lost?: boolean }>
		? true
		: false,
];
export type AllComponentsHold = Assert<
	ComponentContracts[number] extends true ? true : false
>;

// Hooks and plain functions.
export type HookContracts = [
	Assert<
		Equals<
			ReturnType<typeof useLegActions>,
			{ accept(target: LegTarget, mode: LegMode): Promise<void> }
		>
	>,
	Assert<
		ReturnType<typeof useAttachDrop> extends {
			rootProps: HTMLAttributes<HTMLElement>;
			isOver: boolean;
		}
			? true
			: false
	>,
	Assert<
		Parameters<typeof useAttachDrop>[0] extends BundleTarget | null
			? true
			: false
	>,
	Assert<Equals<ReturnType<typeof useNotePreview>, string | null>>,
	Assert<Equals<ReturnType<typeof registerServiceWorker>, Promise<void>>>,
	Assert<Equals<Parameters<typeof removeTripOffline>, [tripId: string]>>,
	Assert<
		Parameters<typeof markTripSaved> extends [string, string, string]
			? true
			: false
	>,
	Assert<
		ReturnType<typeof useOfflineAvailability> extends object ? true : false
	>,
	// ---- F-ext0 ----
	Assert<Equals<ReturnType<typeof useHoursIssues>, HoursIssues>>,
	Assert<
		Equals<
			ReturnType<typeof useDateDraftImpact>,
			{ items: Set<string>; legs: Set<string> } | null
		>
	>,
	Assert<Equals<ReturnType<typeof useMoneyCounts>, Record<MarkKey, number>>>,
	Assert<Equals<ReturnType<typeof useProposalMarks>, ProposalMark[]>>,
	Assert<
		Equals<
			Parameters<typeof useEditGuard>,
			[kind?: "propose-ok" | "edit-only" | "rate", editOnlyReason?: string]
		>
	>,
	Assert<
		ReturnType<typeof proposalStyle> extends { proposed: boolean }
			? true
			: false
	>,
	Assert<
		Equals<
			Parameters<typeof describeProposal>,
			[p: ProposalDto, _ix: GraphIndex]
		>
	>,
	Assert<
		Parameters<typeof useTripMutation>[1] extends {
			keys: readonly unknown[];
		}
			? true
			: false
	>,
];

// ---------------------------------------------------------------------------
// §13 server-function outputs (inputs are the zod schemas next to each one)
// ---------------------------------------------------------------------------

type Fns = typeof import("@/functions/trips.functions") &
	typeof import("@/functions/graph.functions") &
	typeof import("@/functions/nodes.functions") &
	typeof import("@/functions/items.functions") &
	typeof import("@/functions/legs.functions") &
	typeof import("@/functions/days.functions") &
	typeof import("@/functions/proposals.functions") &
	typeof import("@/functions/activity.functions") &
	typeof import("@/functions/prefs.functions") &
	typeof import("@/functions/inbox.functions") &
	typeof import("@/features/home/sharing.functions") &
	typeof import("@/features/home/dashboard.functions") &
	typeof import("@/features/media/media.functions") &
	typeof import("@/features/insights/insights.functions") &
	typeof import("@/features/money/money.functions") &
	typeof import("@/features/suggest/suggest.functions") &
	typeof import("@/lib/auth/share.functions");

/** A proposable function answers its result OR `{ proposed }` (EXTENSIONS §2.2 step 3). */
type P<R> = R | Proposed;

export type ServerFnContracts = [
	Assert<Equals<Out<Fns["createTrip"]>, CreateTripResult>>,
	Assert<Equals<Out<Fns["resolveTripSlug"]>, { tripId: string }>>,
	Assert<Equals<Out<Fns["updateTrip"]>, { slug: string }>>,
	Assert<Equals<Out<Fns["previewTripDates"]>, PreviewTripDatesResult>>,
	Assert<
		Equals<Out<Fns["setTripDates"]>, P<{ ok: true; version: number | null }>>
	>,
	Assert<
		Equals<Out<Fns["shiftTripDates"]>, P<{ ok: true; version: number | null }>>
	>,
	Assert<Equals<Out<Fns["deleteTrip"]>, { ok: true }>>,
	Assert<
		Out<typeof getTripGraph> extends Omit<TripGraph, "nodes"> ? true : false
	>,
	Assert<Equals<Out<Fns["getTripCounts"]>, TripCounts>>,
	Assert<Equals<Out<Fns["listActivity"]>, ActivityEntry[]>>,
	Assert<Equals<Out<Fns["getCapabilities"]>, Capabilities>>,
	Assert<Equals<Out<Fns["createNode"]>, P<{ nodeId: string; slug: string }>>>,
	Assert<Equals<Out<Fns["createNodePath"]>, P<{ nodeIds: string[] }>>>,
	Assert<
		Equals<Out<Fns["updateNode"]>, P<{ updatedAt: string; slug: string }>>
	>,
	Assert<Equals<Out<Fns["moveNode"]>, P<{ slug: string }>>>,
	Assert<
		Equals<
			Out<Fns["deleteNode"]>,
			P<{ deletedAt: string; detachedLegIds: string[] }>
		>
	>,
	Assert<Equals<Out<Fns["restoreNode"]>, { slug: string }>>,
	Assert<Equals<Out<Fns["setNodePriority"]>, P<{ ok: true }>>>,
	Assert<
		Equals<Out<Fns["createItem"]>, P<SequenceResult & { itemId: string }>>
	>,
	Assert<
		Equals<Out<Fns["updateItem"]>, P<SequenceResult & { updatedAt: string }>>
	>,
	Assert<Equals<Out<Fns["moveItem"]>, P<SequenceResult>>>,
	Assert<
		Equals<Out<Fns["deleteItem"]>, P<SequenceResult & { deletedAt: string }>>
	>,
	Assert<Equals<Out<Fns["restoreItem"]>, SequenceResult>>,
	Assert<Equals<Out<Fns["setItemAssignees"]>, P<{ ok: true }>>>,
	Assert<Equals<Out<Fns["ensureLeg"]>, { legId: string }>>,
	Assert<Equals<Out<Fns["setLeg"]>, P<{ legId: string; updatedAt: string }>>>,
	Assert<Equals<Out<Fns["relinkLeg"]>, P<{ ok: true }>>>,
	Assert<Equals<Out<Fns["deleteLeg"]>, P<{ ok: true }>>>,
	Assert<Equals<Out<Fns["setLegAssignees"]>, P<{ ok: true }>>>,
	Assert<Equals<Out<Fns["getLeg"]>, LegWithAlternatives | null>>,
	Assert<Equals<Out<Fns["insertDay"]>, P<DayMutationResult>>>,
	Assert<Equals<Out<Fns["moveDay"]>, P<DayMutationResult>>>,
	Assert<Equals<Out<Fns["deleteDay"]>, P<DayMutationResult>>>,
	Assert<Equals<Out<Fns["updateDay"]>, P<{ updatedAt: string }>>>,
	Assert<Equals<Out<Fns["setDayStay"]>, P<{ dayIds: string[] }>>>,
	Assert<Equals<Out<Fns["getSharing"]>, SharingDto>>,
	Assert<Equals<Out<Fns["setShareLink"]>, { ok: true }>>,
	Assert<Equals<Out<Fns["resetShareLink"]>, { url: string }>>,
	Assert<Equals<Out<Fns["extendShareLink"]>, { expiresAt: string }>>,
	Assert<Equals<Out<Fns["removeGuest"]>, { ok: true }>>,
	Assert<
		Out<Fns["redeemShareLink"]> extends {
			tripId: string;
			slug: string;
			role: string;
		}
			? true
			: false
	>,
	// ---- F-ext0: proposals, digest, prefs (F) ----
	Assert<Equals<Out<Fns["listProposals"]>, ProposalDto[]>>,
	Assert<Equals<Out<Fns["resolveProposal"]>, ResolveResult>>,
	Assert<Equals<Out<Fns["resolveProposals"]>, Record<string, ResolveResult>>>,
	Assert<Equals<Out<Fns["withdrawProposal"]>, { ok: true }>>,
	Assert<Equals<Out<Fns["getDigest"]>, Digest>>,
	Assert<Equals<Out<Fns["markTripSeen"]>, { seenVersion: number }>>,
	Assert<Equals<Out<Fns["getUserPrefs"]>, UserPrefs>>,
	Assert<Equals<Out<Fns["setUserPrefs"]>, UserPrefs>>,
	// ---- F-ext0: WP stubs with final signatures ----
	Assert<Equals<Out<Fns["setOpeningHours"]>, P<{ updatedAt: string }>>>,
	Assert<Equals<Out<Fns["fetchOpeningHours"]>, { updated: string[] }>>,
	Assert<Equals<Out<Fns["listMoney"]>, MoneyDto>>,
	Assert<Equals<Out<Fns["createExpense"]>, { id: string }>>,
	Assert<Equals<Out<Fns["createSettlement"]>, { id: string }>>,
	Assert<Equals<Out<Fns["setBudgetLine"]>, { id: string }>>,
	Assert<Equals<Out<Fns["proposeNoteAppend"]>, P<{ ok: true }>>>,
	// ---- ADDENDUM §9/§10 stubs with final signatures ----
	Assert<Equals<Out<Fns["duplicateTrip"]>, { tripId: string; slug: string }>>,
	Assert<Equals<Out<Fns["claimPlaceholder"]>, { memberId: string }>>,
	Assert<Equals<Out<Fns["setAttachmentVisibility"]>, { ok: true }>>,
	// ---- F-ext0b: people, one inbox, money (ADDENDUM §6–§10) ----
	Assert<
		Equals<Out<Fns["addPlaceholder"]>, { memberId: string; created: boolean }>
	>,
	Assert<Equals<Out<Fns["linkPlaceholder"]>, { ok: true }>>,
	Assert<Equals<Out<Fns["listInbox"]>, InboxDto>>,
	Assert<Equals<Out<Fns["markInboxRead"]>, { updated: number }>>,
	Assert<Equals<Out<Fns["markExpensePaid"]>, { updatedAt: string }>>,
	Assert<Equals<Out<Fns["exportMoneyCsv"]>, { filename: string; csv: string }>>,
];

// ---------------------------------------------------------------------------
// Mid-point checkpoint amendments (SPEC §18.4; the WPs' CONTRACT_REQUESTS.md)
// ---------------------------------------------------------------------------

export type CheckpointContracts = [
	// WP-Map #1 / WP-Outline #1: the `f` filter on the workspace; WP-Media #2.
	Assert<
		Equals<Parameters<WorkspaceNavT["setFilter"]>, [f: WorkspaceFilter | null]>
	>,
	Assert<
		Equals<
			Parameters<WorkspaceNavT["setMediaFilter"]>,
			[mf: WorkspaceSearch["mf"] | null]
		>
	>,
	Assert<
		Equals<
			Parameters<WorkspaceNavT["setList"]>,
			[list: WorkspaceSearch["list"] | null]
		>
	>,
	Assert<Equals<WorkspaceT["filter"], WorkspaceFilter>>,
	// WP-Outline #2: one shared matcher.
	Assert<Equals<ReturnType<typeof matchesFilter>, boolean>>,
	Assert<Equals<ReturnType<typeof filterContextOf>, FilterContext>>,
	// WP-Outline #3 / WP-Plan #4 / WP-Lists #3: the drag system.
	Assert<
		Extract<DragData, { type: "list" }> extends { listItemId: string }
			? true
			: false
	>,
	Assert<Equals<ReturnType<typeof useDnd>["inContext"], boolean>>,
	Assert<
		Parameters<ReturnType<typeof useDnd>["setOverlay"]> extends
			| [OverlayRender | null]
			| [DragData["type"], OverlayRender | null]
			? true
			: false
	>,
	// WP-Plan #1 / WP-Insights #1, WP-Places #3: graph fields (optional).
	Assert<Equals<GraphItem["fixedDate"], boolean | undefined>>,
	Assert<Equals<GraphNode["osmRef"], string | null | undefined>>,
	// WP-Shell #1, #2, #5.
	Assert<null extends UserPrefs["defaultLens"] ? true : false>,
	Assert<
		Equals<
			Parameters<typeof setDisplayPrefs>[0]["clock"],
			"12h" | "24h" | null | undefined
		>
	>,
	Assert<Equals<ReturnType<typeof getDisplayPrefs>, DisplayPrefs>>,
	Assert<
		Extract<InboxItem, { kind: "mention" }>["where"] extends
			| string
			| null
			| undefined
			? true
			: false
	>,
	// WP-Lists #2, WP-Money #4, WP-Plan #5: dialog requests.
	Assert<Equals<AddExpenseRequest["isPrivate"], boolean | undefined>>,
	Assert<Equals<AddExpenseRequest["expenseId"], string | undefined>>,
	Assert<Equals<AddExpenseRequest["refundOfId"], string | undefined>>,
	Assert<Equals<AddPlaceRequest["beforeItemId"], string | undefined>>,
	Assert<Equals<AddFlightRequest["beforeItemId"], string | undefined>>,
	// WP-Media #3; WP-Plan #3, #6.
	Assert<
		Equals<
			Parameters<typeof mediaPageUrl>,
			[attachmentId: string, page: number]
		>
	>,
	typeof TreePicker extends Component<{
		value: string | null;
		onChange: (id: string | null) => void;
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
	}>
		? true
		: false,
	typeof TimeInput extends Component<{
		value: string;
		onChange: (hhmm: string) => void;
	}>
		? true
		: false,
	// WP-Transit #3: job handlers write legs without emitting.
	Assert<Equals<WriteLegMeta["emit"], boolean | undefined>>,
	// WP-Suggest T1: fixture options.
	Assert<
		Equals<
			FixtureOptions,
			{ mayaRole?: "editor" | "suggester" | "viewer"; proposals?: boolean }
		>
	>,
];
export type AllCheckpointHold = Assert<
	CheckpointContracts[number] extends true ? true : false
>;

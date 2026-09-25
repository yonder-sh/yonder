/**
 * Every write the Plan makes (SPEC §13.1 items, days and legs), through
 * `useTripMutation`: optimistic where it helps (duration, pin, reorder),
 * the graph key invalidated by this tab (it never gets its own live event),
 * Undo on deletes, moves and unschedules, and the "route unlinked" toast
 * with Undo and Relink when a move detaches a significant leg (§7.8).
 *
 * In suggest mode `useTripMutation` skips the optimistic write and turns the
 * result into a "Suggested — …" toast; nothing here needs to know.
 */
import type { QueryClient } from "@tanstack/react-query";
import { generateKeyBetween } from "fractional-indexing";
import {
	createContext,
	createElement,
	type ReactNode,
	useContext,
	useMemo,
	useRef,
} from "react";
import { toast } from "sonner";
import { undoToast } from "@/components/common/undo-toast";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import {
	deleteDay,
	insertDay,
	moveDay,
	setDayStay,
	updateDay,
} from "@/functions/days.functions";
import {
	createItem,
	deleteItem,
	moveItem,
	restoreItem,
	setItemAssignees,
	updateItem,
} from "@/functions/items.functions";
import { deleteLeg, relinkLeg } from "@/functions/legs.functions";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { timedLegName } from "@/lib/engine/schedule";
import type { GraphItem, TripGraph } from "@/lib/engine/types";
import { AppError, errorCode, errorDetail } from "@/lib/errors";
import { formatDayDate } from "@/lib/format";
import { tripKeys } from "@/lib/query/keys";
import { useWorkspace } from "@/lib/workspace/use-workspace";

export const FLIGHT_MOVE_MESSAGE =
	"Flights move with their times — edit the flight.";

/** Server CONFLICTs about flight blocks read as one friendly sentence. */
async function friendly<T>(p: Promise<T>): Promise<T> {
	try {
		return await p;
	} catch (e) {
		const detail = errorDetail(e) ?? "";
		if (
			errorCode(e) === "CONFLICT" &&
			/inside flight|flights move/i.test(detail)
		)
			throw new AppError("CONFLICT", FLIGHT_MOVE_MESSAGE);
		if (
			errorCode(e) === "CONFLICT" &&
			/note|flight block|part of/i.test(detail)
		)
			throw new AppError(
				"CONFLICT",
				`${detail.charAt(0).toUpperCase()}${detail.slice(1).replace(/[.!?]?$/, ".")}`,
			);
		throw e;
	}
}

export type ItemPatch = {
	durationMin?: number;
	pinnedStart?: string | null;
	title?: string | null;
	note?: string | null;
	nodeId?: string | null;
	fixedDate?: boolean;
};

export type MoveVars = {
	itemId: string;
	dayId: string | null;
	afterItemId?: string;
	beforeItemId?: string;
	/** For the toast: where it came from (Undo puts it back there). */
	undo?: { dayId: string | null; afterItemId?: string; beforeItemId?: string };
	quiet?: boolean;
};

export function itemName(ix: GraphIndex, item: GraphItem | undefined): string {
	if (!item) return "Item";
	return item.title ?? ix.node(item.nodeId)?.name ?? "Untitled";
}

/** Where an item sits now: its day and neighbours (so a move can be undone). */
export function slotOf(
	ix: GraphIndex,
	itemId: string,
): { dayId: string | null; afterItemId?: string; beforeItemId?: string } {
	const item = ix.item(itemId);
	if (!item) return { dayId: null };
	const list = item.dayId
		? (ix.itemsByDay.get(item.dayId) ?? [])
		: ix.unscheduled;
	const i = list.findIndex((x) => x.id === itemId);
	const after = i > 0 ? list[i - 1]?.id : undefined;
	const before = list[i + 1]?.id;
	return {
		dayId: item.dayId,
		...(after
			? { afterItemId: after }
			: before
				? { beforeItemId: before }
				: {}),
	};
}

// ---------------------------------------------------------------------------
// Optimistic graph edits (display only; the server's positions replace them)
// ---------------------------------------------------------------------------

function patchGraph(
	qc: QueryClient,
	tripId: string,
	fn: (g: TripGraph) => TripGraph,
) {
	qc.setQueryData(tripKeys.graph(tripId), (g?: TripGraph) => (g ? fn(g) : g));
}

export function optimisticMove(g: TripGraph, v: MoveVars): TripGraph {
	const item = g.items.find((i) => i.id === v.itemId);
	if (!item) return g;
	const siblings = g.items
		.filter((i) => i.dayId === v.dayId && i.id !== v.itemId)
		.sort((a, b) =>
			a.position === b.position
				? a.id.localeCompare(b.id)
				: a.position < b.position
					? -1
					: 1,
		);
	let at = siblings.length;
	if (v.afterItemId) {
		const i = siblings.findIndex((s) => s.id === v.afterItemId);
		if (i >= 0) at = i + 1;
	} else if (v.beforeItemId) {
		const i = siblings.findIndex((s) => s.id === v.beforeItemId);
		if (i >= 0) at = i;
	}
	let position: string;
	try {
		position = generateKeyBetween(
			siblings[at - 1]?.position ?? null,
			siblings[at]?.position ?? null,
		);
	} catch {
		// Keys that aren't fractional-indexing keys (fixtures): keep the order by id.
		position = item.position;
	}
	return {
		...g,
		items: g.items.map((i) =>
			i.id === v.itemId ? { ...i, dayId: v.dayId, position } : i,
		),
	};
}

export function optimisticPatch(
	g: TripGraph,
	itemId: string,
	patch: ItemPatch,
): TripGraph {
	return {
		...g,
		items: g.items.map((i) =>
			i.id === itemId
				? {
						...i,
						...(patch.durationMin !== undefined
							? { durationMin: patch.durationMin }
							: {}),
						...(patch.pinnedStart !== undefined
							? { pinnedStart: patch.pinnedStart }
							: {}),
						...(patch.title !== undefined ? { title: patch.title } : {}),
						...(patch.note !== undefined ? { note: patch.note } : {}),
						...(patch.fixedDate !== undefined
							? { fixedDate: patch.fixedDate }
							: {}),
					}
				: i,
		),
	};
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

function usePlanActionsImpl() {
	const { graph, ix, nav } = useWorkspace();
	const tripId = graph.trip.id;
	const graphKey = tripKeys.graph(tripId);
	const common = { tripId };

	const relink = useTripMutation(
		(v: { legId: string; fromItemId: string; toItemId: string }) =>
			friendly(relinkLeg({ data: v })),
		{ ...common, keys: [graphKey] },
	);
	const discard = useTripMutation(
		(v: { legId: string }) => friendly(deleteLeg({ data: v })),
		{
			...common,
			keys: [
				graphKey,
				tripKeys.counts(tripId),
				tripKeys.media(tripId),
				tripKeys.lists(tripId),
				tripKeys.notes(tripId),
				tripKeys.money(tripId),
			],
		},
	);

	/** "Fuji Excursion 7 route unlinked · Undo · Relink…" (§7.8). */
	const announceDetached = (
		detachedLegIds: readonly string[],
		undo: () => Promise<unknown>,
	) => {
		for (const legId of detachedLegIds) {
			const leg = ix.leg(legId);
			const name = leg ? timedLegName(ix, leg) : null;
			const label =
				name && name !== "the departure" && name !== "the flight"
					? name
					: leg?.fromItemId && leg.toItemId
						? `${itemName(ix, ix.item(leg.fromItemId))} → ${itemName(ix, ix.item(leg.toItemId))}`
						: "A";
			undoToast(`${label} route unlinked`, () => void undo(), {
				secondary: {
					label: "Relink…",
					onClick: () =>
						leg?.fromItemId &&
						leg.toItemId &&
						nav.select({
							kind: "leg",
							target: {
								kind: "pair",
								fromItemId: leg.fromItemId,
								toItemId: leg.toItemId,
							},
						}),
				},
			});
		}
	};

	const update = useTripMutation(
		(v: { itemId: string; patch: ItemPatch; expectedUpdatedAt?: string }) =>
			friendly(updateItem({ data: v })),
		{
			...common,
			keys: [graphKey],
			optimistic: (qc, v) =>
				patchGraph(qc, tripId, (g) => optimisticPatch(g, v.itemId, v.patch)),
		},
	);

	const move = useTripMutation(
		(v: MoveVars) =>
			friendly(
				moveItem({
					data: {
						itemId: v.itemId,
						dayId: v.dayId,
						...(v.afterItemId ? { afterItemId: v.afterItemId } : {}),
						...(v.beforeItemId ? { beforeItemId: v.beforeItemId } : {}),
					},
				}),
			),
		{
			...common,
			keys: [graphKey],
			optimistic: (qc, v) =>
				patchGraph(qc, tripId, (g) => optimisticMove(g, v)),
			onSuccess: (r, v) => {
				const back = v.undo;
				const undo = () =>
					back
						? move.mutateAsync({ itemId: v.itemId, ...back, quiet: true })
						: Promise.resolve();
				if (r.detachedLegIds.length) announceDetached(r.detachedLegIds, undo);
				else if (!v.quiet && back && back.dayId !== v.dayId) {
					const name = itemName(ix, ix.item(v.itemId));
					const where = v.dayId
						? `Day ${ix.dayNumber(v.dayId)}`
						: "Unscheduled";
					undoToast(`${name} moved to ${where}`, () => void undo());
				}
			},
		},
	);

	const remove = useTripMutation(
		(v: { itemId: string; name?: string }) =>
			friendly(deleteItem({ data: { itemId: v.itemId } })),
		{
			...common,
			keys: [graphKey, tripKeys.counts(tripId)],
			optimistic: (qc, v) =>
				patchGraph(qc, tripId, (g) => ({
					...g,
					items: g.items.filter((i) => i.id !== v.itemId),
				})),
			onSuccess: (r, v) => {
				const name = v.name ?? "Item";
				undoToast(`${name} deleted`, async () => {
					await restore.mutateAsync({
						itemId: v.itemId,
						deletedAt: r.deletedAt,
					});
				});
			},
		},
	);
	const restore = useTripMutation(
		(v: { itemId: string; deletedAt: string }) =>
			friendly(restoreItem({ data: v })),
		{ ...common, keys: [graphKey, tripKeys.counts(tripId)] },
	);

	const create = useTripMutation(
		(v: {
			dayId: string | null;
			nodeId?: string;
			title?: string;
			durationMin?: number;
			afterItemId?: string;
			beforeItemId?: string;
		}) => friendly(createItem({ data: { tripId, ...v } })),
		{ ...common, keys: [graphKey] },
	);

	const assign = useTripMutation(
		(v: { itemId: string; memberIds: string[] }) =>
			friendly(setItemAssignees({ data: v })),
		{
			...common,
			keys: [graphKey],
			optimistic: (qc, v) =>
				patchGraph(qc, tripId, (g) => ({
					...g,
					items: g.items.map((i) =>
						i.id === v.itemId ? { ...i, assigneeIds: v.memberIds } : i,
					),
				})),
		},
	);

	// ---- days ----------------------------------------------------------------
	const dayUpdate = useTripMutation(
		(v: {
			dayId: string;
			startTime?: string;
			title?: string | null;
			expectedUpdatedAt?: string;
		}) => friendly(updateDay({ data: v })),
		{
			...common,
			keys: [graphKey],
			optimistic: (qc, v) =>
				patchGraph(qc, tripId, (g) => ({
					...g,
					days: g.days.map((d) =>
						d.id === v.dayId
							? {
									...d,
									...(v.startTime ? { startTime: v.startTime } : {}),
									...(v.title !== undefined ? { title: v.title } : {}),
								}
							: d,
					),
				})),
		},
	);
	const dayInsert = useTripMutation(
		(v: { dayId: string; where: "before" | "after" }) =>
			friendly(insertDay({ data: { tripId, ...v } })),
		{
			...common,
			keys: [graphKey],
			onSuccess: (_r, v) => {
				const d = ix.day(v.dayId);
				if (d)
					toast(
						`Added a day ${v.where} ${formatDayDate(d.date)}; later days moved by one.`,
					);
			},
		},
	);
	const dayMove = useTripMutation(
		(v: { dayId: string; toDate: string; fromDate: string }) =>
			friendly(moveDay({ data: { dayId: v.dayId, toDate: v.toDate } })),
		{
			...common,
			keys: [graphKey],
			onSuccess: (r, v) => {
				const undo = () =>
					dayMove.mutateAsync({
						dayId: v.dayId,
						toDate: v.fromDate,
						fromDate: v.toDate,
					});
				if (r.detachedLegIds.length) announceDetached(r.detachedLegIds, undo);
				else
					undoToast(
						`Day moved to ${formatDayDate(v.toDate)}`,
						() => void undo(),
					);
			},
		},
	);
	const dayDelete = useTripMutation(
		(v: { dayId: string }) => friendly(deleteDay({ data: v })),
		{
			...common,
			keys: [
				graphKey,
				tripKeys.counts(tripId),
				tripKeys.lists(tripId),
				tripKeys.media(tripId),
				tripKeys.money(tripId),
			],
		},
	);
	const dayStay = useTripMutation(
		(v: { fromDayId: string; toDayId?: string; nodeId: string | null }) =>
			friendly(setDayStay({ data: v })),
		{
			...common,
			keys: [graphKey],
			optimistic: (qc, v) =>
				patchGraph(qc, tripId, (g) => ({
					...g,
					days: g.days.map((d) =>
						d.id === v.fromDayId ? { ...d, nightNodeId: v.nodeId } : d,
					),
				})),
		},
	);

	return useMemo(
		() => ({
			update,
			move,
			remove,
			create,
			assign,
			relink,
			discard,
			dayUpdate,
			dayInsert,
			dayMove,
			dayDelete,
			dayStay,
			/** Delete with Undo (the name is taken now: the card is gone by the time it answers). */
			deleteItem(itemId: string) {
				remove.mutate({ itemId, name: itemName(ix, ix.item(itemId)) });
			},
			/** Unschedule with Undo (back to its old slot). */
			unschedule(itemId: string) {
				move.mutate({
					itemId,
					dayId: null,
					undo: slotOf(ix, itemId),
				});
			},
			/** Move to another day (at its end) with Undo. */
			moveToDay(itemId: string, dayId: string) {
				const last = (ix.itemsByDay.get(dayId) ?? []).at(-1);
				move.mutate({
					itemId,
					dayId,
					...(last ? { afterItemId: last.id } : {}),
					undo: slotOf(ix, itemId),
				});
			},
		}),
		[
			update,
			move,
			remove,
			create,
			assign,
			relink,
			discard,
			dayUpdate,
			dayInsert,
			dayMove,
			dayDelete,
			dayStay,
			ix,
		],
	);
}

export type PlanActions = ReturnType<typeof usePlanActionsImpl>;

const PlanActionsContext = createContext<PlanActions | null>(null);

/**
 * One set of Plan mutations per surface (the Plan tab, an inspector
 * Overview), shared through context: a 35-day trip renders hundreds of cards,
 * and each one owning a dozen `useMutation`s would be wasteful (QA PERF-05).
 * The value is a stable proxy onto the latest mutations, so a mutation's
 * pending state never re-renders every card.
 */
export function PlanActionsProvider({ children }: { children: ReactNode }) {
	const actions = usePlanActionsImpl();
	const ref = useRef(actions);
	ref.current = actions;
	const stable = useMemo(
		() =>
			new Proxy({} as PlanActions, {
				get: (_t, k) => ref.current[k as keyof PlanActions],
			}),
		[],
	);
	return createElement(
		PlanActionsContext.Provider,
		{ value: stable },
		children,
	);
}

/** The Plan's mutations (inside `PlanActionsProvider`). */
export function usePlanActions(): PlanActions {
	const actions = useContext(PlanActionsContext);
	if (!actions)
		throw new Error("usePlanActions() needs a <PlanActionsProvider> above it");
	return actions;
}

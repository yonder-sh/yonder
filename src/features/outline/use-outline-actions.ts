/**
 * Every write the Outline and Ideas make, through `useTripMutation` (SPEC
 * §12.6): optimistic where it's cheap, every affected key invalidated (the
 * live event skips this tab), a `{ proposed }` result becomes a ghost + toast
 * in suggest mode, and deletes and moves offer Undo (SPEC §0 rule 17).
 *
 * The Undo toasts run from the mutation's own `onSuccess` (not `mutate()`
 * callbacks), so they still fire when the row that started them unmounts
 * (the mobile Outline drawer closes on tap). What they need rides in `vars`
 * and is stripped before the strict server schemas see it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { generateKeyBetween } from "fractional-indexing";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { v7 as uuidv7 } from "uuid";
import { undoToast } from "@/components/common/undo-toast";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { createItem, deleteItem } from "@/functions/items.functions";
import {
	createNode,
	deleteNode,
	moveNode,
	restoreNode,
	setNodePriority,
	updateNode,
} from "@/functions/nodes.functions";
import { isSchedulable } from "@/lib/engine/tree";
import type {
	GraphNode,
	NodeStatus,
	NodeType,
	PlaceCategory,
	Priority,
	TripGraph,
} from "@/lib/engine/types";
import { humanError } from "@/lib/errors";
import { formatDayDate } from "@/lib/format";
import { tripKeys } from "@/lib/query/keys";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { othersProposedCreate, reviewFirst } from "./ghosts";

export type MoveVars = {
	nodeId: string;
	parentId: string | null;
	afterId?: string;
	beforeId?: string;
};

type Patch = {
	name?: string;
	type?: NodeType;
	category?: PlaceCategory;
	status?: NodeStatus;
};

/** A key between two siblings for the optimistic cache only (the server picks the real one). */
function optimisticKey(
	sibs: readonly GraphNode[],
	afterId?: string,
	beforeId?: string,
): string | null {
	try {
		const i = afterId
			? sibs.findIndex((s) => s.id === afterId)
			: beforeId
				? sibs.findIndex((s) => s.id === beforeId) - 1
				: sibs.length - 1;
		const lo = i >= 0 ? (sibs[i]?.position ?? null) : null;
		const hi = sibs[i + 1]?.position ?? null;
		return generateKeyBetween(lo, hi);
	} catch {
		return null;
	}
}

/** Neighbours that put `node` back where it is now (for Undo). */
function currentSlot(
	sibs: readonly GraphNode[],
	node: GraphNode,
): Pick<MoveVars, "afterId" | "beforeId"> {
	const i = sibs.findIndex((s) => s.id === node.id);
	const before = sibs[i - 1];
	const after = sibs[i + 1];
	return before ? { afterId: before.id } : after ? { beforeId: after.id } : {};
}

/** A live announcer for keyboard users (the Outline's polite region). */
export type Announce = (text: string) => void;

export function useOutlineActions(announce?: Announce) {
	const { graph, ix, sel, days, scope, nav, proposals, access } =
		useWorkspace();
	const tripId = graph.trip.id;
	const qc = useQueryClient();
	const graphKey = useMemo(() => tripKeys.graph(tripId), [tripId]);
	const countsKey = useMemo(() => tripKeys.counts(tripId), [tripId]);
	const openAddPlace = useUi((s) => s.openAddPlace);
	const patchGraph = useCallback(
		(fn: (g: TripGraph) => TripGraph) =>
			qc.setQueryData<TripGraph>(graphKey, (g) => (g ? fn(g) : g)),
		[qc, graphKey],
	);
	const refresh = useCallback(
		() =>
			Promise.all([
				qc.invalidateQueries({ queryKey: graphKey }),
				qc.invalidateQueries({ queryKey: countsKey }),
			]),
		[qc, graphKey, countsKey],
	);

	// -- move (drag, Move…) --------------------------------------------------
	type MoveM = MoveVars & { label?: string; back?: MoveVars };
	const moveM = useTripMutation(
		({ nodeId, parentId, afterId, beforeId }: MoveM) =>
			moveNode({
				data: {
					nodeId,
					parentId,
					...(afterId ? { afterId } : {}),
					...(beforeId ? { beforeId } : {}),
				},
			}),
		{
			keys: [graphKey],
			tripId,
			optimistic: (_qc, v) => {
				const sibs = ix.children(v.parentId).filter((s) => s.id !== v.nodeId);
				const position = optimisticKey(sibs, v.afterId, v.beforeId);
				patchGraph((g) => ({
					...g,
					nodes: g.nodes.map((n) =>
						n.id === v.nodeId
							? {
									...n,
									parentId: v.parentId,
									...(position ? { position } : {}),
								}
							: n,
					),
				}));
			},
			onSuccess: (_r, v) => {
				if (!v.label) return;
				announce?.(v.label);
				const back = v.back;
				if (back) undoToast(v.label, () => moveM.mutate(back));
			},
		},
	);
	const move = useCallback(
		(v: MoveVars) => {
			const node = ix.node(v.nodeId);
			if (!node) return;
			const to = v.parentId ? ix.node(v.parentId)?.name : "the top level";
			const label =
				v.parentId !== node.parentId
					? `${node.name} moved into ${to ?? "another place"}`
					: `${node.name} moved`;
			moveM.mutate({
				...v,
				label,
				back: {
					nodeId: node.id,
					parentId: node.parentId,
					...currentSlot(ix.children(node.parentId), node),
				},
			});
		},
		[ix, moveM],
	);

	// -- update (rename, type, drop/restore) ---------------------------------
	type UpdateM = {
		nodeId: string;
		patch: Patch;
		expectedUpdatedAt?: string;
		toast?: { text: string; undo?: Patch };
	};
	const updateM = useTripMutation(
		({ nodeId, patch, expectedUpdatedAt }: UpdateM) =>
			updateNode({
				data: {
					nodeId,
					patch,
					...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
				},
			}),
		{
			keys: [graphKey],
			tripId,
			optimistic: (_qc, v) =>
				patchGraph((g) => ({
					...g,
					nodes: g.nodes.map((n) =>
						n.id === v.nodeId
							? {
									...n,
									...(v.patch.name ? { name: v.patch.name } : {}),
									...(v.patch.status ? { status: v.patch.status } : {}),
									...(v.patch.type
										? {
												type: v.patch.type,
												category:
													v.patch.type === "place"
														? (v.patch.category ?? n.category ?? "other")
														: null,
											}
										: {}),
								}
							: n,
					),
				})),
			onSuccess: (_r, v) => {
				if (!v.toast) return;
				announce?.(v.toast.text);
				const undo = v.toast.undo;
				if (undo)
					undoToast(v.toast.text, () =>
						updateM.mutate({ nodeId: v.nodeId, patch: undo }),
					);
				else toast(v.toast.text);
			},
		},
	);
	const rename = useCallback(
		(nodeId: string, name: string, expectedUpdatedAt?: string) => {
			const trimmed = name.trim().slice(0, 200);
			const node = ix.node(nodeId);
			if (!node || !trimmed || trimmed === node.name) return;
			updateM.mutate({
				nodeId,
				patch: { name: trimmed },
				...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
			});
		},
		[ix, updateM],
	);
	const changeType = useCallback(
		(nodeId: string, type: NodeType) => {
			const node = ix.node(nodeId);
			if (!node || node.type === type) return;
			updateM.mutate({
				nodeId,
				patch: { type, ...(type === "place" ? { category: "other" } : {}) },
				toast: {
					text: `${node.name} is now ${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`,
					undo: {
						type: node.type,
						...(node.type === "place" && node.category
							? { category: node.category }
							: {}),
					},
				},
			});
		},
		[ix, updateM],
	);
	const setStatus = useCallback(
		(nodeId: string, status: NodeStatus) => {
			const node = ix.node(nodeId);
			if (!node || node.status === status) return;
			updateM.mutate({
				nodeId,
				patch: { status },
				toast:
					status === "dropped"
						? { text: `${node.name} dropped`, undo: { status: "active" } }
						: { text: `${node.name} restored` },
			});
		},
		[ix, updateM],
	);

	// -- delete + undo -------------------------------------------------------
	type DeleteM = { nodeId: string; name?: string };
	const deleteM = useTripMutation(
		({ nodeId }: DeleteM) => deleteNode({ data: { nodeId } }),
		{
			keys: [graphKey, countsKey],
			tripId,
			optimistic: (_qc, v) =>
				patchGraph((g) => {
					const gone = new Set(
						ix.outline
							.filter((n) => ix.isWithin(n.id, v.nodeId))
							.map((n) => n.id),
					);
					return {
						...g,
						nodes: g.nodes.filter((n) => !gone.has(n.id)),
						items: g.items.filter((i) => !i.nodeId || !gone.has(i.nodeId)),
					};
				}),
			onSuccess: (r, v) => {
				const text = `${v.name ?? "Place"} deleted`;
				announce?.(text);
				undoToast(text, async () => {
					try {
						await restoreNode({
							data: { nodeId: v.nodeId, deletedAt: r.deletedAt },
						});
					} catch (e) {
						toast.error(humanError(e));
					}
					await refresh();
				});
			},
		},
	);
	const remove = useCallback(
		(nodeId: string) => {
			const node = ix.node(nodeId);
			if (!node) return;
			// Don't stay inside what's being deleted.
			if (scope && ix.isWithin(scope.id, nodeId)) nav.zoomTo(node.parentId);
			else if (sel?.kind === "node" && ix.isWithin(sel.id, nodeId))
				nav.select(null);
			deleteM.mutate({ nodeId, name: node.name });
		},
		[ix, scope, sel, nav, deleteM],
	);

	// -- create a child -------------------------------------------------------
	type CreateM = {
		id: string;
		parentId: string | null;
		type: NodeType;
		name: string;
		category?: PlaceCategory;
	};
	const createM = useTripMutation(
		(v: CreateM) => createNode({ data: { tripId, ...v } }),
		{
			keys: [graphKey],
			tripId,
			onSuccess: (_r, v) => {
				announce?.(`${v.name} added`);
				nav.select({ kind: "node", id: v.id });
			},
		},
	);
	const addChild = useCallback(
		(parentId: string | null, type: NodeType, name: string) => {
			const trimmed = name.trim().slice(0, 200);
			if (!trimmed) return null;
			const id = uuidv7();
			createM.mutate({
				id,
				parentId,
				type,
				name: trimmed,
				...(type === "place" ? { category: "other" as const } : {}),
			});
			return id;
		},
		[createM],
	);

	// -- schedule (A) ---------------------------------------------------------
	type ScheduleM = { dayId: string; nodeId: string; label?: string };
	const createItemM = useTripMutation(
		({ dayId, nodeId }: ScheduleM) =>
			createItem({ data: { tripId, dayId, nodeId } }),
		{
			keys: [graphKey, countsKey],
			tripId,
			onSuccess: (r, v) => {
				const text = v.label ?? "Added to the plan";
				announce?.(text);
				undoToast(text, async () => {
					try {
						await deleteItem({ data: { itemId: r.itemId } });
					} catch (e) {
						toast.error(humanError(e));
					}
					await refresh();
				});
			},
		},
	);
	/** The day **A** adds to (DESIGN §13): the selected day, the selected item's day, else the first day of the range. */
	const focusedDayId = useCallback((): string | null => {
		if (sel?.kind === "day") return sel.id;
		if (sel?.kind === "item") return ix.item(sel.id)?.dayId ?? null;
		if (days) return ix.dayOfDate(days.from)?.id ?? null;
		return null;
	}, [sel, days, ix]);
	const schedule = useCallback(
		(nodeId: string, dayId?: string | null): boolean => {
			const node = ix.node(nodeId);
			if (!node) return false;
			if (node.type !== "place") {
				const msg = `Only places can be scheduled — ${node.name} is ${/^[aeiou]/.test(node.type) ? "an" : "a"} ${node.type}.`;
				announce?.(msg);
				toast(msg);
				return false;
			}
			if (!isSchedulable(ix, nodeId)) {
				const msg = `${node.name} is dropped — restore it first.`;
				announce?.(msg);
				toast(msg);
				return false;
			}
			// Someone else's proposed place isn't real yet (E7).
			const ghost = othersProposedCreate(
				proposals.marks.get(`node:${nodeId}`),
				access.memberId,
			);
			if (ghost) {
				announce?.(reviewFirst(ghost));
				toast(reviewFirst(ghost));
				return false;
			}
			const target = dayId ?? focusedDayId();
			if (!target) {
				// No day in focus: let the add flow ask which day (WP-Places).
				openAddPlace({ mode: "schedule", nodeId });
				return false;
			}
			const day = ix.day(target);
			const label = `Added ${node.name} to ${
				day
					? `Day ${ix.dayNumber(target)} · ${formatDayDate(day.date)}`
					: "that day"
			}`;
			createItemM.mutate({ dayId: target, nodeId, label });
			return true;
		},
		[
			ix,
			focusedDayId,
			createItemM,
			openAddPlace,
			announce,
			proposals.marks,
			access.memberId,
		],
	);

	// -- my priority ----------------------------------------------------------
	const priorityM = useTripMutation(
		(v: { nodeId: string; memberId: string; priority: Priority | null }) =>
			setNodePriority({ data: v }),
		{
			keys: [graphKey],
			tripId,
			optimistic: (_qc, v) =>
				patchGraph((g) => ({
					...g,
					nodes: g.nodes.map((n) => {
						if (n.id !== v.nodeId) return n;
						const priorities = { ...n.priorities };
						if (v.priority) priorities[v.memberId] = v.priority;
						else delete priorities[v.memberId];
						return { ...n, priorities };
					}),
				})),
		},
	);
	const setPriority = useCallback(
		(nodeId: string, memberId: string, priority: Priority | null) =>
			priorityM.mutate({ nodeId, memberId, priority }),
		[priorityM],
	);

	return {
		move,
		rename,
		changeType,
		setStatus,
		remove,
		addChild,
		schedule,
		setPriority,
		focusedDayId,
	};
}

export type OutlineActions = ReturnType<typeof useOutlineActions>;

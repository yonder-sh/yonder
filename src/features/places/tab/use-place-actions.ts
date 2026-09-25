/**
 * What you can do to a place from the Places tab (docs/PLACES.md §1–§3):
 * rate it (your own rating), pin / unpin it on the shortlist, drop it or
 * bring it back, set its time needed, put it on a day. Pin, unpin and drop
 * are ordinary node edits, so the gate proposes them in suggest mode; every
 * change offers Undo.
 */
import {
	createContext,
	createElement,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
} from "react";
import { toast } from "sonner";
import { useEditGuard } from "@/components/common/edit-guard";
import { undoToast } from "@/components/common/undo-toast";
import { deleteItem } from "@/functions/items.functions";
import type { LifecycleFields } from "@/lib/domain/places-lifecycle";
import { humanError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import type { Priority } from "@/lib/schemas/enums";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useCreateItem, useSetPriority, useUpdateNode } from "../mutations";
import { mayRate } from "../ui/member-ratings";
import { toggleDrop, toggleShortlist } from "./lifecycle";
import type { PlaceRow } from "./model";

/**
 * Whether I may set my own rating here, and why not. The same check as the
 * node inspector's picker (`mayRate` + the edit guard), so the roles the
 * gate allows to rate (and only those) get live buttons.
 */
export function useCanRateOwn(): {
	canRate: boolean;
	reason: string | null;
	memberId: string | null;
} {
	const { graph, access } = useWorkspace();
	const guard = useEditGuard("rate");
	const me = access.memberId
		? graph.members.find((m) => m.id === access.memberId)
		: undefined;
	if (!me)
		return {
			canRate: false,
			reason: "Only trip members rate places.",
			memberId: null,
		};
	const allowed = mayRate(access, me);
	return {
		canRate: allowed && !guard.disabled,
		reason: guard.disabled ? guard.reason : allowed ? null : "View only",
		memberId: me.id,
	};
}

function usePlaceActionsValue() {
	const { graph, access } = useWorkspace();
	const tripId = graph.trip.id;
	const setPriority = useSetPriority(tripId);
	const update = useUpdateNode(tripId);
	const createItem = useCreateItem(tripId);
	const guard = useEditGuard();
	const own = useCanRateOwn();

	const rate = useCallback(
		(nodeId: string, p: Priority | null) => {
			if (!own.canRate || !own.memberId) {
				if (own.reason) toast(own.reason, { id: "rate-blocked" });
				return false;
			}
			setPriority.mutate(
				{ nodeId, memberId: own.memberId, priority: p },
				{ onError: (e) => toast.error(humanError(e)) },
			);
			return true;
		},
		[own.canRate, own.memberId, own.reason, setPriority],
	);

	/** An editor sets a placeholder's rating (an imported friend without an account). */
	const ratePlaceholder = useCallback(
		(nodeId: string, memberId: string, p: Priority | null) => {
			if (guard.disabled) return;
			setPriority.mutate(
				{ nodeId, memberId, priority: p },
				{ onError: (e) => toast.error(humanError(e)) },
			);
		},
		[guard.disabled, setPriority],
	);

	const lifecycle = useCallback(
		(
			row: PlaceRow,
			patch: LifecycleFields,
			done: string,
			back: LifecycleFields,
		) => {
			if (guard.disabled) return;
			update.mutate(
				{ nodeId: row.id, patch },
				{
					onError: (e) => toast.error(humanError(e)),
					onSuccess: () =>
						undoToast(
							access.mode === "suggest" ? `Suggested: ${done}` : done,
							() => update.mutate({ nodeId: row.id, patch: back }),
						),
				},
			);
		},
		[guard.disabled, update, access.mode],
	);

	/** S: pin or unpin (back to the ratings where that says the same). */
	const togglePin = useCallback(
		(row: PlaceRow, threshold: number) => {
			if (row.status === "scheduled") return;
			const next = toggleShortlist({
				...row.info,
				score: row.score,
				threshold,
			});
			const was = row.node.shortlistPin ?? "auto";
			// Pinning a dropped place brings it back first.
			const patch: LifecycleFields =
				row.status === "dropped" && next.shortlistPin === "pinned"
					? { status: "active", shortlistPin: "pinned" }
					: next;
			const onList =
				next.shortlistPin === "pinned" ||
				(next.shortlistPin === "auto" && row.score >= threshold);
			lifecycle(
				row,
				patch,
				onList
					? `${row.name} is on the shortlist`
					: `${row.name} is off the shortlist`,
				row.status === "dropped"
					? { status: "dropped", shortlistPin: was }
					: { shortlistPin: was },
			);
		},
		[lifecycle],
	);

	/** D: drop, or bring back. */
	const toggleDropped = useCallback(
		(row: PlaceRow) => {
			const patch = toggleDrop(row.droppedByHand);
			lifecycle(
				row,
				patch,
				row.droppedByHand ? `${row.name} is back` : `Dropped ${row.name}`,
				toggleDrop(!row.droppedByHand),
			);
		},
		[lifecycle],
	);

	const setTime = useCallback(
		(row: PlaceRow, minutes: number | null) => {
			if (guard.disabled) return;
			if (minutes === row.node.timeNeededMin) return;
			update.mutate(
				{ nodeId: row.id, patch: { timeNeededMin: minutes } },
				{ onError: (e) => toast.error(humanError(e)) },
			);
		},
		[guard.disabled, update],
	);

	/** Put it on a day: at the end, or at a spot (`bestSpot`: after / before a stop). */
	const addToDay = useCallback(
		async (
			row: PlaceRow,
			dayId: string,
			label: string,
			at?: { afterItemId?: string; beforeItemId?: string },
		) => {
			try {
				if (row.droppedByHand)
					await update.mutateAsync({
						nodeId: row.id,
						patch: { status: "active" },
					});
				const id = newId();
				await createItem.mutateAsync({
					id,
					dayId,
					nodeId: row.id,
					...(at?.afterItemId ? { afterItemId: at.afterItemId } : {}),
					...(at?.beforeItemId && !at.afterItemId
						? { beforeItemId: at.beforeItemId }
						: {}),
				});
				undoToast(`${row.name} · ${label}`, async () => {
					await deleteItem({ data: { itemId: id } });
				});
			} catch (e) {
				toast.error(humanError(e));
			}
		},
		[update, createItem],
	);

	return useMemo(
		() => ({
			rate,
			ratePlaceholder,
			togglePin,
			toggleDropped,
			setTime,
			addToDay,
			canEdit: !guard.disabled,
			editReason: guard.reason,
			canRate: own.canRate,
			rateReason: own.reason,
			me: own.memberId,
		}),
		[
			rate,
			ratePlaceholder,
			togglePin,
			toggleDropped,
			setTime,
			addToDay,
			guard.disabled,
			guard.reason,
			own.canRate,
			own.reason,
			own.memberId,
		],
	);
}

export type PlaceActions = ReturnType<typeof usePlaceActionsValue>;

const PlaceActionsContext = createContext<PlaceActions | null>(null);

/** One set of mutations for a whole table (not one per cell). */
export function PlaceActionsProvider({ children }: { children: ReactNode }) {
	const value = usePlaceActionsValue();
	return createElement(PlaceActionsContext.Provider, { value }, children);
}

export function usePlaceActions(): PlaceActions {
	const v = useContext(PlaceActionsContext);
	if (!v)
		throw new Error(
			"usePlaceActions() needs a <PlaceActionsProvider> above it",
		);
	return v;
}

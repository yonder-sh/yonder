/**
 * What Today changes (One Yonder phase 5). Done and its Undo are shared
 * travel state: direct, never a proposal, for owners, editors and suggesters
 * (`markDone`). The fixes are ordinary plan edits with their Undo (proposals
 * in suggest mode): Skip moves the stop to Ideas, Shorten sets its duration,
 * Add puts an idea on today (the Plan's add-to-day). Raters, viewers and
 * link guests follow along.
 */
import { undoToast } from "@/components/common/undo-toast";
import { useMoveItem } from "@/features/places/mutations";
import type { PlaceRow } from "@/features/places/tab/model";
import { usePlaceActions } from "@/features/places/tab/use-place-actions";
import {
	itemName,
	slotOf,
	usePlanActions,
} from "@/features/plan/use-plan-actions";
import { can } from "@/lib/auth/roles";
import { isProposed } from "@/lib/schemas/proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { spokenMin } from "./lib/words";
import { useSetItemDone } from "./mutations";

export interface TodayActions {
	/** Done and Undo are shown. */
	mayMarkDone: boolean;
	/** The fixes and Add are shown (edits, or suggestions in suggest mode). */
	mayChange: boolean;
	/** Offline: the buttons wait (shown, disabled). */
	offline: boolean;
	done(itemId: string): void;
	undo(itemId: string): void;
	skip(itemId: string): void;
	shorten(itemId: string, toMin: number): void;
	add(
		place: Pick<PlaceRow, "id" | "name">,
		dayId: string,
		at: { afterItemId?: string; beforeItemId?: string },
	): void;
}

export function useTodayActions(): TodayActions {
	const { graph, ix, access, connection } = useWorkspace();
	const setDone = useSetItemDone(graph.trip.id);
	const move = useMoveItem(graph.trip.id);
	const plan = usePlanActions();
	const places = usePlaceActions();
	const by = graph.me.userId;
	return {
		mayMarkDone: can(graph.me, "markDone"),
		mayChange: access.mode !== "read",
		offline: connection === "offline",
		done: (itemId) => setDone.mutate({ itemId, done: true, by }),
		undo: (itemId) => setDone.mutate({ itemId, done: false, by }),
		// "Bic Camera moved to Ideas · Undo" (a leg it leaves behind rejoins on Undo).
		skip: (itemId) => {
			const back = slotOf(ix, itemId);
			const name = itemName(ix, ix.item(itemId));
			move.mutate(
				{ itemId, dayId: null },
				{
					onSuccess: (r) => {
						if (isProposed(r)) return;
						undoToast(`${name} moved to Ideas`, () =>
							move.mutate({ itemId, ...back }),
						);
					},
				},
			);
		},
		shorten: (itemId, toMin) => {
			const item = ix.item(itemId);
			if (!item) return;
			const was = item.durationMin;
			plan.update.mutate(
				{ itemId, patch: { durationMin: toMin } },
				{
					onSuccess: (r) => {
						if (isProposed(r)) return;
						undoToast(
							`${itemName(ix, item)} shortened to ${spokenMin(toMin)}`,
							() => plan.update.mutate({ itemId, patch: { durationMin: was } }),
						);
					},
				},
			);
		},
		add: (place, dayId, at) =>
			void places.addToDay(
				{ ...place, droppedByHand: false },
				dayId,
				"Added to today",
				at,
			),
	};
}

/**
 * The Bookings tab's writes (One Yonder D12): "Mark booked" ticks the
 * booking to-do and sets its stop "Booked for this date" (`items.fixed_date`,
 * the what-if's "Needs rebooking"); "Not booked yet" (or unticking it, in
 * Bookings or To-dos) reopens the to-do and clears its stop's "Booked for
 * this date" too, with Undo for both.
 */
import { undoToast } from "@/components/common/undo-toast";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { updateItem } from "@/functions/items.functions";
import type { TripGraph } from "@/lib/engine/types";
import { tripKeys } from "@/lib/query/keys";
import { isProposed } from "@/lib/schemas/proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	type BookingEntry,
	type BookingFor,
	bookedStopOf,
} from "./bookings-model";
import { plainOf } from "./format";
import { itemName } from "./list-model";
import { useListActions } from "./use-list-actions";

export function useBookingActions() {
	const { graph, ix } = useWorkspace();
	const tripId = graph.trip.id;
	const lists = useListActions();
	const fixDate = useTripMutation(
		(v: { itemId: string; fixedDate: boolean }) =>
			updateItem({
				data: { itemId: v.itemId, patch: { fixedDate: v.fixedDate } },
			}),
		{
			keys: [tripKeys.graph(tripId)],
			tripId,
			optimistic: (qc, v) =>
				qc.setQueryData<TripGraph>(tripKeys.graph(tripId), (g) =>
					g
						? {
								...g,
								items: g.items.map((i) =>
									i.id === v.itemId ? { ...i, fixedDate: v.fixedDate } : i,
								),
							}
						: g,
				),
		},
	);
	return {
		/** Ticks the to-do; a stop it is for becomes "Booked for this date". */
		markBooked: (e: BookingEntry, f: BookingFor | null) => {
			if (e.kind !== "todo") return;
			lists.setStatus(e.row.id, "done");
			if (f?.target.kind !== "item") return;
			const item = ix.item(f.target.itemId);
			if (item?.dayId && !item.fixedDate)
				fixDate.mutate({ itemId: item.id, fixedDate: true });
		},
		/**
		 * Reopens a ticked booking to-do and clears its stop's "Booked for this
		 * date" (a booked stop on its own: just that). Clearing a stop offers
		 * Undo for both; reopening alone is silent, like any checkbox.
		 */
		notBooked: (e: BookingEntry) => {
			const todo = e.kind === "todo" && e.row.status === "done" ? e.row : null;
			const stop =
				e.kind === "stop" ? e.item : (e.stop ?? bookedStopOf(ix, e.row));
			if (!stop) {
				if (todo) lists.setStatus(todo.id, "open");
				return;
			}
			const label =
				e.kind === "todo" ? plainOf(e.row.text) : itemName(ix, e.id);
			void Promise.all([
				todo ? lists.setStatusAsync(todo.id, "open") : null,
				fixDate.mutateAsync({ itemId: stop.id, fixedDate: false }),
			]).then(
				(done) => {
					// A suggestion toasts itself ("Suggested — …"): nothing to undo here.
					if (done.some(isProposed)) return;
					undoToast(`${label} · not booked yet`, () => {
						if (todo) lists.setStatus(todo.id, "done");
						fixDate.mutate({ itemId: stop.id, fixedDate: true });
					});
				},
				// A failure rolls back and toasts already.
				() => {},
			);
		},
	};
}

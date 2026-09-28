/**
 * The Bookings tab's writes (One Yonder D12): "Mark booked" ticks the
 * booking to-do and sets its stop "Booked for this date" (`items.fixed_date`,
 * the what-if's "Needs rebooking"); "Not booked yet" reopens the to-do.
 */
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { updateItem } from "@/functions/items.functions";
import type { TripGraph } from "@/lib/engine/types";
import { tripKeys } from "@/lib/query/keys";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { BookingEntry, BookingFor } from "./bookings-model";
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
		/** Reopens a ticked booking to-do (its stop stays booked). */
		notBooked: (e: BookingEntry) => {
			if (e.kind === "todo") lists.setStatus(e.row.id, "open");
		},
	};
}

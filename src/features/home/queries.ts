/** WP-Home queries (SPEC §12.2). */
import { forgetLostTrips } from "@/features/offline/saved-trips";
import { meKeys, tripKeys } from "@/lib/query/keys";
import { persistedQuery } from "@/lib/query/persister";
import {
	listMyDeadlines,
	listMyTrips,
	type MyDeadline,
	type MyTrip,
} from "./dashboard.functions";

/**
 * My trips. Every answer from the server (never a restored copy: this runs
 * only on a real fetch) also drops the offline copy of a saved trip the
 * account lost while away (QA PWA-08); on the server it's a no-op.
 */
export const myTripsQuery = () =>
	persistedQuery({
		queryKey: meKeys.trips,
		queryFn: async ({ client }): Promise<MyTrip[]> => {
			const askedAt = Date.now();
			const trips = await listMyTrips();
			const { dropped, done } = forgetLostTrips(
				trips.map((t) => t.id),
				askedAt,
			);
			for (const id of dropped)
				client.removeQueries({ queryKey: tripKeys.trip(id) });
			void done.catch(() => {});
			return trips;
		},
	});

/** Mine and unassigned; `everyone` adds rows assigned only to others (same key prefix, so `lists` invalidations reach both). */
export const myDeadlinesQuery = (everyone = false) =>
	persistedQuery({
		queryKey: everyone ? [...meKeys.deadlines, "everyone"] : meKeys.deadlines,
		queryFn: (): Promise<MyDeadline[]> =>
			everyone ? listMyDeadlines({ data: { everyone } }) : listMyDeadlines(),
	});

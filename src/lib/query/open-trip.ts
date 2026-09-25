import type { QueryClient } from "@tanstack/react-query";
import { saveGrant } from "@/lib/auth/grants";
import { openTripByLink } from "@/lib/auth/share.functions";
import type { TripGraph } from "@/lib/engine/types";
import { isAccessDenied } from "@/lib/errors";
import { tripSlugKey } from "./keys";
import { tripGraphQuery, tripSlugQuery } from "./trip-queries";

/**
 * The trip at `/t/<slug>` for the route loaders. The address is the trip's
 * share link, like Google Drive: the viewer's own access first (a
 * membership, or a grant they already hold); when that answers NOT_FOUND or
 * FORBIDDEN, the trip's link (`openTripByLink`), which lets a non-member in
 * with the "Anyone with the link" role while it is on. Anything else rethrows
 * the first answer, so the page is the same "no access" for a trip that
 * doesn't exist and one the viewer may not open.
 */
export async function ensureTripBySlug(
	qc: QueryClient,
	slug: string,
): Promise<{ tripId: string; graph: TripGraph }> {
	try {
		const { tripId } = await qc.ensureQueryData(tripSlugQuery(slug));
		const graph = await qc.ensureQueryData(tripGraphQuery(tripId));
		return { tripId, graph };
	} catch (e) {
		if (!isAccessDenied(e)) throw e;
		const opened = await openTripByLink({ data: { slug } }).catch(() => null);
		if (!opened) throw e;
		saveGrant(slug);
		qc.setQueryData(tripSlugKey(slug), { tripId: opened.tripId });
		const graph = await qc.fetchQuery(tripGraphQuery(opened.tripId));
		return { tripId: opened.tripId, graph };
	}
}

/**
 * The app's mutation transaction helper (SPEC §10.5, §12.3), bound to the
 * process-wide pool. Every mutating server function runs its writes through it:
 *
 *   await withTripTx(tripId, async (tx, out) => {
 *     …writes…
 *     out.emit({ entity: "item", ids: [itemId] })
 *   }, mutationMeta(access))
 *
 * It takes the trip's advisory lock, bumps `trips.version` by 1, and after
 * COMMIT publishes one merged `invalidate` event (Redis → collab → clients) and
 * enqueues the jobs. Nothing is published when the transaction fails.
 */
import { getRequestHeaders } from "@tanstack/react-start/server";
import { db } from "@/db/db.server";
import type { TripAccess } from "@/lib/auth/roles";
import { tabIdFromHeaders } from "@/lib/realtime/tab-id";
import type { AuthUser } from "@/server/auth.server";
import { createWithTripTx, type OutboxMeta } from "@/server/live/outbox.server";

export const withTripTx = createWithTripTx(db);

/**
 * `{ by, actor }` for `withTripTx`: the calling tab (so it skips its own event)
 * and who did it (the "Maya changed this" glow). Safe outside a request.
 */
export function mutationMeta(
	access: Pick<TripAccess, "color">,
	user: Pick<AuthUser, "id" | "name">,
): OutboxMeta {
	let by: string | undefined;
	try {
		by = tabIdFromHeaders(getRequestHeaders());
	} catch {
		by = undefined; // scripts and tests: no request
	}
	return {
		by,
		actor: { userId: user.id, name: user.name, color: access.color },
	};
}

import { createFileRoute } from "@tanstack/react-router";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/db.server";
import { nodes } from "@/db/schema";
import { GOOGLE_PLACE_ID_RE } from "@/features/places/lib/providers";
import { googlePhotoUri } from "@/features/places/server/providers.server";
import { can } from "@/lib/auth/roles";
import { isId } from "@/lib/ids";
import { getTripAccess } from "@/server/authz/access.server";
import { loadSession } from "@/server/authz/session.server";
import { rateLimit } from "@/server/cache.server";
import { getEnv } from "@/server/env.server";

/**
 * `GET /api/places/photo?nodeId=&idx=&w=` and `?tripId=&placeId=&idx=&w=`
 * (SPEC §13.3): looks up a Google photo NAME on the server and 302s to its
 * short-lived `photoUri`. Photo names never reach the client; the client only
 * ever sends a node id or a place id plus an index.
 *
 * - `nodeId`: any viewer of the node's trip (V).
 * - `tripId` + `placeId`: previews of places not saved yet, so it needs the
 *   `searchPlaces` capability (E): a viewer gets 403.
 * Without a Google key every request is a 404.
 */
const plain = (status: number, body: string) =>
	new Response(body, {
		status,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "private, no-store",
		},
	});

export const Route = createFileRoute("/api/places/photo/$")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const sp = url.searchParams;
				const idx = Number(sp.get("idx") ?? "0");
				const w = Number(sp.get("w") ?? "800");
				if (!Number.isInteger(idx) || idx < 0 || idx > 9)
					return plain(400, "Bad idx");
				if (!Number.isFinite(w) || w < 32 || w > 4000)
					return plain(400, "Bad w");
				const session = await loadSession(request.headers);
				if (!session) return plain(401, "Unauthorized");
				const user = session.user;

				let placeId: string | null = null;
				const nodeId = sp.get("nodeId");
				if (nodeId) {
					if (!isId(nodeId)) return plain(400, "Bad nodeId");
					const [row] = await db
						.select({ tripId: nodes.tripId, placeId: nodes.googlePlaceId })
						.from(nodes)
						.where(and(eq(nodes.id, nodeId), isNull(nodes.deletedAt)));
					if (!row) return plain(404, "Not found");
					const access = await getTripAccess(row.tripId, user);
					if (!access || !can(access, "read")) return plain(404, "Not found");
					placeId = row.placeId;
				} else {
					const tripId = sp.get("tripId");
					const pid = sp.get("placeId");
					if (!tripId || !isId(tripId) || !pid)
						return plain(400, "Bad request");
					const access = await getTripAccess(tripId, user);
					if (!access) return plain(404, "Not found");
					if (!can(access, "searchPlaces")) return plain(403, "Forbidden");
					placeId = pid;
				}
				if (!placeId || !GOOGLE_PLACE_ID_RE.test(placeId))
					return plain(404, "Not found");
				if (!getEnv().GOOGLE_MAPS_API_KEY) return plain(404, "Not found");
				try {
					await rateLimit(`places:photo:${user.id}`, 120);
				} catch {
					return plain(429, "Too many requests");
				}
				let uri: string | null = null;
				try {
					uri = await googlePhotoUri(placeId, idx, w);
				} catch {
					return plain(502, "Photo unavailable");
				}
				if (!uri) return plain(404, "Not found");
				return new Response(null, {
					status: 302,
					headers: {
						Location: uri,
						"Cache-Control": "private, max-age=3000",
						"Referrer-Policy": "no-referrer",
					},
				});
			},
		},
	},
});

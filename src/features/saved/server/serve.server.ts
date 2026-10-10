/**
 * `GET /api/saved/<id>/image|favicon`: a saved link's re-hosted picture, for
 * its owner only (anything else is 404; ids reveal nothing). Streamed from
 * the bucket like attachments' `image`.
 */
import { db } from "@/db/db.server";
import { streamObject } from "@/features/media/server/storage.server";
import { loadSession } from "@/server/authz/session.server";
import { savedObjectKey } from "./saved.server";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () =>
	new Response("Not found", {
		status: 404,
		headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
	});

export async function serveSaved(
	request: Request,
	id: string,
	variant: string,
): Promise<Response> {
	if (!UUID_RE.test(id) || (variant !== "image" && variant !== "favicon"))
		return notFound();
	const session = await loadSession(request.headers);
	if (!session) return notFound();
	const key = await savedObjectKey(db, session.user.id, id, variant);
	const obj = key ? await streamObject(key) : null;
	if (!obj) return notFound();
	return new Response(obj.body, {
		status: 200,
		headers: {
			"Content-Type": "image/webp",
			"Cache-Control": "private, max-age=86400",
			Vary: "Cookie",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox",
			"Cross-Origin-Resource-Policy": "same-origin",
			...(obj.size !== null ? { "Content-Length": String(obj.size) } : {}),
			...(obj.etag ? { ETag: obj.etag } : {}),
		},
	});
}

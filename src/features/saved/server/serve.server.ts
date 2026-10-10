/**
 * `GET /api/saved/<id>/image|favicon`: a saved link's re-hosted picture;
 * `GET /api/saved-file/<id>/thumb|display|poster|original`: a saved photo or
 * video. For their owner only (anything else is 404; ids reveal nothing).
 * Pictures stream from the bucket like attachments' `thumb`; `original`
 * answers 302 to a short-lived presigned GET (video seeking needs Range).
 */
import { db } from "@/db/db.server";
import {
	GET_WINDOW_SEC,
	presignGet,
	streamObject,
} from "@/features/media/server/storage.server";
import { loadSession } from "@/server/authz/session.server";
import { ownFile } from "./files.server";
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
	return key ? stream(key) : notFound();
}

const FILE_VARIANTS: Record<string, string> = {
	thumb: "thumb.webp",
	display: "display.webp",
	poster: "poster.jpg",
};

export async function serveSavedFile(
	request: Request,
	id: string,
	variant: string,
): Promise<Response> {
	if (!UUID_RE.test(id) || (variant !== "original" && !FILE_VARIANTS[variant]))
		return notFound();
	const session = await loadSession(request.headers);
	if (!session) return notFound();
	const f = await ownFile(session.user.id, id);
	if (!f || f.status === "pending" || f.status === "failed") return notFound();
	if (variant !== "original")
		return stream(
			`${f.storageKey}${FILE_VARIANTS[variant]}`,
			variant === "poster" ? "image/jpeg" : "image/webp",
		);
	const url = await presignGet(`${f.storageKey}original`, {
		contentType: f.mime,
		disposition: "inline",
	});
	return new Response(null, {
		status: 302,
		headers: {
			Location: url,
			"Cache-Control": `private, max-age=${GET_WINDOW_SEC}`,
			"Referrer-Policy": "no-referrer",
		},
	});
}

async function stream(key: string, type = "image/webp"): Promise<Response> {
	const obj = await streamObject(key);
	if (!obj) return notFound();
	return new Response(obj.body, {
		status: 200,
		headers: {
			"Content-Type": type,
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

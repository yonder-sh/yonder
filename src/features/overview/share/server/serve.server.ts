/**
 * `GET /t/$trip/share-card.png?size=story|square` (docs/OVERVIEW.md
 * §Sharing): the trip's share card as a PNG, for anyone who can see the trip
 * (members, and link guests through their guest session). It's drawn from
 * the graph that session is allowed to read (`loadTripGraph`: redacted for
 * guests), so the card never shows more than the trip page does.
 *
 * No session, an unknown slug, a deleted trip or no access: 404 (a slug never
 * reveals that a trip exists). `Cache-Control: private, max-age=60` and an
 * ETag from the card's inputs (`cardFingerprint`) plus the size and the
 * design's version: an unchanged route answers 304 without drawing. Recent
 * renders are kept in memory, keyed by that ETag.
 */
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/db.server";
import { trips } from "@/db/schema";
import { getTripAccess } from "@/server/authz/access.server";
import { loadSession } from "@/server/authz/session.server";
import { TripSlug } from "@/server/cores/trips.server";
import { loadTripGraph } from "@/server/graph.server";
import { cardFingerprint, shareCardData } from "../card/card-data";
import type { CardSize } from "../card/card-svg";
import { renderShareCardPng } from "./render.server";

/** Bump when the picture changes for the same inputs (a design change). */
export const CARD_DESIGN_VERSION = 1;
const MAX_AGE_SEC = 60;
const CACHE_ENTRIES = 24;

const cache = new Map<string, Buffer>();

const notFound = () =>
	new Response("Not found", {
		status: 404,
		headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
	});

export function cardSize(param: string | null): CardSize | null {
	if (param === null || param === "" || param === "story") return "story";
	if (param === "square") return "square";
	return null;
}

export async function serveShareCard(
	request: Request,
	slug: string,
): Promise<Response> {
	const size = cardSize(new URL(request.url).searchParams.get("size"));
	if (!size)
		return new Response("size must be story or square", {
			status: 400,
			headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
		});
	if (!TripSlug.safeParse(slug).success) return notFound();
	const session = await loadSession(request.headers);
	if (!session) return notFound();
	const [trip] = await db
		.select({ id: trips.id })
		.from(trips)
		.where(and(eq(trips.slug, slug), isNull(trips.deletedAt)))
		.limit(1);
	if (!trip) return notFound();
	const access = await getTripAccess(trip.id, session.user);
	if (!access) return notFound();
	const graph = await loadTripGraph(trip.id, { ...access, user: session.user });
	if (!graph) return notFound();

	const data = shareCardData(graph);
	const etag = `"sc${CARD_DESIGN_VERSION}-${createHash("sha256")
		.update(`${size}\n${cardFingerprint(data)}`)
		.digest("base64url")
		.slice(0, 22)}"`;
	const headers = {
		"Cache-Control": `private, max-age=${MAX_AGE_SEC}`,
		ETag: etag,
		Vary: "Cookie",
		"X-Content-Type-Options": "nosniff",
	};
	const match = request.headers.get("if-none-match");
	if (match?.split(",").some((t) => t.trim() === etag))
		return new Response(null, { status: 304, headers });

	let png = cache.get(etag);
	if (png) {
		cache.delete(etag);
	} else {
		png = await renderShareCardPng(data, size);
		if (cache.size >= CACHE_ENTRIES) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
	}
	cache.set(etag, png);
	return new Response(new Uint8Array(png), {
		status: 200,
		headers: {
			...headers,
			"Content-Type": "image/png",
			"Content-Length": String(png.length),
			"Content-Disposition": `inline; filename="${slug}-${size}.png"`,
		},
	});
}

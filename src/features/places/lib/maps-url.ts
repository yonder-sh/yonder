/**
 * `parseMapsUrl` (EXTENSIONS §10, E8): what a shared Google Maps URL names.
 * Pure. Handles `query_place_id` / `place_id:`, `/maps/place/<name>/@lat,lng`,
 * the `!3d<lat>!4d<lng>` data blob, `?q=lat,lng`, `?q=<text>`, and flags the
 * short links (`maps.app.goo.gl`, `goo.gl/maps`) the server must follow.
 * Anything that isn't a Google Maps URL is `null`.
 */

export type ParsedMapsUrl =
	| { kind: "short"; url: string }
	| {
			kind: "place";
			placeId?: string;
			name?: string;
			lat?: number;
			lng?: number;
			/** Free text to search for (`?q=Itoya Ginza`). */
			query?: string;
	  };

const GOOGLE_HOST =
	/^(?:www\.|maps\.)?google\.(?:com|[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/i;

/** Hosts whose redirects `resolveSharedLink` may follow (and nothing else). */
export function isGoogleMapsHost(host: string, path = "/"): boolean {
	const h = host.toLowerCase();
	if (h === "maps.app.goo.gl") return true;
	if (h === "goo.gl") return path.startsWith("/maps");
	if (!GOOGLE_HOST.test(h)) return false;
	return h.startsWith("maps.") || path.startsWith("/maps");
}

function num(s: string | undefined | null): number | undefined {
	if (s == null || s.trim() === "") return undefined;
	const n = Number(s);
	return Number.isFinite(n) ? n : undefined;
}

function validLatLng(lat?: number, lng?: number): boolean {
	return (
		lat !== undefined &&
		lng !== undefined &&
		Math.abs(lat) <= 90 &&
		Math.abs(lng) <= 180
	);
}

// Up to 3 integer digits on both sides; `validLatLng` then drops impossible pairs.
const LATLNG = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;

function decodeSegment(s: string): string {
	try {
		return decodeURIComponent(s.replace(/\+/g, " ")).trim();
	} catch {
		return s.replace(/\+/g, " ").trim();
	}
}

export function parseMapsUrl(raw: string): ParsedMapsUrl | null {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (!isGoogleMapsHost(url.hostname, url.pathname)) return null;
	const host = url.hostname.toLowerCase();
	if (host === "maps.app.goo.gl" || host === "goo.gl")
		return { kind: "short", url: url.toString() };

	const out: Extract<ParsedMapsUrl, { kind: "place" }> = { kind: "place" };
	const sp = url.searchParams;

	// Place ids: ?query_place_id=, ?q=place_id:…, ?place_id=
	const qpid = sp.get("query_place_id") ?? sp.get("place_id");
	const q = sp.get("q") ?? sp.get("query") ?? undefined;
	if (qpid && PLACE_ID.test(qpid)) out.placeId = qpid;
	else if (q?.startsWith("place_id:")) {
		const id = q.slice("place_id:".length);
		if (PLACE_ID.test(id)) out.placeId = id;
	}

	// /maps/place/<name>/@lat,lng,zoom/data=…!3d<lat>!4d<lng>
	const path = url.pathname;
	const place = /\/maps\/place\/([^/]+)/.exec(path);
	if (place?.[1]) {
		const name = decodeSegment(place[1]);
		if (LATLNG.test(name)) {
			const m = LATLNG.exec(name);
			out.lat = num(m?.[1]);
			out.lng = num(m?.[2]);
		} else if (name) out.name = name;
	}
	const data = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(
		decodeSegment(path + url.search),
	);
	if (data) {
		out.lat = num(data[1]);
		out.lng = num(data[2]);
	} else {
		const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(path);
		if (at && out.lat === undefined) {
			out.lat = num(at[1]);
			out.lng = num(at[2]);
		}
	}

	// ?q=lat,lng or ?q=<text>
	if (q && !q.startsWith("place_id:")) {
		const m = LATLNG.exec(q);
		if (m) {
			if (out.lat === undefined) {
				out.lat = num(m[1]);
				out.lng = num(m[2]);
			}
		} else if (!out.name) out.query = q.trim().slice(0, 200);
	}
	// /maps/search/<text>
	const search = /\/maps\/search\/([^/]+)/.exec(path);
	if (search?.[1] && !out.name && !out.query) {
		const text = decodeSegment(search[1]);
		const m = LATLNG.exec(text);
		if (m) {
			out.lat ??= num(m[1]);
			out.lng ??= num(m[2]);
		} else out.query = text.slice(0, 200);
	}

	if (!validLatLng(out.lat, out.lng)) {
		delete out.lat;
		delete out.lng;
	}
	if (!out.placeId && !out.name && !out.query && out.lat === undefined)
		return null;
	return out;
}

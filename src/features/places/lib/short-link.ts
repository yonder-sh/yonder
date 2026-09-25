/**
 * Follows a Google Maps short link (`maps.app.goo.gl/…`) to the URL that
 * names the place (EXTENSIONS §10): `redirect: 'manual'`, at most 3 hops,
 * only `Location` is read (never a body), and every hop must be a Google Maps
 * host over https, so the fetch can never be steered at another server.
 * `fetchImpl` is injectable for tests.
 */
import { isGoogleMapsHost, parseMapsUrl } from "./maps-url";

export const MAX_HOPS = 3;

export async function expandShortLink(
	start: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	let url = start;
	for (let hop = 0; hop <= MAX_HOPS; hop++) {
		let u: URL;
		try {
			u = new URL(url);
		} catch {
			return null;
		}
		if (u.protocol !== "https:" || !isGoogleMapsHost(u.hostname, u.pathname))
			return null;
		const parsed = parseMapsUrl(url);
		if (parsed?.kind === "place") return url;
		if (hop === MAX_HOPS) return null;
		let res: Response;
		try {
			res = await fetchImpl(url, {
				method: "GET",
				redirect: "manual",
				signal: AbortSignal.timeout(6_000),
				headers: { "User-Agent": "Mozilla/5.0 (compatible; Yonder)" },
			});
		} catch {
			return null;
		}
		await res.body?.cancel().catch(() => undefined);
		const loc = res.headers.get("location");
		if (res.status < 300 || res.status >= 400 || !loc) return null;
		try {
			url = new URL(loc, url).toString();
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * OpenStreetMap references and links (client-safe, pure). `nodes.osm_ref`
 * holds `N123` / `W45` / `R6` (older rows may carry Photon's `osm:` prefix).
 */

const REF_RE = /^(?:osm:)?([NWR])(\d{1,15})$/i;
const KIND = { N: "node", W: "way", R: "relation" } as const;

/** `N123` from `N123` / `osm:N123` (any case); null when it isn't an OSM ref. */
export function parseOsmRef(raw: string | null | undefined): string | null {
	const m = REF_RE.exec(raw?.trim() ?? "");
	if (!m?.[1] || !m[2]) return null;
	return `${m[1].toUpperCase()}${m[2]}`;
}

/** `https://www.openstreetmap.org/node/123` for `N123`; null for anything else. */
export function osmObjectUrl(raw: string | null | undefined): string | null {
	const ref = parseOsmRef(raw);
	if (!ref) return null;
	const kind = KIND[ref[0] as keyof typeof KIND];
	return `https://www.openstreetmap.org/${kind}/${ref.slice(1)}`;
}

/** ODbL attribution (openstreetmap.org/copyright asks for exactly this). */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
export const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

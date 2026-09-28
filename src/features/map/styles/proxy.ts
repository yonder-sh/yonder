import type { StyleSpecification } from "maplibre-gl";

/**
 * e2e only: VITE_MAP_PROXY_URL (`pnpm e2e:fast` sets it) sends the basemap's
 * requests — OpenFreeMap's TileJSON, tiles and glyphs, Esri's imagery — to a
 * local cache (e2e/stubs/map-proxy.mjs) instead of the internet:
 * `https://tiles.openfreemap.org/<path>` → `<proxy>/ofm/<path>`,
 * `https://server.arcgisonline.com/<path>` → `<proxy>/arcgis/<path>`.
 * Unset (everywhere else), styles keep their real URLs.
 */
const UPSTREAMS: readonly (readonly [string, string])[] = [
	["https://tiles.openfreemap.org/", "ofm/"],
	["https://server.arcgisonline.com/", "arcgis/"],
];

export function proxiedStyle(
	style: StyleSpecification,
	proxy: string | undefined = import.meta.env.VITE_MAP_PROXY_URL,
): StyleSpecification {
	if (!proxy) return style;
	const base = proxy.endsWith("/") ? proxy : `${proxy}/`;
	const swap = (u: string) => {
		for (const [from, to] of UPSTREAMS)
			if (u.startsWith(from)) return base + to + u.slice(from.length);
		return u;
	};
	const out = structuredClone(style);
	if (out.glyphs) out.glyphs = swap(out.glyphs);
	if (typeof out.sprite === "string") out.sprite = swap(out.sprite);
	for (const src of Object.values(out.sources)) {
		const s = src as { url?: string; tiles?: string[] };
		if (s.url) s.url = swap(s.url);
		if (s.tiles) s.tiles = s.tiles.map(swap);
	}
	return out;
}

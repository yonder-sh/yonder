/**
 * QA ERR-06: when basemap tiles can't load (blocked, offline, the tile host
 * down), the map keeps its pins and lines on the plain background and says
 * "Map tiles couldn't load" instead of sitting there blank. Pure; MapCanvas
 * feeds it MapLibre's `error` and `sourcedata` events.
 */

export type TileHealth = {
	/** Basemap failures since the last tile that loaded. */
	failures: number;
	down: boolean;
};

export const TILES_OK: TileHealth = { failures: 0, down: false };

/** Failed tiles in a row before the map says so (one flaky tile isn't "down"). */
export const TILES_DOWN_AFTER = 3;

export type MapErrorEventLike = {
	error?: { message?: string; status?: number; name?: string } | null;
	sourceId?: string;
	tile?: unknown;
};

/** An aborted request (a pan, a style swap, leaving the page) is no failure. */
export function isAbortError(
	err: MapErrorEventLike["error"] | undefined,
): boolean {
	return err?.name === "AbortError" || /\baborted\b/i.test(err?.message ?? "");
}

/** A network-ish failure MapLibre reports (expected offline; not a bug to log). */
export function isNetworkError(
	err: MapErrorEventLike["error"] | undefined,
): boolean {
	return (
		isAbortError(err) ||
		err?.status !== undefined ||
		/Failed to fetch|NetworkError|AJAXError|Load failed/i.test(
			err?.message ?? "",
		)
	);
}

/**
 * The next health after an `error` event. Only the basemap's own sources
 * count (not the app's GeoJSON layers, not glyphs). A failed source (its
 * TileJSON, no `tile`) means no tiles at all: down at once.
 */
export function tileHealthOnError(
	h: TileHealth,
	e: MapErrorEventLike,
	basemapSources: ReadonlySet<string>,
): TileHealth {
	if (!e.sourceId || !basemapSources.has(e.sourceId)) return h;
	if (h.down || isAbortError(e.error)) return h;
	const failures = h.failures + 1;
	const down = failures >= TILES_DOWN_AFTER || !e.tile;
	return { failures, down };
}

/** The next health after a `sourcedata` event: a basemap tile that loads clears it. */
export function tileHealthOnData(
	h: TileHealth,
	e: { sourceId?: string; tile?: unknown },
	basemapSources: ReadonlySet<string>,
): TileHealth {
	if (!e.tile || !e.sourceId || !basemapSources.has(e.sourceId)) return h;
	return h.failures === 0 && !h.down ? h : TILES_OK;
}

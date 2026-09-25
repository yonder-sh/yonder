/**
 * QA ERR-06: blocked basemap tiles make the map say "Map tiles couldn't load";
 * aborted requests, the app's own sources and one flaky tile don't.
 */
import { describe, expect, it } from "vitest";
import {
	isNetworkError,
	TILES_DOWN_AFTER,
	TILES_OK,
	tileHealthOnData,
	tileHealthOnError,
} from "../tile-health";

const BASEMAP = new Set(["openmaptiles"]);
const failed = {
	sourceId: "openmaptiles",
	tile: {},
	error: { name: "AJAXError", status: 0, message: "Failed to fetch" },
};

describe("tile health", () => {
	it("goes down after a few failed tiles in a row, and a loaded tile clears it", () => {
		let h = TILES_OK;
		for (let i = 1; i < TILES_DOWN_AFTER; i++) {
			h = tileHealthOnError(h, failed, BASEMAP);
			expect(h.down).toBe(false);
		}
		h = tileHealthOnError(h, failed, BASEMAP);
		expect(h.down).toBe(true);
		// Unchanged while down (no re-render per failed tile).
		expect(tileHealthOnError(h, failed, BASEMAP)).toBe(h);
		h = tileHealthOnData(h, { sourceId: "openmaptiles", tile: {} }, BASEMAP);
		expect(h).toEqual(TILES_OK);
	});

	it("is down at once when the basemap source itself can't load", () => {
		const h = tileHealthOnError(
			TILES_OK,
			{ ...failed, tile: undefined },
			BASEMAP,
		);
		expect(h.down).toBe(true);
	});

	it("ignores aborts, the app's own sources and glyphs", () => {
		const abort = { ...failed, error: { name: "AbortError", message: "" } };
		expect(tileHealthOnError(TILES_OK, abort, BASEMAP)).toBe(TILES_OK);
		expect(
			tileHealthOnError(TILES_OK, { ...failed, sourceId: "edges" }, BASEMAP),
		).toBe(TILES_OK);
		expect(
			tileHealthOnError(TILES_OK, { ...failed, sourceId: undefined }, BASEMAP),
		).toBe(TILES_OK);
		// Metadata events and the app's sources never clear or set anything.
		expect(
			tileHealthOnData(TILES_OK, { sourceId: "openmaptiles" }, BASEMAP),
		).toBe(TILES_OK);
	});

	it("tells network failures (not logged) from real errors", () => {
		expect(isNetworkError(failed.error)).toBe(true);
		expect(isNetworkError({ name: "AbortError" })).toBe(true);
		expect(isNetworkError({ message: "Unknown projection name" })).toBe(false);
	});
});

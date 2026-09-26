/** A chunk from an older build that fails to load reloads the page, once a minute at most. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldReload, watchStaleChunks } from "../stale-build";

describe("shouldReload", () => {
	it("reloads online when it hasn't lately", () => {
		expect(shouldReload(null, 1_000_000, true)).toBe(true);
		expect(shouldReload(1_000_000 - 60_000, 1_000_000, true)).toBe(true);
	});
	it("not twice in a minute, and never offline", () => {
		expect(shouldReload(1_000_000 - 5_000, 1_000_000, true)).toBe(false);
		expect(shouldReload(null, 1_000_000, false)).toBe(false);
	});
});

describe("watchStaleChunks", () => {
	afterEach(() => {
		sessionStorage.clear();
		vi.restoreAllMocks();
	});

	it("a failed chunk reloads the page, and a second one right after doesn't", () => {
		const reload = vi
			.spyOn(window.location, "reload")
			.mockImplementation(() => {});
		const off = watchStaleChunks();
		window.dispatchEvent(new Event("vite:preloadError"));
		window.dispatchEvent(new Event("vite:preloadError"));
		off();
		window.dispatchEvent(new Event("vite:preloadError"));
		expect(reload).toHaveBeenCalledTimes(1);
	});
});

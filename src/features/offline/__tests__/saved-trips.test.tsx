/**
 * QA PWA-08 (R-SEC-1): a fresh `listMyTrips` answer drops the offline copy
 * of every saved trip the account lost while away, and a trip page that
 * answered "no access" drops the shell the worker kept for it (happy-dom
 * localStorage; Cache Storage is a stand-in where a test needs it, and
 * IndexedDB removals are no-ops).
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { myTripsQuery } from "@/features/home/queries";
import { BRAND } from "@/lib/brand";
import { tripKeys } from "@/lib/query/keys";
import {
	forgetLostTrips,
	isNetworkFailure,
	readSavedTrips,
	removeTripPageOffline,
} from "../saved-trips";

vi.mock("@/features/home/dashboard.functions", () => ({
	listMyTrips: vi.fn(async () => [{ id: "t2" }]),
	listMyDeadlines: vi.fn(async () => []),
}));

const save = (list: object[]) =>
	localStorage.setItem(BRAND.storage.savedTrips, JSON.stringify(list));

afterEach(() => {
	localStorage.clear();
	vi.unstubAllGlobals();
});

/** A Cache Storage stand-in: one cache per name, keyed by URL (search ignored). */
function fakeCaches(initial: Record<string, string[]>) {
	const store = new Map(
		Object.entries(initial).map(([k, v]) => [k, new Set(v)] as const),
	);
	const bare = (u: string) => u.split("?")[0] ?? u;
	const api = {
		open: vi.fn(async (name: string) => {
			const set = store.get(name) ?? new Set<string>();
			store.set(name, set);
			return {
				delete: vi.fn(async (req: string) => set.delete(bare(req))),
			};
		}),
		delete: vi.fn(async (name: string) => store.delete(name)),
	};
	vi.stubGlobal("caches", api);
	return { keys: (name: string) => [...(store.get(name) ?? [])], api };
}

describe("forgetLostTrips (PWA-08)", () => {
	it("drops a saved trip the server no longer lists, at once", async () => {
		save([{ slug: "asia", tripId: "t1", name: "Asia", savedAt: 1000 }]);
		const { dropped, done } = forgetLostTrips(["t2"], 5000);
		expect(dropped).toEqual(["t1"]);
		// The index is rewritten before anything async: offline.html and the
		// dashboard's cold-start redirect no longer see it.
		expect(readSavedTrips()).toEqual([]);
		await done;
	});

	it("keeps trips still listed, and one saved while the list was in flight", async () => {
		save([
			{ slug: "asia", tripId: "t1", name: "Asia", savedAt: 1000 },
			{ slug: "new", tripId: "t3", name: "New", savedAt: 6000 },
		]);
		const { dropped, done } = forgetLostTrips(["t1"], 5000);
		await done;
		expect(dropped).toEqual([]);
		expect(readSavedTrips().map((t) => t.tripId)).toEqual(["t1", "t3"]);
	});

	it("judges entries without a saved time as old", async () => {
		save([{ slug: "old", tripId: "t9", name: "Old" }]);
		const { dropped, done } = forgetLostTrips([], Date.now());
		await done;
		expect(dropped).toEqual(["t9"]);
	});
});

describe("myTripsQuery (the dashboard's list)", () => {
	it("a fetched list purges the lost saved trip and its in-memory queries", async () => {
		save([{ slug: "asia", tripId: "t1", name: "Asia", savedAt: 1000 }]);
		const client = new QueryClient();
		client.setQueryData(tripKeys.graph("t1"), { stale: true });
		await client.fetchQuery(myTripsQuery());
		expect(readSavedTrips()).toEqual([]);
		expect(client.getQueryData(tripKeys.graph("t1"))).toBeUndefined();
		client.clear();
	});
});

describe("removeTripPageOffline (PWA-08 / LINK-04: a no-access visit)", () => {
	const origin = () => window.location.origin;

	it("drops the page shell the worker kept even when the index no longer lists the slug", async () => {
		// The dashboard already purged the saved copy; then the trip URL was
		// opened online and answered "no access" (the shell is a 200).
		const c = fakeCaches({
			pages: [`${origin()}/share`, `${origin()}/`, `${origin()}/t/asia`],
		});
		await removeTripPageOffline("asia");
		expect(c.keys("pages")).toEqual([`${origin()}/share`, `${origin()}/`]);
		expect(readSavedTrips()).toEqual([]);
	});

	it("drops the saved copy too when the index still lists it", async () => {
		save([
			{ slug: "asia", tripId: "t1", name: "Asia", savedAt: 1000 },
			{ slug: "other", tripId: "t2", name: "Other", savedAt: 900 },
		]);
		const c = fakeCaches({
			pages: [`${origin()}/t/asia`, `${origin()}/t/other`],
			"yonder-docs-t1": [],
		});
		await removeTripPageOffline("asia");
		expect(readSavedTrips().map((t) => t.tripId)).toEqual(["t2"]);
		expect(c.keys("pages")).toEqual([`${origin()}/t/other`]);
		expect(c.api.delete).toHaveBeenCalledWith("yonder-docs-t1");
	});

	it("never throws without Cache Storage", async () => {
		vi.stubGlobal("caches", undefined);
		await expect(removeTripPageOffline("asia")).resolves.toBeUndefined();
		await expect(removeTripPageOffline("")).resolves.toBeUndefined();
	});
});

describe("isNetworkFailure", () => {
	it("is a fetch that never reached the server, or the browser offline", () => {
		expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
		expect(
			isNetworkFailure(
				new TypeError("NetworkError when attempting to fetch resource."),
			),
		).toBe(true);
		expect(isNetworkFailure(new TypeError("Load failed"))).toBe(true);
		// Server answers and bugs are not.
		expect(isNetworkFailure(new Error("NOT_FOUND"))).toBe(false);
		expect(isNetworkFailure(new TypeError("x is not a function"))).toBe(false);
		vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
		try {
			expect(isNetworkFailure(new Error("anything"))).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});
});

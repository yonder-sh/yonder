import { describe, expect, it } from "vitest";
import {
	backoffMs,
	type CachedTag,
	fetchOsmOpeningHours,
	memoryPace,
	OVERPASS_ATTEMPTS,
	OVERPASS_BATCH,
	type OverpassDeps,
	OverpassError,
	overpassQuery,
	retryAfterMs,
} from "./overpass.server";

type Sent = { at: number; ids: string[]; body: string; headers: Headers };

/**
 * A fake Overpass (no network) on a fake clock: `sleep` moves the clock, so
 * the pace is measured, not waited for. `answers` are consumed in order; by
 * default every requested object exists with `opening_hours: "<ref> hours"`.
 */
function harness(
	opts: {
		answers?: (Response | Error | "echo")[];
		cached?: Record<string, CachedTag>;
		tags?: Record<string, string | undefined>;
	} = {},
) {
	let clock = 0;
	const sent: Sent[] = [];
	const cache = new Map(Object.entries(opts.cached ?? {}));
	const writes: [string, CachedTag][] = [];
	const answers = [...(opts.answers ?? [])];
	const echo = (ids: string[]) =>
		Response.json({
			elements: ids.map((ref) => ({
				type: { N: "node", W: "way", R: "relation" }[ref[0] as "N"],
				id: Number(ref.slice(1)),
				tags:
					opts.tags && ref in opts.tags
						? opts.tags[ref] === undefined
							? { name: "no hours" }
							: { opening_hours: opts.tags[ref] }
						: { opening_hours: `${ref} hours` },
			})),
		});
	const deps: OverpassDeps = {
		url: "https://overpass.test/api/interpreter",
		userAgent: "Yonder/1.0 (+ops@example.com)",
		pace: memoryPace(() => clock),
		sleep: async (ms) => {
			clock += ms;
		},
		cache: {
			get: async (ref) => cache.get(ref) ?? null,
			set: async (ref, v) => {
				cache.set(ref, v);
				writes.push([ref, v]);
			},
		},
		fetch: async (_url, init) => {
			const body = String(init?.body ?? "");
			const q = new URLSearchParams(body).get("data") ?? "";
			const ids = [...q.matchAll(/(node|way|rel)\(id:([\d,]+)\)/g)].flatMap(
				(m) =>
					(m[2] ?? "")
						.split(",")
						.map(
							(id) =>
								`${{ node: "N", way: "W", rel: "R" }[m[1] as "node"]}${id}`,
						),
			);
			sent.push({ at: clock, ids, body, headers: new Headers(init?.headers) });
			const next = answers.shift() ?? "echo";
			if (next instanceof Error) throw next;
			return next === "echo" ? echo(ids) : next;
		},
	};
	return { deps, sent, writes, cache, now: () => clock };
}

describe("overpassQuery", () => {
	it("asks for the tags of every object type in one query", () => {
		expect(overpassQuery(["N1", "N2", "W3", "R4"])).toBe(
			"[out:json][timeout:25];(node(id:1,2);way(id:3);rel(id:4););out tags;",
		);
		expect(overpassQuery(["W9"])).toBe(
			"[out:json][timeout:25];(way(id:9););out tags;",
		);
	});
});

describe("fetchOsmOpeningHours: batching and caching", () => {
	it("batches up to OVERPASS_BATCH ids per request and maps every ref", async () => {
		const refs = Array.from({ length: 250 }, (_, i) => `N${i + 1}`);
		const { deps, sent } = harness();
		const tags = await fetchOsmOpeningHours(refs, deps);
		expect(sent.map((s) => s.ids.length)).toEqual([
			OVERPASS_BATCH,
			OVERPASS_BATCH,
			50,
		]);
		expect(new Set(sent.flatMap((s) => s.ids)).size).toBe(250);
		expect(tags.size).toBe(250);
		expect(tags.get("N250")).toBe("N250 hours");
	});

	it("normalises refs, drops junk and duplicates, and mixes object types", async () => {
		const { deps, sent } = harness({ tags: { W7: undefined } });
		const tags = await fetchOsmOpeningHours(
			["osm:N5", "N5", "w7", "R8", "ChIJxyz", ""],
			deps,
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.ids.sort()).toEqual(["N5", "R8", "W7"]);
		// No tag, and gone from OSM (not in the answer): both null.
		expect(Object.fromEntries(tags)).toEqual({
			N5: "N5 hours",
			W7: null,
			R8: "R8 hours",
		});
	});

	it("an object missing from the answer (deleted) has no hours", async () => {
		const { deps } = harness({
			answers: [
				Response.json({
					elements: [{ type: "node", id: 1, tags: { opening_hours: "24/7" } }],
				}),
			],
		});
		const tags = await fetchOsmOpeningHours(["N1", "N2"], deps);
		expect(Object.fromEntries(tags)).toEqual({ N1: "24/7", N2: null });
	});

	it("answers from the cache first and caches what it fetched, 'no tag' included", async () => {
		const { deps, sent, writes } = harness({
			cached: { N1: { tag: "Mo-Fr 09:00-18:00" }, N2: { tag: null } },
			tags: { W3: undefined },
		});
		const tags = await fetchOsmOpeningHours(["N1", "N2", "N4", "W3"], deps);
		expect(sent.map((s) => s.ids.sort())).toEqual([["N4", "W3"]]);
		expect(Object.fromEntries(tags)).toEqual({
			N1: "Mo-Fr 09:00-18:00",
			N2: null,
			N4: "N4 hours",
			W3: null,
		});
		expect(writes).toEqual([
			["N4", { tag: "N4 hours" }],
			["W3", { tag: null }],
		]);
		// Everything cached: no request at all.
		const again = harness({ cached: Object.fromEntries(writes) });
		await fetchOsmOpeningHours(["N4", "W3"], again.deps);
		expect(again.sent).toEqual([]);
	});

	it("identifies itself and POSTs the query as a form", async () => {
		const { deps, sent } = harness();
		await fetchOsmOpeningHours(["N1"], deps);
		expect(sent[0]?.headers.get("user-agent")).toBe(
			"Yonder/1.0 (+ops@example.com)",
		);
		expect(sent[0]?.headers.get("content-type")).toBe(
			"application/x-www-form-urlencoded",
		);
		expect(sent[0]?.body.startsWith("data=")).toBe(true);
	});
});

describe("pacing and back-off", () => {
	it("sends at most one request per second", async () => {
		const refs = Array.from({ length: 4 * OVERPASS_BATCH }, (_, i) => `N${i}`);
		const { deps, sent } = harness();
		await fetchOsmOpeningHours(refs, deps);
		expect(sent.map((s) => s.at)).toEqual([0, 1000, 2000, 3000]);
	});

	it("shares the pace: two jobs at once on one store still go one per second", async () => {
		const { deps, sent } = harness();
		await Promise.all([
			fetchOsmOpeningHours(["N1"], deps),
			fetchOsmOpeningHours(["N2"], deps),
		]);
		expect(sent.map((s) => s.at)).toEqual([0, 1000]);
	});

	it("backs off on 429 (Retry-After) and 504 (doubling), then succeeds", async () => {
		const { deps, sent } = harness({
			answers: [
				new Response("busy", {
					status: 429,
					headers: { "Retry-After": "7" },
				}),
				new Response("timeout", { status: 504 }),
				"echo",
			],
		});
		const tags = await fetchOsmOpeningHours(["N1"], deps);
		expect(tags.get("N1")).toBe("N1 hours");
		// 0: refused (Retry-After 7 s) → 7000: 504, attempt 2 → 5 s × 2 → 17000.
		expect(sent.map((s) => s.at)).toEqual([0, 7000, 17000]);
	});

	it("retries network errors, and gives up after OVERPASS_ATTEMPTS", async () => {
		const { deps, sent, writes } = harness({
			answers: [
				new TypeError("fetch failed"),
				...Array.from(
					{ length: OVERPASS_ATTEMPTS },
					() => new Response("", { status: 503 }),
				),
			],
		});
		await expect(fetchOsmOpeningHours(["N1"], deps)).rejects.toThrow(
			OverpassError,
		);
		expect(sent).toHaveLength(OVERPASS_ATTEMPTS);
		expect(writes).toEqual([]);
	});

	it("a runtime-error remark or another status is an error, never 'no hours'", async () => {
		const remark = harness({
			answers: [
				Response.json({
					elements: [],
					remark: 'runtime error: Query timed out in "query" at line 1',
				}),
			],
		});
		await expect(fetchOsmOpeningHours(["N1"], remark.deps)).rejects.toThrow(
			/timed out/,
		);
		expect(remark.writes).toEqual([]);

		const bad = harness({ answers: [new Response("", { status: 400 })] });
		await expect(fetchOsmOpeningHours(["N1"], bad.deps)).rejects.toThrow(
			"Overpass answered 400",
		);
		expect(bad.sent).toHaveLength(1);
	});

	it("reads Retry-After as seconds or a date, and caps the back-off", () => {
		expect(retryAfterMs("12")).toBe(12_000);
		expect(
			retryAfterMs("Thu, 01 Jan 2026 00:00:30 GMT", Date.UTC(2026, 0, 1)),
		).toBe(30_000);
		expect(retryAfterMs(null)).toBeNull();
		expect(retryAfterMs("soon")).toBeNull();
		expect([0, 1, 2, 3, 10].map((a) => backoffMs(a, null))).toEqual([
			5000, 10_000, 20_000, 40_000, 120_000,
		]);
		expect(backoffMs(0, 3_600_000)).toBe(120_000);
		expect(backoffMs(0, 0)).toBe(1000);
	});

	it("memoryPace hands out slots a second apart and honours a deferral", async () => {
		let t = 0;
		const pace = memoryPace(() => t);
		expect(await pace.reserve(1000)).toBe(0);
		expect(await pace.reserve(1000)).toBe(1000);
		expect(await pace.reserve(1000)).toBe(2000);
		t = 10_000;
		expect(await pace.reserve(1000)).toBe(0);
		await pace.defer(30_000);
		expect(await pace.reserve(1000)).toBe(30_000);
	});
});

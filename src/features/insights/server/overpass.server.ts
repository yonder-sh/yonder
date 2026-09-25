/**
 * The Overpass API client behind OSM opening hours (E1, WP-Insights): the
 * `opening_hours` tag of many OSM objects per request (`out tags` of an id
 * list, up to OVERPASS_BATCH ids), from a fixed, env-configured host
 * (`OVERPASS_URL`; ids come from `nodes.osm_ref`, never from a URL), with
 * the usage policy's manners:
 *
 * - at most one request per second across every process (a slot reserved in
 *   Redis; a process-local pace when Redis is down);
 * - 429 / 503 / 504 and network errors push that slot back for everyone
 *   (`Retry-After`, else 5 s doubling up to 2 min) and retry, 4 attempts;
 * - an identifying User-Agent with `OSM_CONTACT` (`osmUserAgent`, required in
 *   production), a 60 s timeout, no redirects, a 5 MB cap;
 * - answers cached in Redis for 3 days per object, "no tag" included, so a
 *   place in several trips (or a duplicated trip) costs one lookup.
 *
 * A 200 whose `remark` reports a runtime error (Overpass times out or runs
 * out of memory mid-answer) is an error, never "these objects have no hours".
 */
import { getEnv, osmUserAgent } from "@/server/env.server";
import { key, redis } from "@/server/live/redis.server";
import { parseOsmRef } from "../osm-link";

/** Object ids per Overpass request. */
export const OVERPASS_BATCH = 100;
/** The polite pace: one request per second, whatever the number of workers. */
export const OVERPASS_GAP_MS = 1_000;
export const OVERPASS_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 120_000;
const TIMEOUT_MS = 60_000;
const MAX_BODY = 5_000_000;
export const OVERPASS_CACHE_TTL_S = 3 * 24 * 3600;

export type PaceStore = {
	/** Reserves the next request slot: how long to wait for it (ms). */
	reserve(gapMs: number): Promise<number>;
	/** No one may send before now + `ms` (after a 429/504). */
	defer(ms: number): Promise<void>;
};

/** A cached answer: the tag, or null when the object has none (or is gone). */
export type CachedTag = { tag: string | null };

export type OverpassDeps = {
	fetch: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	pace: PaceStore;
	cache: {
		get(ref: string): Promise<CachedTag | null>;
		set(ref: string, value: CachedTag): Promise<void>;
	};
	url: string;
	userAgent: string;
	log?: (msg: string) => void;
};

export class OverpassError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "OverpassError";
	}
}

/** The Overpass QL for some refs (`N1`, `W2`, `R3`): their tags only. */
export function overpassQuery(refs: readonly string[]): string {
	const ids: Record<"N" | "W" | "R", string[]> = { N: [], W: [], R: [] };
	for (const ref of refs) ids[ref[0] as "N" | "W" | "R"]?.push(ref.slice(1));
	const sets = [
		ids.N.length ? `node(id:${ids.N.join(",")});` : "",
		ids.W.length ? `way(id:${ids.W.join(",")});` : "",
		ids.R.length ? `rel(id:${ids.R.join(",")});` : "",
	].join("");
	return `[out:json][timeout:25];(${sets});out tags;`;
}

/** `Retry-After` (seconds or an HTTP date) in ms; null when absent or unreadable. */
export function retryAfterMs(
	value: string | null,
	now = Date.now(),
): number | null {
	if (!value) return null;
	const s = Number(value);
	if (Number.isFinite(s)) return Math.max(0, s * 1000);
	const at = Date.parse(value);
	return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** How long everyone waits after the `attempt`-th refusal (0-based). */
export function backoffMs(attempt: number, retryAfter: number | null): number {
	if (retryAfter !== null)
		return Math.min(BACKOFF_MAX_MS, Math.max(OVERPASS_GAP_MS, retryAfter));
	return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

type OverpassBody = {
	elements?: { type?: string; id?: number; tags?: Record<string, string> }[];
	remark?: string;
};

const TYPE_LETTER: Record<string, string> = {
	node: "N",
	way: "W",
	relation: "R",
};

/** One request (with its retries) for ≤ OVERPASS_BATCH refs → ref → tag. */
async function queryBatch(
	refs: readonly string[],
	deps: OverpassDeps,
): Promise<Map<string, string | null>> {
	const body = new URLSearchParams({ data: overpassQuery(refs) }).toString();
	let last = "";
	for (let attempt = 0; attempt < OVERPASS_ATTEMPTS; attempt++) {
		const wait = await deps.pace.reserve(OVERPASS_GAP_MS);
		if (wait > 0) await deps.sleep(wait);
		let res: Response;
		try {
			res = await deps.fetch(deps.url, {
				method: "POST",
				headers: {
					"User-Agent": deps.userAgent,
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body,
				redirect: "error",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (e) {
			last = e instanceof Error ? e.name : "network error";
			await deps.pace.defer(backoffMs(attempt, null));
			continue;
		}
		if (res.status === 429 || res.status === 503 || res.status === 504) {
			const ms = backoffMs(
				attempt,
				retryAfterMs(res.headers.get("retry-after")),
			);
			last = `HTTP ${res.status}`;
			deps.log?.(
				`overpass ${res.status}: backing off ${Math.round(ms / 1000)} s`,
			);
			await res.body?.cancel().catch(() => {});
			await deps.pace.defer(ms);
			continue;
		}
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			throw new OverpassError(`Overpass answered ${res.status}`, res.status);
		}
		const text = await res.text();
		if (text.length > MAX_BODY)
			throw new OverpassError("Overpass answer too large");
		let parsed: OverpassBody;
		try {
			parsed = JSON.parse(text) as OverpassBody;
		} catch {
			throw new OverpassError("Overpass answer is not JSON");
		}
		// A runtime error mid-answer: the elements are incomplete.
		if (parsed.remark && /error/i.test(parsed.remark))
			throw new OverpassError(`Overpass: ${parsed.remark.slice(0, 160)}`);
		const out = new Map<string, string | null>(refs.map((r) => [r, null]));
		for (const el of parsed.elements ?? []) {
			const letter = TYPE_LETTER[el.type ?? ""];
			if (!letter || !Number.isSafeInteger(el.id)) continue;
			const ref = `${letter}${el.id}`;
			if (!out.has(ref)) continue;
			const tag = el.tags?.opening_hours;
			out.set(ref, typeof tag === "string" && tag.trim() ? tag : null);
		}
		return out;
	}
	throw new OverpassError(`Overpass is busy (${last})`);
}

/**
 * The `opening_hours` tag of each OSM object (`N123`, `osm:W45`…): cached
 * answers first, the rest in batched, paced Overpass requests. Objects
 * without the tag, or gone from OSM, map to null; invalid refs are left out.
 * Throws `OverpassError` when Overpass keeps refusing (the job retries).
 */
export async function fetchOsmOpeningHours(
	rawRefs: readonly string[],
	deps: OverpassDeps = overpassDeps(),
): Promise<Map<string, string | null>> {
	const refs = [
		...new Set(
			rawRefs.map((r) => parseOsmRef(r)).filter((r): r is string => !!r),
		),
	];
	const out = new Map<string, string | null>();
	const cached = await Promise.all(refs.map((r) => deps.cache.get(r)));
	const missing: string[] = [];
	refs.forEach((ref, i) => {
		const hit = cached[i];
		if (hit) out.set(ref, hit.tag);
		else missing.push(ref);
	});
	for (let i = 0; i < missing.length; i += OVERPASS_BATCH) {
		const batch = missing.slice(i, i + OVERPASS_BATCH);
		const found = await queryBatch(batch, deps);
		for (const [ref, tag] of found) {
			out.set(ref, tag);
			await deps.cache.set(ref, { tag });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// The real dependencies
// ---------------------------------------------------------------------------

/** A process-local pace (tests, and the fallback when Redis is down). */
export function memoryPace(now: () => number = Date.now): PaceStore {
	let next = 0;
	return {
		async reserve(gapMs) {
			const t = now();
			const at = Math.max(t, next);
			next = at + gapMs;
			return at - t;
		},
		async defer(ms) {
			next = Math.max(next, now() + ms);
		},
	};
}

// The next free slot (epoch ms) lives in one key; reserving moves it on.
const RESERVE_LUA = `
local now = tonumber(ARGV[1])
local gap = tonumber(ARGV[2])
local nxt = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local at = math.max(now, nxt)
redis.call('SET', KEYS[1], string.format('%d', at + gap), 'PX', at - now + gap + 60000)
return at - now`;
const DEFER_LUA = `
local want = tonumber(ARGV[1]) + tonumber(ARGV[2])
local nxt = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
if want > nxt then
  redis.call('SET', KEYS[1], string.format('%d', want), 'PX', tonumber(ARGV[2]) + 60000)
end
return 0`;

/** The shared pace in Redis, falling back to this process's own on errors. */
export function redisPace(): PaceStore {
	const local = memoryPace();
	const slot = () => key("overpass", "next");
	return {
		async reserve(gapMs) {
			try {
				const wait = await redis().eval(
					RESERVE_LUA,
					1,
					slot(),
					Date.now(),
					gapMs,
				);
				return Math.max(0, Number(wait) || 0);
			} catch {
				return local.reserve(gapMs);
			}
		},
		async defer(ms) {
			await local.defer(ms);
			try {
				await redis().eval(DEFER_LUA, 1, slot(), Date.now(), Math.round(ms));
			} catch {
				// Redis down: this process still backs off.
			}
		},
	};
}

function redisTagCache(): OverpassDeps["cache"] {
	const k = (ref: string) => key("cache", "osm-hours", ref);
	return {
		async get(ref) {
			try {
				const raw = await redis().get(k(ref));
				if (raw === null) return null;
				const v = JSON.parse(raw) as CachedTag;
				return v && (typeof v.tag === "string" || v.tag === null) ? v : null;
			} catch {
				return null;
			}
		},
		async set(ref, value) {
			try {
				await redis().set(
					k(ref),
					JSON.stringify(value),
					"EX",
					OVERPASS_CACHE_TTL_S,
				);
			} catch {
				// A cache miss next time, nothing worse.
			}
		},
	};
}

export function overpassDeps(log?: (msg: string) => void): OverpassDeps {
	const env = getEnv();
	return {
		fetch: (input, init) => fetch(input, init),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		pace: redisPace(),
		cache: redisTagCache(),
		url: env.OVERPASS_URL,
		userAgent: osmUserAgent(env),
		...(log ? { log } : {}),
	};
}

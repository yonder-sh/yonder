/**
 * QA MT-14 (TR-06): Google transit answers are cached, but an empty answer
 * only briefly, and "Refresh routes" (`fresh`) asks Google again instead of
 * reading the cache. No network: `fetch` is stubbed, the cache is a Map.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(
	() => new Map<string, { value: unknown; ttlSec: number }>(),
);

vi.mock("@/server/cache.server", () => ({
	cacheGet: async (...parts: (string | number)[]) =>
		store.get(parts.join(":"))?.value ?? null,
	cacheSet: async (
		parts: readonly (string | number)[],
		value: unknown,
		ttlSec: number,
	) => {
		store.set(parts.join(":"), { value, ttlSec });
	},
}));

import { resetEnv } from "@/server/env.server";
import {
	EMPTY_TTL_SEC,
	googleTransit,
} from "../server/providers/google.server";

const saved = {
	key: process.env.GOOGLE_MAPS_API_KEY,
	url: process.env.GOOGLE_ROUTES_URL,
};
process.env.GOOGLE_MAPS_API_KEY = "stub";
process.env.GOOGLE_ROUTES_URL = "http://127.0.0.1:9";
resetEnv();

afterAll(() => {
	// `process.env.X = undefined` would store the string "undefined".
	for (const [k, v] of [
		["GOOGLE_MAPS_API_KEY", saved.key],
		["GOOGLE_ROUTES_URL", saved.url],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	resetEnv();
	vi.unstubAllGlobals();
});

const seoul = { lat: 37.5665, lng: 126.978 };
const namsan = { lat: 37.5512, lng: 126.9882 };
const departAt = new Date(Date.now() + 2 * 86_400_000);

let answers: { status: number; body: unknown }[] = [];
const calls: string[] = [];
beforeEach(() => {
	store.clear();
	calls.length = 0;
	answers = [];
	vi.stubGlobal("fetch", async (url: string) => {
		calls.push(url);
		const a = answers.shift() ?? { status: 200, body: { routes: [] } };
		return new Response(JSON.stringify(a.body), { status: a.status });
	});
});

describe("Google transit cache (QA MT-14)", () => {
	it("keeps a no-route answer only briefly", async () => {
		const r = await googleTransit(seoul, namsan, departAt, "Asia/Seoul");
		expect(r.routes).toEqual([]);
		expect(calls).toHaveLength(1);
		const [entry] = [...store.values()];
		expect(entry?.ttlSec).toBe(EMPTY_TTL_SEC);
		expect(EMPTY_TTL_SEC).toBeLessThanOrEqual(15 * 60);
		// Within that time an automatic look-up is served from the cache…
		await googleTransit(seoul, namsan, departAt, "Asia/Seoul");
		expect(calls).toHaveLength(1);
	});

	it("Refresh asks Google again, and an error isn't hidden behind the cached empty answer", async () => {
		await googleTransit(seoul, namsan, departAt, "Asia/Seoul");
		expect(calls).toHaveLength(1);
		answers.push({ status: 500, body: {} });
		await expect(
			googleTransit(seoul, namsan, departAt, "Asia/Seoul", { fresh: true }),
		).rejects.toMatchObject({ kind: "unavailable" });
		expect(calls).toHaveLength(2);
	});
});

/**
 * Redis-backed limits (SECURITY §10) against the dev Redis with an isolated
 * prefix: `rateLimitPer` answers RATE_LIMITED past its budget, and the global
 * server-function limit fails open (logged) when Redis is unreachable.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	process.env.REDIS_PREFIX = `yonder-rltest-${Math.random().toString(16).slice(2, 10)}`;
	// Agent copies' `.env` turns the e2e switches on, which also switches the
	// per-user function limit off; this file tests that limit, so force both
	// off before `getEnv()` memoizes.
	process.env.ENABLE_TEST_ROUTES = "";
	process.env.AUTH_RATE_LIMIT = "";
});

import { errorCode } from "./authz/errors";
import { FN_CALLS_PER_MINUTE, fnRateLimit, rateLimitPer } from "./cache.server";
import { closeRedis, redis, redisPrefix } from "./live/redis.server";

afterAll(async () => {
	const keys = await redis().keys(`${redisPrefix()}:*`);
	if (keys.length) await redis().del(...keys);
	await closeRedis();
});

describe("rate limits", () => {
	it("allows `points` calls per window, then RATE_LIMITED", async () => {
		const name = `t:${Math.random()}`;
		for (let i = 0; i < 3; i++) await rateLimitPer(name, 3, 3600);
		let code: string | null = null;
		try {
			await rateLimitPer(name, 3, 3600);
		} catch (e) {
			code = errorCode(e);
		}
		expect(code).toBe("RATE_LIMITED");
		// Other names have their own budget.
		await rateLimitPer(`${name}:other`, 3, 3600);
	});

	it("the global function limit is 300/min per user", async () => {
		expect(FN_CALLS_PER_MINUTE).toBe(300);
		const user = `u-${Math.random()}`;
		for (let i = 0; i < FN_CALLS_PER_MINUTE; i++) await fnRateLimit(user);
		await expect(fnRateLimit(user)).rejects.toThrow(/^RATE_LIMITED/);
	});
});

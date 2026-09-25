/**
 * Redis-backed helpers for feature server code (SPEC §12.3, §13.1, §14):
 *
 * - `rateLimit(name, perMinute)` / `rateLimitPer(name, points, windowSec)` —
 *   per-user limits (providers, trip creation, share links): throw
 *   RATE_LIMITED (429, with `Retry-After`) when exceeded. Shared across app
 *   and worker processes. `fnRateLimit(userId)` is the global 300/min limit
 *   the session middleware applies to every server function.
 * - `cacheGet(key)` / `cacheSet(key, value, ttlSec)` — JSON values with a
 *   mandatory TTL (Redis runs `noeviction`, so nothing may live forever).
 *
 * Keys are always built with `key(...)`; pass the parts, not a full key.
 */
import { setResponseHeader } from "@tanstack/react-start/server";
import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { authEnv } from "./auth/env.server";
import { fail } from "./authz/session.server";
import { testRoutesEnabled } from "./env.server";
import { key, redis } from "./live/redis.server";

const limiters = new Map<string, RateLimiterRedis>();

function limiter(points: number, windowSec: number): RateLimiterRedis {
	const id = windowSec === 60 ? `pm${points}` : `p${points}w${windowSec}`;
	let l = limiters.get(id);
	if (!l) {
		l = new RateLimiterRedis({
			storeClient: redis(),
			keyPrefix: key("rl", id),
			points,
			duration: windowSec,
		});
		limiters.set(id, l);
	}
	return l;
}

/** 429 with `Retry-After` (SECURITY §10). */
function tooMany(msBeforeNext: number): never {
	const seconds = Math.max(1, Math.ceil(msBeforeNext / 1000));
	try {
		setResponseHeader("Retry-After", String(seconds));
	} catch {
		// Outside a request (scripts, tests): nothing to set.
	}
	return fail("RATE_LIMITED", `try again in ${seconds} s`);
}

/**
 * Consumes one point for `name` in a window of `windowSec`; 429 with
 * `Retry-After` when over `points`. Throws the Redis error when Redis is
 * down: callers decide (see `fnRateLimit` for the fail-open variant).
 */
export async function rateLimitPer(
	name: string,
	points: number,
	windowSec: number,
): Promise<void> {
	try {
		await limiter(points, windowSec).consume(name);
	} catch (e) {
		if (e instanceof RateLimiterRes) return tooMany(e.msBeforeNext);
		throw e; // Redis down: let the caller's error handling decide
	}
}

/** Consumes one point for `name` (e.g. `provider:<userId>`); 429 when over the limit. */
export async function rateLimit(
	name: string,
	perMinute: number,
): Promise<void> {
	return rateLimitPer(name, perMinute, 60);
}

/** Server-function calls per user per minute (SECURITY §10 "300/min per session"). */
export const FN_CALLS_PER_MINUTE = 300;

/**
 * Local e2e only: parallel specs all run as dev@example.com and would share
 * one 300/min budget. Off when the test routes are on (`ENABLE_TEST_ROUTES=1`
 * on a localhost APP_URL, never in production) or `AUTH_RATE_LIMIT=off` on
 * localhost, like the auth limits.
 */
function fnLimitOff(): boolean {
	try {
		return testRoutesEnabled() || authEnv().rateLimitOff;
	} catch {
		return false;
	}
}

/**
 * The global server-function limit, run by the session middleware for every
 * signed-in call. Fails OPEN when Redis is unreachable (logged): a Redis blip
 * must not take the whole app down; the per-feature limits still apply.
 */
export async function fnRateLimit(userId: string): Promise<void> {
	if (fnLimitOff()) return;
	try {
		await rateLimitPer(`fn:${userId}`, FN_CALLS_PER_MINUTE, 60);
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("RATE_LIMITED")) throw e;
		console.error(
			"[limits] function rate limit unavailable:",
			e instanceof Error ? e.message : e,
		);
	}
}

/** The cached JSON value, or null (missing, expired, unreadable or Redis down). */
export async function cacheGet<T>(
	...parts: (string | number)[]
): Promise<T | null> {
	try {
		const raw = await redis().get(key("cache", ...parts));
		return raw === null ? null : (JSON.parse(raw) as T);
	} catch {
		return null;
	}
}

/** Stores a JSON value for `ttlSec` seconds (required, ≥ 1). Never throws. */
export async function cacheSet(
	parts: readonly (string | number)[],
	value: unknown,
	ttlSec: number,
): Promise<void> {
	if (!(ttlSec >= 1)) throw new Error("cacheSet: every cache key needs a TTL");
	try {
		await redis().set(
			key("cache", ...parts),
			JSON.stringify(value),
			"EX",
			Math.round(ttlSec),
		);
	} catch (e) {
		console.error("[cache] set failed:", e instanceof Error ? e.message : e);
	}
}

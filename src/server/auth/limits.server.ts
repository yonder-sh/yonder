import { createHash } from "node:crypto";
import {
	type RateLimiterAbstract,
	RateLimiterMemory,
	RateLimiterRedis,
	RateLimiterRes,
} from "rate-limiter-flexible";
import { key, redis } from "@/server/live/redis.server";
import { authEnv } from "./env.server";

/**
 * App-side limits that Better Auth's per-IP limiter can't express
 * (SECURITY §8 and §10), backed by Redis so they hold across instances:
 *
 * - OTP sends per email: 5 per hour and 20 per day. The cap is checked in
 *   the `before` hook of the send endpoint, BEFORE Better Auth generates and
 *   stores a code (a later check would still hand out 5 fresh attempts and
 *   silently invalidate the victim's real code). Over the cap the endpoint
 *   answers `{ success: true }` and sends nothing, so the cap can't be used
 *   to enumerate accounts and a victim can't be email-bombed.
 * - OTP verify failures per email: a 24 h failure counter (no block of its
 *   own) plus a SEPARATE 1 h lock key. The 11th failure in the window sets
 *   the lock, and every later failure in the same 24 h window sets it again.
 *   So an attacker gets 10 guesses, then at most one per hour: ≤ ~33 a day
 *   per email with rotating IPs (a single limiter with `blockDuration` would
 *   replace its 24 h window with the 1 h block and reset the count hourly).
 * - Non-member trip opens per IP: 30 per minute. Opening a trip's address
 *   (`/t/<slug>`) as a non-member is how its link is used, so this caps
 *   guessing addresses; over the cap the answer is the same not-found.
 *
 * Emails are hashed before they become Redis keys (no PII in the keyspace).
 * The limits are active in production builds unless AUTH_RATE_LIMIT=off on
 * localhost (e2e), matching Better Auth's own limiter (SPEC §11.1).
 */

export const LIMITS = {
	otpSendPerHour: 5,
	otpSendPerDay: 20,
	otpFailuresPerDay: 10,
	otpLockSeconds: 3600,
	tripOpensPerMinute: 30,
} as const;

/** Normalizes an email the way Better Auth does, plus trimming. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

const hashEmail = (email: string) =>
	createHash("sha256")
		.update(normalizeEmail(email))
		.digest("base64url")
		.slice(0, 32);

export interface AuthLimits {
	enabled: boolean;
	/** Consumes one send; false when the email is over its hourly or daily cap. */
	allowOtpSend(email: string): Promise<boolean>;
	/** Milliseconds left on this email's OTP lock (0 = not locked). */
	otpLockRemaining(email: string): Promise<number>;
	recordOtpFailure(email: string): Promise<void>;
	clearOtpFailures(email: string): Promise<void>;
	/** Consumes one non-member trip open for the IP; returns ms to wait, or 0 if allowed. */
	tripOpenRetryAfter(ip: string): Promise<number>;
}

type Factory = (o: {
	keyPrefix: string;
	points: number;
	duration: number;
}) => RateLimiterAbstract;

/** Builds the limiters on a store (Redis in the app, memory in tests). */
export function createAuthLimits(opts: {
	enabled: boolean;
	make: Factory;
}): AuthLimits {
	const { enabled, make } = opts;
	const sendHour = make({
		keyPrefix: "otp-send-h",
		points: LIMITS.otpSendPerHour,
		duration: 3600,
	});
	const sendDay = make({
		keyPrefix: "otp-send-d",
		points: LIMITS.otpSendPerDay,
		duration: 86_400,
	});
	// The 24 h window of failures. Never blocks by itself: `blockDuration` would
	// overwrite this key with a 1 h TTL and forget the count (see the header).
	const failures = make({
		keyPrefix: "otp-fail",
		points: LIMITS.otpFailuresPerDay,
		duration: 86_400,
	});
	// The lock, set with `.block()` for otpLockSeconds after each failure past the cap.
	const lock = make({
		keyPrefix: "otp-lock",
		points: 1,
		duration: LIMITS.otpLockSeconds,
	});
	const tripOpen = make({
		keyPrefix: "trip-open-ip",
		points: LIMITS.tripOpensPerMinute,
		duration: 60,
	});

	/** consume() rejects with a RateLimiterRes when over the limit; errors are real failures. */
	async function consumed(
		l: RateLimiterAbstract,
		key: string,
	): Promise<RateLimiterRes | null> {
		try {
			await l.consume(key);
			return null;
		} catch (e) {
			if (e instanceof RateLimiterRes) return e;
			throw e;
		}
	}

	return {
		enabled,
		async allowOtpSend(email) {
			if (!enabled) return true;
			const key = hashEmail(email);
			if (await consumed(sendHour, key)) return false;
			return !(await consumed(sendDay, key));
		},
		async otpLockRemaining(email) {
			if (!enabled) return 0;
			const res = await lock.get(hashEmail(email));
			// `.block()` stores points + 1, so a live lock reads as over the cap.
			return res && res.consumedPoints > 1 ? Math.max(res.msBeforeNext, 1) : 0;
		},
		async recordOtpFailure(email) {
			if (!enabled) return;
			const key = hashEmail(email);
			// Over the daily cap → (re-)lock for an hour. The counter keeps its own 24 h TTL.
			if (await consumed(failures, key))
				await lock.block(key, LIMITS.otpLockSeconds);
		},
		async clearOtpFailures(email) {
			if (!enabled) return;
			const key = hashEmail(email);
			await Promise.all([failures.delete(key), lock.delete(key)]);
		},
		async tripOpenRetryAfter(ip) {
			if (!enabled) return 0;
			const over = await consumed(tripOpen, ip || "unknown");
			return over ? Math.max(over.msBeforeNext, 1000) : 0;
		},
	};
}

let limits: AuthLimits | undefined;

/** The app's limiters on Redis (memory insurance if Redis hiccups). */
export function authLimits(): AuthLimits {
	if (!limits) {
		const env = authEnv();
		limits = createAuthLimits({
			enabled: env.isProduction && !env.rateLimitOff,
			make: ({ keyPrefix, ...o }) =>
				new RateLimiterRedis({
					...o,
					storeClient: redis(),
					keyPrefix: key("auth", keyPrefix),
					insuranceLimiter: new RateLimiterMemory({ ...o, keyPrefix }),
				}),
		});
	}
	return limits;
}

/** In-memory limiters, for tests. */
export function memoryAuthLimits(enabled = true): AuthLimits {
	return createAuthLimits({
		enabled,
		make: (o) => new RateLimiterMemory(o),
	});
}

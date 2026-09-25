import { redisStorage } from "@better-auth/redis-storage";
import type { BetterAuthOptions, SecondaryStorage } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { captcha } from "better-auth/plugins";
import { anonymous } from "better-auth/plugins/anonymous";
import { bearer } from "better-auth/plugins/bearer";
import { emailOTP } from "better-auth/plugins/email-otp";
import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import * as schema from "@/db/schema";
import { AUTH_BRAND } from "@/lib/auth/constants";
import { randomGuestName } from "@/lib/auth/names";
import { key, redis } from "@/server/live/redis.server";
import { claimInvites, migrateGuestToUser } from "./accounts.server";
import { announceUserChange } from "./announce-user.server";
import { maskEmail, otpEmail, sendMail } from "./email.server";
import { authEnv } from "./env.server";
import { type AuthLimits, authLimits, normalizeEmail } from "./limits.server";
import { applyUserCreate, applyUserUpdate, UserRuleError } from "./user-hooks";

/**
 * The shared Better Auth options (spikes/auth pattern, SPEC §10.3/§11.1),
 * exported as `authOptions` from `src/server/auth-options.ts`. The app
 * instance in `src/server/auth.server.ts` adds `tanstackStartCookies()` LAST;
 * any other Node process (the collab server, scripts) runs
 * `betterAuth(authOptions)` against the same DB, Redis and secret to validate
 * the same sessions (cookie or `Authorization: Bearer`).
 *
 * Sign-in is email OTP only: no passwords, magic links or OAuth (QA AUTH-09).
 * Guests are Better Auth anonymous users (SPEC D2).
 */

export const OTP = {
	length: 6,
	/** Seconds (SPEC §11.1). */
	expiresIn: 600,
	allowedAttempts: 5,
} as const;

/** Endpoints that must not exist for an OTP-only app (they 404). */
const DISABLED_PATHS = [
	"/sign-in/email",
	"/sign-up/email",
	"/request-password-reset",
	"/reset-password",
	"/change-password",
	"/set-password",
	"/change-email",
	"/delete-user",
	"/email-otp/request-password-reset",
	"/email-otp/reset-password",
	"/forget-password/email-otp",
	"/email-otp/request-email-change",
	"/email-otp/change-email",
];

const SEND_PATH = "/email-otp/send-verification-otp";
const VERIFY_PATH = "/sign-in/email-otp";

/**
 * Emails whose last OTP delivery failed, set by the sender and read by the
 * `after` hook of the same request, which turns the endpoint's `{ success }`
 * into a visible error (QA AUTH-14). Better Auth swallows sender errors.
 */
const failedSends = new Set<string>();

/** A Redis value that is a Better Auth session copy for `key` (its token). */
function isSessionCopy(key: string, value: unknown): boolean {
	try {
		const v = typeof value === "string" ? JSON.parse(value) : value;
		return (
			!!v &&
			typeof v === "object" &&
			(v as { session?: { token?: unknown } }).session?.token === key
		);
	} catch {
		return false;
	}
}

/**
 * Redis for sessions and rate limits, but OTP verification values stay in
 * Postgres (hashed): tests time-travel the `verification` row (QA TI-8), and
 * a Redis flush must not invalidate codes already sent.
 *
 * Postgres is the source of truth for sessions (SECURITY §1, QA ERR-07 and
 * AUTH-12): a Redis copy whose `session` row is gone (deleted by the QA hook,
 * incident response or a user purge) is dropped on read, so the session ends
 * on the next request instead of living on until its TTL.
 */
export function sessionsAndLimitsOnly(
	storage: SecondaryStorage,
	sessionInDb: (token: string) => Promise<boolean> = sessionRowExists,
): SecondaryStorage {
	const skip = (key: string) => key.startsWith("verification:");
	return {
		...storage,
		get: async (key) => {
			if (skip(key)) return null;
			const value = await storage.get(key);
			if (value && isSessionCopy(key, value) && !(await sessionInDb(key))) {
				await storage.delete(key);
				return null;
			}
			return value;
		},
		set: (key, value, ttl) =>
			skip(key) ? undefined : storage.set(key, value, ttl),
		delete: (key) => (skip(key) ? undefined : storage.delete(key)),
	};
}

async function sessionRowExists(token: string): Promise<boolean> {
	const res = await db.execute(
		sql`select 1 from "session" where token = ${token} limit 1`,
	);
	return res.rows.length > 0;
}

async function deliverOtp(
	email: string,
	otp: string,
	type: string,
): Promise<void> {
	const env = authEnv();
	// Other OTP types are refused, and the per-email send cap is enforced, by the
	// `before` hook: by the time this runs Better Auth has already stored the code.
	if (type !== "sign-in") return;
	// Machine-greppable dev line (ADDENDUM §3); never in production (SECURITY §12).
	if (!env.isProduction)
		console.log(`[auth] OTP type=${type} email=${email} code=${otp}`);
	try {
		await sendMail({
			to: email,
			...otpEmail({
				appName: env.APP_NAME,
				otp,
				expiresInMin: Math.round(OTP.expiresIn / 60),
			}),
			outboxMeta: { kind: "otp", type, otp },
		});
	} catch (e) {
		console.error(
			`[auth] OTP email to ${maskEmail(email)} failed:`,
			e instanceof Error ? e.message : e,
		);
		failedSends.add(normalizeEmail(email));
	}
}

function bodyEmail(body: unknown): string {
	const email = (body as { email?: unknown } | undefined)?.email;
	return typeof email === "string" ? normalizeEmail(email) : "";
}

function toApiError(e: unknown): never {
	if (e instanceof UserRuleError)
		throw new APIError("BAD_REQUEST", {
			message: e.message,
			code: "INVALID_NAME",
		});
	throw e;
}

/**
 * `limits` defaults to the app's Redis limiters; tests pass enabled in-memory
 * ones (`memoryAuthLimits()`) to exercise the caps outside production.
 */
export function buildAuthOptions(opts: { limits?: AuthLimits } = {}) {
	const env = authEnv();
	const limits = opts.limits ?? authLimits();

	return {
		appName: env.APP_NAME,
		baseURL: env.authOrigin,
		secret: env.BETTER_AUTH_SECRET,
		trustedOrigins: env.trustedOrigins,
		database: drizzleAdapter(db, { provider: "pg", schema }),
		secondaryStorage: sessionsAndLimitsOnly(
			redisStorage({ client: redis(), keyPrefix: `${key("ba")}:` }),
		),
		emailAndPassword: { enabled: false },
		disabledPaths: DISABLED_PATHS,
		user: {
			additionalFields: {
				// Required by the product, optional in the DB: OTP sign-in creates the
				// user before we know the name (spikes/auth gotcha 7). The onboarding
				// guard and `withNamedUser` enforce them.
				firstName: {
					type: "string",
					required: false,
					input: true,
					defaultValue: "",
				},
				lastName: {
					type: "string",
					required: false,
					input: true,
					defaultValue: "",
				},
				// ADDENDUM §12: a per-account storage quota override in bytes (null =
				// STORAGE_QUOTA_DEFAULT_GB). Set only by `set-quota`, never by the user.
				storageQuotaBytes: {
					type: "number",
					bigint: true,
					required: false,
					input: false,
					returned: false,
				},
			},
		},
		session: {
			// Sessions live in Redis (fast reads, shared by every process) AND in
			// Postgres, so a Redis flush doesn't sign everyone out.
			storeSessionInDatabase: true,
			// No cookie cache: with Redis a lookup costs well under a millisecond,
			// and a cached session cookie would keep answering for minutes after
			// sign-out or revocation (QA AUTH-12, SECURITY §1).
			cookieCache: { enabled: false },
		},
		verification: { storeInDatabase: true },
		rateLimit: {
			enabled: env.isProduction && !env.rateLimitOff,
			storage: "secondary-storage",
			window: 60,
			max: 100,
			customRules: {
				[SEND_PATH]: { window: 60, max: 5 },
				// Room for every allowed attempt (QA AUTH-06) before the IP limit.
				[VERIFY_PATH]: { window: 60, max: 10 },
				// SECURITY §2 caps link redemptions at 10/min per IP; a group on one
				// Wi-Fi or carrier NAT opening a real link together must get in
				// (QA HOME-13; SPEC §11.1 said 3). Guessing stays capped by both.
				"/sign-in/anonymous": { window: 60, max: 10 },
			},
		},
		advanced: {
			// A reverse proxy sets X-Forwarded-For; behind Cloudflare
			// (TRUST_CF_CONNECTING_IP=1) CF-Connecting-IP comes first.
			ipAddress: { ipAddressHeaders: env.ipAddressHeaders },
		},
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						try {
							return { data: applyUserCreate(user) };
						} catch (e) {
							toApiError(e);
						}
					},
				},
				update: {
					before: async (patch, ctx) => {
						const sessionUser = ctx?.context.session?.user as
							| { isAnonymous?: boolean | null }
							| undefined;
						try {
							return {
								data: applyUserUpdate(
									patch,
									sessionUser
										? {
												kind: "session",
												isAnonymous: sessionUser.isAnonymous === true,
											}
										: { kind: "internal" },
								),
							};
						} catch (e) {
							toApiError(e);
						}
					},
					// QA AUTH-15: a rename reaches other members' open trips live.
					after: async (user) => {
						try {
							await announceUserChange(user.id);
						} catch (e) {
							console.error("[auth] announcing a user update failed:", e);
						}
					},
				},
			},
			session: {
				create: {
					after: async (s) => {
						try {
							await claimInvites(s.userId);
						} catch (e) {
							console.error("[auth] claimInvites failed:", e);
						}
					},
				},
			},
		},
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path === SEND_PATH) {
					const type = (ctx.body as { type?: unknown } | undefined)?.type;
					if (type !== "sign-in")
						throw new APIError("BAD_REQUEST", {
							message: "Only sign-in codes are supported",
							code: "UNSUPPORTED_OTP_TYPE",
						});
					const email = bodyEmail(ctx.body);
					// The per-email send cap runs BEFORE Better Auth generates and stores a
					// code: past the cap no new code exists, so no fresh attempts are handed
					// out and the victim's real code stays valid. The answer is the same
					// `{ success: true }` as a real send, so the cap reveals nothing.
					if (email && !(await limits.allowOtpSend(email))) {
						console.warn(`[auth] OTP send cap reached for ${maskEmail(email)}`);
						return ctx.json({ success: true });
					}
					return { context: { body: { ...ctx.body, email } } };
				}
				if (ctx.path === VERIFY_PATH) {
					const email = bodyEmail(ctx.body);
					const lockedMs = await limits.otpLockRemaining(email);
					if (lockedMs > 0)
						throw new APIError(
							"TOO_MANY_REQUESTS",
							{
								message: "Too many incorrect codes. Try again later.",
								code: "OTP_LOCKED",
							},
							{ "X-Retry-After": String(Math.ceil(lockedMs / 1000)) },
						);
					return { context: { body: { ...ctx.body, email } } };
				}
			}),
			after: createAuthMiddleware(async (ctx) => {
				if (ctx.path === SEND_PATH) {
					if (failedSends.delete(bodyEmail(ctx.body)))
						throw new APIError("SERVICE_UNAVAILABLE", {
							message: "We couldn't send the code. Try again.",
							code: "EMAIL_SEND_FAILED",
						});
					return;
				}
				if (ctx.path === VERIFY_PATH) {
					const email = bodyEmail(ctx.body);
					const returned = ctx.context.returned;
					const code =
						returned instanceof APIError ? returned.body?.code : undefined;
					if (code === "INVALID_OTP" || code === "TOO_MANY_ATTEMPTS")
						await limits.recordOtpFailure(email);
					else if (!(returned instanceof Error))
						await limits.clearOtpFailures(email);
					return;
				}
				if (ctx.path === "/sign-out") {
					// Shared devices (SECURITY §11): the browser drops caches, storage and
					// the service worker for this origin. The client also wipes explicitly.
					ctx.setHeader("Clear-Site-Data", '"cache", "storage"');
				}
			}),
		},
		plugins: [
			emailOTP({
				otpLength: OTP.length,
				expiresIn: OTP.expiresIn,
				allowedAttempts: OTP.allowedAttempts,
				storeOTP: "hashed",
				disableSignUp: false, // identical response for every email (no enumeration)
				...(env.DEV_FIXED_OTP ? { generateOTP: () => env.DEV_FIXED_OTP } : {}),
				// Awaited (no backgroundTasks handler) so a failed send can be reported
				// (QA AUTH-14). Every email takes the same path, so the wait reveals
				// nothing about whether an account exists.
				sendVerificationOTP: ({ email, otp, type }) =>
					deliverOtp(email, otp, type),
			}),
			anonymous({
				emailDomainName: AUTH_BRAND.guestEmailDomain,
				generateName: () => randomGuestName(),
				onLinkAccount: async ({ anonymousUser, newUser }) => {
					await migrateGuestToUser(anonymousUser.user.id, newUser.user.id);
				},
			}),
			// `Authorization: Bearer <session token>` for the collab socket and
			// non-browser clients (ADDENDUM §3).
			bearer(),
			// Cloudflare Turnstile on the endpoint that SENDS a code (sign-in and
			// sign-up are the same step), only when both keys are set. The token
			// travels in `x-captcha-response`.
			...(env.turnstile
				? [
						captcha({
							provider: "cloudflare-turnstile",
							secretKey: env.turnstile.secretKey,
							endpoints: [SEND_PATH],
						}),
					]
				: []),
		],
	} satisfies BetterAuthOptions;
}

export type AuthOptions = ReturnType<typeof buildAuthOptions>;

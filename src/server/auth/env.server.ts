import { z } from "zod";

/**
 * The auth layer's slice of `process.env` (names from SPEC §5.1; Redis
 * settings belong to `src/server/live/env.server.ts`). Parsed once, lazily,
 * and memoized.
 *
 * Safety rails (SPEC §5.1): the test/dev escape hatches `DEV_FIXED_OTP`,
 * `AUTH_RATE_LIMIT=off` and `EMAIL_OUTBOX_DIR` are refused unless
 * BETTER_AUTH_URL is on localhost/127.0.0.1 (`DEV_FIXED_OTP` always in
 * production), and production refuses to run without a real
 * BETTER_AUTH_SECRET (SECURITY §8) or an email transport
 * (`emailTransportProblem`, checked at start-up by the app).
 *
 * Cloudflare Turnstile guards the OTP send when BOTH TURNSTILE_SITE_KEY and
 * TURNSTILE_SECRET_KEY are set (read at runtime: one image serves every
 * environment). TRUST_CF_CONNECTING_IP=1 (behind Cloudflare, whose
 * `CF-Connecting-IP` can't be forged past an origin that only accepts
 * Cloudflare) makes it the client IP for rate limits, ahead of
 * `X-Forwarded-For`.
 */
const blankToUndefined = (v: unknown) =>
	typeof v === "string" && v.trim() === "" ? undefined : v;
const optionalString = z.preprocess(blankToUndefined, z.string().optional());

const Schema = z.object({
	NODE_ENV: z.string().default("development"),
	APP_NAME: z.preprocess(blankToUndefined, z.string().default("Yonder")),
	APP_URL: z.preprocess(
		blankToUndefined,
		z.url().default("http://localhost:3000"),
	),
	BETTER_AUTH_URL: z.preprocess(blankToUndefined, z.url().optional()),
	BETTER_AUTH_SECRET: optionalString,
	TRUSTED_ORIGINS: z.preprocess(blankToUndefined, z.string().default("")),
	DEV_FIXED_OTP: z.preprocess(
		blankToUndefined,
		z
			.string()
			.regex(/^\d{6}$/, "DEV_FIXED_OTP must be 6 digits")
			.optional(),
	),
	AUTH_RATE_LIMIT: optionalString,
	EMAIL_FROM: z.preprocess(
		blankToUndefined,
		z.string().default("Yonder <trips@localhost>"),
	),
	RESEND_API_KEY: optionalString,
	SMTP_HOST: optionalString,
	SMTP_PORT: z.preprocess(
		blankToUndefined,
		z.coerce.number().int().default(587),
	),
	SMTP_SECURE: z.preprocess(
		blankToUndefined,
		z
			.enum(["true", "false", "1", "0"])
			.default("false")
			.transform((v) => v === "true" || v === "1"),
	),
	SMTP_USER: optionalString,
	SMTP_PASSWORD: optionalString,
	EMAIL_OUTBOX_DIR: optionalString,
	TURNSTILE_SITE_KEY: optionalString,
	TURNSTILE_SECRET_KEY: optionalString,
	TRUST_CF_CONNECTING_IP: z.preprocess(
		blankToUndefined,
		z
			.enum(["true", "false", "1", "0"])
			.default("false")
			.transform((v) => v === "true" || v === "1"),
	),
});

export type AuthEnv = z.output<typeof Schema> & {
	/** Origin Better Auth runs on (BETTER_AUTH_URL, else APP_URL). */
	authOrigin: string;
	/** BETTER_AUTH_URL's hostname is localhost or 127.0.0.1. */
	isLocal: boolean;
	isProduction: boolean;
	/** AUTH_RATE_LIMIT=off, honoured only on localhost (e2e against a prod build). */
	rateLimitOff: boolean;
	trustedOrigins: string[];
	/** Turnstile on the OTP send: both keys set, else null (no widget, no check). */
	turnstile: { siteKey: string; secretKey: string } | null;
	/** Where Better Auth reads the client IP from, in order. */
	ipAddressHeaders: string[];
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Parses an env record (exported for tests; the app uses `authEnv()`). */
export function parseAuthEnv(
	source: Record<string, string | undefined>,
): AuthEnv {
	const env = Schema.parse(source);
	const authUrl = new URL(env.BETTER_AUTH_URL ?? env.APP_URL);
	const isLocal = LOCAL_HOSTS.has(authUrl.hostname);
	const isProduction = env.NODE_ENV === "production";

	if (!isLocal) {
		const hatches = [
			env.DEV_FIXED_OTP && "DEV_FIXED_OTP",
			env.AUTH_RATE_LIMIT === "off" && "AUTH_RATE_LIMIT=off",
			env.EMAIL_OUTBOX_DIR && "EMAIL_OUTBOX_DIR",
		].filter(Boolean);
		if (hatches.length > 0)
			throw new Error(
				`[auth] ${hatches.join(", ")} set while BETTER_AUTH_URL (${authUrl.origin}) is not localhost`,
			);
	}
	if (isProduction && env.DEV_FIXED_OTP)
		throw new Error("[auth] DEV_FIXED_OTP is set in production");
	if (
		isProduction &&
		(!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
	)
		throw new Error(
			"[auth] BETTER_AUTH_SECRET (32+ chars) is required in production",
		);
	if (!env.TURNSTILE_SITE_KEY !== !env.TURNSTILE_SECRET_KEY)
		console.warn(
			"[auth] Turnstile is off: set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY",
		);

	return {
		...env,
		authOrigin: authUrl.origin,
		isLocal,
		isProduction,
		rateLimitOff: isLocal && env.AUTH_RATE_LIMIT === "off",
		trustedOrigins: env.TRUSTED_ORIGINS.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		turnstile:
			env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY
				? {
						siteKey: env.TURNSTILE_SITE_KEY,
						secretKey: env.TURNSTILE_SECRET_KEY,
					}
				: null,
		ipAddressHeaders: env.TRUST_CF_CONNECTING_IP
			? ["cf-connecting-ip", "x-forwarded-for"]
			: ["x-forwarded-for"],
	};
}

/**
 * Why sign-in codes can't be delivered, or null: production needs Resend
 * (RESEND_API_KEY) or SMTP (SMTP_HOST); the JSON outbox (localhost only)
 * counts for a production build under test.
 */
export function emailTransportProblem(env: AuthEnv): string | null {
	if (!env.isProduction) return null;
	if (env.RESEND_API_KEY || env.SMTP_HOST || env.EMAIL_OUTBOX_DIR) return null;
	return "[auth] no email transport in production: set RESEND_API_KEY (with EMAIL_FROM) or SMTP_HOST";
}

let cached: AuthEnv | undefined;

/** The parsed auth env (memoized). Throws on unsafe combinations. */
export function authEnv(): AuthEnv {
	cached ??= parseAuthEnv(process.env);
	return cached;
}

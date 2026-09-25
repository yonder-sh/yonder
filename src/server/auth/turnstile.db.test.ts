/**
 * Cloudflare Turnstile on the OTP send (Better Auth's captcha plugin), with
 * Cloudflare's documented test keys against the real siteverify endpoint
 * (needs the network): the always-pass secret accepts the test widgets'
 * dummy token, the always-fail secret refuses it, a send without a token is
 * refused, and only the send endpoint is gated (verifying a code is not).
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
import { betterAuth } from "better-auth";
import { captcha } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const PASS_SECRET = "1x0000000000000000000000000000000AA";
const FAIL_SECRET = "2x0000000000000000000000000000000AA";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_captcha_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-captchatest-${hex}`;
	process.env.BETTER_AUTH_URL = "http://localhost:3000";
	process.env.APP_URL = "http://localhost:3000";
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	process.env.DEV_FIXED_OTP = "";
	process.env.TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
	process.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
	return { hex, scratchUrl: scratch.toString() };
});

import { closeDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { memoryAuthLimits } from "./limits.server";
import { buildAuthOptions } from "./options.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
	const keys = await redis().keys(`${redisPrefix()}:*`);
	if (keys.length) await redis().del(...keys);
	await closeRedis();
	await closeDb();
	await dropDatabase(testEnv.scratchUrl);
});

type Handler = { handler: (r: Request) => Promise<Response> };

function post(
	auth: Handler,
	path: string,
	body: unknown,
	token?: string,
): Promise<Response> {
	return auth.handler(
		new Request(`http://localhost:3000/api/auth${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
				...(token ? { "x-captcha-response": token } : {}),
			},
			body: JSON.stringify(body),
		}),
	);
}

const send = (auth: Handler, email: string, token?: string) =>
	post(
		auth,
		"/email-otp/send-verification-otp",
		{ email, type: "sign-in" },
		token,
	);

describe("Turnstile on the OTP send (test keys)", () => {
	const options = () => buildAuthOptions({ limits: memoryAuthLimits() });

	it("is wired when both keys are set, on the send endpoint only", () => {
		expect(options().plugins.map((p) => p.id)).toContain("captcha");
	});

	it("the always-pass secret accepts the test token; no token is refused", async () => {
		const auth = betterAuth(options());
		const ok = await send(
			auth,
			`pass-${testEnv.hex}@asia2027.test`,
			DUMMY_TOKEN,
		);
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ success: true });
		const missing = await send(auth, `none-${testEnv.hex}@asia2027.test`);
		expect(missing.status).toBe(400);
		expect(await missing.json()).toMatchObject({ code: "MISSING_RESPONSE" });
	});

	it("the always-fail secret refuses the token", async () => {
		const base = options();
		const auth = betterAuth({
			...base,
			plugins: [
				...base.plugins.filter((p) => p.id !== "captcha"),
				captcha({
					provider: "cloudflare-turnstile",
					secretKey: FAIL_SECRET,
					endpoints: ["/email-otp/send-verification-otp"],
				}),
			],
		});
		const res = await send(
			auth,
			`fail-${testEnv.hex}@asia2027.test`,
			DUMMY_TOKEN,
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "VERIFICATION_FAILED" });
	});

	it("checking a code needs no token", async () => {
		const auth = betterAuth(options());
		const res = await post(auth, "/sign-in/email-otp", {
			email: `verify-${testEnv.hex}@asia2027.test`,
			otp: "123456",
		});
		const body = (await res.json()) as { code?: string };
		expect(body.code).not.toBe("MISSING_RESPONSE");
		expect(res.status).not.toBe(403);
	});

	it("uses the pass secret from the environment", () => {
		expect(process.env.TURNSTILE_SECRET_KEY).toBe(PASS_SECRET);
	});
});

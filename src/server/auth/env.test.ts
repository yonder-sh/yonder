import { getIP } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import { emailTransportProblem, parseAuthEnv } from "./env.server";

const SECRET = "s".repeat(43);

describe("parseAuthEnv (SPEC §5.1 safety rails)", () => {
	it("defaults to localhost dev", () => {
		const env = parseAuthEnv({});
		expect(env.isLocal).toBe(true);
		expect(env.authOrigin).toBe("http://localhost:3000");
		expect(env.rateLimitOff).toBe(false);
		expect(env.trustedOrigins).toEqual([]);
	});

	it("allows the test hatches on localhost", () => {
		const env = parseAuthEnv({
			BETTER_AUTH_URL: "http://127.0.0.1:5102",
			DEV_FIXED_OTP: "000000",
			AUTH_RATE_LIMIT: "off",
			EMAIL_OUTBOX_DIR: ".data/outbox",
			TRUSTED_ORIGINS: "http://192.168.1.20:3000, ,http://10.0.0.2:3000",
		});
		expect(env.DEV_FIXED_OTP).toBe("000000");
		expect(env.rateLimitOff).toBe(true);
		expect(env.trustedOrigins).toEqual([
			"http://192.168.1.20:3000",
			"http://10.0.0.2:3000",
		]);
	});

	it.each([
		[{ DEV_FIXED_OTP: "000000" }, "DEV_FIXED_OTP"],
		[{ AUTH_RATE_LIMIT: "off" }, "AUTH_RATE_LIMIT=off"],
		[{ EMAIL_OUTBOX_DIR: "/tmp/outbox" }, "EMAIL_OUTBOX_DIR"],
	])("refuses %j outside localhost", (extra, name) => {
		expect(() =>
			parseAuthEnv({
				BETTER_AUTH_URL: "https://yonder.example",
				BETTER_AUTH_SECRET: SECRET,
				...extra,
			}),
		).toThrow(name);
	});

	it("requires a real secret in production", () => {
		expect(() =>
			parseAuthEnv({
				NODE_ENV: "production",
				BETTER_AUTH_URL: "https://yonder.example",
			}),
		).toThrow("BETTER_AUTH_SECRET");
		expect(() =>
			parseAuthEnv({
				NODE_ENV: "production",
				BETTER_AUTH_URL: "https://yonder.example",
				BETTER_AUTH_SECRET: "short",
			}),
		).toThrow("BETTER_AUTH_SECRET");
		const env = parseAuthEnv({
			NODE_ENV: "production",
			BETTER_AUTH_URL: "https://yonder.example",
			BETTER_AUTH_SECRET: SECRET,
		});
		expect(env.isProduction).toBe(true);
		expect(env.isLocal).toBe(false);
	});

	it("ignores AUTH_RATE_LIMIT=off only as a value, and treats blanks as unset", () => {
		expect(parseAuthEnv({ AUTH_RATE_LIMIT: "on" }).rateLimitOff).toBe(false);
		expect(
			parseAuthEnv({ DEV_FIXED_OTP: "   " }).DEV_FIXED_OTP,
		).toBeUndefined();
		expect(() => parseAuthEnv({ DEV_FIXED_OTP: "12345" })).toThrow();
	});
});

describe("production start-up rails", () => {
	const prod = {
		NODE_ENV: "production",
		BETTER_AUTH_URL: "https://yonder.sh",
		BETTER_AUTH_SECRET: SECRET,
	};

	it("refuses DEV_FIXED_OTP in production, even on localhost", () => {
		expect(() =>
			parseAuthEnv({
				NODE_ENV: "production",
				BETTER_AUTH_URL: "http://localhost:5960",
				BETTER_AUTH_SECRET: SECRET,
				DEV_FIXED_OTP: "000000",
			}),
		).toThrow("DEV_FIXED_OTP");
	});

	it("needs an email transport in production (Resend or SMTP)", () => {
		expect(emailTransportProblem(parseAuthEnv(prod))).toMatch(
			/no email transport/,
		);
		expect(
			emailTransportProblem(
				parseAuthEnv({
					...prod,
					RESEND_API_KEY: "re_123",
					EMAIL_FROM: "Yonder <login@yonder.sh>",
				}),
			),
		).toBeNull();
		expect(
			emailTransportProblem(
				parseAuthEnv({ ...prod, SMTP_HOST: "mail.axolotl.cloud" }),
			),
		).toBeNull();
		// Development logs codes to the console.
		expect(emailTransportProblem(parseAuthEnv({}))).toBeNull();
		// A production build under test on localhost may use the JSON outbox.
		expect(
			emailTransportProblem(
				parseAuthEnv({
					...prod,
					BETTER_AUTH_URL: "http://localhost:5960",
					EMAIL_OUTBOX_DIR: "/tmp/outbox",
				}),
			),
		).toBeNull();
	});
});

describe("Cloudflare Turnstile keys", () => {
	it("is on only with BOTH keys", () => {
		expect(parseAuthEnv({}).turnstile).toBeNull();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(
			parseAuthEnv({ TURNSTILE_SITE_KEY: "1x00000000000000000000AA" })
				.turnstile,
		).toBeNull();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Turnstile"));
		warn.mockRestore();
		expect(
			parseAuthEnv({
				TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
				TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
			}).turnstile,
		).toEqual({
			siteKey: "1x00000000000000000000AA",
			secretKey: "1x0000000000000000000000000000000AA",
		});
	});
});

describe("client IP (TRUST_CF_CONNECTING_IP)", () => {
	const ipOf = (env: Record<string, string>, headers: Record<string, string>) =>
		getIP(new Request("https://yonder.sh/api/auth/x", { headers }), {
			advanced: {
				ipAddress: { ipAddressHeaders: parseAuthEnv(env).ipAddressHeaders },
			},
		});

	it("reads X-Forwarded-For by default (behind a reverse proxy)", () => {
		expect(parseAuthEnv({}).ipAddressHeaders).toEqual(["x-forwarded-for"]);
		expect(
			ipOf(
				{},
				{
					"cf-connecting-ip": "203.0.113.7",
					"x-forwarded-for": "198.51.100.1",
				},
			),
		).toBe("198.51.100.1");
	});

	it("prefers CF-Connecting-IP behind Cloudflare, a client can't spoof it with X-Forwarded-For", () => {
		const cf = { TRUST_CF_CONNECTING_IP: "1" };
		expect(parseAuthEnv(cf).ipAddressHeaders).toEqual([
			"cf-connecting-ip",
			"x-forwarded-for",
		]);
		expect(
			ipOf(cf, {
				"cf-connecting-ip": "203.0.113.7",
				// What a client sends plus what Cloudflare and the gateway append.
				"x-forwarded-for": "1.2.3.4, 203.0.113.7, 172.68.1.1",
			}),
		).toBe("203.0.113.7");
		// Without the header (a request that didn't come through Cloudflare).
		expect(ipOf(cf, { "x-forwarded-for": "198.51.100.1" })).toBe(
			"198.51.100.1",
		);
	});
});

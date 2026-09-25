import { describe, expect, it } from "vitest";
import { parseCollabEnv } from "./env";

describe("parseCollabEnv", () => {
	it("binds loopback in dev and all interfaces in production", () => {
		expect(parseCollabEnv({}).HOCUSPOCUS_HOST).toBe("127.0.0.1");
		expect(
			parseCollabEnv({ NODE_ENV: "production", BETTER_AUTH_SECRET: "x" })
				.HOCUSPOCUS_HOST,
		).toBe("0.0.0.0");
		expect(parseCollabEnv({ HOCUSPOCUS_HOST: "::1" }).HOCUSPOCUS_HOST).toBe(
			"::1",
		);
	});

	it("collects the allowed browser origins", () => {
		const env = parseCollabEnv({
			APP_URL: "https://trips.example.com/",
			BETTER_AUTH_URL: "https://trips.example.com",
			TRUSTED_ORIGINS: "http://192.168.1.20:3000, https://other.example",
		});
		expect(env.allowedOrigins).toEqual([
			"https://trips.example.com",
			"http://192.168.1.20:3000",
			"https://other.example",
		]);
	});

	it("refuses production without an auth secret", () => {
		expect(() => parseCollabEnv({ NODE_ENV: "production" })).toThrow(
			/BETTER_AUTH_SECRET/,
		);
	});
});

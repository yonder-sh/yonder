/**
 * The one-shot production scripts' pure parts: `set-quota`'s size argument
 * and `setup-bucket`'s CORS origins and lifecycle rules.
 */
import { describe, expect, it } from "vitest";
import { parseQuota } from "./set-quota";
import { corsOrigins, LIFECYCLE_RULES } from "./setup-bucket";

describe("set-quota <email> <GB|default>", () => {
	it("reads GB (1024³ bytes, decimals allowed) or default", () => {
		expect(parseQuota("5")).toBe(5 * 1024 ** 3);
		expect(parseQuota("0.5")).toBe(512 * 1024 ** 2);
		expect(parseQuota("0.001")).toBe(Math.round(0.001 * 1024 ** 3));
		expect(parseQuota("default")).toBeNull();
		for (const bad of ["-1", "5GB", "", "1e3", "abc"])
			expect(() => parseQuota(bad)).toThrow();
	});
});

describe("setup-bucket", () => {
	it("allows the app's origins for CORS", () => {
		expect(
			corsOrigins({
				APP_URL: "https://yonder.sh/",
				BETTER_AUTH_URL: "https://yonder.sh",
				TRUSTED_ORIGINS: " http://192.168.1.20:3000 ,",
			}),
		).toEqual(["https://yonder.sh", "http://192.168.1.20:3000"]);
	});

	it("aborts stale multipart uploads after a day and keeps noncurrent versions 14 days", () => {
		expect(LIFECYCLE_RULES).toEqual([
			expect.objectContaining({
				Status: "Enabled",
				AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
			}),
			expect.objectContaining({
				Status: "Enabled",
				NoncurrentVersionExpiration: { NoncurrentDays: 14 },
			}),
		]);
	});
});

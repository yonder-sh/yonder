/**
 * The per-email OTP send cap runs in Better Auth's `before` hook, so a send over
 * the cap never generates or stores a code (SECURITY §8). Checked against the
 * real Better Auth endpoint and a throwaway migrated database: the stored
 * verification value (hashed code + attempt counter) must not rotate.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_otp_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-otptest-${hex}`;
	process.env.BETTER_AUTH_URL = "http://localhost:3000";
	process.env.APP_URL = "http://localhost:3000";
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	// Random codes (the fixed dev code would make every rotation look identical).
	process.env.DEV_FIXED_OTP = "";
	return { hex, scratchUrl: scratch.toString() };
});

import { betterAuth } from "better-auth";
import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { verification } from "@/db/schema";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { LIMITS, memoryAuthLimits } from "./limits.server";
import { buildAuthOptions } from "./options.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
});

afterAll(async () => {
	const keys = await redis().keys(`${redisPrefix()}:*`);
	if (keys.length) await redis().del(...keys);
	await closeRedis();
	await closeDb();
	await dropDatabase(testEnv.scratchUrl);
});

describe("OTP send cap (before hook)", () => {
	it("answers success past the cap without generating or storing a new code", async () => {
		const auth = betterAuth(buildAuthOptions({ limits: memoryAuthLimits() }));
		const email = `cap-${testEnv.hex}@asia2027.test`;
		// Every verification row for the email (Better Auth may keep one per send).
		const stored = async () =>
			(
				await getDb()
					.select({ id: verification.id, value: verification.value })
					.from(verification)
					.where(eq(verification.identifier, `sign-in-otp-${email}`))
			)
				.map((r) => `${r.id}:${r.value}`)
				.sort();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		let last: string[] = [];
		for (let i = 0; i < LIMITS.otpSendPerHour; i++) {
			const res = await auth.api.sendVerificationOTP({
				body: { email, type: "sign-in" },
			});
			expect(res).toEqual({ success: true });
			const now = await stored();
			expect(now.length).toBeGreaterThan(0);
			expect(now).not.toEqual(last); // each allowed send stores a fresh code
			last = now;
		}
		// Over the cap: same answer, and the stored code (with its attempt counter) is untouched.
		const res = await auth.api.sendVerificationOTP({
			body: { email, type: "sign-in" },
		});
		expect(res).toEqual({ success: true });
		expect(await stored()).toEqual(last);
		expect(warn.mock.calls.flat().join(" ")).toContain("OTP send cap reached");
		log.mockRestore();
		warn.mockRestore();
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS, memoryAuthLimits, normalizeEmail } from "./limits.server";

describe("auth limits (SECURITY §8, §10)", () => {
	it("caps OTP sends per email at 5 per hour, silently", async () => {
		const l = memoryAuthLimits();
		for (let i = 0; i < LIMITS.otpSendPerHour; i++)
			expect(await l.allowOtpSend("kai@asia2027.test")).toBe(true);
		expect(await l.allowOtpSend("kai@asia2027.test")).toBe(false);
		// Normalized: the same address in another case/with spaces shares the cap.
		expect(await l.allowOtpSend("  KAI@asia2027.TEST ")).toBe(false);
		// Other emails are unaffected.
		expect(await l.allowOtpSend("audrey@asia2027.test")).toBe(true);
	});

	it("locks OTP sign-in for an email after 10 failures, until cleared", async () => {
		const l = memoryAuthLimits();
		const email = "eve@asia2027.test";
		for (let i = 0; i < LIMITS.otpFailuresPerDay; i++) {
			expect(await l.otpLockRemaining(email)).toBe(0);
			await l.recordOtpFailure(email);
		}
		expect(await l.otpLockRemaining(email)).toBe(0); // exactly 10 failures: still allowed
		await l.recordOtpFailure(email);
		const locked = await l.otpLockRemaining(email);
		expect(locked).toBeGreaterThan(0);
		expect(locked).toBeLessThanOrEqual(LIMITS.otpLockSeconds * 1000);
		await l.clearOtpFailures(email);
		expect(await l.otpLockRemaining(email)).toBe(0);
	});

	describe("with a fake clock", () => {
		afterEach(() => vi.useRealTimers());

		it("keeps the 24 h failure count across the 1 h lock: every later failure re-locks", async () => {
			vi.useFakeTimers({ now: new Date("2027-10-01T00:00:00Z") });
			const l = memoryAuthLimits();
			const email = "mallory@asia2027.test";
			for (let i = 0; i <= LIMITS.otpFailuresPerDay; i++)
				await l.recordOtpFailure(email);
			expect(await l.otpLockRemaining(email)).toBeGreaterThan(0);

			// Just past the 1 h lock: one more guess is allowed…
			vi.advanceTimersByTime(LIMITS.otpLockSeconds * 1000 + 1000);
			expect(await l.otpLockRemaining(email)).toBe(0);
			// …and its failure re-locks at once (the counter was NOT reset by the lock).
			await l.recordOtpFailure(email);
			const relocked = await l.otpLockRemaining(email);
			expect(relocked).toBeGreaterThan(LIMITS.otpLockSeconds * 1000 - 1000);

			// Over a whole day an attacker gets 10 + at most one guess per hour.
			let guesses = LIMITS.otpFailuresPerDay + 2;
			for (let h = 0; h < 21; h++) {
				vi.advanceTimersByTime(LIMITS.otpLockSeconds * 1000 + 1000);
				if ((await l.otpLockRemaining(email)) === 0) {
					guesses++;
					await l.recordOtpFailure(email);
				}
			}
			expect(guesses).toBeLessThanOrEqual(LIMITS.otpFailuresPerDay + 24);

			// A fresh day starts a fresh window (once the last lock has run out).
			vi.advanceTimersByTime(86_400_000);
			expect(await l.otpLockRemaining(email)).toBe(0);
			for (let i = 0; i < LIMITS.otpFailuresPerDay; i++)
				await l.recordOtpFailure(email);
			expect(await l.otpLockRemaining(email)).toBe(0);
		});

		it("resets the hourly send cap after an hour, the daily one after a day", async () => {
			vi.useFakeTimers({ now: new Date("2027-10-01T00:00:00Z") });
			const l = memoryAuthLimits();
			const email = "kai@asia2027.test";
			let sent = 0;
			for (let h = 0; h < 6; h++) {
				for (let i = 0; i < 10; i++) if (await l.allowOtpSend(email)) sent++;
				vi.advanceTimersByTime(3_600_000 + 1000);
			}
			// 5 per hour, but never more than 20 in the day.
			expect(sent).toBe(LIMITS.otpSendPerDay);
		});
	});

	it("limits share-link redemptions per IP (10/min)", async () => {
		const l = memoryAuthLimits();
		for (let i = 0; i < LIMITS.redeemPerMinute; i++)
			expect(await l.redeemRetryAfter("203.0.113.9")).toBe(0);
		expect(await l.redeemRetryAfter("203.0.113.9")).toBeGreaterThanOrEqual(
			1000,
		);
		expect(await l.redeemRetryAfter("198.51.100.1")).toBe(0);
	});

	it("does nothing when disabled (dev, AUTH_RATE_LIMIT=off)", async () => {
		const l = memoryAuthLimits(false);
		for (let i = 0; i < 50; i++) {
			expect(await l.allowOtpSend("a@b.c")).toBe(true);
			await l.recordOtpFailure("a@b.c");
			expect(await l.redeemRetryAfter("1.2.3.4")).toBe(0);
		}
		expect(await l.otpLockRemaining("a@b.c")).toBe(0);
	});

	it("normalizes emails like Better Auth, plus trimming", () => {
		expect(normalizeEmail("  Dennis@Asia2027.TEST ")).toBe(
			"dennis@asia2027.test",
		);
	});
});

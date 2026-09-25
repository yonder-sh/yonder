import { describe, expect, it } from "vitest";
import { DocSizes, LimitError, RateLimiter } from "./limits";

describe("RateLimiter", () => {
	it("allows a burst up to the budget, then throws, and resets per window", () => {
		let now = 0;
		const rl = new RateLimiter<object>(
			{ WINDOW_MS: 1000, MAX_MESSAGES: 3, MAX_BYTES: 100 },
			() => now,
		);
		const conn = {};
		rl.hit(conn, 10);
		rl.hit(conn, 10);
		rl.hit(conn, 10);
		expect(() => rl.hit(conn, 10)).toThrow(LimitError);
		now = 1000;
		expect(() => rl.hit(conn, 10)).not.toThrow();
		expect(() => rl.hit({}, 101)).toThrow(/bytes/);
	});
});

describe("DocSizes", () => {
	it("tracks stored size plus updates", () => {
		const s = new DocSizes<object>(100);
		const d = {};
		s.set(d, 60);
		s.add(d, 30);
		expect(s.isOversized(d)).toBe(false);
		s.add(d, 20);
		expect(s.isOversized(d)).toBe(true);
		s.set(d, 10);
		expect(s.isOversized(d)).toBe(false);
	});
});

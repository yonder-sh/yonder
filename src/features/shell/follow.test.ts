import { describe, expect, it } from "vitest";
import { safeFollowPath } from "./follow";

const O = "http://localhost:5110";

describe("safeFollowPath (SPEC §10.4 client re-check)", () => {
	it("accepts views inside this trip", () => {
		expect(safeFollowPath("/t/asia-2027", "asia-2027", O)).toBe("/t/asia-2027");
		expect(
			safeFollowPath(
				"/t/asia-2027/japan/tokyo?lens=area&sel=root",
				"asia-2027",
				O,
			),
		).toBe("/t/asia-2027/japan/tokyo?lens=area&sel=root");
	});

	it("refuses forged paths", () => {
		const bad = [
			"https://evil.example/t/asia-2027",
			"//evil.example/t/asia-2027",
			"/t/asia-2027-other/japan",
			"/t/other-trip",
			"/t/asia-2027/../../login",
			"/t/asia-2027/JAPAN",
			"/t/asia-2027#x",
			"javascript:alert(1)",
			"/t/asia-2027/rate",
			"/",
			"",
			`/t/asia-2027/${"a".repeat(700)}`,
		];
		for (const p of bad)
			expect(safeFollowPath(p, "asia-2027", O), p).toBeNull();
		expect(safeFollowPath(42, "asia-2027", O)).toBeNull();
		expect(safeFollowPath(null, "asia-2027", O)).toBeNull();
	});
});

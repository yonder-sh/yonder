import { describe, expect, it } from "vitest";
import { postAuthDestination, safeNext } from "./redirect";

describe("safeNext (QA AUTH-05)", () => {
	it("keeps same-origin relative paths with search and hash", () => {
		expect(safeNext("/t/asia-2027")).toBe("/t/asia-2027");
		expect(safeNext("/t/asia-2027/japan?days=2027-10-05&lens=city#x")).toBe(
			"/t/asia-2027/japan?days=2027-10-05&lens=city#x",
		);
	});

	it.each([
		["https://evil.example"],
		["//evil.example"],
		["//evil.example/t/x"],
		["/\\evil.example"],
		["\\\\evil.example"],
		["javascript:alert(1)"],
		["t/relative"],
		["/\t/evil.example"],
		["/\n/evil.example"],
		[""],
		[undefined],
		[null],
		[42],
		[`/${"a".repeat(3000)}`],
	])("rejects %j", (next) => {
		expect(safeNext(next)).toBe("/");
	});

	it("uses the given fallback", () => {
		expect(safeNext("https://evil.example", "/home")).toBe("/home");
	});

	it("never lands back on the auth pages", () => {
		expect(postAuthDestination("/login")).toBe("/");
		expect(postAuthDestination("/welcome?next=/t/x")).toBe("/");
		expect(postAuthDestination("/t/x")).toBe("/t/x");
	});
});

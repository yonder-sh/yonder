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
		expect(safeNext(next)).toBe("/dashboard");
	});

	it("uses the given fallback", () => {
		expect(safeNext("https://evil.example", "/home")).toBe("/home");
	});

	it("never lands back on the auth pages", () => {
		expect(postAuthDestination("/login")).toBe("/dashboard");
		expect(postAuthDestination("/welcome?next=/t/x")).toBe("/dashboard");
		expect(postAuthDestination("/t/x")).toBe("/t/x");
	});

	it("goes to the dashboard by default and never to the landing page", () => {
		expect(postAuthDestination(undefined)).toBe("/dashboard");
		expect(postAuthDestination("/")).toBe("/dashboard");
		expect(postAuthDestination("/?source=pwa")).toBe("/dashboard");
		expect(postAuthDestination("/dashboard")).toBe("/dashboard");
		expect(postAuthDestination("/share?id=x")).toBe("/share?id=x");
	});
});

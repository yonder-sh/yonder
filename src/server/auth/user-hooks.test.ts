import { describe, expect, it } from "vitest";
import { applyUserCreate, applyUserUpdate, UserRuleError } from "./user-hooks";

const session = (isAnonymous: boolean) =>
	({ kind: "session", isAnonymous }) as const;

describe("user.create.before", () => {
	it("OTP sign-up without names leaves them blank (the onboarding gate asks)", () => {
		expect(
			applyUserCreate({ email: "kai@asia2027.test", name: "" }),
		).toMatchObject({
			firstName: "",
			lastName: "",
			name: "",
		});
	});

	it("names sent at sign-up are cleaned and derive `name`", () => {
		expect(
			applyUserCreate({
				email: "a@b.c",
				name: "ignored",
				firstName: " Ada ",
				lastName: "Love​lace",
			}),
		).toMatchObject({
			firstName: "Ada",
			lastName: "Lovelace",
			name: "Ada Lovelace",
		});
	});

	it("rejects one name without the other", () => {
		expect(() => applyUserCreate({ firstName: "Ada", lastName: "" })).toThrow(
			UserRuleError,
		);
	});

	it("keeps an anonymous user's generated name", () => {
		expect(
			applyUserCreate({ name: "Guest Heron", isAnonymous: true }).name,
		).toBe("Guest Heron");
	});
});

describe("user.update.before", () => {
	it("derives name from both names (the ONLY way an account's name changes)", () => {
		expect(
			applyUserUpdate(
				{ firstName: "Thảo", lastName: "Nguyễn-O'Brien" },
				session(false),
			),
		).toEqual({
			firstName: "Thảo",
			lastName: "Nguyễn-O'Brien",
			name: "Thảo Nguyễn-O'Brien",
		});
	});

	it("requires both names together and non-blank (QA AUTH-02)", () => {
		expect(() => applyUserUpdate({ firstName: "Kai" }, session(false))).toThrow(
			"together",
		);
		expect(() =>
			applyUserUpdate({ firstName: "Kai", lastName: "   " }, session(false)),
		).toThrow("required");
		expect(() =>
			applyUserUpdate({ firstName: "", lastName: "Tester" }, session(false)),
		).toThrow("required");
	});

	it("an account can't set `name` directly", () => {
		expect(() =>
			applyUserUpdate({ name: "Admin (owner)" }, session(false)),
		).toThrow(UserRuleError);
	});

	it("a guest may rename themselves, cleaned and length-checked", () => {
		expect(applyUserUpdate({ name: " Guest‮ Wren " }, session(true))).toEqual({
			name: "Guest Wren",
		});
		expect(() =>
			applyUserUpdate({ name: "x".repeat(41) }, session(true)),
		).toThrow(UserRuleError);
		expect(() => applyUserUpdate({ name: "  " }, session(true))).toThrow(
			UserRuleError,
		);
	});

	it("a request can't set `image` (FB-16: only the avatar upload does)", () => {
		expect(() =>
			applyUserUpdate({ image: "https://evil.example/p.png" }, session(false)),
		).toThrow(UserRuleError);
		expect(() => applyUserUpdate({ image: null }, session(true))).toThrow(
			UserRuleError,
		);
		expect(
			applyUserUpdate({ image: "/api/avatar/u1?v=abc" }, { kind: "internal" }),
		).toEqual({ image: "/api/avatar/u1?v=abc" });
		// Better Auth sends `image: undefined` along with a rename.
		const rename = { firstName: "Ada", lastName: "Byron", image: undefined };
		expect(
			(applyUserUpdate(rename, session(false)) as { name?: string }).name,
		).toBe("Ada Byron");
	});

	it("server-internal writes pass through, and unrelated patches are untouched", () => {
		expect(applyUserUpdate({ name: "Migrated" }, { kind: "internal" })).toEqual(
			{ name: "Migrated" },
		);
		const patch = { emailVerified: true, updatedAt: new Date(0) };
		expect(applyUserUpdate(patch, session(false))).toBe(patch);
	});
});

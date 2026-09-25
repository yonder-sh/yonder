import { describe, expect, it } from "vitest";
import {
	type AccessRow,
	leastUsedColor,
	resolveAccess,
	UUID_RE,
} from "./resolve";

const TRIP = "0192f0c1-0000-7000-8000-000000000001";
const member = (role: string, color = 2): AccessRow => ({
	via: "member",
	role,
	memberId: "0192f0c1-0000-7000-8000-0000000000aa",
	color,
	slug: "asia-2027",
});
const grant = (role: string, color = 5): AccessRow => ({
	via: "grant",
	role,
	memberId: null,
	color,
	slug: "asia-2027",
});

describe("resolveAccess (SPEC §11.3)", () => {
	it("no rows → null (the caller answers NOT_FOUND)", () => {
		expect(resolveAccess(TRIP, [])).toBeNull();
	});

	it("a member is not a guest and keeps their member id and colour", () => {
		expect(resolveAccess(TRIP, [member("editor")])).toEqual({
			tripId: TRIP,
			slug: "asia-2027",
			role: "editor",
			memberId: "0192f0c1-0000-7000-8000-0000000000aa",
			isGuest: false,
			color: 2,
		});
	});

	it("grant-only access is a guest with the grant's colour", () => {
		const a = resolveAccess(TRIP, [grant("viewer", 6)]);
		expect(a).toMatchObject({
			role: "viewer",
			isGuest: true,
			memberId: null,
			color: 6,
		});
	});

	it("role is the max of membership and grants; member identity wins", () => {
		const a = resolveAccess(TRIP, [member("viewer", 1), grant("editor", 4)]);
		expect(a).toMatchObject({ role: "editor", isGuest: false, color: 1 });
		const b = resolveAccess(TRIP, [grant("viewer"), grant("editor")]);
		expect(b).toMatchObject({ role: "editor", isGuest: true });
		const c = resolveAccess(TRIP, [grant("editor"), member("owner")]);
		expect(c?.role).toBe("owner");
	});

	it("ignores unknown roles and clamps bad colours", () => {
		expect(resolveAccess(TRIP, [member("admin")])).toBeNull();
		expect(resolveAccess(TRIP, [member("viewer", 99)])?.color).toBe(0);
		expect(
			resolveAccess(TRIP, [{ ...member("viewer"), color: "3" }])?.color,
		).toBe(3);
	});
});

describe("leastUsedColor", () => {
	it("picks the lowest unused, then the least used", () => {
		expect(leastUsedColor([])).toBe(0);
		expect(leastUsedColor([0, 1, 2])).toBe(3);
		expect(leastUsedColor([0, 1, 2, 3, 4, 5, 6, 7])).toBe(0);
		expect(leastUsedColor([0, 0, 1, 2, 3, 4, 5, 6, 7])).toBe(1);
		expect(leastUsedColor([9, -1, 0])).toBe(1);
	});
});

describe("UUID_RE", () => {
	it("guards SQL from malformed ids", () => {
		expect(UUID_RE.test(TRIP)).toBe(true);
		expect(UUID_RE.test("1 or 1=1")).toBe(false);
		expect(UUID_RE.test(`${TRIP}x`)).toBe(false);
	});
});

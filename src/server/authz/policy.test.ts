import { describe, expect, it } from "vitest";
import type { TripAccess } from "@/lib/auth/roles";
import { AppError, ERROR_STATUS, errorCode, errorDetail } from "./errors";
import {
	assertAccount,
	assertCapability,
	assertNamedUser,
	assertTripRole,
	assertUser,
} from "./policy";

const named = {
	id: "u1",
	isAnonymous: false,
	firstName: "Kai",
	lastName: "Tester",
};
const unnamed = { id: "u2", isAnonymous: false, firstName: "", lastName: null };
const guest = { id: "g1", isAnonymous: true, firstName: "", lastName: "" };

const access = (role: TripAccess["role"], isGuest = false): TripAccess => ({
	tripId: "t",
	slug: "s",
	role,
	memberId: isGuest ? null : "m",
	isGuest,
	color: 0,
});

/** Runs `fn`, returning the AppError it throws (or failing the test). */
function thrown(fn: () => unknown): AppError {
	try {
		fn();
	} catch (e) {
		if (e instanceof AppError) return e;
		throw e;
	}
	throw new Error("expected an AppError");
}

describe("user assertions", () => {
	it("no user → UNAUTHORIZED (401)", () => {
		const e = thrown(() => assertUser(null));
		expect(e.code).toBe("UNAUTHORIZED");
		expect(e.status).toBe(401);
	});

	it("an account without names → FORBIDDEN: name required (QA AUTH-02)", () => {
		const e = thrown(() => assertNamedUser(unnamed));
		expect(e.message).toBe("FORBIDDEN: name required");
		expect(e.status).toBe(403);
	});

	it("guests pass the name check but are not accounts", () => {
		expect(assertNamedUser(guest)).toBe(guest);
		expect(thrown(() => assertAccount(guest)).message).toBe(
			"FORBIDDEN: account required",
		);
		expect(assertAccount(named)).toBe(named);
	});
});

describe("trip assertions", () => {
	it("no access → NOT_FOUND, never FORBIDDEN (no existence oracle)", () => {
		expect(thrown(() => assertTripRole(null, "viewer")).code).toBe("NOT_FOUND");
		expect(thrown(() => assertCapability(null, "read")).code).toBe("NOT_FOUND");
	});

	it("a weaker role → FORBIDDEN", () => {
		expect(thrown(() => assertTripRole(access("viewer"), "editor")).code).toBe(
			"FORBIDDEN",
		);
		expect(thrown(() => assertTripRole(access("editor"), "owner")).code).toBe(
			"FORBIDDEN",
		);
		expect(assertTripRole(access("owner"), "editor").role).toBe("owner");
	});

	it("capabilities follow the matrix, including guest limits", () => {
		expect(assertCapability(access("editor", true), "edit").isGuest).toBe(true);
		expect(
			thrown(() => assertCapability(access("editor", true), "manageShareLinks"))
				.code,
		).toBe("FORBIDDEN");
		expect(
			thrown(() => assertCapability(access("editor"), "deleteTrip")).code,
		).toBe("FORBIDDEN");
	});
});

describe("AppError travels as a message (SPEC §12.3)", () => {
	it("round-trips the code through a plain Error, as seroval would", () => {
		const e = new AppError("FORBIDDEN", "name required");
		const wire = new Error(e.message); // custom fields are lost on the wire
		expect(errorCode(wire)).toBe("FORBIDDEN");
		expect(errorDetail(wire)).toBe("name required");
		expect(errorCode({ message: "NOT_FOUND" })).toBe("NOT_FOUND");
		expect(errorCode("RATE_LIMITED")).toBe("RATE_LIMITED");
	});

	it("does not mistake other messages for codes", () => {
		expect(errorCode(new Error("NOT_FOUNDATION"))).toBeNull();
		expect(errorCode(new Error("network down"))).toBeNull();
		expect(errorCode(undefined)).toBeNull();
	});

	it("maps every code to an HTTP status", () => {
		expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
		expect(new AppError("CONFLICT").status).toBe(409);
	});
});

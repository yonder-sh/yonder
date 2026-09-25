import { hasFullName } from "@/lib/auth/names";
import {
	type Capability,
	can,
	roleAtLeast,
	type TripAccess,
	type TripRole,
} from "@/lib/auth/roles";
import { AppError } from "./errors";

/**
 * The authorization decisions, as pure functions (unit-tested). The
 * `*.server.ts` helpers load the session and the access rows, then call these.
 */

/** The user fields the policy reads (Better Auth's user plus our fields). */
export interface PolicyUser {
	id: string;
	isAnonymous?: boolean | null;
	firstName?: string | null;
	lastName?: string | null;
}

export function assertUser<U extends PolicyUser>(
	user: U | null | undefined,
): U {
	if (!user) throw new AppError("UNAUTHORIZED");
	return user;
}

/**
 * Signed in, and (for accounts) both names set. Guests pass: their display
 * name is optional. Every mutating server function needs this (SPEC §11.2.4).
 */
export function assertNamedUser<U extends PolicyUser>(
	user: U | null | undefined,
): U {
	const u = assertUser(user);
	if (!u.isAnonymous && !hasFullName(u))
		throw new AppError("FORBIDDEN", "name required");
	return u;
}

/** A named, non-anonymous account (creating trips, dashboards, invites). */
export function assertAccount<U extends PolicyUser>(
	user: U | null | undefined,
): U {
	const u = assertNamedUser(user);
	if (u.isAnonymous) throw new AppError("FORBIDDEN", "account required");
	return u;
}

/**
 * `access` must reach `min`. No access at all is NOT_FOUND, never FORBIDDEN,
 * so a non-member can't tell whether a trip exists (SECURITY §1).
 */
export function assertTripRole(
	access: TripAccess | null,
	min: TripRole,
): TripAccess {
	if (!access) throw new AppError("NOT_FOUND");
	if (!roleAtLeast(access.role, min))
		throw new AppError("FORBIDDEN", `${min} role required`);
	return access;
}

/** `access` must allow the capability (SPEC §11.3 matrix). */
export function assertCapability(
	access: TripAccess | null,
	capability: Capability,
): TripAccess {
	if (!access) throw new AppError("NOT_FOUND");
	if (!can(access, capability))
		throw new AppError("FORBIDDEN", `not allowed: ${capability}`);
	return access;
}

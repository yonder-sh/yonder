import type { Capability, TripAccess, TripRole } from "@/lib/auth/roles";
import type { AuthUser } from "@/server/auth.server";
import { assertCapability, assertNamedUser, assertTripRole } from "./policy";
import { enforce, getUser, requireUser } from "./session.server";
import { loadTripAccess } from "./trip-access.server";

/**
 * Trip-level authorization for server functions (SPEC §11.3, SECURITY §1),
 * on top of the session: the access itself always comes from Postgres
 * (`loadTripAccess`), on every call.
 */

/**
 * The user's access to a trip, or null (no session, malformed id, deleted
 * trip, or neither a membership nor a live grant). Pass `user` when you
 * already have it (e.g. from `withUser` middleware context).
 */
export async function getTripAccess(
	tripId: string,
	user?: Pick<AuthUser, "id"> | null,
): Promise<TripAccess | null> {
	const u = user === undefined ? await getUser() : user;
	if (!u) return null;
	return loadTripAccess(tripId, u.id);
}

/**
 * The trip access of the signed-in user, requiring at least `min`:
 * no session → 401, no access → 404, weaker role → 403.
 *
 * For `editor` and `owner` it also requires both names on non-anonymous
 * accounts (403 "name required"), because those roles are only checked for
 * writes and every write needs a named user (SPEC §11.2.4).
 */
export async function requireTripRole(
	tripId: string,
	min: TripRole,
	user?: AuthUser,
): Promise<TripAccess & { user: AuthUser }> {
	const u = user ?? (await requireUser());
	if (min !== "viewer") enforce(() => assertNamedUser(u));
	const access = await getTripAccess(tripId, u);
	return { ...enforce(() => assertTripRole(access, min)), user: u };
}

/** Capabilities that only read; every other one is a write and needs a named user. */
const READ_CAPABILITIES: ReadonlySet<Capability> = new Set([
	"read",
	"seeBookingDetails",
	"beMentioned",
	"seeMemberEmails",
]);

/** Like `requireTripRole`, but checks one capability of the §11.3 matrix. */
export async function requireTripCapability(
	tripId: string,
	capability: Capability,
	user?: AuthUser,
): Promise<TripAccess & { user: AuthUser }> {
	const u = user ?? (await requireUser());
	if (!READ_CAPABILITIES.has(capability)) enforce(() => assertNamedUser(u));
	const access = await getTripAccess(tripId, u);
	return { ...enforce(() => assertCapability(access, capability)), user: u };
}

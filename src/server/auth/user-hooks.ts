import { cleanName, GuestName, PersonName } from "@/lib/auth/names";

/**
 * Rules for writes to Better Auth's `user` row (SPEC §11.1 databaseHooks).
 * Pure functions so they can be unit-tested; `options.server.ts` wires them
 * into `databaseHooks.user.{create,update}.before`.
 *
 * - `firstName`/`lastName` travel together, are cleaned and validated
 *   (1–60 chars), and `name` is always derived as "First Last".
 * - Signed-in accounts can never set `name` directly (it is derived).
 * - Anonymous guests may set `name` (their display name, 1–40 chars).
 * - Nobody sets `image` from a request (only `avatar.server.ts` does, FB-16).
 * - Server-internal writes (no request session) are trusted.
 */
export class UserRuleError extends Error {}

type Patch = Record<string, unknown>;

/** Who is writing: a request with a session, or trusted server code. */
export type UserWriter =
	| { kind: "session"; isAnonymous: boolean }
	| { kind: "internal" };

function parseNames(patch: Patch): { firstName: string; lastName: string } {
	const f = PersonName.safeParse(patch.firstName ?? "");
	const l = PersonName.safeParse(patch.lastName ?? "");
	if (!f.success || !l.success)
		throw new UserRuleError("first and last name are required");
	return { firstName: f.data, lastName: l.data };
}

/** `user.create.before`: names are optional at sign-up but validated if sent. */
export function applyUserCreate<T extends Patch>(user: T): T {
	const hasF =
		typeof user.firstName === "string" && user.firstName.trim() !== "";
	const hasL = typeof user.lastName === "string" && user.lastName.trim() !== "";
	if (hasF || hasL) {
		const names = parseNames(user);
		return { ...user, ...names, name: `${names.firstName} ${names.lastName}` };
	}
	const name = typeof user.name === "string" ? cleanName(user.name) : "";
	return { ...user, firstName: "", lastName: "", name };
}

/** `user.update.before`: see the module comment. Returns the patch to apply. */
export function applyUserUpdate<T extends Patch>(
	patch: T,
	writer: UserWriter,
): T {
	// Owner FB-16: `image` is only ever our own avatar URL, written by
	// `commitAvatar`/`removeAvatar` (internal). A client can't point it anywhere.
	// (Better Auth's update-user puts `image: undefined` in every patch.)
	if (patch.image !== undefined && writer.kind === "session")
		throw new UserRuleError("the picture is set through the avatar upload");
	const hasF = "firstName" in patch;
	const hasL = "lastName" in patch;
	if (hasF !== hasL)
		throw new UserRuleError("send firstName and lastName together");
	if (hasF) {
		const names = parseNames(patch);
		return { ...patch, ...names, name: `${names.firstName} ${names.lastName}` };
	}
	if ("name" in patch) {
		if (writer.kind === "internal") return patch;
		if (!writer.isAnonymous)
			throw new UserRuleError("name is set through firstName and lastName");
		const name = GuestName.safeParse(patch.name ?? "");
		if (!name.success)
			throw new UserRuleError("guest name must be 1–40 characters");
		return { ...patch, name: name.data };
	}
	return patch;
}

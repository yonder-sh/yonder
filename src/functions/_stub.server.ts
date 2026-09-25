import { fail } from "@/server/authz/session.server";

/**
 * Body of a server function whose signature is frozen but whose implementation
 * belongs to another package (SPEC §0 rule 11). Answers 502 with a readable
 * detail, so a functional stub that calls it shows a clear toast.
 */
export function notBuilt(owner: string): never {
	return fail("PROVIDER", `Not built yet (${owner}).`);
}

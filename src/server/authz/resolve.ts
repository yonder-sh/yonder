import {
	isTripRole,
	maxRole,
	type TripAccess,
	type TripRole,
} from "@/lib/auth/roles";

/**
 * One row of the access query (`access.server.ts`): either the user's active
 * membership or one of their grants on an enabled, unrevoked share link.
 * Deleted trips never produce rows.
 */
export interface AccessRow {
	via: "member" | "grant";
	role: string;
	memberId: string | null;
	color: number | string | null;
	slug: string;
}

/**
 * Folds access rows into a TripAccess (SPEC §11.3):
 * - no rows → null (the caller answers NOT_FOUND, so non-members can't probe);
 * - role = the strongest of the membership role and every live grant's role;
 * - memberId and colour come from the member row when there is one;
 * - `isGuest` = no active membership.
 * Rows with an unknown role are ignored (defensive; the enums forbid them).
 */
export function resolveAccess(
	tripId: string,
	rows: readonly AccessRow[],
): TripAccess | null {
	const valid = rows.filter((r): r is AccessRow & { role: TripRole } =>
		isTripRole(r.role),
	);
	const role = maxRole(valid.map((r) => r.role));
	if (!role) return null;
	const member = valid.find((r) => r.via === "member") ?? null;
	const grant = valid.find((r) => r.via === "grant") ?? null;
	const source = member ?? grant;
	const color = Number(source?.color ?? 0);
	return {
		tripId,
		slug: source?.slug ?? "",
		role,
		memberId: member?.memberId ?? null,
		isGuest: member === null,
		color: Number.isInteger(color) && color >= 0 && color <= 7 ? color : 0,
	};
}

/** Postgres rejects a malformed uuid with an error; check before querying. */
export const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The least-used presence colour 0..7 among the colours already taken on a
 * trip (members and guests share one palette, SPEC §7.5). Ties pick the lowest.
 */
export function leastUsedColor(taken: Iterable<number>): number {
	const counts = new Array<number>(8).fill(0);
	for (const c of taken)
		if (Number.isInteger(c) && c >= 0 && c < 8)
			counts[c] = (counts[c] ?? 0) + 1;
	let best = 0;
	for (let i = 1; i < 8; i++)
		if ((counts[i] ?? 0) < (counts[best] ?? 0)) best = i;
	return best;
}

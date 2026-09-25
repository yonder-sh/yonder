/**
 * "Are you Audrey?" (ADDENDUM §10): which placeholder looks like a person.
 * Shared by the client prompts (GuestNudge, the Share dialog's "This is me")
 * and the server checks (`claimPlaceholder`, `promoteGuestCore`), so the UI
 * never offers what the server refuses. Pure: no server or DOM imports.
 */

export type ClaimPerson = { name: string; firstName?: string | null };

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** The person's full and first name, normalized (empty strings dropped). */
function namesOf(person: ClaimPerson): { full: string; first: string } {
	const full = norm(person.name);
	const first = norm(person.firstName || full.split(" ")[0] || "");
	return { full, first };
}

/** A placeholder named like this person: their full name, or their first name. */
export function nameMatchesPerson(
	placeholderName: string,
	person: ClaimPerson,
): boolean {
	const name = norm(placeholderName);
	if (!name) return false;
	const { full, first } = namesOf(person);
	return (!!full && name === full) || (!!first && name === first);
}

/**
 * The one placeholder that looks like this person: a full-name match wins,
 * else the only first-name match; null when none or ambiguous.
 */
export function matchingPlaceholder<T extends { name: string; status: string }>(
	members: readonly T[],
	person: ClaimPerson,
): T | null {
	const live = members.filter((m) => m.status === "placeholder");
	const { full } = namesOf(person);
	const exact = live.filter((m) => !!full && norm(m.name) === full);
	if (exact.length) return exact.length === 1 ? (exact[0] ?? null) : null;
	const hits = live.filter((m) => nameMatchesPerson(m.name, person));
	return hits.length === 1 ? (hits[0] ?? null) : null;
}

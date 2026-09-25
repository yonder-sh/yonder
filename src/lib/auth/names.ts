import { z } from "zod";
import { BIRD_NAMES } from "@/data/bird-names";

/**
 * Person and guest names (SPEC §11.1, SECURITY §2 "Anonymous display names").
 * Names are user content: they are NFC-normalized, stripped of control and
 * format characters (bidi overrides such as U+202E, zero-width U+200B…), and
 * always rendered as React text. Letters, marks, apostrophes, hyphens and
 * markup-looking text are kept exactly (QA AUTH-03 stores "<img …>" verbatim
 * and shows it as literal text).
 */

// \p{Cc} control, \p{Cf} format (bidi/zero-width), \p{Co} private use,
// \p{Cn} unassigned, \p{Zl}/\p{Zp} line and paragraph separators.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;

/** NFC, whitespace (incl. tabs/newlines) → one space, drop invisible characters, trim. */
export function cleanName(raw: string): string {
	return raw
		.normalize("NFC")
		.replace(/\s+/gu, " ")
		.replace(INVISIBLE, "")
		.replace(/ {2,}/g, " ")
		.trim();
}

export const PERSON_NAME_MAX = 60;
export const GUEST_NAME_MAX = 40;

/** A first or last name: 1–60 characters after cleaning. */
export const PersonName = z
	.string()
	.transform(cleanName)
	.pipe(
		z
			.string()
			.min(1, "Required")
			.max(PERSON_NAME_MAX, `At most ${PERSON_NAME_MAX} characters`),
	);

/** A guest's display name (`renameGuest`): 1–40 characters after cleaning. */
export const GuestName = z
	.string()
	.transform(cleanName)
	.pipe(
		z
			.string()
			.min(1, "Required")
			.max(GUEST_NAME_MAX, `At most ${GUEST_NAME_MAX} characters`),
	);

export const PersonNames = z.object({
	firstName: PersonName,
	lastName: PersonName,
});
export type PersonNames = z.output<typeof PersonNames>;

type MaybeNamed = {
	firstName?: string | null;
	lastName?: string | null;
};

/** Both names are set (null and "" both mean "not set", §6.2). */
export function hasFullName(u: MaybeNamed): boolean {
	return Boolean(u.firstName?.trim() && u.lastName?.trim());
}

/** "First Last", or "" when either is missing. */
export function fullName(u: MaybeNamed): string {
	return hasFullName(u) ? `${u.firstName?.trim()} ${u.lastName?.trim()}` : "";
}

/** Up to two initials, by grapheme (so "Thảo Nguyễn" → "TN", emoji stay whole). */
export function initials(name: string): string {
	const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const words = cleanName(name).split(" ").filter(Boolean);
	const firstGrapheme = (w: string) =>
		seg.segment(w)[Symbol.iterator]().next().value?.segment ?? "";
	const picked =
		words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
	return picked
		.map((w) => firstGrapheme(w ?? ""))
		.join("")
		.toLocaleUpperCase();
}

/** Guest names for Better Auth anonymous users: "Guest Heron". */
const BIRDS = BIRD_NAMES;

/** A random "Guest <Bird>" name. `rand` is injectable for tests. */
export function randomGuestName(rand: () => number = Math.random): string {
	const bird = BIRDS[Math.floor(rand() * BIRDS.length) % BIRDS.length];
	return `Guest ${bird}`;
}

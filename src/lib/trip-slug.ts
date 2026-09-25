/**
 * Trip addresses (`/t/<slug>`): a readable part and an unguessable tail, like
 * Notion (`asia-2027-k7m2qxw9`). The address is the trip's share link (like
 * Google Drive): members open it as members, and anyone else gets the trip's
 * "Anyone with the link" role when that is on. The tail is what makes it
 * unguessable, so every app flow that makes or changes an address gives it
 * one (create, duplicate, import, editing the address, turning link access
 * on, "Reset link"). Seeds may keep tail-less slugs (`asia-2027`): the rule
 * lives in those flows, not in a database constraint.
 *
 * `trips.slug` holds the whole address; `trips.slug_tail` the tail (null for
 * a seed's tail-less slug), so the readable part is never guessed from the
 * text. Isomorphic: the settings dialog splits the address with it too.
 */
import { slugify } from "./engine/tree";

/** Lowercase letters and digits without the look-alikes 0/o, 1/l and i: 31 characters. */
export const SLUG_TAIL_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
/** 31^8 ≈ 8.5·10^11 addresses per readable part (≈ 39.6 bits). */
export const SLUG_TAIL_LENGTH = 8;
/** `^[a-z0-9-]{1,100}$` for the whole slug, minus `-` and the tail. */
export const SLUG_BASE_MAX = 100 - 1 - SLUG_TAIL_LENGTH;

/** A whole address (`trips_slug_ck`). */
export const TRIP_SLUG_RE = /^[a-z0-9-]{1,100}$/;

export function isTripSlug(v: unknown): v is string {
	return typeof v === "string" && TRIP_SLUG_RE.test(v);
}

export const SLUG_TAIL_RE = new RegExp(
	`^[${SLUG_TAIL_ALPHABET}]{${SLUG_TAIL_LENGTH}}$`,
);
/** The readable part the owner types: lowercase letters, digits and dashes. */
export const SLUG_BASE_RE = new RegExp(`^[a-z0-9-]{1,${SLUG_BASE_MAX}}$`);

export function isSlugTail(v: unknown): v is string {
	return typeof v === "string" && SLUG_TAIL_RE.test(v);
}

/**
 * A fresh tail from the CSPRNG. Rejection sampling keeps every character
 * equally likely (bytes 248..255 would favour the first 8 characters).
 */
export function newSlugTail(
	random: (n: number) => Uint8Array = (n) =>
		crypto.getRandomValues(new Uint8Array(n)),
): string {
	const limit = 256 - (256 % SLUG_TAIL_ALPHABET.length);
	let out = "";
	while (out.length < SLUG_TAIL_LENGTH) {
		for (const b of random(SLUG_TAIL_LENGTH * 2)) {
			if (b >= limit) continue;
			out += SLUG_TAIL_ALPHABET[b % SLUG_TAIL_ALPHABET.length];
			if (out.length === SLUG_TAIL_LENGTH) break;
		}
	}
	return out;
}

/**
 * Cleans a typed readable part: lowercase, spaces and other characters to
 * dashes, no leading, trailing or doubled dashes, at most SLUG_BASE_MAX.
 * "" when nothing usable is left.
 */
export function cleanSlugBase(v: string): string {
	return v
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, SLUG_BASE_MAX)
		.replace(/-+$/, "");
}

/** The readable part for a trip name (`slugify`, then fitted to SLUG_BASE_MAX). */
export function slugBaseFromName(name: string, id: string): string {
	return cleanSlugBase(slugify(name, id)) || "trip";
}

/** `base-tail`. */
export function withSlugTail(base: string, tail: string): string {
	return `${base}-${tail}`;
}

/**
 * Splits an address into its readable part and tail. `tail` is the trip's
 * `slug_tail`: null (a seed's tail-less slug) leaves the whole slug readable.
 */
export function splitTripSlug(
	slug: string,
	tail: string | null | undefined,
): { base: string; tail: string | null } {
	if (tail && slug.endsWith(`-${tail}`))
		return { base: slug.slice(0, -(tail.length + 1)), tail };
	return { base: slug, tail: null };
}

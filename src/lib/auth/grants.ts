import { AUTH_BRAND } from "./constants";

/**
 * `localStorage["yonder:grants"]` = the trip slugs this browser opened as a
 * link guest (SPEC §11.2; the 2026-09-25 redesign: the trip's address is its
 * link, so there is no token to keep). It only decides how a trip that
 * stops opening reads: "This link is no longer active" for a trip this
 * browser had link access to, the plain "no access" page for any other.
 * Every accessor tolerates SSR, private mode and corrupted JSON.
 */
const KEY = AUTH_BRAND.storage.grants;
/** Slugs whose link stopped working here (see `markGrantGone`). */
const GONE_KEY = AUTH_BRAND.storage.grantsGone;
/** Enough for any realistic number of links on one device. */
const MAX = 50;

function storage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

/** A JSON list of strings; an older `{ slug: token }` object reads as its slugs. */
function readList(key: string): string[] {
	const raw = storage()?.getItem(key);
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		const list = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === "object"
				? Object.keys(parsed)
				: [];
		return list.filter((s): s is string => typeof s === "string");
	} catch {
		return [];
	}
}

function writeList(key: string, slugs: string[]): void {
	try {
		if (slugs.length) storage()?.setItem(key, JSON.stringify(slugs));
		else storage()?.removeItem(key);
	} catch {
		// quota or private mode: the plain "no access" page will do
	}
}

export function readGrants(): string[] {
	return readList(KEY);
}

/** Whether this browser opened `slug` as a link guest (and hasn't lost it). */
export function hasGrant(slug: string): boolean {
	return readGrants().includes(slug);
}

/** This browser just opened `slug` through its link. */
export function saveGrant(slug: string): void {
	writeList(KEY, [...readGrants().filter((s) => s !== slug), slug].slice(-MAX));
	const gone = readList(GONE_KEY);
	if (gone.includes(slug))
		writeList(
			GONE_KEY,
			gone.filter((s) => s !== slug),
		);
}

export function forgetGrant(slug: string): void {
	writeList(
		KEY,
		readGrants().filter((s) => s !== slug),
	);
}

export function clearGrants(): void {
	try {
		storage()?.removeItem(KEY);
		storage()?.removeItem(GONE_KEY);
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// Links that stopped working (QA LINK-04/05/07)
// ---------------------------------------------------------------------------

/**
 * `localStorage["yonder:grants-gone"]` = the slugs whose link was turned off
 * or reset while this browser held it. Only those say "This link is no
 * longer active" (and keep saying it on reload); any other trip a guest
 * can't open is the plain "no access" page, and the trips they do have are
 * left alone.
 */
export function markGrantGone(slug: string): void {
	forgetGrant(slug);
	writeList(
		GONE_KEY,
		[...readList(GONE_KEY).filter((s) => s !== slug), slug].slice(-MAX),
	);
}

/**
 * Whether a guest who can't open `slug` lost link access to it: a trip this
 * browser opened through its link (it now answers NOT_FOUND, so the link was
 * turned off or reset), or one already marked gone. False for a trip the
 * guest never opened (QA LINK-07).
 */
export function lostLinkFor(slug: string): boolean {
	return hasGrant(slug) || readList(GONE_KEY).includes(slug);
}

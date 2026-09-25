import { AUTH_BRAND } from "./constants";
import { isShareToken } from "./share-link";

/**
 * `localStorage["yonder:grants"]` = `{ [tripSlug]: shareToken }` (SPEC §11.2):
 * lets a guest whose session expired re-redeem the link they came in with.
 * Every accessor tolerates SSR, private mode and corrupted JSON.
 */
const KEY = AUTH_BRAND.storage.grants;
/** Slugs whose link stopped working here (see `markGrantGone`). */
const GONE_KEY = AUTH_BRAND.storage.grantsGone;
/** Enough for any realistic number of links on one device. */
const GONE_MAX = 50;

function storage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

export function readGrants(): Record<string, string> {
	const raw = storage()?.getItem(KEY);
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return {};
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(e): e is [string, string] =>
					typeof e[0] === "string" && isShareToken(e[1]),
			),
		);
	} catch {
		return {};
	}
}

function write(grants: Record<string, string>): void {
	try {
		storage()?.setItem(KEY, JSON.stringify(grants));
	} catch {
		// quota or private mode: re-redeem just won't be available
	}
}

export function grantFor(slug: string): string | null {
	return readGrants()[slug] ?? null;
}

export function saveGrant(slug: string, token: string): void {
	write({ ...readGrants(), [slug]: token });
	unmarkGone(slug);
}

export function forgetGrant(slug: string): void {
	const { [slug]: _dropped, ...rest } = readGrants();
	write(rest);
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
 * `localStorage["yonder:grants-gone"]` = the slugs whose remembered link was
 * turned off or replaced while this browser held it. Only those say "This
 * link is no longer active" (and keep saying it on reload, after the token
 * itself is forgotten); any other trip a guest can't open is the plain "no
 * access" page, and its grant (for another trip) is left alone.
 */
function readGone(): string[] {
	const raw = storage()?.getItem(GONE_KEY);
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((s): s is string => typeof s === "string")
			: [];
	} catch {
		return [];
	}
}

function writeGone(slugs: string[]): void {
	try {
		if (slugs.length) storage()?.setItem(GONE_KEY, JSON.stringify(slugs));
		else storage()?.removeItem(GONE_KEY);
	} catch {
		// quota or private mode
	}
}

function unmarkGone(slug: string): void {
	const gone = readGone();
	if (gone.includes(slug)) writeGone(gone.filter((s) => s !== slug));
}

/** The link for `slug` stopped working: forget its token, remember that it went. */
export function markGrantGone(slug: string): void {
	forgetGrant(slug);
	writeGone([...readGone().filter((s) => s !== slug), slug].slice(-GONE_MAX));
}

/**
 * Whether a guest who can't open `slug` lost a link to it: a remembered token
 * for that slug (the trip now answers NOT_FOUND, so the link was turned off
 * or replaced), or a link already marked gone. False for a trip the guest
 * never had a link to (QA LINK-07).
 */
export function lostLinkFor(slug: string): boolean {
	return grantFor(slug) !== null || readGone().includes(slug);
}

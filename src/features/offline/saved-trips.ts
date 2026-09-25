/**
 * The last-loaded trip is the one kept offline (SPEC §16.4, decision 9, QA
 * PWA-05). `markTripSaved` runs after the workspace's graph loads;
 * `removeTripOffline` runs on access loss, NOT_FOUND, leaving and sign-out
 * (`removeTripPageOffline` when only the slug is known: the trip error page),
 * and `forgetLostTrips` whenever a fresh `listMyTrips` answer no longer has a
 * saved trip (QA PWA-08: removed while away, the next online open purges it).
 *
 * Offline data = the localStorage index (read by `public/offline.html` and the
 * dashboard's offline redirect), the persisted query cache (IndexedDB, F's
 * persister), the service worker's cached page shell (`pages` cache, keyed
 * `/t/<slug>`) and WP-Media's offline documents (`yonder-docs-<tripId>`).
 * Only one trip is kept: saving one drops the others.
 */
import { BRAND } from "@/lib/brand";
import { removePersistedTrip } from "@/lib/query/persister";

export type SavedTrip = {
	slug: string;
	tripId: string;
	name: string;
	savedAt: number;
};

function storage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

export function readSavedTrips(): SavedTrip[] {
	try {
		const raw = storage()?.getItem(BRAND.storage.savedTrips);
		const list = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(list)
			? (list as SavedTrip[]).filter(
					(t) =>
						t &&
						typeof t.slug === "string" &&
						typeof t.tripId === "string" &&
						/^[a-z0-9-]{1,100}$/.test(t.slug),
				)
			: [];
	} catch {
		return [];
	}
}

/** Drops the whole index (sign-out). */
export function clearSavedTrips(): void {
	try {
		storage()?.removeItem(BRAND.storage.savedTrips);
	} catch {
		// ignore
	}
}

/** The SW's cached shell of a trip page (`pages` cache, one key per slug). */
async function removeCachedShell(slug: string): Promise<void> {
	if (typeof caches === "undefined") return;
	try {
		const cache = await caches.open("pages");
		await cache.delete(`${window.location.origin}/t/${slug}`, {
			ignoreSearch: true,
		});
	} catch {
		// no Cache Storage (private mode): nothing cached anyway
	}
}

export async function markTripSaved(
	slug: string,
	tripId: string,
	name: string,
): Promise<void> {
	const all = readSavedTrips();
	const others = all.filter((t) => t.tripId !== tripId);
	try {
		storage()?.setItem(
			BRAND.storage.savedTrips,
			JSON.stringify([
				{ slug, tripId, name, savedAt: Date.now() } satisfies SavedTrip,
			]),
		);
	} catch {
		// quota / private mode: offline reading just won't be available
	}
	// A renamed slug leaves the old shell behind: drop it too.
	const renamed = all.find((t) => t.tripId === tripId && t.slug !== slug);
	await Promise.all([
		...others.map((t) =>
			Promise.all([removePersistedTrip(t.tripId), removeCachedShell(t.slug)]),
		),
		...(renamed ? [removeCachedShell(renamed.slug)] : []),
	]);
}

/**
 * WP-Media's offline documents of a trip (ADDENDUM §9: small PDFs as page
 * images, Cache Storage `yonder-docs-<tripId>`, see
 * `features/media/offline/doc-cache.ts`). Named here, not imported, so this
 * module stays free of media code.
 */
async function removeTripDocs(tripId: string): Promise<void> {
	if (typeof caches === "undefined") return;
	try {
		await caches.delete(`yonder-docs-${tripId}`);
	} catch {
		// no Cache Storage: nothing kept
	}
}

export async function removeTripOffline(tripId: string): Promise<void> {
	const all = readSavedTrips();
	const gone = all.find((t) => t.tripId === tripId);
	const rest = all.filter((t) => t.tripId !== tripId);
	try {
		storage()?.setItem(BRAND.storage.savedTrips, JSON.stringify(rest));
	} catch {
		// ignore
	}
	await Promise.all([
		removePersistedTrip(tripId),
		removeTripDocs(tripId),
		...(gone ? [removeCachedShell(gone.slug)] : []),
	]);
}

/**
 * QA PWA-08 / LINK-04: a trip page that answered "no access". The workspace
 * is client-rendered, so that visit's navigation answered 200 and the service
 * worker kept its shell under `/t/<slug>`; offline, the shell would open this
 * trip's error page instead of offline.html's "Not available offline". Drops
 * that shell even when the index no longer lists the slug (a dashboard visit
 * purged the saved copy first), and the saved copy when it still does.
 * `slug` is the path segment as it appears in the URL.
 */
export async function removeTripPageOffline(slug: string): Promise<void> {
	if (!slug) return;
	let plain = slug;
	try {
		plain = decodeURIComponent(slug);
	} catch {
		// a malformed escape: no saved slug looks like that
	}
	const saved = readSavedTrips().find((t) => t.slug === plain);
	await Promise.all([
		saved ? removeTripOffline(saved.tripId) : undefined,
		removeCachedShell(slug),
	]);
}

/**
 * A load that never reached the server: the browser says it's offline, or
 * the fetch itself failed (DNS, a dropped socket, the server gone). Server
 * answers (`NOT_FOUND`, 500, …) and bugs (other TypeErrors) are not.
 */
export function isNetworkFailure(e: unknown): boolean {
	if (typeof navigator !== "undefined" && navigator.onLine === false)
		return true;
	return (
		e instanceof TypeError &&
		/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(
			e.message,
		)
	);
}

/**
 * QA PWA-08 (R-SEC-1): `liveTripIds` is a fresh server answer (`listMyTrips`,
 * never a restored copy) of every trip this account can open. A saved trip
 * that isn't among them loses its offline copy: the index entry (so the
 * offline cold start and `offline.html` don't go there), the page shell, the
 * persisted queries and its documents. Only entries saved before `askedAt`
 * are judged, so a trip saved while the list was in flight stays. The index
 * is rewritten synchronously; the caches follow. Returns the dropped ids.
 */
export function forgetLostTrips(
	liveTripIds: Iterable<string>,
	askedAt: number,
): { dropped: string[]; done: Promise<void> } {
	const live = new Set(liveTripIds);
	const dropped = readSavedTrips()
		.filter((t) => !live.has(t.tripId) && !(t.savedAt >= askedAt))
		.map((t) => t.tripId);
	// Each call rewrites the index before its first await.
	const done = Promise.all(dropped.map((id) => removeTripOffline(id))).then(
		() => undefined,
	);
	return { dropped, done };
}

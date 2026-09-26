/**
 * After a deploy, an open tab's lazy chunks (the lightbox, the map, …) are
 * gone from the server: a chunk that fails to load reloads the page onto the
 * new build. At most once a minute, so an outage doesn't loop; offline, the
 * error stands.
 */
const KEY = "yonder:stale-reload";
const GAP_MS = 60_000;

/** Reload now? Online, and no reload for this in the last minute. */
export function shouldReload(
	last: number | null,
	now: number,
	online: boolean,
): boolean {
	return online && (last === null || now - last >= GAP_MS);
}

function lastReload(): number | null {
	try {
		const v = Number(sessionStorage.getItem(KEY));
		return v > 0 ? v : null;
	} catch {
		return null;
	}
}

export function watchStaleChunks(): () => void {
	const onError = () => {
		const now = Date.now();
		if (!shouldReload(lastReload(), now, navigator.onLine)) return;
		try {
			sessionStorage.setItem(KEY, String(now));
		} catch {
			// no storage: the reload still helps
		}
		window.location.reload();
	};
	window.addEventListener("vite:preloadError", onError);
	return () => window.removeEventListener("vite:preloadError", onError);
}

/**
 * Service-worker registration (SPEC §12.5 `registerServiceWorker()`, §16.1,
 * §16.3; QA PWA-01, PWA-09) with workbox-window:
 *
 * - registers `/sw.js` (production builds only; `vite dev` has none);
 * - a waiting worker shows the toast "Update ready · Reload"; Reload sends
 *   SKIP_WAITING and the page reloads once the new worker controls it;
 * - on `sw-activated` (the worker dropped its `pages` cache) the page re-warms
 *   its saved trip's shell, so the offline copy never points at deleted assets;
 * - when a worker first controls the page, every `/assets/` file the page
 *   already loaded is fetched once through it, so chunks the precache left
 *   out (the 2.5 MB budget, `sw.config.ts`) land in the runtime cache;
 * - checks for updates hourly;
 * - `warmShareInbox()` (the signed-in dashboard) asks the worker to keep the
 *   `/share` shell, so a share sent offline still opens the inbox (E8).
 */
import { toast } from "sonner";
import { readSavedTrips } from "./saved-trips";

let started = false;

/** Fetches the saved trip's page so the worker caches its shell again. */
export async function rewarmSavedTrip(): Promise<void> {
	const saved = readSavedTrips()[0];
	if (!saved || !navigator.onLine) return;
	try {
		await fetch(`/t/${encodeURIComponent(saved.slug)}`, {
			credentials: "same-origin",
			headers: { Accept: "text/html" },
		});
	} catch {
		// offline or blocked: it re-caches on the next visit
	}
}

/**
 * E8 offline: the worker keeps the `/share` shell (it skips when it has one;
 * signed out it keeps nothing). A no-op without a controlling worker.
 */
export function warmShareInbox(): void {
	try {
		if (typeof navigator === "undefined" || !navigator.onLine) return;
		navigator.serviceWorker?.controller?.postMessage({ type: "WARM_SHARE" });
	} catch {
		// no worker
	}
}

/** Same-origin `/assets/*.{js,css,woff2}` this page has loaded so far. */
export function loadedAssetUrls(
	entries: readonly { name: string }[],
	origin: string,
): string[] {
	const out = new Set<string>();
	for (const e of entries) {
		try {
			const u = new URL(e.name);
			if (
				u.origin === origin &&
				/^\/assets\/[^/]+\.(?:js|css|woff2)$/.test(u.pathname)
			)
				out.add(u.origin + u.pathname);
		} catch {
			// not a URL
		}
	}
	return [...out];
}

/**
 * Fetches the page's own assets through the (now controlling) worker: the
 * precached ones answer from the precache, the others are stored by the
 * `assets-lazy` route. The HTTP cache serves them, so it costs no download.
 */
export async function warmLoadedAssets(): Promise<void> {
	if (!navigator.serviceWorker?.controller || !navigator.onLine) return;
	const urls = loadedAssetUrls(
		performance.getEntriesByType("resource"),
		window.location.origin,
	);
	for (const url of urls)
		await fetch(url, { credentials: "same-origin" }).catch(() => undefined);
}

export async function registerServiceWorker(): Promise<void> {
	if (started || typeof window === "undefined") return;
	if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
	started = true;
	const { Workbox } = await import("workbox-window");
	const wb = new Workbox("/sw.js", { scope: "/" });
	let reloading = false;
	wb.addEventListener("waiting", () => {
		toast("Update ready", {
			id: "sw-update",
			duration: Number.POSITIVE_INFINITY,
			description: "A new version of Yonder is available.",
			action: {
				label: "Reload",
				onClick: () => {
					wb.addEventListener("controlling", () => {
						if (reloading) return;
						reloading = true;
						window.location.reload();
					});
					wb.messageSkipWaiting();
				},
			},
		});
	});
	navigator.serviceWorker.addEventListener("message", (e) => {
		if ((e.data as { type?: string } | null)?.type === "sw-activated")
			void rewarmSavedTrip().then(warmLoadedAssets);
	});
	// The first install: nothing this page loaded went through the worker yet.
	if (!navigator.serviceWorker.controller)
		navigator.serviceWorker.addEventListener(
			"controllerchange",
			() => void warmLoadedAssets(),
			{ once: true },
		);
	try {
		const reg = await wb.register();
		setInterval(() => void reg?.update().catch(() => {}), 60 * 60 * 1000);
	} catch (e) {
		console.warn("[sw] registration failed", e);
	}
}

/**
 * The service worker (SPEC §16.3; ADDENDUM §3 PWA, §10 "offline is
 * read-only"; EXTENSIONS §10 E8), built by `sw.config.ts` with Serwist's
 * `runBuildCommand` (esbuild bundles this file; the precache manifest is
 * injected at `self.__SW_MANIFEST`). Never imported by the app bundle.
 *
 * - App shell precached (hashed assets, offline.html, manifest, icons).
 * - Trip pages `/t/*`: NetworkFirst (4 s), cached under `/t/<slug>` (the
 *   workspace is client-rendered, so every scope/lens/tab URL shares one
 *   shell); offline → that trip's shell, else `offline.html` (which forwards
 *   to the saved trip, or says this one isn't available offline). The shell
 *   answers 200 whatever the access (`ssr: false`), so a visit that ends in
 *   "no access" has its entry dropped by the page (TripError →
 *   `removeTripPageOffline`, QA PWA-08 / LINK-04).
 * - Other pages: NetworkFirst (4 s) → `offline.html`.
 * - Lazy assets, media thumbs and PDF pages, map tiles/fonts/styles:
 *   CacheFirst with limits (PDF pages also from WP-Media's `yonder-docs-*`).
 * - Auth, provider proxies, test routes, `/collab` and server functions:
 *   network only (trip data offline comes from the persisted query cache; the
 *   route guards fall back to the persisted session, SPEC §16.4).
 * - E8 share target: the POST to `/share` is stored on the device
 *   (IndexedDB `yonder-share`) and answered with 303 `/share?id=`. The
 *   `/share` page (client-rendered, `ssr: false`) is NetworkFirst under one
 *   key, warmed while signed in (on activate and on the page's
 *   `WARM_SHARE`), so offline the inbox still opens and says "You're
 *   offline — it's kept on this device"; with no shell yet, `offline.html`
 *   says the same (never the browser's error page).
 * - Updates wait for the page's "Reload" (SKIP_WAITING); on activate the
 *   `pages` cache is dropped and pages are told to re-warm their saved trip.
 *
 * No DOM-only code here. The app's TS program includes the DOM lib, so the
 * worker scope is typed locally below instead of with `lib: ["webworker"]`.
 */
import {
	CacheableResponsePlugin,
	CacheFirst,
	ExpirationPlugin,
	NetworkFirst,
	NetworkOnly,
	type PrecacheEntry,
	Serwist,
	type SerwistPlugin,
} from "serwist";
import {
	putShared,
	type SharedFile,
	sanitizeShared,
} from "./features/offline/share-store";

type ExtendableEvent = Event & { waitUntil(p: Promise<unknown>): void };
type FetchEvent = ExtendableEvent & {
	request: Request;
	respondWith(r: Response | Promise<Response>): void;
};
type MessageEventLike = ExtendableEvent & { data: unknown };
type WorkerClient = { postMessage(msg: unknown): void };
type Scope = {
	__SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
	location: Location;
	clients: {
		matchAll(o?: {
			type?: "window" | "all";
			includeUncontrolled?: boolean;
		}): Promise<WorkerClient[]>;
		claim(): Promise<void>;
	};
	skipWaiting(): Promise<void>;
	addEventListener(type: "fetch", fn: (e: FetchEvent) => void): void;
	addEventListener(type: "message", fn: (e: MessageEventLike) => void): void;
	addEventListener(type: "activate", fn: (e: ExtendableEvent) => void): void;
};
declare const self: Scope;

const PAGES = "pages";
const OFFLINE_URL = "/offline.html";
/** The E8 inbox page; every `/share?…` shares this one cached shell. */
const SHARE_PATH = "/share";

/** `/t/<slug>/…?…` → `/t/<slug>` (one shell per trip). */
function tripShellKey(url: URL): string {
	const slug = url.pathname.split("/")[2] ?? "";
	return new URL(`/t/${slug}`, url.origin).href;
}

const serwist = new Serwist({
	precacheEntries: self.__SW_MANIFEST,
	precacheOptions: { cleanupOutdatedCaches: true },
	skipWaiting: false,
	clientsClaim: true,
	navigationPreload: false,
	disableDevLogs: true,
});

async function offlinePage(): Promise<Response> {
	return (
		(await serwist.matchPrecache(OFFLINE_URL)) ??
		(await caches.match(OFFLINE_URL)) ??
		new Response("You're offline.", {
			status: 503,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		})
	);
}

const tripPagePlugin: SerwistPlugin = {
	cacheKeyWillBeUsed: async ({ request }) => tripShellKey(new URL(request.url)),
	handlerDidError: async ({ request }) => {
		const cache = await caches.open(PAGES);
		const own = await cache.match(tripShellKey(new URL(request.url)), {
			ignoreSearch: true,
		});
		if (own) return own;
		// Another trip: offline.html says "Not available offline" and links the
		// saved one (QA PWA-05); it never redirects twice (`from=offline`).
		return offlinePage();
	},
};

const shareKey = () => new URL(SHARE_PATH, self.location.origin).href;

/**
 * Keeps a copy of the `/share` shell (client-rendered: no trip data in it)
 * so a share sent offline lands in ShareInbox. Signed out, `/share` redirects
 * to /login: nothing is kept. Never throws.
 */
async function warmShareShell(): Promise<void> {
	try {
		const cache = await caches.open(PAGES);
		if (await cache.match(shareKey())) return;
		const res = await fetch(shareKey(), {
			credentials: "same-origin",
			headers: { Accept: "text/html" },
		});
		if (
			res.ok &&
			!res.redirected &&
			new URL(res.url).pathname === SHARE_PATH &&
			(res.headers.get("Content-Type") ?? "").includes("text/html")
		)
			await cache.put(shareKey(), res);
	} catch {
		// offline or blocked: the next visit or warm-up keeps it
	}
}

const sharePagePlugin: SerwistPlugin = {
	cacheKeyWillBeUsed: async () => shareKey(),
	// Offline: the cached inbox shell, else offline.html's share message.
	handlerDidError: async () =>
		(await (await caches.open(PAGES)).match(shareKey())) ?? offlinePage(),
};

const pageFallbackPlugin: SerwistPlugin = {
	handlerDidError: async () => offlinePage(),
};

const ok = new CacheableResponsePlugin({ statuses: [200] });

const isOwn = (url: URL) => url.origin === self.location.origin;
const OFM = /^https:\/\/tiles\.openfreemap\.org\//;

// ---- Network only (checked first) --------------------------------------------
for (const prefix of [
	"/api/auth/",
	"/api/places/",
	"/api/test/",
	"/api/health",
	"/collab",
]) {
	serwist.registerCapture(
		({ url }) => isOwn(url) && url.pathname.startsWith(prefix),
		new NetworkOnly(),
	);
}

// ---- Server functions: network only (SPEC §16.3) -------------------------------
// Trip data offline comes from the persisted query cache, and the route guards
// fall back to the persisted session on a network failure (SPEC §16.4), so no
// server answer is ever kept by the worker.
serwist.registerCapture(
	({ url }) => isOwn(url) && url.pathname.startsWith("/_serverFn/"),
	new NetworkOnly(),
);

// ---- Pages ---------------------------------------------------------------------
serwist.registerCapture(
	({ request, url }) =>
		request.mode === "navigate" && isOwn(url) && url.pathname.startsWith("/t/"),
	new NetworkFirst({
		cacheName: PAGES,
		networkTimeoutSeconds: 4,
		matchOptions: { ignoreSearch: true },
		plugins: [ok, tripPagePlugin],
	}),
);
// E8: GET `/share?id=…` (the 303 after a share, online or not).
serwist.registerCapture(
	({ request, url }) =>
		request.mode === "navigate" && isOwn(url) && url.pathname === SHARE_PATH,
	new NetworkFirst({
		cacheName: PAGES,
		networkTimeoutSeconds: 4,
		plugins: [ok, sharePagePlugin],
	}),
);
serwist.registerCapture(
	({ request, url }) =>
		request.mode === "navigate" &&
		isOwn(url) &&
		!url.pathname.startsWith("/api/") &&
		!url.pathname.startsWith("/share"),
	new NetworkFirst({
		cacheName: PAGES,
		networkTimeoutSeconds: 4,
		plugins: [
			ok,
			new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 30 * 86_400 }),
			pageFallbackPlugin,
		],
	}),
);

// ---- Assets and media -------------------------------------------------------------
serwist.registerCapture(
	({ url }) =>
		isOwn(url) && /^\/assets\/.+\.(?:woff2|js|css)$/.test(url.pathname),
	new CacheFirst({
		cacheName: "assets-lazy",
		plugins: [
			ok,
			new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 86_400 }),
		],
	}),
);
// Media variants that stream same-origin (WP-Media: `thumb`, `image`,
// `favicon`, PDF pages `page-<n>`; `display`/`original`/`poster` are 302s to
// presigned S3 URLs and never cached). Thumbs seen online show offline (QA
// PWA-10). Offline, a miss falls back to any cache holding the URL: WP-Media
// keeps the last trip's small PDFs (≤ 5 MB) as page images in
// `yonder-docs-<tripId>` (ADDENDUM §9), so the PDF viewer works offline.
const anyCacheFallback: SerwistPlugin = {
	handlerDidError: async ({ request }) =>
		(await caches.match(request, { ignoreVary: true })) ?? undefined,
};
serwist.registerCapture(
	({ url }) =>
		isOwn(url) &&
		/^\/media\/[^/]+\/(?:thumb|image|favicon|page-\d{1,3})$/.test(url.pathname),
	new CacheFirst({
		cacheName: "media-thumbs",
		plugins: [
			ok,
			new ExpirationPlugin({ maxEntries: 600, maxAgeSeconds: 60 * 86_400 }),
			anyCacheFallback,
		],
	}),
);

// ---- Map (OpenFreeMap: cached as browsed; the terms forbid bulk prefetch) -------
const planetKey: SerwistPlugin = {
	// Each planet rebuild renames the tile path; one key keeps cached tiles useful.
	cacheKeyWillBeUsed: async ({ request }) =>
		request.url.replace(/\/planet\/[^/]+_pt\//, "/planet/_/"),
};
serwist.registerCapture(
	({ url }) => OFM.test(url.href) && /\.(?:pbf|png|webp)$/.test(url.pathname),
	new CacheFirst({
		cacheName: "map-tiles",
		plugins: [
			ok,
			planetKey,
			new ExpirationPlugin({
				maxEntries: 4000,
				maxAgeSeconds: 90 * 86_400,
				purgeOnQuotaError: true,
			}),
		],
	}),
);
serwist.registerCapture(
	({ url }) =>
		OFM.test(url.href) && /^\/(?:fonts|sprites)\//.test(url.pathname),
	new CacheFirst({
		cacheName: "map-assets",
		plugins: [ok, new ExpirationPlugin({ maxEntries: 500 })],
	}),
);
serwist.registerCapture(
	({ url }) => OFM.test(url.href),
	new CacheFirst({
		cacheName: "map-meta",
		plugins: [ok, new ExpirationPlugin({ maxAgeSeconds: 86_400 })],
	}),
);

// ---- E8: Share to Yonder -----------------------------------------------------------
async function receiveShare(request: Request): Promise<Response> {
	try {
		const form = await request.formData();
		const files: SharedFile[] = [];
		for (const f of form.getAll("files")) {
			if (typeof f === "string") continue;
			files.push({ name: f.name, type: f.type, size: f.size, blob: f });
		}
		const id =
			typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
		await putShared(
			sanitizeShared(
				{
					title: form.get("title"),
					text: form.get("text"),
					url: form.get("url"),
					files,
				},
				id,
			),
		);
		return Response.redirect(`/share?id=${encodeURIComponent(id)}`, 303);
	} catch {
		return Response.redirect("/share?lost=1", 303);
	}
}

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (
		event.request.method === "POST" &&
		isOwn(url) &&
		url.pathname === "/share"
	)
		event.respondWith(receiveShare(event.request));
});

// ---- Lifecycle ----------------------------------------------------------------------
self.addEventListener("message", (event) => {
	const data = event.data as { type?: string } | null;
	if (data?.type === "SKIP_WAITING") void self.skipWaiting();
	// A signed-in page (the dashboard) asks for the offline share inbox.
	if (data?.type === "WARM_SHARE") event.waitUntil(warmShareShell());
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			// The old shells may point at deleted hashed assets (spikes/pwa gotcha 5).
			await caches.delete(PAGES);
			// Round 1 kept server-function answers in "api"; nothing uses it now.
			await caches.delete("api");
			await self.clients.claim();
			for (const c of await self.clients.matchAll({ type: "window" }))
				c.postMessage({ type: "sw-activated" });
			// The pages cache was just dropped: keep the share inbox (if signed in).
			await warmShareShell();
		})(),
	);
});

serwist.addEventListeners();

/**
 * `peekLink`'s metadata in the web server (D10): the same cached, SSRF-safe
 * `linkMeta` the preview job reads, without changing this process's fetch.
 * The preview code brings undici (the SSRF-safe fetch's, and
 * open-graph-scraper's), and undici's first import takes over Node's global
 * fetch dispatcher (`safe-fetch.server.ts` then pins it to HTTP/1.1, which
 * the worker keeps). Here that code loads once and the global slots are put
 * back; the SSRF-safe fetch never reads them, every request passes its own
 * agent. No static import here may reach undici.
 */
import type { LinkMeta } from "./preview.server";

/** Where Node's fetch (…1) and undici 7+ (…2) keep the global dispatcher. */
const SLOTS = [
	Symbol.for("undici.globalDispatcher.1"),
	Symbol.for("undici.globalDispatcher.2"),
];

/** Runs `load` (an import that brings undici), then puts the global dispatcher back. */
export async function keepingGlobalFetch<T>(
	load: () => Promise<T>,
): Promise<T> {
	// Node's fetch sets its own dispatcher on first use: have it do so now,
	// so there's one to put back.
	void globalThis.Response;
	const g = globalThis as unknown as Record<symbol, unknown>;
	const before = SLOTS.map((s) => g[s]);
	try {
		return await load();
	} finally {
		// undici defines the slots writable (not configurable): assigning restores them.
		SLOTS.forEach((s, i) => {
			if (g[s] !== before[i]) g[s] = before[i];
		});
	}
}

let preview: Promise<typeof import("./preview.server")> | undefined;

/** The preview code, loaded once (both undici copies inside the guard). */
function loadPreview() {
	preview ??= keepingGlobalFetch(async () => {
		// `linkMeta` imports open-graph-scraper later, after the guard: load it now.
		const [m] = await Promise.all([
			import("./preview.server"),
			import("open-graph-scraper"),
		]);
		return m;
	}).catch((e: unknown) => {
		preview = undefined;
		throw e;
	});
	return preview;
}

/** A link's metadata for `peekLink` (never throws for a failed fetch). */
export async function peekMeta(url: string): Promise<LinkMeta> {
	const { linkMeta } = await loadPreview();
	return linkMeta(url);
}

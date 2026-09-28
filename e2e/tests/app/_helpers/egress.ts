/**
 * The browser's half of "tests never leave this machine" (`pnpm e2e:fast`;
 * the server's half is scripts/no-egress-preload.mjs). Every context gets a
 * route for URLs whose host isn't loopback:
 *   - a video player frame (YouTube, TikTok, Instagram embeds) gets a small
 *     black local page, and so does a page opened outside the app (a popup, a
 *     link followed): both are recorded as "stubbed";
 *   - anything else is aborted and recorded as "refused": the test that made
 *     it fails (fast-test.ts), naming what it asked for.
 * Each record is also appended to E2E_BROWSER_EGRESS_LOG, which e2e:fast
 * counts at the end. The fast config's Chromium also resolves no host but
 * localhost (--host-resolver-rules), so a request a spec's own route lets
 * through still can't leave.
 *
 * Types only from "@playwright/test": in the fast config it maps to
 * fast-test.ts, which imports this file.
 */
import { appendFileSync } from "node:fs";
import type { BrowserContext } from "@playwright/test";

/** http(s)/ws(s) URLs whose host isn't localhost, 127.x or [::1]. */
export const OUTSIDE =
	/^(?!(?:https?|wss?):\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$))(?:https?|wss?):\/\//i;
const PLAYER =
	/^https:\/\/(?:www\.)?(?:youtube-nocookie\.com\/embed\/|youtube\.com\/embed\/|tiktok\.com\/(?:embed|player)\/|instagram\.com\/(?:p|reel|reels|tv)\/[^/]+\/embed)/i;
/** The basemap's TileJSON and tiles, from OpenFreeMap or (e2e:fast) the local map proxy. */
export const MAP_TILES = /tiles\.openfreemap\.org|\/__map\/ofm\//;
/** Esri's World Imagery tiles (Satellite), direct or (e2e:fast) through the map proxy. */
export const ESRI_TILES = /^https:\/\/server\.arcgisonline\.com\/|\/__map\/arcgis\/ArcGIS\/rest\/services\/World_Imagery\//;
/** OpenFreeMap's public styles (the app uses its own). */
export const OFM_STYLES = /openfreemap\.org\/styles\/|\/__map\/ofm\/styles\//;
/** Chromium's own resolver: nothing but localhost resolves (a backstop). */
export const NO_DNS_ARGS = ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"];

export type Egress = {
	action: "refused" | "stubbed";
	host: string;
	url: string;
	type: string;
};

let current = "(no test)";
/** Refused since the last `takeRefused()`. */
const refused: Egress[] = [];

/** Names the running test in the log (fast-test.ts). */
export function setEgressTest(title: string): void {
	current = title;
}

/** The refusals recorded since the last call. */
export function takeRefused(): Egress[] {
	return refused.splice(0);
}

function record(e: Egress): void {
	if (e.action === "refused") refused.push(e);
	const file = process.env.E2E_BROWSER_EGRESS_LOG;
	if (!file) return;
	try {
		appendFileSync(
			file,
			`${JSON.stringify({ t: new Date().toISOString(), test: current, ...e, url: e.url.slice(0, 300) })}\n`,
		);
	} catch {}
}

const page = (title: string, body: string, dark = false) =>
	`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;height:100vh;display:grid;place-items:center;font:14px system-ui,sans-serif;${dark ? "background:#000;color:#bbb" : "background:#fff;color:#444"}">${body}</body>`;

/** Routes `ctx`'s requests to anywhere but loopback (see the module comment). */
export async function guardContext(ctx: BrowserContext): Promise<void> {
	await ctx.route(OUTSIDE, async (route) => {
		const req = route.request();
		const url = req.url();
		const host = new URL(url).host;
		const type = req.resourceType();
		let top = false;
		try {
			top = type === "document" && req.isNavigationRequest() && !req.frame().parentFrame();
		} catch {} // a service worker's request has no frame
		try {
			if (type === "document" && PLAYER.test(url)) {
				record({ action: "stubbed", host, url, type });
				const name = /tiktok/i.test(host) ? "TikTok" : /instagram/i.test(host) ? "Instagram" : "YouTube";
				return await route.fulfill({
					contentType: "text/html",
					body: page(`${name} (e2e)`, `<div>&#9654; ${name} player (not loaded in e2e)</div>`, true),
				});
			}
			if (top) {
				record({ action: "stubbed", host, url, type });
				return await route.fulfill({
					contentType: "text/html",
					body: page(host, `<p>${host}: an outside page, not loaded in e2e.</p>`),
				});
			}
		} catch {
			return; // the page went away meanwhile
		}
		record({ action: "refused", host, url, type });
		await route.abort("blockedbyclient").catch(() => {});
	});
	// What got past the route (a spec's own route let it through, a WebSocket):
	// Chromium can't resolve the host, and it's recorded here. (No
	// routeWebSocket: it would wrap the collab socket too.)
	ctx.on("requestfailed", (req) => {
		const url = req.url();
		if (OUTSIDE.test(url) && /ERR_NAME_NOT_RESOLVED/.test(req.failure()?.errorText ?? ""))
			record({ action: "refused", host: new URL(url).host, url, type: req.resourceType() });
	});
	ctx.on("page", (p) =>
		p.on("websocket", (ws) => {
			const url = ws.url();
			if (OUTSIDE.test(url)) record({ action: "refused", host: new URL(url).host, url, type: "websocket" });
		}),
	);
}

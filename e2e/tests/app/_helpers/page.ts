/** Page helpers shared by the app specs. */
import type { Locator } from "@playwright/test";

/**
 * Waits until React has hydrated `locator`'s element (it carries React's
 * internal fiber key). SSR pages render inputs before hydration; typing into
 * them earlier is lost when React takes over.
 */
export async function hydrated(locator: Locator, timeout = 20_000): Promise<Locator> {
	await locator.waitFor({ state: "visible", timeout });
	await locator.evaluate(
		(el, ms) =>
			new Promise<void>((resolve, reject) => {
				const t0 = Date.now();
				const tick = () => {
					if (Object.keys(el).some((k) => k.startsWith("__reactFiber"))) resolve();
					else if (Date.now() - t0 > ms) reject(new Error("not hydrated"));
					else setTimeout(tick, 50);
				};
				tick();
			}),
		timeout,
	);
	return locator;
}

/**
 * The workspace's collab channel is live: the pill says Live (desktop), or —
 * on compact layouts, which hide the pill while live — no pill is shown.
 */
export async function expectLive(page: import("@playwright/test").Page, timeout = 20_000): Promise<void> {
	const { expect } = await import("@playwright/test");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout });
	await expect
		.poll(
			async () => {
				const statuses = await page
					.getByTestId("connection-pill")
					.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
				return statuses.length === 0 || statuses.includes("live") ? "live" : statuses.join(",");
			},
			{ timeout },
		)
		.toBe("live");
}

/**
 * Collects console errors and warnings plus uncaught page errors, so a spec
 * can assert that an expected path (a revoked trip, a not-found page) stays
 * quiet. `allow` holds known, harmless messages.
 */
export function collectConsole(
	page: import("@playwright/test").Page,
	allow: readonly RegExp[] = [],
): { messages: string[] } {
	const ALWAYS_ALLOWED: RegExp[] = [
		// React DevTools / Vite chatter in dev.
		/Download the React DevTools/,
		/\[vite\]/,
		// Revocation closes the socket on purpose; the browser logs the close.
		/WebSocket connection to .* failed/,
		// Headless Chromium's WebGL driver (SwiftShader) notices once a MapLibre
		// map rasterises labels ("GPU stall due to ReadPixels"): not app errors.
		/GL Driver Message/,
		// The public OpenFreeMap CDN occasionally drops a glyph (font) request;
		// MapLibre renders those characters locally and warns. A network blip on
		// a third-party host, not an app error (seen repeatedly at integration).
		/Unable to load glyph range/,
	];
	const messages: string[] = [];
	const allowed = (text: string) =>
		[...ALWAYS_ALLOWED, ...allow].some((re) => re.test(text));
	page.on("console", (m) => {
		if (m.type() !== "error" && m.type() !== "warning") return;
		const text = m.text();
		if (!allowed(text)) messages.push(`${m.type()}: ${text}`);
	});
	page.on("pageerror", (e) => {
		if (!allowed(e.message)) messages.push(`pageerror: ${e.message}`);
	});
	return { messages };
}

/** No horizontal page scroll (the layout fits the viewport). */
export async function expectNoHorizontalOverflow(
	page: import("@playwright/test").Page,
): Promise<void> {
	const { expect } = await import("@playwright/test");
	const dims = await page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		width: window.innerWidth,
	}));
	expect(dims.scroll, `scrollWidth ${dims.scroll} > ${dims.width}`).toBeLessThanOrEqual(dims.width);
}

/**
 * Loads the CJK @font-face rules (`src/fonts-cjk.css`) once, off the critical
 * path (QA VIS2-10 / PERF-05). Vite emits them as their own stylesheet, which
 * this dynamic import adds to the page; `styles.css` keeps only the Latin
 * fonts, so it no longer carries ~300 kB of unicode-range rules.
 */
let loading: Promise<unknown> | null = null;

export function loadCjkFonts(): Promise<unknown> {
	if (typeof window === "undefined") return Promise.resolve();
	loading ??= import("../fonts-cjk.css").catch(() => {
		// A failed chunk (offline before first use) retries on the next call.
		loading = null;
	});
	return loading;
}

/**
 * QA VIS2-10 / PERF-05: the CJK @font-face rules are not in the render-blocking
 * stylesheet; the root route loads them once after hydration.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCjkFonts } from "./fonts";

describe("CJK fonts off the critical path", () => {
	it("styles.css keeps the Latin fonts and the family stacks, not the Noto faces", () => {
		const css = readFileSync("src/styles.css", "utf8");
		expect(css).not.toMatch(/@import "@fontsource-variable\/noto-sans/);
		expect(css).toMatch(/@import "@fontsource-variable\/commissioner/);
		expect(css).toMatch(/"Noto Sans JP Variable"/);
		const cjk = readFileSync("src/fonts-cjk.css", "utf8");
		for (const f of ["jp", "kr", "tc"])
			expect(cjk).toContain(`@fontsource-variable/noto-sans-${f}/index.css`);
	});

	it("loads once", async () => {
		const a = loadCjkFonts();
		expect(loadCjkFonts()).toBe(a);
		await a;
	});
});

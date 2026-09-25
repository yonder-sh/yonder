/**
 * WP-Map probes (VIS3-07), not part of the regular run: where a lens change
 * spends its main-thread time, by file and function (CDP sampling profiler);
 * what a projection switch costs; and lens-change long tasks with the
 * MapLibre map vs the SVG fallback (no WebGL2), with and without reduced
 * motion. Dev build and headless Chromium's software WebGL (SwiftShader), so
 * absolute numbers are inflated; the split is what matters.
 *
 *   MAP_PERF_PROBE=1 .data/agent-35-e2e.sh tests/app/map-perf-probe.spec.ts --project chromium
 */
import { expect, type Page, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";

test.skip(({ browserName }) => browserName !== "chromium" || process.env.MAP_PERF_PROBE !== "1", "probe");

type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] };

test("profile lens changes on the whole trip", async ({ page }) => {
	test.setTimeout(180_000);
	await loginViaApi(page.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	await page.goto(`/t/${process.env.PROBE_TRIP ?? "asia-2027"}?tab=plan`);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(6000);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Profiler.enable");
	await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
	const byFile = new Map<string, number>();
	const byFn = new Map<string, number>();
	for (const lens of ["Region", "City", "Country", "Area", "Country"]) {
		await cdp.send("Profiler.start");
		const lt = await page.evaluate(
			(lens) =>
				new Promise<number[]>((resolve) => {
					const out: number[] = [];
					const po = new PerformanceObserver((l) => out.push(...l.getEntries().map((e) => Math.round(e.duration))));
					po.observe({ type: "longtask" });
					const btn = [...document.querySelectorAll('[data-testid="lens-control"] button, [role=radio]')].find(
						(b) => b.textContent?.trim() === lens,
					) as HTMLElement;
					btn.click();
					setTimeout(() => {
						po.disconnect();
						resolve(out);
					}, 1500);
				}),
			lens,
		);
		const { profile } = (await cdp.send("Profiler.stop")) as { profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] } };
		const self = new Map<number, number>();
		profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
		// Inclusive attribution: each sample goes to its innermost app frame's folder
		// (or maplibre / react when no app frame is on the stack).
		const parent = new Map<number, number>();
		const byId = new Map(profile.nodes.map((n) => [n.id, n]));
		for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
		const groups = new Map<string, number>();
		profile.samples.forEach((id, i) => {
			const dt = (profile.timeDeltas[i] ?? 0) / 1000;
			let cur: number | undefined = id;
			let group = "";
			let lib = "";
			while (cur !== undefined) {
				const url = byId.get(cur)?.callFrame.url ?? "";
				const m = /\/src\/((?:features|lib|components|routes)\/[^/]+)/.exec(url);
				if (m) {
					group = m[1] ?? "";
					break;
				}
				if (!lib && /maplibre/.test(url)) lib = "maplibre-gl";
				if (!lib && /react-dom|client-|react_jsx|react\.js/.test(url)) lib = "react";
				cur = parent.get(cur);
			}
			const name = byId.get(id)?.callFrame.functionName ?? "";
			const key = group || lib || (name.startsWith("(") ? name : "(other)");
			groups.set(key, (groups.get(key) ?? 0) + dt);
		});
		// The outermost maplibre frame of each sample, and its caller.
		const entries = new Map<string, number>();
		profile.samples.forEach((id, i) => {
			const dt = (profile.timeDeltas[i] ?? 0) / 1000;
			let cur: number | undefined = id;
			let outer: string | null = null;
			let caller = "";
			while (cur !== undefined) {
				const f = byId.get(cur)?.callFrame;
				const url = f?.url ?? "";
				if (/maplibre/.test(url)) {
					outer = `${f?.functionName || "(anon)"}:${f?.lineNumber}`;
					caller = "";
				} else if (outer && !caller) caller = `${f?.functionName || "(anon)"} ${url.split("/").pop()?.replace(/\?.*$/, "")}:${f?.lineNumber}`;
				cur = parent.get(cur);
			}
			if (outer) entries.set(`${outer} <- ${caller}`, (entries.get(`${outer} <- ${caller}`) ?? 0) + dt);
		});
		console.log(
			`  maplibre entries: ${[...entries]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 8)
				.map(([k, v]) => `\n     ${v.toFixed(0)} ${k}`)
				.join("")}`,
		);
		console.log(
			`  groups: ${[...groups]
				.filter(([k]) => k !== "(idle)")
				.sort((a, b) => b[1] - a[1])
				.slice(0, 12)
				.map(([k, v]) => `${k} ${v.toFixed(0)}`)
				.join(" · ")}`,
		);
		for (const n of profile.nodes) {
			const t = (self.get(n.id) ?? 0) / 1000;
			if (!t) continue;
			const url = n.callFrame.url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
			const file = url.includes("node_modules") ? url.replace(/.*node_modules\/(\.pnpm\/)?/, "nm:").split("/").slice(0, 2).join("/") : url;
			byFile.set(file || "(native)", (byFile.get(file || "(native)") ?? 0) + t);
			const fn = `${n.callFrame.functionName || "(anon)"} ${url.split("/").pop()}:${n.callFrame.lineNumber}`;
			byFn.set(fn, (byFn.get(fn) ?? 0) + t);
		}
		console.log(`LENS ${lens}: long tasks ${lt.join(", ")} ms`);
	}
	const top = (m: Map<string, number>, n: number) =>
		[...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0).padStart(6)} ms  ${k}`).join("\n");
	console.log(`BY FILE\n${top(byFile, 40)}\n\nBY FUNCTION\n${top(byFn, 50)}`);
});

test("projection switch cost", async ({ page }) => {
	test.setTimeout(180_000);
	await loginViaApi(page.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	await page.goto(`/t/${process.env.PROBE_TRIP ?? "asia-2027"}?tab=plan`);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => page.evaluate(() => !!(window as unknown as { __tripMap?: unknown }).__tripMap), { timeout: 30_000 }).toBe(true);
	await page.waitForTimeout(4000);
	for (const step of ["mercator", "globe", "mercator", "globe", "jump", "jump"]) {
		const r = await page.evaluate(
			(step) =>
				new Promise<{ sync: number; lt: number[] }>((resolve) => {
					// biome-ignore lint/suspicious/noExplicitAny: probe
					const m = (window as any).__tripMap;
					const out: number[] = [];
					const po = new PerformanceObserver((l) => out.push(...l.getEntries().map((e) => Math.round(e.duration))));
					po.observe({ type: "longtask" });
					const t0 = performance.now();
					if (step === "jump") m.jumpTo({ center: [m.getCenter().lng + 20, m.getCenter().lat], zoom: m.getZoom() });
					else m.setProjection({ type: step });
					const sync = performance.now() - t0;
					setTimeout(() => {
						po.disconnect();
						resolve({ sync: Math.round(sync), lt: out });
					}, 1500);
				}),
			step,
		);
		console.log(`STEP ${step}: sync ${r.sync} ms, long tasks ${r.lt.join(", ")}`);
	}
});

async function run(page: Page): Promise<number[]> {
	await page.goto(`/t/${process.env.PROBE_TRIP ?? "asia-2027"}?tab=plan`);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(5000);
	const totals: number[] = [];
	for (const lens of ["Region", "City", "Country", "Area", "Country"]) {
		const lt = await page.evaluate(
			(lens) =>
				new Promise<number[]>((resolve) => {
					const out: number[] = [];
					const po = new PerformanceObserver((l) => out.push(...l.getEntries().map((e) => Math.round(e.duration))));
					po.observe({ type: "longtask" });
					const btn = [...document.querySelectorAll("[role=radio]")].find((b) => b.textContent?.trim() === lens) as HTMLElement;
					btn.click();
					setTimeout(() => {
						po.disconnect();
						resolve(out);
					}, 1800);
				}),
			lens,
		);
		totals.push(lt.reduce((a, b) => a + b, 0));
	}
	return totals;
}

test("map vs no map", async ({ browser }) => {
	test.setTimeout(300_000);
	for (let round = 0; round < 2; round++) {
		for (const [webgl, reduce] of [
			[true, false],
			[true, true],
			[false, false],
		] as const) {
			const ctx = await browser.newContext({
				viewport: { width: 1440, height: 900 },
				reducedMotion: reduce ? "reduce" : "no-preference",
			});
			const page = await ctx.newPage();
			await loginViaApi(page.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
			if (!webgl)
				await page.addInitScript(() => {
					const orig = HTMLCanvasElement.prototype.getContext;
					// biome-ignore lint/suspicious/noExplicitAny: probe
					(HTMLCanvasElement.prototype as any).getContext = function (this: HTMLCanvasElement, t: string, ...a: unknown[]) {
						if (t === "webgl2") return null;
						// biome-ignore lint/suspicious/noExplicitAny: probe
						return (orig as any).call(this, t, ...a);
					};
				});
			const t = await run(page);
			console.log(`${webgl ? "MAPLIBRE" : "FALLBACK"}${reduce ? " reduced-motion" : ""} long-task ms per change: ${t.join(" / ")}  (sum ${t.reduce((a, b) => a + b, 0)})`);
			await ctx.close();
		}
	}
});

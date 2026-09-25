/**
 * `public/offline.html` can't import TypeScript: its hard-coded localStorage
 * key and loop guard must match the app (SPEC §16.4), the manifest must carry
 * the E8 share target and install fields (QA PWA-01), and the precache
 * selection must follow SPEC §16.1.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRAND } from "@/lib/brand";
import { fitPrecache, precachedAssets } from "../../../../sw.config";
import { loadedAssetUrls } from "../register-sw";
import { sanitizeShared } from "../share-store";

const read = (p: string) => readFileSync(p, "utf8");

describe("offline.html", () => {
	const html = read("public/offline.html");
	it("reads the saved-trips key the app writes", () => {
		expect(html).toContain(`"${BRAND.storage.savedTrips}"`);
	});
	it("redirects once (from=offline) and never on a trip page", () => {
		expect(html).toContain('params.get("from") !== "offline"');
		expect(html).toContain("?from=offline");
		expect(html).toMatch(/!tripPage/);
	});
	it("builds the DOM with textContent only (no innerHTML)", () => {
		expect(html).not.toMatch(/innerHTML|document\.write/);
	});
	it("on /share (E8, shared while offline) says it's kept and never redirects", () => {
		const share = html.slice(
			html.indexOf("if (sharePage)"),
			html.indexOf("// Cold start offline"),
		);
		expect(share).toContain(
			"You're offline — it's kept on this device. Open Yonder later to finish.",
		);
		expect(share).toContain("return;");
		expect(share).not.toContain("location.replace");
		// The share branch runs before the saved-trip redirect.
		expect(html.indexOf("if (sharePage)")).toBeLessThan(
			html.indexOf("location.replace(href)"),
		);
	});
});

describe("service worker (E8 offline share, QA HOME-4)", () => {
	const sw = read("src/sw.ts");
	it("answers GET /share navigations with a cached shell or offline.html", () => {
		expect(sw).toMatch(
			/request\.mode === "navigate" && isOwn\(url\) && url\.pathname === SHARE_PATH/,
		);
		expect(sw).toContain("plugins: [ok, sharePagePlugin]");
		expect(sw).toMatch(/handlerDidError:[\s\S]*?offlinePage\(\)/);
	});
	it("warms the /share shell on activate and on WARM_SHARE", () => {
		expect(sw).toContain('data?.type === "WARM_SHARE"');
		expect(sw).toMatch(
			/addEventListener\("activate"[\s\S]*await warmShareShell\(\)/,
		);
	});
});

describe("manifest.webmanifest", () => {
	const m = JSON.parse(read("public/manifest.webmanifest"));
	it("is installable", () => {
		expect(m).toMatchObject({
			name: "Yonder",
			short_name: "Yonder",
			start_url: "/?source=pwa",
			display: "standalone",
			theme_color: "#f9fafd",
			background_color: "#f9fafd",
		});
		const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
		expect(sizes).toContain("192x192");
		expect(sizes).toContain("512x512");
		expect(
			m.icons.some((i: { purpose: string }) => i.purpose === "maskable"),
		).toBe(true);
	});
	it("declares the E8 share target", () => {
		expect(m.share_target).toMatchObject({
			action: "/share",
			method: "POST",
			enctype: "multipart/form-data",
		});
		expect(m.share_target.params.files[0].accept).not.toContain("image/heic");
	});
});

describe("share-store sanitizing (EXTENSIONS §10 caps)", () => {
	it("keeps http(s) URLs only, trims text, caps files", () => {
		const blob = new Blob(["x"]);
		const files = Array.from({ length: 12 }, (_, i) => ({
			name: `p${i}.jpg`,
			type: "image/jpeg",
			size: 1,
			blob,
		}));
		const e = sanitizeShared(
			{
				title: "  Hi ",
				text: "x".repeat(3000),
				url: "javascript:alert(1)",
				files: [
					...files,
					{ name: "a.heic", type: "image/heic", size: 1, blob },
				],
			},
			"id1",
			42,
		);
		expect(e.url).toBeNull();
		expect(e.title).toBe("Hi");
		expect(e.text?.length).toBe(2000);
		expect(e.files).toHaveLength(10);
		expect(e.createdAt).toBe(42);
		expect(
			sanitizeShared({ url: "https://maps.app.goo.gl/x" }, "id2").url,
		).toBe("https://maps.app.goo.gl/x");
	});
});

describe("precache selection (SPEC §16.1)", () => {
	it("returns [] without a build", () => {
		expect(precachedAssets("/nonexistent")).toEqual([]);
	});
	it("fits the budget: boot assets always, then the smallest chunks", () => {
		const KB = 1024;
		const fit = fitPrecache(
			[
				{ path: "assets/index-AbC1.js", size: 400 * KB },
				{ path: "assets/styles-x_Y.css", size: 300 * KB },
				{
					path: "assets/commissioner-latin-wght-normal-1.woff2",
					size: 40 * KB,
				},
				{ path: "assets/Workspace-Q.js", size: 500 * KB },
				{ path: "assets/select-Z.js", size: 150 * KB },
				{ path: "assets/button-B.js", size: 30 * KB },
			],
			1000 * KB,
			20 * KB,
		);
		expect(fit.keep).toEqual([
			"assets/index-AbC1.js",
			"assets/styles-x_Y.css",
			"assets/commissioner-latin-wght-normal-1.woff2",
			"assets/button-B.js",
			"assets/select-Z.js",
		]);
		expect(fit.left).toEqual(["assets/Workspace-Q.js"]);
		expect(fit.bytes).toBe(940 * KB);
	});
});

describe("warming the runtime cache", () => {
	it("keeps this origin's hashed assets only, once each", () => {
		expect(
			loadedAssetUrls(
				[
					{ name: "https://yonder.test/assets/Workspace-Q.js" },
					{ name: "https://yonder.test/assets/Workspace-Q.js?v=1" },
					{ name: "https://yonder.test/assets/font-latin.woff2" },
					{ name: "https://yonder.test/_serverFn/abc" },
					{ name: "https://tiles.openfreemap.org/assets/x.js" },
					{ name: "not a url" },
				],
				"https://yonder.test",
			),
		).toEqual([
			"https://yonder.test/assets/Workspace-Q.js",
			"https://yonder.test/assets/font-latin.woff2",
		]);
	});
});

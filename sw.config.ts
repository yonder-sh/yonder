/**
 * Service-worker build hook, called by `vite.config.ts` (plugin `yonder:service-worker`)
 * in the client environment's `closeBundle`, i.e. INSIDE `vite build` and before Nitro
 * bakes its static-asset manifest (SPEC D6, §16.1). Owner: WP-Home.
 *
 * Serwist (SPEC D6): `@serwist/cli`'s `runBuildCommand` bundles `src/sw.ts` with
 * esbuild and injects the precache manifest (`self.__SW_MANIFEST`). The generator
 * is imported lazily, so `vite dev` never loads it.
 *
 * Precache = the app shell (hashed JS/CSS, Latin font subsets) within the
 * 2.5 MB budget (SPEC §16.1). The boot files (the entry chunk, the stylesheet,
 * the fonts) always go in; the other chunks go in smallest first while they
 * fit, and the rest are left to the runtime cache (`assets-lazy`): the page
 * warms that cache with every asset it already loaded as soon as the worker
 * controls it (`warmLoadedAssets`), so the offline copy never misses a chunk
 * the precache left out. Everything else the user opens (maplibre, CJK fonts,
 * the lightbox) is cached at runtime too. Nitro copies `public/` only AFTER
 * closeBundle, so files from `public/` are added with `additionalPrecacheEntries`
 * and a content revision.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ServiceWorkerBuildContext {
	/** The client build output directory (Nitro sets it to `.output/public`). */
	outDir: string;
	/** sha1 of a file (path relative to the repo root), for precache revisions. */
	sha: (path: string) => string;
}

/** SPEC §16.1: the precache stays at most 2.5 MB. */
export const PRECACHE_BUDGET_BYTES = 2.5 * 1024 * 1024;

/**
 * The same selection as `globPatterns` / `globIgnores` below, before the
 * budget (Serwist's own counter lives in `@serwist/build`, which isn't a
 * direct dependency).
 */
export function precachedAssets(outDir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(join(outDir, "assets"));
	} catch {
		return [];
	}
	const ignored = (n: string) =>
		/noto-sans-|heic|maplibre|lightbox/.test(n) ||
		/-(?:cyrillic|cyrillic-ext|greek|greek-ext|vietnamese)-.*\.woff2$/.test(n);
	return names
		.filter(
			(n) =>
				(/\.(?:js|css)$/.test(n) ||
					(/latin/.test(n) && n.endsWith(".woff2"))) &&
				!ignored(n),
		)
		.map((n) => `assets/${n}`);
}

/** The entry chunk, the stylesheet and the fonts: a cold offline start needs them. */
export const isBootAsset = (path: string): boolean =>
	/^assets\/(?:index|styles)-[\w-]+\.(?:js|css)$/.test(path) ||
	path.endsWith(".woff2");

/**
 * Fits the precache into `budget` bytes (with `fixedBytes` already taken by
 * the `public/` files): boot assets first, then the other chunks smallest
 * first while they fit. `left` is what the runtime cache handles instead.
 */
export function fitPrecache(
	files: readonly { path: string; size: number }[],
	budget: number,
	fixedBytes = 0,
): { keep: string[]; left: string[]; bytes: number } {
	let bytes = fixedBytes;
	const keep: string[] = [];
	const left: string[] = [];
	const boot = files.filter((f) => isBootAsset(f.path));
	const rest = files
		.filter((f) => !isBootAsset(f.path))
		.sort((a, b) => a.size - b.size || a.path.localeCompare(b.path));
	for (const f of boot) {
		keep.push(f.path);
		bytes += f.size;
	}
	for (const f of rest) {
		if (bytes + f.size <= budget) {
			keep.push(f.path);
			bytes += f.size;
		} else left.push(f.path);
	}
	return { keep, left, bytes };
}

/** Files from `public/` in the precache (the offline fallback and install assets). */
const PUBLIC_PRECACHE = [
	"offline.html",
	"manifest.webmanifest",
	"favicon.svg",
	"icons/icon-192.png",
];

export async function buildServiceWorker({
	outDir,
	sha,
}: ServiceWorkerBuildContext): Promise<void> {
	const { runBuildCommand } = await import("@serwist/cli");
	const config = {
		swSrc: "src/sw.ts",
		swDest: join(outDir, "sw.js"),
		globDirectory: outDir,
		globPatterns: ["assets/*.{js,css}", "assets/*latin*.woff2"],
		globIgnores: [
			"sw.js",
			"**/*noto-sans-*",
			"**/*heic*",
			"**/*maplibre*",
			"**/*lightbox*",
			"**/*-{cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-*.woff2",
		],
		maximumFileSizeToCacheInBytes: 3_000_000,
		additionalPrecacheEntries: PUBLIC_PRECACHE.map((file) => ({
			url: `/${file}`,
			revision: sha(`public/${file}`),
		})),
	};
	const files = precachedAssets(outDir).map((path) => ({
		path,
		size: statSync(join(outDir, path)).size,
	}));
	const fixed = PUBLIC_PRECACHE.reduce(
		(sum, f) => sum + statSync(join("public", f)).size,
		0,
	);
	const fit = fitPrecache(files, PRECACHE_BUDGET_BYTES, fixed);
	const mb = (n: number) => (n / 1024 / 1024).toFixed(2);
	console.log(
		`[sw] precache: ${fit.keep.length + PUBLIC_PRECACHE.length} files, ${mb(fit.bytes)} MB (budget 2.5 MB)`,
	);
	if (fit.left.length)
		console.log(
			`[sw] left to the runtime cache (warmed by the page): ${fit.left.join(", ")}`,
		);
	if (fit.bytes > PRECACHE_BUDGET_BYTES)
		throw new Error(
			`[sw] the boot assets alone are ${mb(fit.bytes)} MB, over the 2.5 MB budget (SPEC §16.1)`,
		);
	config.globIgnores.push(...fit.left);
	await runBuildCommand({
		watch: false,
		config: {
			...config,
			esbuildOptions: {
				define: { "process.env.NODE_ENV": JSON.stringify("production") },
				legalComments: "none",
			},
		},
	});
}

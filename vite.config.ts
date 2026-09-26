import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin, type Rolldown } from "vite";
import { loadDotEnv } from "./scripts/load-env.ts";
import { buildServiceWorker } from "./sw.config.ts";

// Make APP_PORT / HOCUSPOCUS_PORT visible to this file, and the server env
// (DATABASE_URL, REDIS_URL, …) to SSR and server functions in `vite dev`. Never
// overrides variables that are already set (`APP_PORT=5411 pnpm dev:app` works).
// Vite itself only exposes VITE_* to the client.
loadDotEnv();
const APP_PORT = Number(process.env.APP_PORT ?? 3000);
// Nitro's Vite plugin takes the dev-server port from process.env.PORT before
// `server.port`, and .env's PORT is meant for `pnpm start`. APP_PORT is the dev
// knob (SPEC §5.7), so it wins here: `APP_PORT=5411 pnpm dev:app` listens on 5411.
process.env.PORT = String(APP_PORT);
const COLLAB_PORT = Number(process.env.HOCUSPOCUS_PORT ?? 1234);

/** Content hash of a file, used as a precache revision for files Nitro copies after the build. */
const sha = (path: string) =>
	createHash("sha1").update(readFileSync(path)).digest("hex");

// Radix/lucide ship "use client" banners: harmless outside RSC, but every build
// prints dozens of MODULE_LEVEL_DIRECTIVE warnings. Drop just those.
function quietDirectives(
	warning: Rolldown.RollupLog,
	warn: (w: Rolldown.RollupLog) => void,
) {
	if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
	warn(warning);
}

/**
 * SPEC D6: write sw.js INTO the client outDir inside `vite build`, before Nitro
 * bakes its static-asset manifest (a file added after the build is never served).
 * The actual generator lives in `sw.config.ts` (owned by WP-Home), so switching
 * between Serwist and the spike-proven workbox-build never touches this file.
 */
function serviceWorker(): Plugin {
	return {
		name: "yonder:service-worker",
		apply: "build",
		applyToEnvironment: (env) => env.name === "client",
		async closeBundle() {
			const outDir = this.environment.config.build.outDir; // Nitro sets this to .output/public
			await buildServiceWorker({ outDir, sha });
		},
	};
}

export default defineConfig({
	server: {
		port: APP_PORT,
		strictPort: true,
		// The browser always talks to same-origin /collab (Caddy does the same in prod).
		proxy: {
			"/collab": { target: `ws://localhost:${COLLAB_PORT}`, ws: true },
		},
		watch: {
			ignored: [
				"**/spikes/**",
				"**/brand/**",
				"**/e2e/**",
				"**/qa/**",
				"**/infra/**",
				"**/seed/**",
				"**/.data/**",
			],
		},
	},
	optimizeDeps: {
		// Only crawl the app for pre-bundling; never spikes/, e2e/ or brand/ index.html files.
		entries: ["src/**/*.tsx"],
		// Client deps reached only through lazy or client-only routes. Without them Vite
		// discovers them on the first page load, re-bundles, and briefly serves two
		// copies of React ("Invalid hook call").
		include: [
			"zustand",
			"vaul",
			"motion/react",
			"@dnd-kit/core",
			"react-hotkeys-hook",
			"idb-keyval",
			"@tanstack/query-persist-client-core",
			"react-markdown",
			"remark-gfm",
			"thumbhash",
			"@hocuspocus/provider",
			"yjs",
			"y-protocols/awareness",
			"temporal-polyfill",
			"cmdk",
			"input-otp",
			"react-resizable-panels",
			"react-day-picker",
			// Lazy map, route-sketch and service-worker deps (CONTRACT_REQUESTS
			// WP-Home #2, WP-Map #5, WP-Places #4): found late, they re-bundle and
			// reload the page mid-test.
			"maplibre-gl",
			"@vis.gl/react-maplibre",
			"supercluster",
			"d3-geo",
			"topojson-client",
			"workbox-window",
		],
		// Server-only native module (the share card's rasteriser, reached through
		// a server route's dynamic import): the client scan must not bundle it.
		exclude: ["@resvg/resvg-js"],
	},
	resolve: {
		// Resolves the `@/*` and `#/*` aliases from tsconfig.json.
		tsconfigPaths: true,
		// One copy of each: two Yjs or ProseMirror instances break collaboration silently.
		dedupe: [
			"react",
			"react-dom",
			"yjs",
			"y-protocols",
			"@tiptap/y-tiptap",
			"@tiptap/pm",
		],
	},
	define: {
		// Used only by the service-worker "Update ready" toast.
		"import.meta.env.VITE_BUILD_ID": JSON.stringify(Date.now().toString(36)),
	},
	build: { rolldownOptions: { onwarn: quietDirectives } },
	plugins: [
		// No TanStack devtools plugin (owner FB-01): no devtools UI, event bus or
		// `data-tsd-source` injection in dev or prod.
		// Nitro node-server output: `pnpm build` -> .output/server/index.mjs (`pnpm start`).
		nitro({
			rolldownConfig: { onwarn: quietDirectives },
			// Close the pg pool and Redis clients on SIGTERM so the process exits;
			// refuse to start a misconfigured production server; never cache a
			// missing asset.
			plugins: [
				"./src/server/nitro/shutdown.ts",
				"./src/server/nitro/startup-checks.ts",
				"./src/server/nitro/asset-cache.ts",
			],
			// Another build's chunk: a plain 404, not the app's not-found page.
			handlers: [
				{ route: "/assets/**", handler: "./src/server/nitro/missing-asset.ts" },
			],
			// Static files skip the app's request middleware: give them the same
			// baseline headers (Caddy adds HSTS in production).
			routeRules: {
				"/**": {
					headers: {
						"X-Content-Type-Options": "nosniff",
						"Referrer-Policy": "strict-origin-when-cross-origin",
						"X-Frame-Options": "DENY",
					},
				},
				// Trip addresses are share links: never indexed (the app's middleware
				// sets the same, `tripPageHeaders`).
				"/t/**": {
					headers: { "X-Robots-Tag": "noindex, nofollow" },
				},
				"/offline.html": {
					headers: {
						"Content-Security-Policy":
							"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
					},
				},
			},
			// geo-tz reads its ~30 MB zone data from `<pkg>/data` at runtime, so it
			// must stay an external package with all its files (not bundled).
			traceDeps: ["geo-tz*"],
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
		serviceWorker(),
	],
});

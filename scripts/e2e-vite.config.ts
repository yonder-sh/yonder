/**
 * `vite dev` for one env of the fast e2e harness (`pnpm e2e:fast`,
 * scripts/lib/e2e-fast.ts): the app's own config plus
 *   - its own dep-optimizer cache (E2E_VITE_CACHE_DIR), so N servers never
 *     re-bundle into, and serve from, one shared `node_modules/.vite`;
 *   - its own Nitro build dir (E2E_NITRO_BUILD_DIR), so it never rewrites
 *     `node_modules/.nitro` (in a worktree whose node_modules links to the
 *     main checkout's, that breaks the main dev server's worker entry);
 *   - such a linked node_modules allowed to be served (it is outside the root);
 *   - no file watching: an edit during a run must not reload pages mid-test.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { mergeConfig, searchForWorkspaceRoot, type UserConfig } from "vite";
import base from "../vite.config.ts";

const root = path.resolve(import.meta.dirname, "..");

const config: UserConfig = mergeConfig(base as UserConfig, {
	cacheDir: process.env.E2E_VITE_CACHE_DIR || undefined,
	nitro: { buildDir: process.env.E2E_NITRO_BUILD_DIR || undefined },
	server: {
		fs: {
			allow: [
				searchForWorkspaceRoot(root),
				realpathSync(path.join(root, "node_modules")),
			],
		},
	},
	clearScreen: false,
});
// mergeConfig skips null values; null is how Vite turns the watcher off.
config.server = { ...config.server, watch: null };

export default config;

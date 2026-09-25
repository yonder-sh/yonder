/**
 * `vite dev` for one env of the fast e2e harness (`pnpm e2e:fast`,
 * scripts/lib/e2e-fast.ts): the app's own config plus
 *   - its own dep-optimizer cache (E2E_VITE_CACHE_DIR), so N servers never
 *     re-bundle into, and serve from, one shared `node_modules/.vite`;
 *   - no file watching: an edit during a run must not reload pages mid-test.
 */
import { mergeConfig, type UserConfig } from "vite";
import base from "../vite.config.ts";

const config: UserConfig = mergeConfig(base as UserConfig, {
	cacheDir: process.env.E2E_VITE_CACHE_DIR || undefined,
	clearScreen: false,
});
// mergeConfig skips null values; null is how Vite turns the watcher off.
config.server = { ...config.server, watch: null };

export default config;

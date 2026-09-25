/**
 * The fast full run (e2e/README.md, "Fast full run"): the app config with one
 * worker per isolated app env. Don't run it directly — `pnpm e2e:fast
 * [playwright args…]` (scripts/e2e-fast.ts) builds the template database,
 * clones and starts the envs, then runs this.
 *
 *   - `_helpers/fast-env.ts` (imported first) points each worker slot's
 *     process.env at its own env before any spec loads;
 *   - `tsconfig.fast.json` maps `@playwright/test` to `_helpers/fast-test.ts`,
 *     whose auto fixture resets the worker's env to the template before each
 *     spec file;
 *   - the template holds the users' sessions, so the storageStates in
 *     `.data/e2e-fast/{auth,qa-auth}` are shared and global setup only checks.
 */
import { FAST } from "./tests/app/_helpers/fast-env";
import { defineConfig } from "@playwright/test";
import base from "./playwright.app.config";

export default defineConfig({
	...base,
	workers: FAST.envs.length,
	// One file = one worker, its tests in order (several specs build on their
	// earlier tests' data). The envs make the files independent instead.
	fullyParallel: false,
	tsconfig: "./tsconfig.fast.json",
	globalSetup: "./tests/app/_helpers/fast-global-setup.ts",
	// The sign-in "spec" writes QA_AUTH_DIR against one env; the template did that already.
	testIgnore: ["**/qa-content-00-auth.spec.ts"],
	outputDir: "./test-results/fast",
	reporter: [
		["list"],
		["json", { outputFile: FAST.report }],
		["html", { open: "never", outputFolder: "playwright-report/fast" }],
	],
	use: { ...base.use, baseURL: process.env.APP_URL },
	// The runner (scripts/e2e-fast.ts) starts and stops the envs.
	webServer: undefined,
});

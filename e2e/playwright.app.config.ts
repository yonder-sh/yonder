/**
 * Playwright config for the APP's e2e specs (SPEC §5.4, §18.5), next to the
 * harness smoke config (`playwright.config.mjs`). Run from the repo root:
 *
 *   N pnpm e2e                                   # all app specs, chromium + mobile
 *   N pnpm e2e -- tests/app/foundation-*.spec.ts --project chromium
 *
 * The base URL is this checkout's APP_URL (each agent has its own port, §5.7).
 * It refuses the main stack (:3000, database `trip`, bucket `trip-media`,
 * Redis prefix `yonder`) unless E2E_ALLOW_MAIN=1: source an isolated env
 * (`pnpm agent:env <n>`) first.
 * The dev server is reused when it is already running, else it is started
 * WITH the test switches (`ENABLE_TEST_ROUTES=1 VITE_E2E=1`: the fixture
 * route and `window.__yonder`). Global setup fails fast, with the command to
 * run, when a reused server lacks them. Specs log in through the API
 * (`_helpers/auth.ts`), clone their own trip (`_helpers/fixture.ts`) and use
 * `data-testid`s from `src/lib/testids.ts` and `src/features/<x>/testids.ts`.
 *
 * Google Routes stub (WP-Transit, QA TI-4): `E2E_ROUTES_STUB=1 N pnpm e2e -- …`
 * also starts `e2e/stubs/routes-stub.mjs` on APP_PORT + 3 (or
 * ROUTES_STUB_PORT), starts the app WITH `GOOGLE_MAPS_API_KEY=stub` and
 * `GOOGLE_ROUTES_URL` pointing at it, and sets `E2E_ROUTES_STUB_URL` for the
 * keyed specs. A dev server that is already running is reused as it is, so
 * stop yours first (or start it with those variables yourself).
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig, devices } from "@playwright/test";
import { ALLOW_MAIN_ENV, mainTargets } from "../src/lib/main-targets";

// ../.env without overriding variables that are already set (like `node --env-file`).
try {
	for (const [k, v] of Object.entries(parseEnv(readFileSync("../.env", "utf8"))))
		if (process.env[k] === undefined) process.env[k] = v;
} catch {
	// no .env: the environment must provide APP_URL
}
const baseURL = process.env.APP_URL ?? "http://localhost:3000";

// Tests never touch the main stack (README): the owner's real trips live on
// :3000 with database `trip`, bucket `trip-media` and Redis prefix `yonder`.
// Source an isolated env first (`pnpm agent:env <n> --out .data/agent-<n>.env`,
// then `set -a; . .data/agent-<n>.env; set +a`). E2E_ALLOW_MAIN=1 overrides
// this check (the server's test routes still refuse the main stack).
const onMain = mainTargets(process.env, { app: true });
if (onMain.length && process.env[ALLOW_MAIN_ENV] !== "1")
	throw new Error(
		`e2e refuses the main stack: ${onMain.join("; ")}. Run against an isolated env (pnpm agent:env <n>), or set ${ALLOW_MAIN_ENV}=1 if you really mean it.`,
	);

const routesStub = process.env.E2E_ROUTES_STUB === "1";
const stubPort = Number(
	process.env.ROUTES_STUB_PORT ?? Number(process.env.APP_PORT ?? 3000) + 3,
);
const stubUrl = `http://127.0.0.1:${stubPort}`;
if (routesStub) process.env.E2E_ROUTES_STUB_URL ??= stubUrl;
const appEnv = routesStub
	? `GOOGLE_MAPS_API_KEY=stub GOOGLE_ROUTES_URL=${stubUrl} `
	: "";

export default defineConfig({
	testDir: "./tests/app",
	outputDir: "./test-results/app",
	fullyParallel: true,
	workers: 2,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/app" }]],
	globalSetup: "./tests/app/_helpers/global-setup.ts",
	use: {
		baseURL,
		headless: true,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
		{ name: "mobile", use: { ...devices["Pixel 7"] } },
	],
	webServer: [
		...(routesStub
			? [
					{
						command: `node stubs/routes-stub.mjs --port ${stubPort}`,
						url: `${stubUrl}/__stub/calls`,
						reuseExistingServer: true,
						timeout: 15_000,
					},
				]
			: []),
		{
			command: `cd .. && ENABLE_TEST_ROUTES=1 VITE_E2E=1 ${appEnv}pnpm dev`,
			url: `${baseURL}/api/health`,
			reuseExistingServer: true,
			timeout: 120_000,
		},
	],
});

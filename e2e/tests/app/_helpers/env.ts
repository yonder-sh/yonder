/** Paths and URLs shared by the app specs. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOW_MAIN_ENV, mainTargets } from "../../../../src/lib/main-targets";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The e2e package root (`<repo>/e2e`). */
export const E2E_ROOT = path.resolve(here, "../../..");
/** The app repo root. */
export const REPO_ROOT = path.resolve(E2E_ROOT, "..");
export const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

/**
 * Tests never write to the main stack (README): the owner's real trips live on
 * :3000 with database `trip`, bucket `trip-media` and Redis prefix `yonder`.
 * Every helper that writes (API login, fixture clones) calls this first; the
 * config checks the same up front. E2E_ALLOW_MAIN=1 overrides it.
 */
export function assertNotMainStack(url: string = APP_URL): void {
	if (process.env[ALLOW_MAIN_ENV] === "1") return;
	const onMain = mainTargets({ ...process.env, APP_URL: url }, { app: true });
	if (onMain.length)
		throw new Error(
			`e2e refuses the main stack: ${onMain.join("; ")}. Use an isolated env (pnpm agent:env <n>) or set ${ALLOW_MAIN_ENV}=1.`,
		);
}
/**
 * Where global setup writes one storageState per fixture user. Agents testing
 * their own server in parallel set `E2E_AUTH_DIR` so they never overwrite
 * each other's sessions (cookies ignore the port).
 */
export const AUTH_DIR = process.env.E2E_AUTH_DIR
	? path.resolve(process.env.E2E_AUTH_DIR)
	: path.join(E2E_ROOT, ".auth");
export const storageStateOf = (handle: string) => path.join(AUTH_DIR, `${handle}.json`);

/** A stable place for screenshots worth keeping after the run (`e2e/shots/`, gitignored). */
export const shotPath = (name: string) => path.join(E2E_ROOT, "shots", name);

/**
 * Test isolation (README "Tests never touch the main stack"): the main
 * checkout's stack holds the owner's real trips — database `trip`, bucket
 * `trip-media`, Redis prefix `yonder`, the app on :3000. Tests, e2e runs and
 * test-only routes must never write there; each agent/test run has its own
 * (`pnpm agent:env <n>`: `trip_a<n>`, `trip-media-a<n>`, `yonder-a<n>`,
 * :5100+10n). This module names the main targets and says which of them an
 * environment points at. Pure (no Node or DOM APIs), so the server, the
 * Vitest config and the Playwright config share it.
 */

export const MAIN_DATABASE = "trip";
export const MAIN_BUCKET = "trip-media";
export const MAIN_REDIS_PREFIX = "yonder";
export const MAIN_APP_PORT = 3000;

/**
 * Set to `1` to let the e2e harness run against the main stack anyway (the
 * owner, knowingly). Test-only server routes never honour it.
 */
export const ALLOW_MAIN_ENV = "E2E_ALLOW_MAIN";

/**
 * The database name in a Postgres URL (`postgres://u:p@h:5432/<name>`). A URL
 * without one connects to the database named after the user (pg's default:
 * `postgres://trip:trip@localhost:5432` is the main database), so that's the
 * name then.
 */
export function databaseNameOf(url: string | undefined | null): string | null {
	if (!url) return null;
	try {
		const u = new URL(url);
		const name = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
		return name || decodeURIComponent(u.username) || null;
	} catch {
		return null;
	}
}

/** The port of an http(s) URL, the scheme's default when none is written. */
export function portOf(url: string | undefined | null): number | null {
	if (!url) return null;
	try {
		const u = new URL(url);
		if (u.port) return Number(u.port);
		return u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : null;
	} catch {
		return null;
	}
}

type Env = Record<string, string | undefined>;

/**
 * Which main targets `env` points at, as readable reasons ("DATABASE_URL is
 * the main database 'trip'"); empty when it is isolated. An unset
 * `S3_BUCKET`/`REDIS_PREFIX` counts as the main one (the app's defaults).
 * `app: true` also checks APP_URL/APP_PORT against :3000 (the e2e harness).
 */
export function mainTargets(env: Env, opts: { app?: boolean } = {}): string[] {
	const out: string[] = [];
	const db = databaseNameOf(env.DATABASE_URL);
	if (db === MAIN_DATABASE)
		out.push(`DATABASE_URL is the main database '${MAIN_DATABASE}'`);
	if ((env.S3_BUCKET?.trim() || MAIN_BUCKET) === MAIN_BUCKET)
		out.push(`S3_BUCKET is the main bucket '${MAIN_BUCKET}'`);
	if ((env.REDIS_PREFIX?.trim() || MAIN_REDIS_PREFIX) === MAIN_REDIS_PREFIX)
		out.push(`REDIS_PREFIX is the main prefix '${MAIN_REDIS_PREFIX}'`);
	if (opts.app) {
		const port =
			portOf(env.APP_URL) ?? (env.APP_PORT ? Number(env.APP_PORT) : null);
		if (port === MAIN_APP_PORT || port === null)
			out.push(`the app is the main server on :${MAIN_APP_PORT}`);
	}
	return out;
}

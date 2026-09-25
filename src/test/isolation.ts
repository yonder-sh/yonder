/**
 * Tests never write to the main stack (README "Tests never touch the main
 * stack"; `@/lib/main-targets`). `vitest.config.ts` calls `isolateTestEnv`
 * before any test process starts: whatever still points at the main
 * database, bucket or Redis prefix after `.env` is loaded is moved to its test
 * twin (`DATABASE_URL` → `DATABASE_URL_TEST`, `trip-media` →
 * `trip-media-test`, `yonder` → `yonder-test`), so a test that reads the
 * app's defaults lands there, never on the owner's data. `assertIsolated`
 * (the db project's setup file) then refuses to run at all if anything is
 * still main. No override: the main stack is never a test target.
 */
import {
	databaseNameOf,
	MAIN_BUCKET,
	MAIN_DATABASE,
	MAIN_REDIS_PREFIX,
	mainTargets,
} from "../lib/main-targets.ts";

type Env = Record<string, string | undefined>;

export const TEST_BUCKET = `${MAIN_BUCKET}-test`;
export const TEST_REDIS_PREFIX = `${MAIN_REDIS_PREFIX}-test`;

/** Moves main targets to their test twins, in place. Returns what it moved. */
export function isolateTestEnv(env: Env): string[] {
	const moved: string[] = [];
	if (databaseNameOf(env.DATABASE_URL) === MAIN_DATABASE) {
		const test = env.DATABASE_URL_TEST;
		if (test && databaseNameOf(test) !== MAIN_DATABASE) {
			env.DATABASE_URL = test;
			moved.push("DATABASE_URL → DATABASE_URL_TEST");
		} else {
			// Nothing safe to move to: unset it, so a test reaching for it fails loudly.
			delete env.DATABASE_URL;
			moved.push("DATABASE_URL (unset: no DATABASE_URL_TEST)");
		}
	}
	if ((env.S3_BUCKET?.trim() || MAIN_BUCKET) === MAIN_BUCKET) {
		env.S3_BUCKET = TEST_BUCKET;
		moved.push(`S3_BUCKET → ${TEST_BUCKET}`);
	}
	if ((env.REDIS_PREFIX?.trim() || MAIN_REDIS_PREFIX) === MAIN_REDIS_PREFIX) {
		env.REDIS_PREFIX = TEST_REDIS_PREFIX;
		moved.push(`REDIS_PREFIX → ${TEST_REDIS_PREFIX}`);
	}
	return moved;
}

/** Throws when the test database, the app database, bucket or prefix is main. */
export function assertIsolated(env: Env): void {
	const problems = [
		...(databaseNameOf(env.DATABASE_URL_TEST) === MAIN_DATABASE
			? [`DATABASE_URL_TEST is the main database '${MAIN_DATABASE}'`]
			: []),
		...mainTargets(env),
	];
	if (problems.length)
		throw new Error(
			`Refusing to run tests against the main stack: ${problems.join("; ")}. Use an isolated env (pnpm agent:env <n>).`,
		);
}

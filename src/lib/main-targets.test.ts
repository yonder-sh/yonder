/**
 * Test isolation (README "Tests never touch the main stack"): which main
 * targets an environment points at, the Vitest env rewrite, and the guard
 * every `/api/test/*` route runs first.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resetEnv, testRouteGuard } from "@/server/env.server";
import { assertIsolated, isolateTestEnv } from "@/test/isolation";
import { databaseNameOf, mainTargets, portOf } from "./main-targets";

const ISOLATED = {
	DATABASE_URL: "postgres://trip:trip@localhost:5432/trip_a61",
	DATABASE_URL_TEST: "postgres://trip:trip@localhost:5432/trip_test_a61",
	S3_BUCKET: "trip-media-a61",
	REDIS_PREFIX: "yonder-a61",
	APP_URL: "http://localhost:5710",
};
const MAIN = {
	DATABASE_URL: "postgres://trip:trip@localhost:5432/trip",
	DATABASE_URL_TEST: "postgres://trip:trip@localhost:5432/trip_test",
	S3_BUCKET: "trip-media",
	REDIS_PREFIX: "yonder",
	APP_URL: "http://localhost:3000",
};

describe("mainTargets", () => {
	it("is empty for an isolated env", () => {
		expect(mainTargets(ISOLATED, { app: true })).toEqual([]);
	});

	it("names every main target", () => {
		expect(mainTargets(MAIN, { app: true })).toEqual([
			"DATABASE_URL is the main database 'trip'",
			"S3_BUCKET is the main bucket 'trip-media'",
			"REDIS_PREFIX is the main prefix 'yonder'",
			"the app is the main server on :3000",
		]);
	});

	it("treats unset bucket, prefix and app URL as the main defaults", () => {
		expect(
			mainTargets({ DATABASE_URL: ISOLATED.DATABASE_URL }, { app: true }),
		).toHaveLength(3);
		// The app port only matters to the e2e harness.
		expect(mainTargets({ ...ISOLATED, APP_URL: MAIN.APP_URL })).toEqual([]);
	});

	it("reads names and ports", () => {
		expect(databaseNameOf("postgres://u:p@h:5432/trip?sslmode=disable")).toBe(
			"trip",
		);
		expect(databaseNameOf("postgres://u:p@h:5432/trip_a1")).toBe("trip_a1");
		// No name: pg connects to the database named after the user.
		expect(databaseNameOf("postgres://trip:trip@localhost:5432")).toBe("trip");
		expect(databaseNameOf("postgres://trip:trip@localhost:5432/")).toBe("trip");
		expect(databaseNameOf("not a url")).toBeNull();
		expect(portOf("http://localhost:3000")).toBe(3000);
		expect(portOf("https://yonder.example")).toBe(443);
	});
});

describe("isolateTestEnv / assertIsolated (the Vitest guard)", () => {
	it("moves main targets to their test twins", () => {
		const env: Record<string, string | undefined> = { ...MAIN };
		isolateTestEnv(env);
		expect(env.DATABASE_URL).toBe(MAIN.DATABASE_URL_TEST);
		expect(env.S3_BUCKET).toBe("trip-media-test");
		expect(env.REDIS_PREFIX).toBe("yonder-test");
		expect(() => assertIsolated(env)).not.toThrow();
	});

	it("leaves an isolated env alone", () => {
		const env: Record<string, string | undefined> = { ...ISOLATED };
		expect(isolateTestEnv(env)).toEqual([]);
		expect(env).toEqual(ISOLATED);
	});

	it("unsets DATABASE_URL when there is no safe test database", () => {
		const env: Record<string, string | undefined> = {
			...MAIN,
			DATABASE_URL_TEST: MAIN.DATABASE_URL,
		};
		isolateTestEnv(env);
		expect(env.DATABASE_URL).toBeUndefined();
		// …and the db project refuses to run at all.
		expect(() => assertIsolated(env)).toThrow(
			/DATABASE_URL_TEST is the main database/,
		);
	});

	it("refuses anything still main", () => {
		expect(() => assertIsolated(MAIN)).toThrow(
			/Refusing to run tests against the main stack/,
		);
		expect(() => assertIsolated(ISOLATED)).not.toThrow();
	});
});

describe("testRouteGuard (every /api/test/* route)", () => {
	const saved = { ...process.env };
	afterEach(() => {
		process.env = { ...saved };
		resetEnv();
	});
	const envWith = (vars: Record<string, string>) => {
		process.env = {
			...saved,
			...vars,
			ENABLE_TEST_ROUTES: "1",
			NODE_ENV: "test",
		};
		resetEnv();
	};

	it("answers 404 when test routes are off", () => {
		envWith(ISOLATED);
		process.env.ENABLE_TEST_ROUTES = "";
		resetEnv();
		expect(testRouteGuard()?.status).toBe(404);
	});

	it("lets an isolated server through", () => {
		envWith(ISOLATED);
		expect(testRouteGuard()).toBeNull();
	});

	it("refuses the main database, bucket or prefix with 403, even with ENABLE_TEST_ROUTES=1", async () => {
		for (const main of [
			{ ...ISOLATED, DATABASE_URL: MAIN.DATABASE_URL },
			{ ...ISOLATED, S3_BUCKET: MAIN.S3_BUCKET },
			{ ...ISOLATED, REDIS_PREFIX: MAIN.REDIS_PREFIX },
		]) {
			envWith(main);
			const res = testRouteGuard();
			if (!res) throw new Error("the guard let a main target through");
			expect(res.status).toBe(403);
			expect(((await res.json()) as { error: string }).error).toBe(
				"MAIN_STACK",
			);
		}
	});
});

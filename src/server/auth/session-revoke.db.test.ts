/**
 * SEC-R1-14 / QA ERR-07: Postgres is the source of truth for sessions. Deleting
 * a `session` row server-side (the QA hook, incident response, a user purge)
 * ends that session on the next request, even though Better Auth also keeps a
 * copy in Redis (`secondaryStorage`).
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_sess_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-sesstest-${hex}`;
	process.env.BETTER_AUTH_URL = "http://localhost:3000";
	process.env.APP_URL = "http://localhost:3000";
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { hex, scratchUrl: scratch.toString() };
});

import { betterAuth } from "better-auth";
import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { memoryAuthLimits } from "./limits.server";
import { buildAuthOptions } from "./options.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
});

afterAll(async () => {
	const keys = await redis().keys(`${redisPrefix()}:*`);
	if (keys.length) await redis().del(...keys);
	await closeRedis();
	await closeDb();
	await dropDatabase(testEnv.scratchUrl);
});

describe("session revocation in Postgres", () => {
	it("a deleted session row ends the session although Redis still had it", async () => {
		const auth = betterAuth(buildAuthOptions({ limits: memoryAuthLimits() }));
		const res = await auth.api.signInAnonymous({
			headers: new Headers({ origin: "http://localhost:3000" }),
			returnHeaders: true,
		});
		const cookie = (res.headers.get("set-cookie") ?? "")
			.split(/,(?=\s*[\w.-]+=)/)
			.map((c) => c.split(";")[0]?.trim())
			.filter(Boolean)
			.join("; ");
		const headers = new Headers({ cookie });
		const before = await auth.api.getSession({ headers });
		expect(before?.user.isAnonymous).toBe(true);
		const token = before?.session.token ?? "";
		// Redis holds a copy of it.
		expect(await redis().exists(`${redisPrefix()}:ba:${token}`)).toBe(1);

		await getDb().execute(sql`delete from "session" where token = ${token}`);

		expect(await auth.api.getSession({ headers })).toBeNull();
		// …and the stale copy is gone from Redis.
		expect(await redis().exists(`${redisPrefix()}:ba:${token}`)).toBe(0);
	});
});

/**
 * SECURITY §2: a guest can't take a trip member's name through Better Auth's
 * own /update-user either (not only through `renameGuest`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_gname_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-gnametest-${hex}`;
	process.env.BETTER_AUTH_URL = "http://localhost:3000";
	process.env.APP_URL = "http://localhost:3000";
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { hex, scratchUrl: scratch.toString() };
});

// The member-name lookup itself is covered with the sharing rules; here only the wiring.
vi.mock("@/server/authz/share-links.server", async (orig) => ({
	...(await orig<object>()),
	guestNameClashes: async (_id: string, name: string) =>
		name.toLowerCase() === "olga owner",
}));

import { betterAuth } from "better-auth";
import { closeDb } from "@/db/db.server";
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

describe("a guest's name through /update-user", () => {
	it("refuses a member's name, accepts another", async () => {
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
		const update = (body: object) =>
			auth.handler(
				new Request("http://localhost:3000/api/auth/update-user", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:3000",
						cookie,
					},
					body: JSON.stringify(body),
				}),
			);
		expect((await update({ name: "Olga Owner" })).status).toBe(400);
		expect(
			(await update({ firstName: "Olga", lastName: "Owner" })).status,
		).toBe(400);
		expect((await update({ name: "Wren" })).status).toBe(200);
		const s = await auth.api.getSession({ headers: new Headers({ cookie }) });
		expect(s?.user.name).toBe("Wren");
	});
});

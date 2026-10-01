/**
 * The iPhone Shortcut's keys and links against real Postgres and Redis: a
 * setup code works once and only to pair, a phone's key only saves, keys are
 * stored hashed, removing a phone or the account kills its key, the key
 * endpoints don't exist over HTTP, and the app takes each link once.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_shortcut_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-shortcuttest-${hex}`;
	process.env.BETTER_AUTH_URL = "http://localhost:3000";
	process.env.APP_URL = "http://localhost:3000";
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { hex, scratchUrl: scratch.toString() };
});

import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { user } from "@/db/schema";
import { auth } from "@/server/auth.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import {
	checkKey,
	listDevices,
	newPairingCode,
	pair,
	removeDevice,
	SHORTCUT,
	saveShare,
	shareInput,
	takeShares,
} from "./shortcut.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const q = async <T>(query: ReturnType<typeof sql>) =>
	(await getDb().execute(query)).rows as T[];

async function newUser(): Promise<string> {
	const id = randomUUID();
	await getDb()
		.insert(user)
		.values({
			id,
			email: `u-${id}@example.test`,
			emailVerified: true,
			name: "Dennis Pham",
			firstName: "Dennis",
			lastName: "Pham",
			isAnonymous: false,
		});
	return id;
}

async function connect(userId: string, label = "Dennis's iPhone") {
	const code = await newPairingCode(getDb(), userId);
	const r = await pair(getDb(), code, label);
	if (!r.ok) throw new Error(`pair failed: ${r.reason}`);
	return r.key;
}

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

describe("pairing", () => {
	it("a setup code pairs once; the key it gives saves, and only hashes are stored", async () => {
		const u = await newUser();
		const code = await newPairingCode(getDb(), u);
		expect(code).toMatch(/^yonder-pair_[A-Za-z]{64}$/);
		const r = await pair(getDb(), code, "  Dennis's   iPhone ");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.key).toMatch(/^ysk_[A-Za-z]{64}$/);
		expect(await pair(getDb(), code, "again")).toEqual({
			ok: false,
			reason: "code",
		});
		const rows = await q<{ key: string; start: string | null }>(
			sql`select key, start from apikey where reference_id = ${u}`,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.key).not.toContain(r.key);
		expect(rows[0]?.key).not.toContain("ysk_");
		expect(rows[0]?.start).toBeNull();
		const check = await checkKey(r.key);
		expect(check.ok && check.device.userId).toBe(u);
		const devices = await listDevices(getDb(), u);
		expect(devices.map((d) => d.label)).toEqual(["Dennis's iPhone"]);
	});

	it("an expired setup code doesn't pair, and a new code replaces the old one", async () => {
		const u = await newUser();
		const old = await newPairingCode(getDb(), u);
		const code = await newPairingCode(getDb(), u);
		expect(await pair(getDb(), old, undefined)).toEqual({
			ok: false,
			reason: "code",
		});
		await getDb().execute(
			sql`update apikey set expires_at = now() - interval '1 minute' where reference_id = ${u}`,
		);
		expect(await pair(getDb(), code, undefined)).toEqual({
			ok: false,
			reason: "code",
		});
	});

	it("a setup code can't save and a phone key can't pair", async () => {
		const u = await newUser();
		const code = await newPairingCode(getDb(), u);
		expect(await checkKey(code)).toEqual({ ok: false, reason: "key" });
		const key = await connect(u);
		expect(await pair(getDb(), key, undefined)).toEqual({
			ok: false,
			reason: "code",
		});
		// A setup code with its prefix swapped is still not a phone key.
		expect(await checkKey(code.replace("yonder-pair_", "ysk_"))).toEqual({
			ok: false,
			reason: "key",
		});
	});

	it("the same phone connecting again replaces its old key", async () => {
		const u = await newUser();
		const first = await connect(u, "Dennis's iPhone");
		const second = await connect(u, "Dennis's iPhone");
		await connect(u, "Dennis's iPad");
		expect(await checkKey(first)).toEqual({ ok: false, reason: "key" });
		expect((await checkKey(second)).ok).toBe(true);
		expect((await listDevices(getDb(), u)).map((d) => d.label)).toEqual([
			"Dennis's iPhone",
			"Dennis's iPad",
		]);
	});

	it("caps an account at 10 phones", async () => {
		const u = await newUser();
		for (let i = 0; i < SHORTCUT.maxDevices; i++)
			await connect(u, `Phone ${i}`);
		const code = await newPairingCode(getDb(), u);
		expect(await pair(getDb(), code, "one more")).toEqual({
			ok: false,
			reason: "devices",
		});
	});
});

describe("keys", () => {
	it("a removed phone's key stops working and its links go", async () => {
		const u = await newUser();
		const key = await connect(u);
		const check = await checkKey(key);
		if (!check.ok) throw new Error("key should work");
		await saveShare(getDb(), check.device, {
			url: "https://example.com/a",
			text: null,
		});
		expect(await removeDevice(getDb(), randomUUID(), check.device.id)).toBe(
			false,
		);
		expect(await removeDevice(getDb(), u, check.device.id)).toBe(true);
		expect(await checkKey(key)).toEqual({ ok: false, reason: "key" });
		expect((await takeShares(getDb(), u)).shares).toEqual([]);
	});

	it("deleting the account deletes its keys", async () => {
		const u = await newUser();
		const key = await connect(u);
		await getDb().execute(sql`delete from "user" where id = ${u}`);
		expect(await checkKey(key)).toEqual({ ok: false, reason: "key" });
		expect(
			await q(sql`select id from apikey where reference_id = ${u}`),
		).toEqual([]);
	});

	it("a phone key allows 60 saves an hour", async () => {
		const u = await newUser();
		const key = await connect(u);
		for (let i = 0; i < 60; i++) expect((await checkKey(key)).ok).toBe(true);
		expect(await checkKey(key)).toEqual({ ok: false, reason: "limit" });
	});

	it("the key endpoints don't exist over HTTP", async () => {
		for (const path of [
			"create",
			"get",
			"list",
			"update",
			"delete",
			"verify",
		]) {
			const res = await auth.handler(
				new Request(`http://localhost:3000/api/auth/api-key/${path}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:3000",
					},
					body: JSON.stringify({ key: "ysk_x", name: "x" }),
				}),
			);
			expect(res.status, path).toBe(404);
		}
	});
});

describe("links", () => {
	it("the app takes each link once, oldest first, and hears about a new phone once", async () => {
		const u = await newUser();
		const key = await connect(u, "Maya's iPhone");
		const check = await checkKey(key);
		if (!check.ok) throw new Error("key should work");
		await saveShare(getDb(), check.device, shareInput("https://a.example/1"));
		await saveShare(
			getDb(),
			check.device,
			shareInput("Matcha at Tsujiri https://b.example/2?x=1."),
		);
		const first = await takeShares(getDb(), u);
		expect(first.connected).toBe("Maya's iPhone");
		expect(first.shares.map((s) => [s.url, s.text])).toEqual([
			["https://a.example/1", null],
			["https://b.example/2?x=1", "Matcha at Tsujiri"],
		]);
		expect(await takeShares(getDb(), u)).toEqual({
			shares: [],
			connected: null,
		});
	});

	it("keeps the newest 50 and drops links older than 7 days", async () => {
		const u = await newUser();
		const key = await connect(u);
		const check = await checkKey(key);
		if (!check.ok) throw new Error("key should work");
		for (let i = 0; i < 52; i++)
			await saveShare(getDb(), check.device, {
				url: `https://e.example/${i}`,
				text: null,
			});
		await getDb().execute(
			sql`update shortcut_shares set created_at = now() - interval '8 days'
			     where user_id = ${u} and url = 'https://e.example/51'`,
		);
		const { shares } = await takeShares(getDb(), u);
		expect(shares).toHaveLength(49);
		expect(shares[0]?.url).toBe("https://e.example/2");
	});

	it("reads only http(s) links", () => {
		expect(shareInput("javascript:alert(1) just words")).toEqual({
			url: null,
			text: "javascript:alert(1) just words",
		});
		expect(shareInput("ftp://x.example/a").url).toBeNull();
	});
});

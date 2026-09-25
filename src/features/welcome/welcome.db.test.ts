/**
 * The welcome's server side against real Postgres: shown once per person and
 * trip (never to whoever created the trip), how they came in ("Maya invited
 * you" with her note, or the trip link with the link's note), remembered on
 * the server and kept when a guest signs in.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_welcome_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-welcometest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { hex, scratchUrl: scratch.toString() };
});

vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
vi.mock(
	"@tanstack/react-start/server",
	() => import("@/test/start-server-mock"),
);

import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { user } from "@/db/schema";
import { inviteMember, setShareLink } from "@/features/home/sharing.functions";
import { migrateGuestToUser } from "@/server/auth/accounts.server";
import type { AuthUser } from "@/server/auth.server";
import { openTripLink } from "@/server/authz/share-links.server";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { TxOutbox } from "@/server/live/outbox.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { resetLink } from "@/server/sharing.server";
import {
	getWelcome,
	markWelcomeSeen,
	type WelcomeInfo,
} from "./welcome.functions";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T = Record<string, unknown>>(
	fn: unknown,
	u: AuthUser,
	data: unknown,
) => (fn as Fn)({ data, context: { user: u } }) as Promise<T>;

const db = () => getDb();

async function newUser(first: string, anonymous = false): Promise<AuthUser> {
	const id = randomUUID();
	await db()
		.insert(user)
		.values({
			id,
			email: `${first.toLowerCase()}-${id}@example.test`,
			emailVerified: !anonymous,
			name: anonymous ? `Guest ${first}` : `${first} Test`,
			firstName: anonymous ? "" : first,
			lastName: anonymous ? "" : "Test",
			isAnonymous: anonymous,
		});
	const [row] = await db().select().from(user).where(sql`${user.id} = ${id}`);
	return row as unknown as AuthUser;
}

const welcome = (u: AuthUser) =>
	call<WelcomeInfo>(getWelcome, u, { tripId: c.tripId });

let owner: AuthUser;
let c: FixtureClone;

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	owner = await newUser("Olga");
	c = await cloneDemoTrip(db(), owner.id);
	// Created by Olga: she never gets a welcome.
	await db().execute(
		sql`update trips set created_by = ${owner.id} where id = ${c.tripId}`,
	);
});

afterAll(async () => {
	await closeQueues().catch(() => {});
	const r = redis();
	let cursor = "0";
	do {
		const [next, keys] = await r.scan(
			cursor,
			"MATCH",
			`${redisPrefix()}:*`,
			"COUNT",
			500,
		);
		cursor = next;
		if (keys.length) await r.unlink(...keys);
	} while (cursor !== "0");
	await closeRedis();
	await closeDb();
	await dropDatabase(testEnv.scratchUrl);
});

describe("getWelcome / markWelcomeSeen", () => {
	it("never for whoever created the trip", async () => {
		expect((await welcome(owner)).show).toBe(false);
	});

	it("an email invite: who invited you and their note, once", async () => {
		const kai = await newUser("Kai");
		await call(inviteMember, owner, {
			tripId: c.tripId,
			email: kai.email,
			role: "editor",
			note: "  Rate the Kyoto places before Sunday!  ",
		});
		const v = await db().execute(
			sql`select version from trips where id = ${c.tripId}`,
		);
		expect(await welcome(kai)).toEqual({
			show: true,
			via: "invite",
			invitedBy: "Olga",
			inviterUserId: owner.id,
			note: { text: "Rate the Kyoto places before Sunday!", by: "Olga" },
		});
		await call(markWelcomeSeen, kai, { tripId: c.tripId });
		expect((await welcome(kai)).show).toBe(false);
		// The digest starts where the trip is now, not at 0.
		const seen = await db().execute(sql`
			select seen_version::int as v from trip_seen where trip_id = ${c.tripId} and user_id = ${kai.id}`);
		expect(seen.rows[0]).toEqual({
			v: Number((v.rows[0] as { version: number }).version),
		});
		// Closing again keeps the first time.
		await call(markWelcomeSeen, kai, { tripId: c.tripId });
		expect((await welcome(kai)).show).toBe(false);
	});

	it("the trip link: a guest, with the link's note; kept when they sign in", async () => {
		await call(setShareLink, owner, {
			tripId: c.tripId,
			enabled: true,
			role: "viewer",
		});
		await call(setShareLink, owner, {
			tripId: c.tripId,
			note: "Have a look before Friday",
		});
		const slug = (
			(await db().execute(sql`select slug from trips where id = ${c.tripId}`))
				.rows[0] as { slug: string }
		).slug;
		const anon = await newUser("Heron", true);
		expect(await openTripLink(slug, anon.id)).not.toBeNull();
		expect(await welcome(anon)).toMatchObject({
			show: true,
			via: "link",
			invitedBy: null,
			note: { text: "Have a look before Friday", by: "Olga" },
		});
		await call(markWelcomeSeen, anon, { tripId: c.tripId });
		const account = await newUser("Hana");
		await migrateGuestToUser(anon.id, account.id);
		const row = await db().execute(sql`
			select welcome_seen_at is not null as seen from trip_seen
			 where trip_id = ${c.tripId} and user_id = ${account.id}`);
		expect(row.rows).toEqual([{ seen: true }]);
	});

	it("a signed-in account on a Can rate link joins through the link; a reset keeps the note", async () => {
		const out = new TxOutbox(c.tripId);
		const slug = await db().transaction((tx) =>
			resetLink(tx, out, c.tripId, "rater", owner.id),
		);
		const kim = await newUser("Kim");
		expect((await openTripLink(slug, kim.id))?.role).toBe("rater");
		expect(await welcome(kim)).toMatchObject({
			show: true,
			via: "link",
			note: { text: "Have a look before Friday", by: "Olga" },
		});
	});
});

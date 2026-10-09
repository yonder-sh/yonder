/**
 * Invite links (owner, 2026-10-09) against real Postgres: the owner makes and
 * deletes them; opening one signed in joins at its role, once; an email
 * invite waiting sets the role instead; a signed-out guest can't join with
 * one; a deleted link stops working. Uses its own throwaway database.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_invite_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-invitetest-${hex}`;
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
import {
	createInviteLink,
	deleteInviteLink,
	getSharing,
	redeemInviteLink,
} from "@/features/home/sharing.functions";
import { isProposed } from "@/lib/schemas/proposals";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { loadTripAccess } from "@/server/authz/trip-access.server";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T = Record<string, unknown>>(
	fn: unknown,
	u: AuthUser,
	data: unknown,
) => (fn as Fn)({ data, context: { user: u } }) as Promise<T>;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		const v = await p;
		return isProposed(v) ? "proposed" : "ok";
	} catch (e) {
		return (
			errorCode(e) ??
			`unexpected: ${e instanceof Error ? e.message : String(e)}`
		);
	}
}

const db = () => getDb();
const q = async <T>(query: ReturnType<typeof sql>) =>
	(await db().execute(query)).rows as T[];

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

let owner: AuthUser;
let c: FixtureClone;

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	owner = await newUser("Olga");
	c = await cloneDemoTrip(db(), owner.id);
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

const tokenOf = (url: string) => url.split("/join/")[1] ?? "";
const memberOf = async (u: AuthUser) =>
	(
		await q<{ role: string; joinedByLink: boolean }>(sql`
			select role::text as role, joined_by_link as "joinedByLink" from trip_members
			 where trip_id = ${c.tripId} and user_id = ${u.id} and status = 'active'`)
	)[0] ?? null;

describe("invite links", () => {
	it("the owner makes one; opening it signed in joins at its role, once", async () => {
		const made = await call<{ id: string; url: string }>(
			createInviteLink,
			owner,
			{ tripId: c.tripId, role: "editor" },
		);
		expect(made.url).toMatch(/\/join\/[A-Za-z0-9_-]{22}$/);
		const sharing = await call<{ invites: { id: string; role: string }[] }>(
			getSharing,
			owner,
			{ tripId: c.tripId },
		);
		expect(sharing.invites).toEqual([
			expect.objectContaining({ id: made.id, role: "editor", useCount: 0 }),
		]);
		const ana = await newUser("Ana");
		await expect(
			call(redeemInviteLink, ana, { token: tokenOf(made.url) }),
		).resolves.toEqual({ slug: c.slug });
		expect(await memberOf(ana)).toEqual({ role: "editor", joinedByLink: true });
		await expect(loadTripAccess(c.tripId, ana.id)).resolves.toMatchObject({
			role: "editor",
			isGuest: false,
		});
		// Again: nothing changes, it still lands in the trip.
		await expect(
			call(redeemInviteLink, ana, { token: tokenOf(made.url) }),
		).resolves.toEqual({ slug: c.slug });
		expect(
			(
				await q<{ n: number }>(sql`
				select count(*)::int as n from trip_members where trip_id = ${c.tripId} and user_id = ${ana.id}`)
			)[0]?.n,
		).toBe(1);
	});

	it("an email invite waiting for them sets the role; a signed-out guest can't join", async () => {
		const { url } = await call<{ url: string }>(createInviteLink, owner, {
			tripId: c.tripId,
			role: "editor",
		});
		const vic = await newUser("Vic");
		await db().execute(sql`
			insert into trip_members (id, trip_id, status, role, email, color)
			values (${randomUUID()}, ${c.tripId}, 'invited', 'viewer', ${vic.email}, 4)`);
		await call(redeemInviteLink, vic, { token: tokenOf(url) });
		expect(await memberOf(vic)).toBeNull();
		const anon = await newUser("Heron", true);
		expect(
			await codeOf(call(redeemInviteLink, anon, { token: tokenOf(url) })),
		).toBe("NOT_FOUND");
		expect(await memberOf(anon)).toBeNull();
	});

	it("only the owner makes or deletes them; a deleted one stops working, and who joined stays", async () => {
		const ed = await newUser("Eda");
		const { url, id } = await call<{ url: string; id: string }>(
			createInviteLink,
			owner,
			{ tripId: c.tripId, role: "rater" },
		);
		await call(redeemInviteLink, ed, { token: tokenOf(url) });
		expect((await memberOf(ed))?.role).toBe("rater");
		expect(
			await codeOf(
				call(createInviteLink, ed, { tripId: c.tripId, role: "editor" }),
			),
		).toBe("FORBIDDEN");
		expect(
			await codeOf(call(deleteInviteLink, ed, { tripId: c.tripId, id })),
		).toBe("FORBIDDEN");
		expect(
			await codeOf(call(deleteInviteLink, owner, { tripId: c.tripId, id })),
		).toBe("ok");
		const late = await newUser("Lee");
		expect(
			await codeOf(call(redeemInviteLink, late, { token: tokenOf(url) })),
		).toBe("NOT_FOUND");
		expect((await memberOf(ed))?.role).toBe("rater");
		expect(
			await codeOf(call(deleteInviteLink, owner, { tripId: c.tripId, id })),
		).toBe("NOT_FOUND");
	});
});

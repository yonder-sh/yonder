/**
 * PLACES §1c "Can rate" against real Postgres, through the real gate:
 * - `setNodePriority` for your OWN member: a rater applies it directly (with a
 *   comment), a suggester still applies directly, a plain viewer is now
 *   FORBIDDEN;
 * - a rater rating someone else (a placeholder) or trying any other mutation
 *   is FORBIDDEN (never a proposal); a suggester's rating of the placeholder
 *   still becomes a suggestion;
 * - a "Can rate" link makes a signed-in account a `rater` member (so it can
 *   rate) while an anonymous guest stays view-only, and a guest who then
 *   signs in becomes one (`joinRateLinks`);
 * - new placeholders are raters.
 * Uses its own throwaway database (created, migrated and dropped here).
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_rater_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-ratertest-${hex}`;
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
import { setNodePriority, updateNode } from "@/functions/nodes.functions";
import { parseShareFragment } from "@/lib/auth/share-link";
import { isProposed } from "@/lib/schemas/proposals";
import { migrateGuestToUser } from "@/server/auth/accounts.server";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { redeemShareToken } from "@/server/authz/share-links.server";
import { loadTripAccess } from "@/server/authz/trip-access.server";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { TxOutbox } from "@/server/live/outbox.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { createPlaceholder } from "@/server/members.server";
import { resetLink } from "@/server/sharing.server";

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

async function addMember(
	tripId: string,
	u: AuthUser,
	role: "rater" | "viewer" | "suggester",
): Promise<string> {
	const id = randomUUID();
	await db().execute(sql`
		insert into trip_members (id, trip_id, user_id, status, role, color, joined_at)
		values (${id}, ${tripId}, ${u.id}, 'active', ${role}, 3, now())`);
	return id;
}

const ratingOf = async (nodeId: string, memberId: string) =>
	(
		await q<{ priority: string; comment: string | null }>(sql`
			select priority::text as priority, rating_comment as comment
			  from node_priorities where node_id = ${nodeId} and member_id = ${memberId}`)
	)[0] ?? null;

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

describe("setNodePriority by role (PLACES §1c)", () => {
	it("a rater sets their own rating and comment directly, and nothing else", async () => {
		const rena = await newUser("Rena");
		const me = await addMember(c.tripId, rena, "rater");
		const node = c.ids.nodes.sensoji as string;
		expect(
			await codeOf(
				call(setNodePriority, rena, {
					nodeId: node,
					memberId: me,
					priority: "must",
					comment: "Only at dawn",
				}),
			),
		).toBe("ok");
		expect(await ratingOf(node, me)).toEqual({
			priority: "must",
			comment: "Only at dawn",
		});
		// Change and clear their own rating.
		expect(
			await codeOf(
				call(setNodePriority, rena, {
					nodeId: node,
					memberId: me,
					priority: "meh",
				}),
			),
		).toBe("ok");
		expect((await ratingOf(node, me))?.priority).toBe("meh");
		expect(
			await codeOf(
				call(setNodePriority, rena, {
					nodeId: node,
					memberId: me,
					priority: null,
				}),
			),
		).toBe("ok");
		expect(await ratingOf(node, me)).toBeNull();

		// Someone else's rating (the placeholder Audrey): FORBIDDEN, not a proposal.
		expect(
			await codeOf(
				call(setNodePriority, rena, {
					nodeId: node,
					memberId: c.members.audrey,
					priority: "nah",
				}),
			),
		).toBe("FORBIDDEN");
		// Any other mutation: FORBIDDEN, not a proposal.
		expect(
			await codeOf(
				call(updateNode, rena, {
					nodeId: node,
					patch: { name: "Renamed by a rater" },
				}),
			),
		).toBe("FORBIDDEN");
		const proposals = await q<{ n: number }>(sql`
			select count(*)::int as n from proposals where author_user_id = ${rena.id}`);
		expect(proposals[0]?.n).toBe(0);
	});

	it("a plain viewer can no longer rate, even their own", async () => {
		const vic = await newUser("Vic");
		const me = await addMember(c.tripId, vic, "viewer");
		const node = c.ids.nodes.sensoji as string;
		expect(
			await codeOf(
				call(setNodePriority, vic, {
					nodeId: node,
					memberId: me,
					priority: "want",
				}),
			),
		).toBe("FORBIDDEN");
		expect(await ratingOf(node, me)).toBeNull();
	});

	it("a suggester still rates directly, and suggests someone else's rating", async () => {
		const sam = await newUser("Sam");
		const me = await addMember(c.tripId, sam, "suggester");
		const node = c.ids.nodes.sensoji as string;
		expect(
			await codeOf(
				call(setNodePriority, sam, {
					nodeId: node,
					memberId: me,
					priority: "really_want",
				}),
			),
		).toBe("ok");
		expect((await ratingOf(node, me))?.priority).toBe("really_want");
		expect(
			await codeOf(
				call(setNodePriority, sam, {
					nodeId: node,
					memberId: c.members.audrey,
					priority: "must",
				}),
			),
		).toBe("proposed");
	});
});

describe('the "Can rate" link (PLACES §1c)', () => {
	async function rateLink(): Promise<string> {
		const out = new TxOutbox(c.tripId);
		const url = await db().transaction((tx) =>
			resetLink(tx, out, c.tripId, "rater", owner.id),
		);
		return parseShareFragment(new URL(url).hash) ?? "(no token)";
	}
	const memberRow = async (userId: string) =>
		(
			await q<{ id: string; role: string; status: string }>(sql`
				select id::text as id, role::text as role, status::text as status
				  from trip_members where trip_id = ${c.tripId} and user_id = ${userId}`)
		)[0] ?? null;
	const grants = async (userId: string) =>
		(
			await q<{ n: number }>(sql`
				select count(*)::int as n from share_grants
				 where trip_id = ${c.tripId} and user_id = ${userId}`)
		)[0]?.n ?? 0;

	it("a signed-in account who opens it becomes a rater member and can rate", async () => {
		const token = await rateLink();
		const kim = await newUser("Kim");
		expect((await redeemShareToken(token, kim.id))?.role).toBe("rater");
		const row = await memberRow(kim.id);
		expect(row).toMatchObject({ role: "rater", status: "active" });
		// The membership is their one source of access (no grant on top).
		expect(await grants(kim.id)).toBe(0);
		const access = await loadTripAccess(c.tripId, kim.id);
		expect(access).toMatchObject({
			role: "rater",
			isGuest: false,
			memberId: row?.id,
		});
		expect(
			await codeOf(
				call(setNodePriority, kim, {
					nodeId: c.ids.nodes.sensoji,
					memberId: row?.id,
					priority: "want",
				}),
			),
		).toBe("ok");
		// Opening it again changes nothing.
		await redeemShareToken(token, kim.id);
		expect((await memberRow(kim.id))?.id).toBe(row?.id);
	});

	it("an anonymous guest stays a view-only guest until they sign in", async () => {
		const token = await rateLink();
		const anon = await newUser("Heron", true);
		expect((await redeemShareToken(token, anon.id))?.role).toBe("rater");
		expect(await memberRow(anon.id)).toBeNull();
		const access = await loadTripAccess(c.tripId, anon.id);
		expect(access).toMatchObject({
			role: "rater",
			isGuest: true,
			memberId: null,
		});
		// Nothing to rate as: Audrey's rating is not theirs.
		expect(
			await codeOf(
				call(setNodePriority, anon, {
					nodeId: c.ids.nodes.sensoji,
					memberId: c.members.audrey,
					priority: "want",
				}),
			),
		).toBe("FORBIDDEN");
		// Signing in (the anonymous plugin links the account) makes them a rater.
		const account = await newUser("Hana");
		await migrateGuestToUser(anon.id, account.id);
		expect(await memberRow(account.id)).toMatchObject({
			role: "rater",
			status: "active",
		});
		expect(await grants(account.id)).toBe(0);
	});

	it("a view link still never makes anyone a member (QA LINK-08)", async () => {
		const out = new TxOutbox(c.tripId);
		const url = await db().transaction((tx) =>
			resetLink(tx, out, c.tripId, "viewer", owner.id),
		);
		const token = parseShareFragment(new URL(url).hash) ?? "";
		const eve = await newUser("Eve");
		expect((await redeemShareToken(token, eve.id))?.role).toBe("viewer");
		expect(await memberRow(eve.id)).toBeNull();
	});
});

describe("placeholders (PLACES §1c)", () => {
	it("a name typed into a people picker becomes a rater placeholder", async () => {
		const { memberId } = await db().transaction((tx) =>
			createPlaceholder(tx, null, c.tripId, "Priya"),
		);
		const [row] = await q<{ role: string; status: string }>(sql`
			select role::text as role, status::text as status from trip_members where id = ${memberId}`);
		expect(row).toEqual({ role: "rater", status: "placeholder" });
	});
});

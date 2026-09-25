/**
 * WP-Home server functions against real Postgres and Redis: invites, roles,
 * removal and leaving (SPEC §11.3–§11.5, QA SHARE-01/02/05/06/07), promoting
 * guests, the trip's one link (FB-13), placeholders ↔ accounts (ADDENDUM §10:
 * claim, link to an email or a member; FB-14: no per-person join links),
 * "Duplicate…" (ADDENDUM §9) and the dashboard reads
 * (`listMyTrips` extras, `listMyDeadlines` incl. privacy).
 *
 * The handlers run for real (validator + body) through `src/test/start-mock.ts`;
 * each test passes `context.user`. A throwaway migrated database and an
 * isolated REDIS_PREFIX are created and removed around the file.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_home_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-hometest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { hex, scratchUrl: scratch.toString() };
});

vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
vi.mock(
	"@tanstack/react-start/server",
	() => import("@/test/start-server-mock"),
);
/** The per-IP limit on non-member trip opens (off outside production): switchable here. */
const tripOpenLimit = vi.hoisted(() => ({ over: false }));
vi.mock("@/server/auth/limits.server", async (importOriginal) => {
	const real =
		await importOriginal<typeof import("@/server/auth/limits.server")>();
	const off = real.memoryAuthLimits(false);
	return {
		...real,
		authLimits: () => ({
			...off,
			tripOpenRetryAfter: async () => (tripOpenLimit.over ? 60_000 : 0),
		}),
	};
});

import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { tripMembers, user } from "@/db/schema";
import { openTripByLink, tripLinkOpen } from "@/lib/auth/share.functions";
import { mentionToken } from "@/lib/notes/mentions";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { openTripLink } from "@/server/authz/share-links.server";
import { loadTripAccess } from "@/server/authz/trip-access.server";
import {
	cloneDemoTrip,
	type FixtureClone,
	joinTestLink,
	pinTestLink,
} from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import {
	duplicateTrip,
	listMyDeadlines,
	listMyTrips,
} from "../dashboard.functions";
import { deadlineAt, deadlineState } from "../server/dashboard.server";
import {
	remapMemberIds,
	remapMentions,
	replaceIdsInState,
} from "../server/duplicate.server";
import {
	addPlaceholder,
	claimPlaceholder,
	getSharing,
	inviteMember,
	leaveTrip,
	linkPlaceholder,
	promoteGuest,
	removeMember,
	resetShareLink,
	setShareLink,
	updateMemberRole,
} from "../sharing.functions";
import type { MyDeadline, MyTrip } from "../types";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const { scratchUrl } = testEnv;

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T = Record<string, unknown>>(
	fn: unknown,
	u: AuthUser,
	data?: unknown,
) => (fn as Fn)({ data, context: { user: u } }) as Promise<T>;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return (
			errorCode(e) ??
			`unexpected: ${e instanceof Error ? e.message : String(e)}`
		);
	}
}

const q = async <T>(query: ReturnType<typeof sql>) =>
	(await getDb().execute(query)).rows as T[];

async function newUser(
	name: { first: string; last: string } | null,
	email?: string,
): Promise<AuthUser> {
	const id = randomUUID();
	const anonymous = name === null;
	await getDb()
		.insert(user)
		.values({
			id,
			email:
				email ??
				`${anonymous ? "temp" : "u"}-${id}@${anonymous ? "guest.yonder.invalid" : "example.test"}`,
			emailVerified: !anonymous,
			name: anonymous ? "Guest Wren" : `${name.first} ${name.last}`,
			firstName: name?.first ?? "",
			lastName: name?.last ?? "",
			isAnonymous: anonymous,
		});
	const [row] = await getDb()
		.select()
		.from(user)
		.where(sql`${user.id} = ${id}`);
	return row as unknown as AuthUser;
}

const U = {} as Record<
	"owner" | "maya" | "viewer" | "stranger" | "guest" | "signedGuest",
	AuthUser
>;

async function freshTrip(): Promise<FixtureClone> {
	const c = await cloneDemoTrip(getDb(), U.owner.id);
	await getDb().insert(tripMembers).values({
		tripId: c.tripId,
		userId: U.viewer.id,
		status: "active",
		role: "viewer",
		color: 5,
	});
	await joinTestLink(getDb(), c, U.guest.id, "viewer");
	await joinTestLink(getDb(), c, U.signedGuest.id, "viewer");
	return c;
}

const memberOf = async (tripId: string, userId: string) =>
	(
		await q<{ id: string; role: string; status: string }>(sql`
		select id::text as id, role::text as role, status::text as status
		  from trip_members where trip_id = ${tripId} and user_id = ${userId}`)
	)[0];

beforeAll(async () => {
	await ensureDatabase(scratchUrl);
	await migrateDatabase(scratchUrl);
	U.owner = await newUser({ first: "Dev", last: "Owner" });
	U.maya = await newUser({ first: "Maya", last: "Chen" }, "maya@example.com");
	U.viewer = await newUser({ first: "Vic", last: "Viewer" });
	U.stranger = await newUser({ first: "Sam", last: "Stranger" });
	U.guest = await newUser(null);
	U.signedGuest = await newUser({ first: "Kai", last: "Tan" });
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
	await dropDatabase(scratchUrl);
});

describe("members (SHARE)", () => {
	it("invites an account (active at once) and an unknown email (pending); refuses repeats and self", async () => {
		const c = await freshTrip();
		const kai = await newUser({ first: "Kai", last: "Viewer" });
		const r1 = await call<{ memberId: string; status: string }>(
			inviteMember,
			U.owner,
			{ tripId: c.tripId, email: kai.email.toUpperCase(), role: "viewer" },
		);
		expect(r1.status).toBe("active");
		expect((await memberOf(c.tripId, kai.id))?.role).toBe("viewer");
		const r2 = await call<{ status: string }>(inviteMember, U.owner, {
			tripId: c.tripId,
			email: "newbie@example.test",
			role: "suggester",
		});
		expect(r2.status).toBe("invited");
		// Already a member, already invited, the caller: CONFLICT; editors can't invite.
		for (const email of [kai.email, "NEWBIE@example.test", U.owner.email])
			expect(
				await codeOf(
					call(inviteMember, U.owner, {
						tripId: c.tripId,
						email,
						role: "viewer",
					}),
				),
			).toBe("CONFLICT");
		expect(
			await codeOf(
				call(inviteMember, U.maya, {
					tripId: c.tripId,
					email: "x@example.test",
					role: "viewer",
				}),
			),
		).toBe("FORBIDDEN");
		// The pending invite shows for the owner with its email; not for Maya.
		const owner = await call<{ members: { email?: string; status: string }[] }>(
			getSharing,
			U.owner,
			{ tripId: c.tripId },
		);
		expect(
			owner.members.some(
				(m) => m.status === "invited" && m.email === "newbie@example.test",
			),
		).toBe(true);
		const maya = await call<{ members: { email?: string }[] }>(
			getSharing,
			U.maya,
			{ tripId: c.tripId },
		);
		expect(maya.members.every((m) => m.email === undefined)).toBe(true);
		const log = await q<{ summary: string }>(sql`
			select summary from activity_log
			 where trip_id = ${c.tripId} and verb = 'person.invite' order by created_at`);
		expect(log.map((r) => r.summary)).toEqual([
			"added Kai Viewer to the trip",
			"invited someone by email",
		]);
	});

	it("changes roles (never the owner's), removes members and lets members leave", async () => {
		const c = await freshTrip();
		const mayaRow = await memberOf(c.tripId, U.maya.id);
		const ownerRow = await memberOf(c.tripId, U.owner.id);
		const viewerRow = await memberOf(c.tripId, U.viewer.id);
		if (!mayaRow || !ownerRow || !viewerRow) throw new Error("fixture");
		await call(updateMemberRole, U.owner, {
			memberId: mayaRow.id,
			role: "suggester",
		});
		expect((await memberOf(c.tripId, U.maya.id))?.role).toBe("suggester");
		expect(
			await codeOf(
				call(updateMemberRole, U.owner, {
					memberId: ownerRow.id,
					role: "viewer",
				}),
			),
		).toBe("CONFLICT");
		expect(
			await codeOf(
				call(updateMemberRole, U.maya, {
					memberId: viewerRow.id,
					role: "editor",
				}),
			),
		).toBe("FORBIDDEN");
		expect(
			await codeOf(call(removeMember, U.owner, { memberId: ownerRow.id })),
		).toBe("CONFLICT");
		await call(removeMember, U.owner, { memberId: viewerRow.id });
		const retired = await q<{ status: string; userId: string | null }>(sql`
			select status::text as status, user_id as "userId" from trip_members where id = ${viewerRow.id}`);
		expect(retired[0]).toEqual({ status: "removed", userId: null });
		expect(await codeOf(call(getSharing, U.viewer, { tripId: c.tripId }))).toBe(
			"NOT_FOUND",
		);
		// Maya leaves on her own; the owner can't leave.
		await call(leaveTrip, U.maya, { tripId: c.tripId });
		expect(await memberOf(c.tripId, U.maya.id)).toBeUndefined();
		expect(await codeOf(call(leaveTrip, U.owner, { tripId: c.tripId }))).toBe(
			"FORBIDDEN",
		);
		// E6 digest: membership changes are in the activity, never an email address.
		const log = await q<{ verb: string; summary: string }>(sql`
			select verb, summary from activity_log
			 where trip_id = ${c.tripId} and verb like 'person.%' order by created_at`);
		expect(log.map((r) => r.verb)).toEqual([
			"person.role",
			"person.remove",
			"person.leave",
		]);
		expect(log[0]?.summary).toMatch(/to Can suggest$/);
		expect(log.map((r) => r.summary).join(" ")).not.toMatch(/@/);
	});

	it("promotes a signed-in guest (never an anonymous one) and merges their pending invite", async () => {
		const c = await freshTrip();
		await call(inviteMember, U.owner, {
			tripId: c.tripId,
			email: U.signedGuest.email,
			role: "viewer",
		}).catch(() => {});
		// The invite made Kai an active member already (existing account) and
		// dropped his link grant: undo both for this test.
		await getDb().execute(
			sql`delete from trip_members where trip_id = ${c.tripId} and user_id = ${U.signedGuest.id}`,
		);
		await joinTestLink(getDb(), c, U.signedGuest.id, "viewer");
		await getDb().execute(sql`
			insert into trip_members (id, trip_id, status, role, email, color)
			values (gen_random_uuid(), ${c.tripId}, 'invited', 'viewer', ${U.signedGuest.email.toLowerCase()}, 3)`);
		expect(
			await codeOf(
				call(promoteGuest, U.owner, {
					tripId: c.tripId,
					userId: U.guest.id,
					role: "editor",
				}),
			),
		).toBe("CONFLICT");
		await call(promoteGuest, U.owner, {
			tripId: c.tripId,
			userId: U.signedGuest.id,
			role: "editor",
		});
		const rows = await q<{ status: string; role: string }>(sql`
			select status::text as status, role::text as role from trip_members
			 where trip_id = ${c.tripId} and (user_id = ${U.signedGuest.id} or email = ${U.signedGuest.email.toLowerCase()})`);
		expect(rows).toEqual([{ status: "active", role: "editor" }]);
		expect(
			await codeOf(
				call(promoteGuest, U.owner, {
					tripId: c.tripId,
					userId: U.signedGuest.id,
					role: "editor",
				}),
			),
		).toBe("CONFLICT");
	});

	it("QA HOME-2: a promoted or re-roled member gets exactly the owner's role (their link grant goes)", async () => {
		const c = await freshTrip();
		const gina = await newUser({ first: "Gina", last: "Guest" });
		await joinTestLink(getDb(), c, gina.id, "editor");
		expect((await loadTripAccess(c.tripId, gina.id))?.role).toBe("editor");
		const { memberId } = await call<{ memberId: string }>(
			promoteGuest,
			U.owner,
			{ tripId: c.tripId, userId: gina.id, role: "suggester" },
		);
		expect(await loadTripAccess(c.tripId, gina.id)).toMatchObject({
			role: "suggester",
			isGuest: false,
			memberId,
		});
		const grants = await q<{ n: number }>(sql`
			select count(*)::int as n from share_grants where trip_id = ${c.tripId} and user_id = ${gina.id}`);
		expect(grants[0]?.n).toBe(0);
		await call(updateMemberRole, U.owner, { memberId, role: "viewer" });
		expect((await loadTripAccess(c.tripId, gina.id))?.role).toBe("viewer");
		// A member who opens the address while the edit link is on keeps their
		// own role: members get no link grant (SHARE-04); the owner's pick wins.
		const mayaRow = await memberOf(c.tripId, U.maya.id);
		if (!mayaRow) throw new Error("fixture");
		await call(updateMemberRole, U.owner, {
			memberId: mayaRow.id,
			role: "viewer",
		});
		await pinTestLink(getDb(), c.tripId, "editor");
		expect(await openTripLink(c.slug, U.maya.id)).toBeNull();
		expect((await loadTripAccess(c.tripId, U.maya.id))?.role).toBe("viewer");
		await call(updateMemberRole, U.owner, {
			memberId: mayaRow.id,
			role: "suggester",
		});
		expect((await loadTripAccess(c.tripId, U.maya.id))?.role).toBe("suggester");
		// Inviting an account that holds an edit-link grant: the invite's role.
		const lee = await newUser({ first: "Lee", last: "Linker" });
		await joinTestLink(getDb(), c, lee.id, "editor");
		await call(inviteMember, U.owner, {
			tripId: c.tripId,
			email: lee.email,
			role: "viewer",
		});
		expect(await loadTripAccess(c.tripId, lee.id)).toMatchObject({
			role: "viewer",
			isGuest: false,
		});
	});

	it("QA SEC-R1-11 / SHARE-08: the link's state (with its creation date) goes to the owner only; the address to everyone", async () => {
		const c = await freshTrip();
		const owner = await call<{
			url: string;
			link: { role: string; createdAt: string | null };
		}>(getSharing, U.owner, { tripId: c.tripId });
		expect(new URL(owner.url).pathname).toBe(`/t/${c.slug}`);
		expect(Date.parse(owner.link.createdAt ?? "")).not.toBeNaN();
		for (const u of [U.maya, U.viewer, U.guest, U.signedGuest]) {
			const r = await call<{ url: string; link: unknown; guests: unknown[] }>(
				getSharing,
				u,
				{ tripId: c.tripId },
			);
			expect(r.link).toBeNull();
			expect(r.guests).toEqual([]);
			expect(r.url).toBe(owner.url);
		}
	});

	it("FB-13: one link per trip, at the trip's address; its role Select changes every link guest's role", async () => {
		const c = await freshTrip();
		type Dto = {
			url: string;
			link: { role: string; enabled: boolean } | null;
			guests: { userId: string; role: string }[];
		};
		// Only the owner manages it; a role alone needs no `enabled`.
		expect(
			await codeOf(
				call(setShareLink, U.maya, { tripId: c.tripId, role: "editor" }),
			),
		).toBe("FORBIDDEN");
		// The validator refuses a call with neither.
		expect(
			await codeOf(call(setShareLink, U.owner, { tripId: c.tripId })),
		).toMatch(/role or enabled/);
		const { url, slug } = await call<{ url: string; slug: string }>(
			resetShareLink,
			U.owner,
			{ tripId: c.tripId, role: "viewer" },
		);
		// A new address tail: the old address opens nothing any more.
		expect(slug).not.toBe(c.slug);
		expect(slug).toMatch(/^demo-[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
		expect(new URL(url).pathname).toBe(`/t/${slug}`);
		const gina = await newUser({ first: "Gina", last: "Guest" });
		expect(await openTripLink(c.slug, gina.id)).toBeNull();
		expect((await openTripLink(slug, gina.id))?.role).toBe("viewer");
		let dto = await call<Dto>(getSharing, U.owner, { tripId: c.tripId });
		expect(dto.url).toBe(url);
		expect(dto.link).toMatchObject({ role: "viewer", enabled: true });
		expect(dto.guests.find((g) => g.userId === gina.id)?.role).toBe("viewer");
		await call(setShareLink, U.owner, { tripId: c.tripId, role: "editor" });
		expect((await loadTripAccess(c.tripId, gina.id))?.role).toBe("editor");
		dto = await call<Dto>(getSharing, U.owner, { tripId: c.tripId });
		expect(dto.link).toMatchObject({ role: "editor", enabled: true });
		expect(dto.url).toBe(url);
		expect(dto.guests.find((g) => g.userId === gina.id)?.role).toBe("editor");
		const live = await q<{ n: number }>(sql`
			select count(*)::int as n from share_links where trip_id = ${c.tripId} and revoked_at is null`);
		expect(live[0]?.n).toBe(1);
		// OFF still removes everyone who came in through it, and the address
		// lets no one else in.
		await call(setShareLink, U.owner, { tripId: c.tripId, enabled: false });
		expect(await loadTripAccess(c.tripId, gina.id)).toBeNull();
		expect(await openTripLink(slug, gina.id)).toBeNull();
		dto = await call<Dto>(getSharing, U.owner, { tripId: c.tripId });
		expect(dto.link).toMatchObject({ role: "editor", enabled: false });
		expect(dto.guests).toEqual([]);
	});
});

describe("opening a trip through its address (the link)", () => {
	it("a non-member gets the link's role while it is on; off, unknown and over the per-IP limit all answer NOT_FOUND", async () => {
		const c = await freshTrip();
		const nina = await newUser({ first: "Nina", last: "Newcomer" });
		// Off: nothing to open, and nothing says the trip exists.
		await call(setShareLink, U.owner, { tripId: c.tripId, enabled: false });
		expect(await call(tripLinkOpen, nina, { slug: c.slug })).toEqual({
			open: false,
		});
		expect(await codeOf(call(openTripByLink, nina, { slug: c.slug }))).toBe(
			"NOT_FOUND",
		);
		expect(
			await codeOf(
				call(openTripByLink, nina, { slug: "no-such-trip-k7m2qxw9" }),
			),
		).toBe("NOT_FOUND");
		// On as "Can suggest": she gets that role through a grant, never a membership.
		await call(setShareLink, U.owner, {
			tripId: c.tripId,
			enabled: true,
			role: "suggester",
		});
		expect(await call(tripLinkOpen, nina, { slug: c.slug })).toEqual({
			open: true,
		});
		expect(await call(openTripByLink, nina, { slug: c.slug })).toEqual({
			tripId: c.tripId,
			slug: c.slug,
			role: "suggester",
		});
		expect(await loadTripAccess(c.tripId, nina.id)).toMatchObject({
			role: "suggester",
			isGuest: true,
			memberId: null,
		});
		// Members open it as members: no grant.
		expect(await codeOf(call(openTripByLink, U.maya, { slug: c.slug }))).toBe(
			"NOT_FOUND",
		);
		expect((await loadTripAccess(c.tripId, U.maya.id))?.isGuest).toBe(false);
		// Over the per-IP limit: the same answers as for a closed trip.
		tripOpenLimit.over = true;
		try {
			const omar = await newUser({ first: "Omar", last: "Other" });
			expect(await call(tripLinkOpen, omar, { slug: c.slug })).toEqual({
				open: false,
			});
			expect(await codeOf(call(openTripByLink, omar, { slug: c.slug }))).toBe(
				"NOT_FOUND",
			);
			expect(await loadTripAccess(c.tripId, omar.id)).toBeNull();
		} finally {
			tripOpenLimit.over = false;
		}
	});
});

describe("placeholders ↔ accounts (ADDENDUM §10)", () => {
	it("QA HOME-1 / SEC-R1-01: a link guest can't claim a placeholder; the owner's promote merges it", async () => {
		const c = await freshTrip();
		const itemId = c.ids.items.hands as string;
		await getDb().execute(sql`
			insert into item_assignees (trip_id, item_id, member_id) values (${c.tripId}, ${itemId}, ${c.members.audrey})
			on conflict do nothing`);
		expect(
			await codeOf(
				call(claimPlaceholder, U.stranger, {
					tripId: c.tripId,
					memberId: c.members.audrey,
				}),
			),
		).toBe("NOT_FOUND");
		// Signed in on the VIEW link: no membership, no money, no booking refs.
		const audreyGuest = await newUser({ first: "Audrey", last: "Nguyen" });
		await joinTestLink(getDb(), c, audreyGuest.id, "viewer");
		for (const u of [U.signedGuest, audreyGuest])
			expect(
				await codeOf(
					call(claimPlaceholder, u, {
						tripId: c.tripId,
						memberId: c.members.audrey,
					}),
				),
			).toBe("FORBIDDEN");
		expect(await memberOf(c.tripId, audreyGuest.id)).toBeUndefined();
		expect(await loadTripAccess(c.tripId, audreyGuest.id)).toMatchObject({
			role: "viewer",
			isGuest: true,
		});
		const ph = await q<{ status: string }>(sql`
			select status::text as status from trip_members where id = ${c.members.audrey}`);
		expect(ph[0]?.status).toBe("placeholder");
		// The owner confirms: "Add to trip" merges the placeholder with her name.
		const { memberId } = await call<{ memberId: string }>(
			promoteGuest,
			U.owner,
			{ tripId: c.tripId, userId: audreyGuest.id, role: "viewer" },
		);
		const merged = await q<{ status: string; into: string }>(sql`
			select status::text as status, merged_into_id::text as into from trip_members where id = ${c.members.audrey}`);
		expect(merged[0]).toEqual({ status: "removed", into: memberId });
		const tags = await q<{ memberId: string }>(sql`
			select member_id::text as "memberId" from item_assignees where item_id = ${itemId}`);
		expect(tags.map((t) => t.memberId)).toContain(memberId);
		// Only placeholders can be claimed.
		expect(
			await codeOf(
				call(claimPlaceholder, U.viewer, {
					tripId: c.tripId,
					memberId: c.members.owner,
				}),
			),
		).toBe("NOT_FOUND");
	});

	it("a member claiming a placeholder merges it into themselves (their own name, or any for editors)", async () => {
		const c = await freshTrip();
		// Vic (viewer) isn't Audrey: taking over her splits needs an owner or editor.
		expect(
			await codeOf(
				call(claimPlaceholder, U.viewer, {
					tripId: c.tripId,
					memberId: c.members.audrey,
				}),
			),
		).toBe("FORBIDDEN");
		const mayaRow = await memberOf(c.tripId, U.maya.id);
		await call(claimPlaceholder, U.maya, {
			tripId: c.tripId,
			memberId: c.members.audrey,
		});
		const audrey = await q<{ status: string; into: string }>(sql`
			select status::text as status, merged_into_id::text as into from trip_members where id = ${c.members.audrey}`);
		expect(audrey[0]).toEqual({ status: "removed", into: mayaRow?.id });
		expect((await memberOf(c.tripId, U.maya.id))?.role).toBe("editor");
		// A viewer member with the placeholder's first name claims it herself.
		const kim = await newUser({ first: "Kim", last: "Lee" });
		await getDb().insert(tripMembers).values({
			tripId: c.tripId,
			userId: kim.id,
			status: "active",
			role: "viewer",
			color: 6,
		});
		const ph = await q<{ id: string }>(sql`
			insert into trip_members (id, trip_id, status, role, display_name, color)
			values (gen_random_uuid(), ${c.tripId}, 'placeholder', 'editor', 'kim', 2) returning id::text as id`);
		const r = await call<{ memberId: string }>(claimPlaceholder, kim, {
			tripId: c.tripId,
			memberId: ph[0]?.id,
		});
		expect(r.memberId).toBe((await memberOf(c.tripId, kim.id))?.id);
		expect((await memberOf(c.tripId, kim.id))?.role).toBe("viewer");
	});

	it("QA SEC-R2-01: an edit-link guest the owner links to a placeholder's email gets the placeholder's role", async () => {
		const c = await freshTrip();
		const grantsOf = async (userId: string) =>
			(
				await q<{ n: number }>(sql`
			select count(*)::int as n from share_grants where trip_id = ${c.tripId} and user_id = ${userId}`)
			)[0]?.n;
		// The owner links a placeholder to the email of an edit-link guest.
		const hana = await newUser({ first: "Hana", last: "Holder" });
		await joinTestLink(getDb(), c, hana.id, "editor");
		const ph2 = await call<{ memberId: string }>(addPlaceholder, U.owner, {
			tripId: c.tripId,
			displayName: "Hana",
		});
		await call(linkPlaceholder, U.owner, {
			memberId: ph2.memberId,
			email: hana.email,
		});
		// A typed-in placeholder is a rater (PLACES §1c), not the link's editor.
		expect(await loadTripAccess(c.tripId, hana.id)).toMatchObject({
			role: "rater",
			isGuest: false,
		});
		expect(await grantsOf(hana.id)).toBe(0);
	});

	it("links a placeholder to an invite email (claimed on sign-up) or merges it into a member", async () => {
		const c = await freshTrip();
		await call(linkPlaceholder, U.maya, {
			memberId: c.members.audrey,
			email: "Audrey@Example.test",
		});
		const row = await q<{ status: string; email: string }>(sql`
			select status::text as status, email from trip_members where id = ${c.members.audrey}`);
		expect(row[0]).toEqual({ status: "invited", email: "audrey@example.test" });
		// A second placeholder merged into Maya.
		const ph = await q<{ id: string }>(sql`
			insert into trip_members (id, trip_id, status, role, display_name, color)
			values (gen_random_uuid(), ${c.tripId}, 'placeholder', 'viewer', 'Mai', 2) returning id::text as id`);
		const mayaRow = await memberOf(c.tripId, U.maya.id);
		await call(linkPlaceholder, U.owner, {
			memberId: ph[0]?.id,
			toMemberId: mayaRow?.id,
		});
		const merged = await q<{ into: string }>(sql`
			select merged_into_id::text as into from trip_members where id = ${ph[0]?.id}`);
		expect(merged[0]?.into).toBe(mayaRow?.id);
		expect(
			await codeOf(
				call(linkPlaceholder, U.viewer, {
					memberId: c.members.audrey,
					email: "z@example.test",
				}),
			),
		).toBe("FORBIDDEN");
	});
});

describe("duplicateTrip (ADDENDUM §9)", () => {
	it("copies the structure with fresh ids and shifted days, and only what was asked", async () => {
		const c = await freshTrip();
		// Maya's private todo must never be copied; mine may be.
		await getDb().execute(sql`
			insert into list_items (id, trip_id, list, text, is_private, created_by, position)
			values (gen_random_uuid(), ${c.tripId}, 'todo', 'Maya secret gift', true, ${U.maya.id}, 'a0'),
			       (gen_random_uuid(), ${c.tripId}, 'todo', 'My own secret', true, ${U.owner.id}, 'a1'),
			       (gen_random_uuid(), ${c.tripId}, 'todo', ${`Ask ${mentionToken("Audrey", c.members.audrey)} and ${mentionToken("Maya", c.members.maya ?? "")}`}, false, ${U.owner.id}, 'a2')`);
		const src = (
			await q<{
				start: string;
				days: number;
				nodes: number;
				items: number;
				legs: number;
			}>(sql`
			select t.start_date::text as start,
			       (select count(*)::int from trip_days where trip_id = t.id) as days,
			       (select count(*)::int from nodes where trip_id = t.id and deleted_at is null) as nodes,
			       (select count(*)::int from items where trip_id = t.id and deleted_at is null) as items,
			       (select count(*)::int from legs where trip_id = t.id) as legs
			  from trips t where t.id = ${c.tripId}`)
		)[0];
		if (!src) throw new Error("fixture");
		expect(
			await codeOf(
				call(duplicateTrip, U.guest, {
					tripId: c.tripId,
					name: "Nope",
					startDate: "2028-01-01",
					include: {
						notes: true,
						lists: true,
						media: true,
						budgets: true,
						placeholders: true,
					},
				}),
			),
		).toBe("FORBIDDEN");
		const startDate = "2028-04-02";
		const r = await call<{ tripId: string; slug: string }>(
			duplicateTrip,
			U.owner,
			{
				tripId: c.tripId,
				name: "Demo again",
				startDate,
				include: {
					notes: true,
					lists: true,
					media: true,
					budgets: true,
					placeholders: true,
				},
			},
		);
		expect(r.tripId).not.toBe(c.tripId);
		// Its own address: the copy's name and a random tail (link sharing off).
		expect(r.slug).toMatch(/^demo-again-[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
		const [addr] = await q<{ tail: string; links: number }>(sql`
			select slug_tail as tail,
			       (select count(*)::int from share_links where trip_id = ${r.tripId}) as links
			  from trips where id = ${r.tripId}`);
		expect(addr).toEqual({ tail: r.slug.slice(-8), links: 0 });
		const dup = (
			await q<{
				start: string;
				days: number;
				nodes: number;
				items: number;
				legs: number;
				members: string[];
				name: string;
			}>(sql`
			select t.start_date::text as start, t.name,
			       (select count(*)::int from trip_days where trip_id = t.id) as days,
			       (select count(*)::int from nodes where trip_id = t.id and deleted_at is null) as nodes,
			       (select count(*)::int from items where trip_id = t.id and deleted_at is null) as items,
			       (select count(*)::int from legs where trip_id = t.id) as legs,
			       (select array_agg(status::text || ':' || role::text order by status) from trip_members where trip_id = t.id) as members
			  from trips t where t.id = ${r.tripId}`)
		)[0];
		expect(dup).toMatchObject({
			start: startDate,
			name: "Demo again",
			days: src.days,
			nodes: src.nodes,
			items: src.items,
			legs: src.legs,
		});
		expect(dup?.members.sort()).toEqual(
			["active:owner", "placeholder:editor"].sort(),
		);
		const lists = await q<{ text: string; status: string }>(sql`
			select text, status::text as status from list_items where trip_id = ${r.tripId} and deleted_at is null`);
		expect(lists.some((l) => l.text === "Maya secret gift")).toBe(false);
		expect(lists.some((l) => l.text === "My own secret")).toBe(true);
		expect(lists.every((l) => l.status === "open")).toBe(true);
		const ask = lists.find((l) => l.text.startsWith("Ask "));
		// Audrey (copied placeholder) keeps a chip with her NEW id; Maya becomes plain text.
		expect(ask?.text).toMatch(
			/\[@Audrey\]\(mention:[0-9a-f-]{36}\) and @Maya$/,
		);
		expect(ask?.text).not.toContain(c.members.audrey);
		// Nothing points back at the source trip.
		const leaks = await q<{ n: number }>(sql`
			select (select count(*)::int from items i join nodes n on n.id = i.node_id
			         where i.trip_id = ${r.tripId} and n.trip_id <> ${r.tripId})
			     + (select count(*)::int from legs l join items i on i.id = l.from_item_id
			         where l.trip_id = ${r.tripId} and i.trip_id <> ${r.tripId}) as n`);
		expect(leaks[0]?.n).toBe(0);
		// No money, links, proposals or activity came along.
		const none = await q<{ n: number }>(sql`
			select (select count(*)::int from expenses where trip_id = ${r.tripId})
			     + (select count(*)::int from share_links where trip_id = ${r.tripId})
			     + (select count(*)::int from proposals where trip_id = ${r.tripId})
			     + (select count(*)::int from activity_log where trip_id = ${r.tripId}) as n`);
		expect(none[0]?.n).toBe(0);
		// Structure only.
		const bare = await call<{ tripId: string }>(duplicateTrip, U.owner, {
			tripId: c.tripId,
			name: "Bare",
			startDate,
			include: {
				notes: false,
				lists: false,
				media: false,
				budgets: false,
				placeholders: false,
			},
		});
		const bareCounts = await q<{
			lists: number;
			members: number;
			notes: number;
		}>(sql`
			select (select count(*)::int from list_items where trip_id = ${bare.tripId}) as lists,
			       (select count(*)::int from trip_members where trip_id = ${bare.tripId}) as members,
			       (select count(*)::int from yjs_documents where trip_id = ${bare.tripId}) as notes`);
		expect(bareCounts[0]).toEqual({ lists: 0, members: 1, notes: 0 });
	});

	it("remaps mentions, member ids in JSON and ids inside Yjs state", () => {
		const a = "11111111-1111-4111-8111-111111111111";
		const b = "22222222-2222-4222-8222-222222222222";
		const z = "33333333-3333-4333-8333-333333333333";
		const m = new Map([[a, b]]);
		expect(
			remapMentions(`${mentionToken("A", a)} + ${mentionToken("Zed", z)}`, m),
		).toBe(`[@A](mention:${b}) + @Zed`);
		expect(
			remapMemberIds(
				{ seats: [{ memberId: a }, { memberId: z, seat: "3A" }] },
				m,
			),
		).toEqual({ seats: [{ memberId: b }, { seat: "3A" }] });
		const state = Buffer.concat([
			Buffer.from([1, 36]),
			Buffer.from(a),
			Buffer.from([0]),
		]);
		expect(replaceIdsInState(state, m).toString("latin1")).toContain(b);
		expect(replaceIdsInState(state, m).length).toBe(state.length);
	});
});

describe("dashboard reads", () => {
	it("lists my trips with role, route points and chips; deadlines skip others' private items", async () => {
		const c = await freshTrip();
		const trips = await call<MyTrip[]>(listMyTrips, U.owner);
		const mine = trips.find((t) => t.id === c.tripId);
		expect(mine?.role).toBe("owner");
		expect(mine?.viaLink).toBe(false);
		expect(mine?.routePoints.length).toBeGreaterThan(0);
		const viaLink = (await call<MyTrip[]>(listMyTrips, U.signedGuest)).find(
			(t) => t.id === c.tripId,
		);
		expect(viaLink).toMatchObject({ viaLink: true, role: "viewer" });

		const tomorrow = new Date(Date.now() + 86_400_000)
			.toISOString()
			.slice(0, 10);
		await getDb().execute(sql`
			insert into list_items (id, trip_id, list, text, due_date, created_by, position, is_private)
			values (gen_random_uuid(), ${c.tripId}, 'todo', 'Book the ryokan', ${tomorrow}, ${U.owner.id}, 'b0', false),
			       (gen_random_uuid(), ${c.tripId}, 'todo', 'Maya private deadline', ${tomorrow}, ${U.maya.id}, 'b1', true)`);
		const owner = await call<MyDeadline[]>(listMyDeadlines, U.owner);
		expect(owner.some((d) => d.text === "Book the ryokan")).toBe(true);
		expect(owner.some((d) => d.text === "Maya private deadline")).toBe(false);
		const maya = await call<MyDeadline[]>(listMyDeadlines, U.maya);
		expect(maya.some((d) => d.text === "Maya private deadline")).toBe(true);
		// Assigned only to Maya: not in my list, but in "Everyone's".
		const ownerRow = await memberOf(c.tripId, U.owner.id);
		const mayaRow = await memberOf(c.tripId, U.maya.id);
		if (!ownerRow || !mayaRow) throw new Error("fixture");
		const [task] = await q<{ id: string }>(sql`
			insert into list_items (id, trip_id, list, text, due_date, created_by, position, is_private)
			values (gen_random_uuid(), ${c.tripId}, 'todo', 'Maya books the JR seats', ${tomorrow}, ${U.owner.id}, 'b2', false)
			returning id::text as id`);
		await getDb().execute(sql`
			insert into list_item_assignees (trip_id, list_item_id, member_id) values (${c.tripId}, ${task?.id}, ${mayaRow.id})`);
		const again = await call<MyDeadline[]>(listMyDeadlines, U.owner);
		expect(again.some((d) => d.text === "Maya books the JR seats")).toBe(false);
		const everyone = await call<MyDeadline[]>(listMyDeadlines, U.owner, {
			everyone: true,
		});
		expect(
			everyone.find((d) => d.text === "Maya books the JR seats"),
		).toBeTruthy();
		expect(everyone.some((d) => d.text === "Maya private deadline")).toBe(
			false,
		);
	});

	it("computes relative booking windows and states", () => {
		const base = {
			dueKind: "opens" as const,
			dueDate: null,
			dueTime: null,
			dueTz: null,
			dueDayDate: null,
			dueDayStart: null,
			tripTz: "Asia/Tokyo",
		};
		const r = deadlineAt({
			...base,
			dueRule: {
				kind: "days",
				itemId: "11111111-1111-4111-8111-111111111111",
				days: 355,
				time: "09:00",
				tz: "Asia/Tokyo",
			},
			anchorDate: "2027-10-02",
		});
		expect(r?.date).toBe("2026-10-12");
		const m = deadlineAt({
			...base,
			dueRule: {
				kind: "months",
				itemId: "11111111-1111-4111-8111-111111111111",
				months: 1,
				time: "10:00",
				tz: "Asia/Tokyo",
			},
			anchorDate: "2027-03-31",
		});
		expect(m?.date).toBe("2027-02-28");
		expect(
			deadlineAt({
				...base,
				dueRule: {
					kind: "days",
					itemId: "11111111-1111-4111-8111-111111111111",
					days: 1,
					time: "09:00",
					tz: "Asia/Tokyo",
				},
				anchorDate: null,
			}),
		).toBeNull();
		const now = Date.parse("2026-09-23T00:00:00Z");
		expect(deadlineState("opens", now - 3_600_000, now)).toBe("open_now");
		expect(deadlineState("opens", now - 5 * 86_400_000, now)).toBe("overdue");
		expect(deadlineState("due", now + 86_400_000, now)).toBe("soon");
		expect(deadlineState("due", now + 30 * 86_400_000, now)).toBe("later");
	});
});

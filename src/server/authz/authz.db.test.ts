/**
 * The authz and account SQL against real Postgres: access resolution
 * (memberships, grants, disabled/expired/revoked links, deleted trips),
 * opening a trip through its address (the link), guest → account migration
 * and invite claiming.
 * Uses its own throwaway database (created, migrated and dropped here).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { shareGrants, shareLinks, tripMembers, trips, user } from "@/db/schema";
import { seedDemoSkeleton } from "@/db/seed.server";
import {
	claimInvites,
	migrateGuestToUser,
} from "@/server/auth/accounts.server";
import { pinTestLink } from "@/server/fixture.server";
import { openTripLink, tripLinkIsOpen } from "./share-links.server";
import { loadTripAccess } from "./trip-access.server";

// .env is loaded by vitest.config.ts (variables already set win).
const baseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL_TEST or DATABASE_URL must be set");
const scratchUrl = (() => {
	const url = new URL(baseUrl);
	url.pathname = `/yonder_authz_${randomBytes(4).toString("hex")}`;
	return url.toString();
})();

beforeAll(async () => {
	await ensureDatabase(scratchUrl);
	await migrateDatabase(scratchUrl);
	// The app's lazy `db` reads DATABASE_URL on first use.
	process.env.DATABASE_URL = scratchUrl;
}, 60_000);

afterAll(async () => {
	await closeDb();
	await dropDatabase(scratchUrl);
});

const db = () => getDb();

async function newUser(opts: { anonymous?: boolean; email?: string } = {}) {
	const id = randomUUID();
	await db()
		.insert(user)
		.values({
			id,
			name: opts.anonymous ? "Guest Wren" : "Kai Tester",
			email:
				opts.email ??
				`${id}@${opts.anonymous ? "guest.yonder.invalid" : "asia2027.test"}`,
			isAnonymous: opts.anonymous ?? false,
			firstName: opts.anonymous ? "" : "Kai",
			lastName: opts.anonymous ? "" : "Tester",
		});
	return id;
}

async function newTrip() {
	const slug = `t-${randomBytes(4).toString("hex")}`;
	return seedDemoSkeleton(db(), {
		email: `${slug}@asia2027.test`,
		tripSlug: slug,
		tripName: slug,
	});
}

async function newLink(
	tripId: string,
	role: "viewer" | "editor",
	extra: Partial<typeof shareLinks.$inferInsert> = {},
) {
	const [row] = await db()
		.insert(shareLinks)
		.values({ tripId, role, ...extra })
		.returning({ id: shareLinks.id });
	if (!row) throw new Error("no link");
	return { id: row.id };
}

/** A grant row as it stands (a member who also holds one: old data, a guest promoted). */
async function grantRow(tripId: string, linkId: string, userId: string) {
	await db()
		.insert(shareGrants)
		.values({ tripId, shareLinkId: linkId, userId, color: 3 });
}

describe("loadTripAccess", () => {
	it("resolves the owner and refuses strangers", async () => {
		const t = await newTrip();
		await expect(loadTripAccess(t.tripId, t.userId)).resolves.toMatchObject({
			role: "owner",
			isGuest: false,
			memberId: t.memberId,
			slug: t.tripSlug,
			color: 0,
		});
		await expect(loadTripAccess(t.tripId, await newUser())).resolves.toBeNull();
		await expect(loadTripAccess("not-a-uuid", t.userId)).resolves.toBeNull();
	});

	it("takes the max of membership and live grants", async () => {
		const t = await newTrip();
		const kai = await newUser();
		await db().insert(tripMembers).values({
			tripId: t.tripId,
			userId: kai,
			status: "active",
			role: "viewer",
			color: 1,
		});
		const link = await newLink(t.tripId, "editor");
		await grantRow(t.tripId, link.id, kai);
		await expect(loadTripAccess(t.tripId, kai)).resolves.toMatchObject({
			role: "editor",
			isGuest: false,
			color: 1,
		});
	});

	it("ignores invited and placeholder rows", async () => {
		const t = await newTrip();
		const kai = await newUser();
		await db().insert(tripMembers).values({
			tripId: t.tripId,
			status: "invited",
			role: "editor",
			email: "kai@x.test",
			color: 2,
		});
		await expect(loadTripAccess(t.tripId, kai)).resolves.toBeNull();
	});

	it("cuts access for a deleted trip", async () => {
		const t = await newTrip();
		await db()
			.update(trips)
			.set({ deletedAt: new Date() })
			.where(eq(trips.id, t.tripId));
		await expect(loadTripAccess(t.tripId, t.userId)).resolves.toBeNull();
	});
});

describe("openTripLink: the trip's address is its link", () => {
	it("gives a non-member who opens it the link's role, with a stable colour", async () => {
		const t = await newTrip();
		const g = await newUser({ anonymous: true });
		const link = await newLink(t.tripId, "viewer");

		expect(await tripLinkIsOpen(t.tripSlug)).toBe(true);
		const first = await openTripLink(t.tripSlug, g);
		expect(first).toMatchObject({
			tripId: t.tripId,
			slug: t.tripSlug,
			role: "viewer",
			shareLinkId: link.id,
		});
		expect(first?.color).toBe(1); // the owner holds 0
		await expect(loadTripAccess(t.tripId, g)).resolves.toMatchObject({
			role: "viewer",
			isGuest: true,
			color: 1,
		});

		const again = await openTripLink(t.tripSlug, g);
		expect(again?.color).toBe(1);
		const [row] = await db()
			.select()
			.from(shareLinks)
			.where(eq(shareLinks.id, link.id));
		expect(row?.useCount).toBe(2);
		expect(row?.lastUsedAt).toBeInstanceOf(Date);

		const g2 = await newUser({ anonymous: true });
		expect((await openTripLink(t.tripSlug, g2))?.color).toBe(2);
	});

	it("members open it as members: no grant, no second member row (SHARE-04, QA LINK-08)", async () => {
		const t = await newTrip();
		await newLink(t.tripId, "editor");
		expect(await openTripLink(t.tripSlug, t.userId)).toBeNull();
		const grants = await db()
			.select()
			.from(shareGrants)
			.where(eq(shareGrants.tripId, t.tripId));
		expect(grants).toHaveLength(0);
		const members = await db()
			.select()
			.from(tripMembers)
			.where(eq(tripMembers.tripId, t.tripId));
		expect(members).toHaveLength(1);
		await expect(loadTripAccess(t.tripId, t.userId)).resolves.toMatchObject({
			role: "owner",
		});
	});

	it("opens nothing for an unknown or malformed address, a link that is off, expired or revoked, or a deleted trip", async () => {
		const g = await newUser({ anonymous: true });
		expect(await openTripLink("no-such-trip-k7m2qxw9", g)).toBeNull();
		expect(await openTripLink("../etc", g)).toBeNull();
		expect(await openTripLink("", g)).toBeNull();

		const off = await newTrip();
		expect(await openTripLink(off.tripSlug, g)).toBeNull(); // never turned on
		await newLink(off.tripId, "viewer", { enabled: false });
		expect(await tripLinkIsOpen(off.tripSlug)).toBe(false);
		expect(await openTripLink(off.tripSlug, g)).toBeNull();

		const expired = await newTrip();
		await newLink(expired.tripId, "viewer", {
			expiresAt: new Date(Date.now() - 1000),
		});
		expect(await openTripLink(expired.tripSlug, g)).toBeNull();

		const revoked = await newTrip();
		await newLink(revoked.tripId, "editor", { revokedAt: new Date() });
		expect(await openTripLink(revoked.tripSlug, g)).toBeNull();

		const deleted = await newTrip();
		await newLink(deleted.tripId, "viewer");
		await db()
			.update(trips)
			.set({ deletedAt: new Date() })
			.where(eq(trips.id, deleted.tripId));
		expect(await tripLinkIsOpen(deleted.tripSlug)).toBe(false);
		expect(await openTripLink(deleted.tripSlug, g)).toBeNull();
		expect(await loadTripAccess(deleted.tripId, g)).toBeNull();
	});

	it("turning the link off or resetting it cuts existing guests off at once (QA LINK-04/05)", async () => {
		const t = await newTrip();
		const g = await newUser({ anonymous: true });
		const link = await newLink(t.tripId, "editor");
		await openTripLink(t.tripSlug, g);
		await expect(loadTripAccess(t.tripId, g)).resolves.toMatchObject({
			role: "editor",
		});

		await db()
			.update(shareLinks)
			.set({ enabled: false })
			.where(eq(shareLinks.id, link.id));
		await expect(loadTripAccess(t.tripId, g)).resolves.toBeNull();

		await db()
			.update(shareLinks)
			.set({ enabled: true, revokedAt: new Date() })
			.where(eq(shareLinks.id, link.id));
		await expect(loadTripAccess(t.tripId, g)).resolves.toBeNull();
		expect(await openTripLink(t.tripSlug, g)).toBeNull();
	});

	it("a grant only reaches its own trip (QA LINK-07)", async () => {
		const a = await newTrip();
		const b = await newTrip();
		const g = await newUser({ anonymous: true });
		await newLink(a.tripId, "editor");
		await openTripLink(a.tripSlug, g);
		await expect(loadTripAccess(b.tripId, g)).resolves.toBeNull();
	});

	it("test fixtures: `pinTestLink` lets each guest in with the role set when they opened it", async () => {
		const t = await newTrip();
		const v = await newUser({ anonymous: true });
		const e = await newUser({ anonymous: true });
		await pinTestLink(db(), t.tripId, "viewer");
		await openTripLink(t.tripSlug, v);
		await pinTestLink(db(), t.tripId, "editor");
		await openTripLink(t.tripSlug, e);
		expect((await loadTripAccess(t.tripId, v))?.role).toBe("viewer");
		expect((await loadTripAccess(t.tripId, e))?.role).toBe("editor");
		await pinTestLink(db(), t.tripId, null);
		expect(await loadTripAccess(t.tripId, v)).toBeNull();
		expect(await loadTripAccess(t.tripId, e)).toBeNull();
		expect(await tripLinkIsOpen(t.tripSlug)).toBe(false);
	});
});

describe("migrateGuestToUser", () => {
	it("moves grants and attribution to the account, de-duplicating, without membership", async () => {
		const t = await newTrip();
		const anon = await newUser({ anonymous: true });
		const account = await newUser();
		const viewer = await newLink(t.tripId, "viewer");
		const editor = await newLink(t.tripId, "editor");
		await grantRow(t.tripId, viewer.id, anon);
		await grantRow(t.tripId, editor.id, anon);
		await grantRow(t.tripId, viewer.id, account); // duplicate after the move
		await db()
			.update(trips)
			.set({ createdBy: anon })
			.where(eq(trips.id, t.tripId));

		await migrateGuestToUser(anon, account);

		const grants = await db()
			.select()
			.from(shareGrants)
			.where(eq(shareGrants.tripId, t.tripId));
		expect(grants.map((g) => g.userId).sort()).toEqual([account, account]);
		expect(grants.some((g) => g.userId === anon)).toBe(false);
		const [trip] = await db()
			.select()
			.from(trips)
			.where(eq(trips.id, t.tripId));
		expect(trip?.createdBy).toBe(account);
		await expect(loadTripAccess(t.tripId, account)).resolves.toMatchObject({
			role: "editor",
			isGuest: true,
		});
		const members = await db()
			.select()
			.from(tripMembers)
			.where(eq(tripMembers.userId, account));
		expect(members).toHaveLength(0);
	});
});

describe("claimInvites", () => {
	it("activates invites for the user's email and drops ones for trips they're already in", async () => {
		const email = `audrey-${randomBytes(3).toString("hex")}@asia2027.test`;
		const audrey = await newUser({ email });
		const invitedTo = await newTrip();
		const alreadyIn = await newTrip();
		await db()
			.insert(tripMembers)
			.values([
				{
					tripId: invitedTo.tripId,
					status: "invited",
					role: "editor",
					email,
					color: 1,
				},
				{
					tripId: alreadyIn.tripId,
					status: "invited",
					role: "viewer",
					email,
					color: 2,
				},
				{
					tripId: alreadyIn.tripId,
					status: "active",
					role: "editor",
					userId: audrey,
					color: 3,
				},
			]);

		expect(await claimInvites(audrey)).toBe(1);

		await expect(
			loadTripAccess(invitedTo.tripId, audrey),
		).resolves.toMatchObject({ role: "editor", isGuest: false });
		const leftovers = await db().execute(
			sql`select count(*)::int as n from trip_members where email = ${email}`,
		);
		expect((leftovers.rows[0] as { n: number }).n).toBe(0);
		expect(await claimInvites(audrey)).toBe(0); // idempotent
	});

	it("skips anonymous users", async () => {
		expect(await claimInvites(await newUser({ anonymous: true }))).toBe(0);
	});
});

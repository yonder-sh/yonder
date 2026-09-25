/**
 * The authz and account SQL against real Postgres: access resolution
 * (memberships, grants, disabled/expired/revoked links, deleted trips),
 * share-link redemption, guest → account migration and invite claiming.
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
import { newShareToken, shareTokenColumns } from "@/db/share-token.server";
import {
	claimInvites,
	migrateGuestToUser,
} from "@/server/auth/accounts.server";
import { redeemShareToken } from "./share-links.server";
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
	const token = newShareToken();
	const [row] = await db()
		.insert(shareLinks)
		.values({ tripId, role, ...shareTokenColumns(token), ...extra })
		.returning({ id: shareLinks.id });
	if (!row) throw new Error("no link");
	return { token, id: row.id };
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
		await redeemShareToken(link.token, kai);
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

describe("redeemShareToken", () => {
	it("grants the link's role to a guest, with a stable colour", async () => {
		const t = await newTrip();
		const g = await newUser({ anonymous: true });
		const link = await newLink(t.tripId, "viewer");

		const first = await redeemShareToken(link.token, g);
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

		const again = await redeemShareToken(link.token, g);
		expect(again?.color).toBe(1);
		const [row] = await db()
			.select()
			.from(shareLinks)
			.where(eq(shareLinks.id, link.id));
		expect(row?.useCount).toBe(2);
		expect(row?.lastUsedAt).toBeInstanceOf(Date);

		const g2 = await newUser({ anonymous: true });
		expect((await redeemShareToken(link.token, g2))?.color).toBe(2);
		// A member keeps their member colour on a grant.
		const owned = await redeemShareToken(link.token, t.userId);
		expect(owned?.color).toBe(0);
		// …and is never turned into a second member row (QA LINK-08).
		const members = await db()
			.select()
			.from(tripMembers)
			.where(eq(tripMembers.tripId, t.tripId));
		expect(members).toHaveLength(1);
	});

	it("rejects unknown, malformed, disabled, expired and revoked links, and deleted trips", async () => {
		const t = await newTrip();
		const g = await newUser({ anonymous: true });
		expect(await redeemShareToken(newShareToken(), g)).toBeNull();
		expect(await redeemShareToken("abc", g)).toBeNull();

		const disabled = await newLink(t.tripId, "viewer", { enabled: false });
		expect(await redeemShareToken(disabled.token, g)).toBeNull();

		const t2 = await newTrip();
		const expired = await newLink(t2.tripId, "viewer", {
			expiresAt: new Date(Date.now() - 1000),
		});
		expect(await redeemShareToken(expired.token, g)).toBeNull();

		const revoked = await newLink(t2.tripId, "editor", {
			revokedAt: new Date(),
		});
		expect(await redeemShareToken(revoked.token, g)).toBeNull();

		const t3 = await newTrip();
		const live = await newLink(t3.tripId, "viewer");
		await db()
			.update(trips)
			.set({ deletedAt: new Date() })
			.where(eq(trips.id, t3.tripId));
		expect(await redeemShareToken(live.token, g)).toBeNull();
	});

	it("turning a link off or resetting it cuts existing guests off at once (QA LINK-04/05)", async () => {
		const t = await newTrip();
		const g = await newUser({ anonymous: true });
		const link = await newLink(t.tripId, "editor");
		await redeemShareToken(link.token, g);
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
		expect(await redeemShareToken(link.token, g)).toBeNull();
	});

	it("a grant only reaches its own trip (QA LINK-07)", async () => {
		const a = await newTrip();
		const b = await newTrip();
		const g = await newUser({ anonymous: true });
		const link = await newLink(a.tripId, "editor");
		await redeemShareToken(link.token, g);
		await expect(loadTripAccess(b.tripId, g)).resolves.toBeNull();
	});
});

describe("migrateGuestToUser", () => {
	it("moves grants and attribution to the account, de-duplicating, without membership", async () => {
		const t = await newTrip();
		const anon = await newUser({ anonymous: true });
		const account = await newUser();
		const viewer = await newLink(t.tripId, "viewer");
		const editor = await newLink(t.tripId, "editor");
		await redeemShareToken(viewer.token, anon);
		await redeemShareToken(editor.token, anon);
		await redeemShareToken(viewer.token, account); // duplicate after the move
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

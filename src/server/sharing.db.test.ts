/**
 * FB-13 and the 2026-09-25 redesign: ONE link per trip, like Google Drive,
 * and it is the trip's address, against real Postgres. The link's role is
 * every link guest's role (changing it changes theirs at once, re-checks
 * their sockets and, down to "Can view", withdraws their open suggestions);
 * OFF and "Reset link" (a new address tail) still remove everyone who came
 * in through it; turning it on gives a tail-less (seeded) address a tail; any
 * write folds a leftover second live link into the one the owner sees. Also
 * the migrations `0008_single_trip_link` (older per-role links become one,
 * per-person join links are gone) and `0016_trip_link_address` (every trip
 * gets an address tail, tokens are gone).
 * Uses its own throwaway databases (created, migrated and dropped here).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	MIGRATIONS_FOLDER,
	migrateDatabase,
} from "@/db/migrate.server";
import { user } from "@/db/schema";
import { SLUG_TAIL_ALPHABET } from "@/lib/trip-slug";
import { openTripLink } from "./authz/share-links.server";
import { loadTripAccess } from "./authz/trip-access.server";
import {
	cloneDemoTrip,
	type FixtureClone,
	pinTestLink,
} from "./fixture.server";
import { TxOutbox } from "./live/outbox.server";
import {
	extendLink,
	LINK_TTL_DAYS,
	loadSharing,
	resetLink,
	setLinkEnabled,
} from "./sharing.server";

const baseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL_TEST or DATABASE_URL must be set");
const scratch = (what: string) => {
	const url = new URL(baseUrl);
	url.pathname = `/yonder_${what}_${randomBytes(4).toString("hex")}`;
	return url.toString();
};
const scratchUrl = scratch("sharing");

beforeAll(async () => {
	await ensureDatabase(scratchUrl);
	await migrateDatabase(scratchUrl);
	process.env.DATABASE_URL = scratchUrl;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
}, 60_000);

afterAll(async () => {
	await closeDb();
	await dropDatabase(scratchUrl);
});

const db = () => getDb();
const q = async <T>(query: ReturnType<typeof sql>) =>
	(await db().execute(query)).rows as T[];

async function newUser(first: string, anonymous = false): Promise<string> {
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
	return id;
}

/** Runs a sharing core in a transaction; returns its result and the users whose access was re-checked. */
async function run<T>(
	tripId: string,
	fn: (
		tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
		out: TxOutbox,
	) => Promise<T>,
): Promise<{ value: T; access: string[] }> {
	const out = new TxOutbox(tripId);
	const value = await db().transaction((tx) => fn(tx, out));
	const users = (out as unknown as { accessUsers: Set<string> | null })
		.accessUsers;
	return { value, access: users ? [...users] : [] };
}

/** A token hash as the pre-0016 schema stored it (43 base64url characters). */
const oldTokenHash = () =>
	createHash("sha256").update(randomBytes(32)).digest("base64url");
const TAIL = `[${SLUG_TAIL_ALPHABET}]{8}`;

const tripSlug = async (tripId: string) =>
	(
		await q<{ slug: string; slugTail: string | null }>(sql`
			select slug, slug_tail as "slugTail" from trips where id = ${tripId}`)
	)[0];

const liveLinks = (tripId: string) =>
	q<{ id: string; role: string; enabled: boolean; expiresAt: Date | null }>(sql`
		select id::text as id, role::text as role, enabled, expires_at as "expiresAt"
		  from share_links where trip_id = ${tripId} and revoked_at is null`);

const roleOf = async (tripId: string, userId: string) =>
	(await loadTripAccess(tripId, userId))?.role ?? null;

const daysLeft = (d: Date | null) =>
	d ? Math.round((new Date(d).getTime() - Date.now()) / 86_400_000) : null;

let owner: string;
let c: FixtureClone;
/** A fresh clone whose one link has `role`, after a reset: its (new) address. */
async function freshLink(role: "viewer" | "suggester" | "editor") {
	c = await cloneDemoTrip(db(), owner);
	const { value: slug } = await run(c.tripId, (tx, out) =>
		resetLink(tx, out, c.tripId, role, owner),
	);
	return slug;
}

async function openProposal(tripId: string, authorUserId: string) {
	const id = randomUUID();
	await db().execute(sql`
		insert into proposals (id, trip_id, op, payload, base, entity_kind, summary,
		                       author_user_id, author_name, author_color, author_is_guest)
		values (${id}, ${tripId}, 'item.update', '{}'::jsonb, '{}'::jsonb, 'item', 'rename a thing',
		        ${authorUserId}, 'Guest', 1, true)`);
	return id;
}
const statusOf = async (id: string) =>
	(
		await q<{ status: string }>(
			sql`select status::text as status from proposals where id = ${id}`,
		)
	)[0]?.status;

beforeAll(async () => {
	owner = await newUser("Olga");
}, 60_000);

describe("one link per trip, at the trip's address (FB-13)", () => {
	it("changing the link's role changes every guest who came in through it, at once", async () => {
		const slug = await freshLink("viewer");
		expect(await liveLinks(c.tripId)).toHaveLength(1);
		const anon = await newUser("Heron", true);
		const signed = await newUser("Kai");
		expect((await openTripLink(slug, anon))?.role).toBe("viewer");
		expect((await openTripLink(slug, signed))?.role).toBe("viewer");
		expect(await roleOf(c.tripId, anon)).toBe("viewer");

		const up = await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, "editor", null, owner),
		);
		// Their open sockets re-check (collab closes and reconnects them).
		expect(up.access.sort()).toEqual([anon, signed].sort());
		expect(await roleOf(c.tripId, anon)).toBe("editor");
		expect(await roleOf(c.tripId, signed)).toBe("editor");
		// Same link, same address: nobody needs a new one.
		expect((await tripSlug(c.tripId))?.slug).toBe(slug);
		expect((await openTripLink(slug, await newUser("Lee")))?.role).toBe(
			"editor",
		);
		expect(await liveLinks(c.tripId)).toHaveLength(1);

		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, "suggester", null, owner),
		);
		expect(await roleOf(c.tripId, anon)).toBe("suggester");
		const sharing = await loadSharing(db(), c.tripId);
		expect(sharing.slug).toBe(slug);
		expect(sharing.link?.role).toBe("suggester");
		expect(sharing.guests.map((g) => g.role)).toEqual([
			"suggester",
			"suggester",
			"suggester",
		]);
	});

	it("down to 'Can view' withdraws the link guests' open suggestions; a member's stay", async () => {
		const slug = await freshLink("suggester");
		const guest = await newUser("Wren", true);
		await openTripLink(slug, guest);
		const theirs = await openProposal(c.tripId, guest);
		const members = await openProposal(c.tripId, owner);
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, "editor", null, owner),
		);
		expect(await statusOf(theirs)).toBe("open");
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, "viewer", null, owner),
		);
		expect(await roleOf(c.tripId, guest)).toBe("viewer");
		expect(await statusOf(theirs)).toBe("withdrawn");
		expect(await statusOf(members)).toBe("open");
	});

	it("a stronger role never keeps a longer expiry; a weaker one keeps its date", async () => {
		await freshLink("viewer");
		expect(daysLeft((await liveLinks(c.tripId))[0]?.expiresAt ?? null)).toBe(
			LINK_TTL_DAYS.viewer,
		);
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, "editor", null, owner),
		);
		expect(daysLeft((await liveLinks(c.tripId))[0]?.expiresAt ?? null)).toBe(
			LINK_TTL_DAYS.editor,
		);
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, "viewer", null, owner),
		);
		expect(daysLeft((await liveLinks(c.tripId))[0]?.expiresAt ?? null)).toBe(
			LINK_TTL_DAYS.editor,
		);
		// "Extend" gives the current role's full term.
		const { value: iso } = await run(c.tripId, (tx, out) =>
			extendLink(tx, out, c.tripId),
		);
		expect(daysLeft(new Date(iso))).toBe(LINK_TTL_DAYS.viewer);
	});

	it("OFF removes everyone for good; ON again keeps the role and the address, and they open it again", async () => {
		const slug = await freshLink("editor");
		const guest = await newUser("Ash", true);
		await openTripLink(slug, guest);
		const off = await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, null, false, owner),
		);
		expect(off.access).toEqual([guest]);
		expect(await roleOf(c.tripId, guest)).toBeNull();
		expect(await openTripLink(slug, guest)).toBeNull();
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, null, true, owner),
		);
		expect(await roleOf(c.tripId, guest)).toBeNull();
		expect((await liveLinks(c.tripId))[0]?.role).toBe("editor");
		expect((await tripSlug(c.tripId))?.slug).toBe(slug);
		expect((await openTripLink(slug, guest))?.role).toBe("editor");
	});

	it("'Reset link' gives the trip a new address tail: the old address and its guests are gone; the role stays", async () => {
		const slug = await freshLink("suggester");
		const guest = await newUser("Fox", true);
		await openTripLink(slug, guest);
		const { value: next, access } = await run(c.tripId, (tx, out) =>
			resetLink(tx, out, c.tripId, null, owner),
		);
		expect(access).toEqual([guest]);
		expect(await roleOf(c.tripId, guest)).toBeNull();
		expect(next).not.toBe(slug);
		// The readable part stays; only the tail is new.
		expect(next).toMatch(new RegExp(`^demo-${TAIL}$`));
		expect(await tripSlug(c.tripId)).toEqual({
			slug: next,
			slugTail: next.slice(-8),
		});
		expect(await openTripLink(slug, guest)).toBeNull();
		const links = await liveLinks(c.tripId);
		expect(links).toHaveLength(1);
		expect(links[0]?.role).toBe("suggester");
		expect((await openTripLink(next, guest))?.role).toBe("suggester");
	});

	it("'Reset link' while the link is off gives a new address and keeps it off", async () => {
		const slug = await freshLink("viewer");
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, null, false, owner),
		);
		const { value: next } = await run(c.tripId, (tx, out) =>
			resetLink(tx, out, c.tripId, null, owner),
		);
		expect(next).not.toBe(slug);
		expect((await liveLinks(c.tripId)).map((l) => l.enabled)).toEqual([false]);
		expect(await openTripLink(next, await newUser("Nox", true))).toBeNull();
	});

	it("turning the link on for a trip without one makes a view link; a tail-less (seeded) address gets a tail first", async () => {
		c = await cloneDemoTrip(db(), owner);
		// A seed's fixed address, like the QA seed's `asia-2027`.
		const seeded = `seeded-${randomBytes(3).toString("hex")}`;
		await db().execute(
			sql`update trips set slug = ${seeded}, slug_tail = null where id = ${c.tripId}`,
		);
		expect((await loadSharing(db(), c.tripId)).link).toBeNull();
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, null, true, owner),
		);
		const links = await liveLinks(c.tripId);
		expect(links.map((l) => [l.role, l.enabled])).toEqual([["viewer", true]]);
		const address = await tripSlug(c.tripId);
		expect(address?.slug).toMatch(new RegExp(`^${seeded}-${TAIL}$`));
		expect(address?.slugTail).toBe(address?.slug.slice(-8));
		// The guessable address opens nothing; the new one does.
		const g = await newUser("Pip", true);
		expect(await openTripLink(seeded, g)).toBeNull();
		expect((await openTripLink(address?.slug ?? "", g))?.role).toBe("viewer");
		// Turning it off and on again keeps that address.
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, null, false, owner),
		);
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, null, true, owner),
		);
		expect((await tripSlug(c.tripId))?.slug).toBe(address?.slug);
		// A role change needs a link: it never makes one silently.
		await db().execute(
			sql`delete from share_links where trip_id = ${c.tripId}`,
		);
		await expect(
			run(c.tripId, (tx, out) =>
				setLinkEnabled(tx, out, c.tripId, "editor", null, owner),
			),
		).rejects.toThrow(/NOT_FOUND/);
	});

	it("a leftover second live link (fixtures, pre-migration rows) is retired by the owner's next change", async () => {
		c = await cloneDemoTrip(db(), owner);
		// Test fixtures may hold a live link per role; guests on both.
		const onEdit = await newUser("Eddie", true);
		const onView = await newUser("Vera", true);
		await pinTestLink(db(), c.tripId, "editor");
		await openTripLink(c.slug, onEdit);
		await pinTestLink(db(), c.tripId, "viewer");
		await openTripLink(c.slug, onView);
		expect(await liveLinks(c.tripId)).toHaveLength(2);
		const shown = (await loadSharing(db(), c.tripId)).link;
		expect(shown?.role).toBe("viewer");
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, null, true, owner),
		);
		const links = await liveLinks(c.tripId);
		expect(links).toHaveLength(1);
		// The one the owner saw is the one that stays.
		expect(links[0]?.role).toBe("viewer");
		expect(await roleOf(c.tripId, onView)).toBe("viewer");
		expect(await roleOf(c.tripId, onEdit)).toBeNull();
	});
});

describe("migration 0008_single_trip_link", () => {
	it("folds per-role links into one per trip and drops per-person join links", async () => {
		// Migrate a database up to 0007, write the old shape, then apply 0008.
		const dir = mkdtempSync(path.join(tmpdir(), "yonder-mig-"));
		const url = scratch("mig");
		try {
			cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
			const journalPath = path.join(dir, "meta", "_journal.json");
			const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
				entries: { tag: string }[];
			};
			journal.entries = journal.entries.filter(
				(e) => e.tag < "0008_single_trip_link",
			);
			writeFileSync(journalPath, JSON.stringify(journal));
			await ensureDatabase(url);
			await migrateDatabase(url, { migrationsFolder: dir });

			const client = new pg.Client({ connectionString: url });
			await client.connect();
			try {
				const exec = (text: string, values: unknown[] = []) =>
					client.query(text, values);
				const users = {
					owner: randomUUID(),
					viewGuest: randomUUID(),
					editGuest: randomUUID(),
					both: randomUUID(),
					soleOwner: randomUUID(),
				};
				for (const [k, id] of Object.entries(users))
					await exec(
						`insert into "user" (id, name, email, email_verified, is_anonymous) values ($1, $2, $3, true, $4)`,
						[id, k, `${k}-${id}@example.test`, k.endsWith("Guest")],
					);
				const trip = randomUUID();
				const other = randomUUID();
				for (const [id, slug, by] of [
					[trip, "mig-a", users.owner],
					[other, "mig-b", users.soleOwner],
				])
					await exec(
						`insert into trips (id, slug, name, created_by) values ($1, $2, 'Trip', $3)`,
						[id, slug, by],
					);
				const placeholder = randomUUID();
				await exec(
					`insert into trip_members (id, trip_id, user_id, status, role, color)
					 values ($1, $2, $3, 'active', 'owner', 0), ($4, $5, $6, 'active', 'owner', 0)`,
					[
						randomUUID(),
						trip,
						users.owner,
						randomUUID(),
						other,
						users.soleOwner,
					],
				);
				const claim = oldTokenHash();
				await exec(
					`insert into trip_members (id, trip_id, status, role, color, display_name, claim_token_hash, claim_token_prefix)
					 values ($1, $2, 'placeholder', 'editor', 1, 'Audrey', $3, 'abcdef')`,
					[placeholder, trip, claim],
				);
				const link = async (
					tripId: string,
					role: string,
					opts: { enabled?: boolean; used?: string | null } = {},
				) => {
					const id = randomUUID();
					await exec(
						`insert into share_links (id, trip_id, token_hash, token_prefix, role, enabled, last_used_at, use_count)
						 values ($1, $2, $3, 'abcdef', $4, $5, $6, 1)`,
						[
							id,
							tripId,
							oldTokenHash(),
							role,
							opts.enabled ?? true,
							opts.used ?? null,
						],
					);
					return id;
				};
				// Trip A: the view link was opened most recently; the edit link
				// earlier; the suggest link is switched off.
				const view = await link(trip, "viewer", { used: "2026-09-20" });
				const edit = await link(trip, "editor", { used: "2026-09-01" });
				await link(trip, "suggester", { enabled: false });
				// Trip B has one link: untouched.
				const lone = await link(other, "editor");
				const grant = (linkId: string, tripId: string, userId: string) =>
					exec(
						`insert into share_grants (trip_id, share_link_id, user_id, color) values ($1, $2, $3, 2)`,
						[tripId, linkId, userId],
					);
				await grant(view, trip, users.viewGuest);
				await grant(edit, trip, users.editGuest);
				await grant(view, trip, users.both);
				await grant(edit, trip, users.both);
				await grant(lone, other, users.viewGuest);
				const proposal = async (author: string) => {
					const id = randomUUID();
					await exec(
						`insert into proposals (id, trip_id, op, payload, base, entity_kind, summary, author_user_id, author_name, author_color, author_is_guest)
						 values ($1, $2, 'item.update', '{}', '{}', 'item', 's', $3, 'G', 1, true)`,
						[id, trip, author],
					);
					return id;
				};
				const lostP = await proposal(users.editGuest);
				const keptP = await proposal(users.both);
				const dependant = randomUUID();
				await exec(
					`insert into proposals (id, trip_id, op, payload, base, entity_kind, summary, author_user_id, author_name, author_color, author_is_guest, requires)
					 values ($1, $2, 'item.update', '{}', '{}', 'item', 's', $3, 'O', 0, false, array[$4]::uuid[])`,
					[dependant, trip, users.owner, lostP],
				);

				await migrateDatabase(url);

				const live = await exec(
					`select id::text as id, trip_id::text as "tripId", role::text as role
					   from share_links where revoked_at is null order by trip_id`,
				);
				expect(
					live.rows.filter((r) => r.tripId === trip).map((r) => [r.id, r.role]),
				).toEqual([[view, "viewer"]]);
				expect(live.rows.filter((r) => r.tripId === other)).toHaveLength(1);
				const grants = await exec(
					`select user_id as "userId", share_link_id::text as link from share_grants where trip_id = $1 order by 1`,
					[trip],
				);
				expect(grants.rows).toEqual(
					[
						{ userId: users.viewGuest, link: view },
						{ userId: users.both, link: view },
					].sort((a, b) => a.userId.localeCompare(b.userId)),
				);
				const status = async (id: string) =>
					(
						await exec(
							`select status::text as s, review_note as note from proposals where id = $1`,
							[id],
						)
					).rows[0];
				expect(await status(lostP)).toEqual({
					s: "withdrawn",
					note: "author lost access",
				});
				expect((await status(keptP))?.s).toBe("open");
				expect(await status(dependant)).toEqual({
					s: "withdrawn",
					note: "depends on a withdrawn suggestion",
				});
				const cols = await exec(
					`select column_name from information_schema.columns
					  where table_name = 'trip_members' and column_name like 'claim%'`,
				);
				expect(cols.rows).toEqual([]);
				const temp = await exec(
					`select count(*)::int as n from pg_class where relname like '_fb13_%'`,
				);
				expect(temp.rows[0]?.n).toBe(0);
			} finally {
				await client.end();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
			await dropDatabase(url).catch(() => {});
		}
	}, 120_000);
});

describe("migration 0016_trip_link_address", () => {
	it("gives every trip an address tail, keeping the readable part, and drops the tokens", async () => {
		// Migrate a database up to 0015, write the old shape, then apply 0016.
		const dir = mkdtempSync(path.join(tmpdir(), "yonder-mig16-"));
		const url = scratch("mig16");
		try {
			cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
			const journalPath = path.join(dir, "meta", "_journal.json");
			const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
				entries: { tag: string }[];
			};
			journal.entries = journal.entries.filter(
				(e) => e.tag < "0016_trip_link_address",
			);
			writeFileSync(journalPath, JSON.stringify(journal));
			await ensureDatabase(url);
			await migrateDatabase(url, { migrationsFolder: dir });

			const client = new pg.Client({ connectionString: url });
			await client.connect();
			try {
				const exec = (text: string, values: unknown[] = []) =>
					client.query(text, values);
				const guest = randomUUID();
				await exec(
					`insert into "user" (id, name, email, email_verified, is_anonymous) values ($1, 'G', $2, true, true)`,
					[guest, `g-${guest}@example.test`],
				);
				const long = `a${"-b".repeat(49)}c`; // 100 characters
				const trips = {
					plain: [randomUUID(), "asia-2027", null],
					long: [randomUUID(), long, null],
					deleted: [randomUUID(), "asia-2027", "2026-09-01"],
				} as const;
				for (const [id, slug, deletedAt] of Object.values(trips))
					await exec(
						`insert into trips (id, slug, name, deleted_at) values ($1, $2, 'Trip', $3)`,
						[id, slug, deletedAt],
					);
				const link = randomUUID();
				await exec(
					`insert into share_links (id, trip_id, token_hash, token_prefix, role) values ($1, $2, $3, 'abcdef', 'viewer')`,
					[link, trips.plain[0], oldTokenHash()],
				);
				await exec(
					`insert into share_grants (trip_id, share_link_id, user_id, color) values ($1, $2, $3, 1)`,
					[trips.plain[0], link, guest],
				);

				await migrateDatabase(url);

				const rows = (
					await exec(
						`select id::text as id, slug, slug_tail as "slugTail" from trips`,
					)
				).rows as { id: string; slug: string; slugTail: string }[];
				const byId = new Map(rows.map((r) => [r.id, r]));
				const tail = new RegExp(`^${TAIL}$`);
				for (const r of rows) {
					expect(r.slugTail).toMatch(tail);
					expect(r.slug.endsWith(`-${r.slugTail}`)).toBe(true);
					expect(r.slug.length).toBeLessThanOrEqual(100);
				}
				expect(byId.get(trips.plain[0])?.slug).toMatch(
					new RegExp(`^asia-2027-${TAIL}$`),
				);
				expect(
					byId.get(trips.long[0])?.slug.startsWith(long.slice(0, 91)),
				).toBe(true);
				// Two trips never share a tail by chance here, and the live one is unique.
				expect(new Set(rows.map((r) => r.slugTail)).size).toBe(rows.length);
				// The link row and the guest's grant stay; the token columns are gone.
				const grants = await exec(
					`select count(*)::int as n from share_grants where share_link_id = $1`,
					[link],
				);
				expect(grants.rows[0]?.n).toBe(1);
				const cols = await exec(
					`select column_name from information_schema.columns
					  where table_name = 'share_links' and column_name like 'token%'`,
				);
				expect(cols.rows).toEqual([]);
				// The address check holds for later writes.
				await expect(
					exec(`update trips set slug_tail = 'zzzzzzzz' where id = $1`, [
						trips.plain[0],
					]),
				).rejects.toThrow(/trips_slug_tail_ck/);
			} finally {
				await client.end();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
			await dropDatabase(url).catch(() => {});
		}
	}, 120_000);
});

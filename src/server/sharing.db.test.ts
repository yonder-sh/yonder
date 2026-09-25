/**
 * FB-13 (owner feedback 2026-09-23): ONE share link per trip, like Google
 * Docs, against real Postgres. The link's role is every link guest's role
 * (changing it changes theirs at once, re-checks their sockets and, down to
 * "Can view", withdraws their open suggestions); OFF and "Reset link" still
 * remove everyone who came in through it; any write folds a leftover second
 * live link into the one the owner sees. Also the `0008_single_trip_link`
 * migration: older per-role links become one, and per-person join links
 * (FB-14) are gone from the schema.
 * Uses its own throwaway databases (created, migrated and dropped here).
 */
import { randomBytes, randomUUID } from "node:crypto";
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
import { hashShareToken } from "@/db/share-token.server";
import { parseShareFragment } from "@/lib/auth/share-link";
import { redeemShareToken } from "./authz/share-links.server";
import { loadTripAccess } from "./authz/trip-access.server";
import { cloneDemoTrip, type FixtureClone } from "./fixture.server";
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

const tokenOf = (url: string) =>
	parseShareFragment(new URL(url).hash) ?? "(no token)";

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
/** The trip's one link after a reset: its token (the fixture seeds two legacy links). */
async function freshLink(role: "viewer" | "suggester" | "editor") {
	c = await cloneDemoTrip(db(), owner);
	const { value: url } = await run(c.tripId, (tx, out) =>
		resetLink(tx, out, c.tripId, role, owner),
	);
	return tokenOf(url);
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

describe("one link per trip (FB-13)", () => {
	it("changing the link's role changes every guest who came in through it, at once", async () => {
		const token = await freshLink("viewer");
		expect(await liveLinks(c.tripId)).toHaveLength(1);
		const anon = await newUser("Heron", true);
		const signed = await newUser("Kai");
		expect((await redeemShareToken(token, anon))?.role).toBe("viewer");
		expect((await redeemShareToken(token, signed))?.role).toBe("viewer");
		expect(await roleOf(c.tripId, anon)).toBe("viewer");

		const up = await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, "editor", null, owner),
		);
		// Their open sockets re-check (collab closes and reconnects them).
		expect(up.access.sort()).toEqual([anon, signed].sort());
		expect(await roleOf(c.tripId, anon)).toBe("editor");
		expect(await roleOf(c.tripId, signed)).toBe("editor");
		// Same link, same URL: nobody needs a new one.
		expect((await redeemShareToken(token, await newUser("Lee")))?.role).toBe(
			"editor",
		);
		expect(await liveLinks(c.tripId)).toHaveLength(1);

		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, "suggester", null, owner),
		);
		expect(await roleOf(c.tripId, anon)).toBe("suggester");
		const sharing = await loadSharing(db(), c.tripId);
		expect(sharing.link?.role).toBe("suggester");
		expect(sharing.guests.map((g) => g.role)).toEqual([
			"suggester",
			"suggester",
			"suggester",
		]);
	});

	it("down to 'Can view' withdraws the link guests' open suggestions; a member's stay", async () => {
		const token = await freshLink("suggester");
		const guest = await newUser("Wren", true);
		await redeemShareToken(token, guest);
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

	it("OFF removes everyone for good; ON again keeps the role and needs the link again", async () => {
		const token = await freshLink("editor");
		const guest = await newUser("Ash", true);
		await redeemShareToken(token, guest);
		const off = await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, null, false, owner),
		);
		expect(off.access).toEqual([guest]);
		expect(await roleOf(c.tripId, guest)).toBeNull();
		expect(await redeemShareToken(token, guest)).toBeNull();
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, null, true, owner),
		);
		expect(await roleOf(c.tripId, guest)).toBeNull();
		expect((await liveLinks(c.tripId))[0]?.role).toBe("editor");
		expect((await redeemShareToken(token, guest))?.role).toBe("editor");
	});

	it("'Reset link' kills the old address and its guests; the new one keeps the role", async () => {
		const token = await freshLink("suggester");
		const guest = await newUser("Fox", true);
		await redeemShareToken(token, guest);
		const { value: url, access } = await run(c.tripId, (tx, out) =>
			resetLink(tx, out, c.tripId, null, owner),
		);
		expect(access).toEqual([guest]);
		expect(await roleOf(c.tripId, guest)).toBeNull();
		expect(await redeemShareToken(token, guest)).toBeNull();
		expect(tokenOf(url)).not.toBe(token);
		const links = await liveLinks(c.tripId);
		expect(links).toHaveLength(1);
		expect(links[0]?.role).toBe("suggester");
		expect((await redeemShareToken(tokenOf(url), guest))?.role).toBe(
			"suggester",
		);
	});

	it("turning the link on for a trip without one makes a view link", async () => {
		c = await cloneDemoTrip(db(), owner);
		await db().execute(
			sql`delete from share_links where trip_id = ${c.tripId}`,
		);
		expect((await loadSharing(db(), c.tripId)).link).toBeNull();
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, null, true, owner),
		);
		const links = await liveLinks(c.tripId);
		expect(links.map((l) => [l.role, l.enabled])).toEqual([["viewer", true]]);
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
		// The fixture seeds an editor and a view link; guests on both.
		const onEdit = await newUser("Eddie", true);
		const onView = await newUser("Vera", true);
		await redeemShareToken(c.shareTokens.editor, onEdit);
		await redeemShareToken(c.shareTokens.viewer, onView);
		expect(await liveLinks(c.tripId)).toHaveLength(2);
		const shown = (await loadSharing(db(), c.tripId)).link;
		await run(c.tripId, (tx, out) =>
			setLinkEnabled(tx, out, c.tripId, null, true, owner),
		);
		const links = await liveLinks(c.tripId);
		expect(links).toHaveLength(1);
		// The one the owner saw is the one that stays.
		expect(links[0]?.role).toBe(shown?.role);
		const kept = shown?.role === "editor" ? onEdit : onView;
		const dropped = kept === onEdit ? onView : onEdit;
		expect(await roleOf(c.tripId, kept)).toBe(shown?.role);
		expect(await roleOf(c.tripId, dropped)).toBeNull();
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
				const claim = hashShareToken(randomBytes(32).toString("base64url"));
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
							hashShareToken(randomBytes(32).toString("base64url")),
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

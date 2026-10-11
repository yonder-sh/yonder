/**
 * Trash against real Postgres (its own database): what goes in (deleted
 * files, files on a deleted stop, place or trip, deleted Saved shares), that
 * it still counts toward the quota (shared objects once), Restore's targets
 * and Undo, Delete forever / Empty trash with shared objects kept, and the
 * purge's 30-day step for files on deleted stops. Storage is stubbed.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_trash_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-trashtest-${hex}`;
	process.env.BETTER_AUTH_URL = "http://localhost:3000";
	process.env.APP_URL = "http://localhost:3000";
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { scratchUrl: scratch.toString() };
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
import { tripMembers, user } from "@/db/schema";
import { purge } from "@/features/media/server/purge.server";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { usedBytes } from "@/server/quota.server";
import {
	deleteForever,
	emptyTrash,
	listTrash,
	restoreTrash,
	retrash,
} from "../server/trash.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const DAY = 86_400_000;
/** The stubbed bucket: prefixes deleted, never a real request. */
const dropped: string[] = [];
const drop = async (p: string) => {
	dropped.push(p);
	return 1;
};

async function newUser(first: string): Promise<AuthUser> {
	const id = randomUUID();
	const [row] = await getDb()
		.insert(user)
		.values({
			id,
			email: `u-${id}@example.test`,
			emailVerified: true,
			name: `${first} Test`,
			firstName: first,
			lastName: "Test",
			isAnonymous: false,
		})
		.returning();
	return row as unknown as AuthUser;
}

const q = async <T>(query: ReturnType<typeof sql>) =>
	(await getDb().execute(query)).rows as T[];

/** A ready file uploaded by `by`, on a node or item (or the trip root). */
async function file(
	tripId: string,
	by: string,
	o: {
		nodeId?: string;
		itemId?: string;
		kind?: "photo" | "video" | "pdf";
		size?: number;
		key?: string;
	} = {},
): Promise<string> {
	const id = randomUUID();
	await getDb().execute(sql`
		insert into attachments (id, trip_id, node_id, item_id, kind, status, storage_key, mime, size_bytes,
		                         position, created_by, meta)
		values (${id}, ${tripId}, ${o.nodeId ?? null}, ${o.itemId ?? null}, ${o.kind ?? "photo"}, 'ready',
		        ${o.key ?? null}, ${o.kind === "pdf" ? "application/pdf" : "image/jpeg"}, ${o.size ?? 100},
		        ${`zz${id.slice(0, 6)}`}, ${by}, '{"thumb": true}'::jsonb)`);
	return id;
}

/** A Saved share of one photo stored at `key`. */
async function savedPhoto(userId: string, key: string, size = 100) {
	const savedId = randomUUID();
	await getDb().execute(sql`
		insert into saved_links (id, user_id, preview_status) values (${savedId}, ${userId}, 'ready')`);
	await getDb().execute(sql`
		insert into saved_files (id, saved_id, user_id, position, kind, mime, size_bytes, storage_key, status)
		values (${randomUUID()}, ${savedId}, ${userId}, 0, 'photo', 'image/jpeg', ${size}, ${key}, 'ready')`);
	return savedId;
}

/** A stop (an item on a place) of the trip. */
async function aStop(c: FixtureClone) {
	const [r] = await q<{ id: string; nodeId: string }>(sql`
		select id::text as id, node_id::text as "nodeId" from items
		 where trip_id = ${c.tripId} and node_id is not null and deleted_at is null limit 1`);
	return r as { id: string; nodeId: string };
}

const ago = (days: number) => new Date(Date.now() - days * DAY);
const ids = async (u: AuthUser) => (await listTrash(u.id)).map((t) => t.id);

let me: AuthUser;
let viewer: AuthUser;
let c: FixtureClone;

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	me = await newUser("Dennis");
	viewer = await newUser("Vic");
	c = await cloneDemoTrip(getDb(), me.id);
	await getDb().insert(tripMembers).values({
		tripId: c.tripId,
		userId: viewer.id,
		status: "active",
		role: "viewer",
		color: 5,
	});
});

afterAll(async () => {
	await closeQueues().catch(() => {});
	const keys = await redis().keys(`${redisPrefix()}:*`);
	if (keys.length) await redis().del(...keys);
	await closeRedis();
	await closeDb();
	await dropDatabase(testEnv.scratchUrl);
});

describe("what goes to Trash, and the quota", () => {
	it("deleted files and files on a deleted stop stay counted; shared objects count once", async () => {
		const u = await newUser("Quinn");
		const t = await cloneDemoTrip(getDb(), u.id);
		const stop = await aStop(t);
		const a = await file(t.tripId, u.id, { size: 100 });
		const b = await file(t.tripId, u.id, { itemId: stop.id, size: 200 });
		expect(await usedBytes(getDb(), u.id)).toBe(300);
		expect(await listTrash(u.id)).toEqual([]);

		await getDb().execute(
			sql`update attachments set deleted_at = ${ago(2)} where id = ${a}`,
		);
		await getDb().execute(
			sql`update items set deleted_at = ${ago(1)} where id = ${stop.id}`,
		);
		const trash = await listTrash(u.id);
		expect(trash.map((x) => x.id)).toEqual([`a:${b}`, `a:${a}`]);
		expect(trash[0]).toMatchObject({ restoreTo: "place", sizeBytes: 200 });
		expect(trash[1]).toMatchObject({ restoreTo: "here" });
		// Trash still counts.
		expect(await usedBytes(getDb(), u.id)).toBe(300);

		// A cancelled upload neither counts nor shows.
		const p = await file(t.tripId, u.id, { size: 999 });
		await getDb().execute(
			sql`update attachments set status = 'pending', deleted_at = now() where id = ${p}`,
		);
		expect(await usedBytes(getDb(), u.id)).toBe(300);
		expect(await ids(u)).not.toContain(`a:${p}`);

		// A deleted Saved share is in Trash and counts; sharing a's object, once.
		const s = await savedPhoto(u.id, `trips/${t.tripId}/${a}/`, 100);
		await getDb().execute(
			sql`update saved_links set deleted_at = now() where id = ${s}`,
		);
		expect(await ids(u)).toContain(`s:${s}`);
		expect(await usedBytes(getDb(), u.id)).toBe(300);

		// A deleted trip: everything in it is in Trash, still counted.
		await getDb().execute(
			sql`update trips set deleted_at = now() where id = ${t.tripId}`,
		);
		expect(await usedBytes(getDb(), u.id)).toBe(300);
		expect(
			(await listTrash(u.id)).filter((x) => x.id.startsWith("a:")),
		).toHaveLength(2);
	});
});

describe("restore", () => {
	it("back where it was, onto the stop's place, or onto the trip; Undo keeps the clock", async () => {
		const stop = await aStop(c);
		const here = await file(c.tripId, me.id, { nodeId: stop.nodeId });
		const onStop = await file(c.tripId, me.id, { itemId: stop.id });
		await getDb().execute(
			sql`update attachments set deleted_at = ${ago(5)} where id = ${here}`,
		);
		await getDb().execute(
			sql`update items set deleted_at = ${ago(3)} where id = ${stop.id}`,
		);
		const done = await restoreTrash(me, [`a:${here}`, `a:${onStop}`]);
		expect(done.map((d) => d.to).sort()).toEqual(["here", "place"]);
		const rows = await q<{
			id: string;
			node: string | null;
			item: string | null;
			gone: boolean;
		}>(sql`
			select id::text as id, node_id::text as node, item_id::text as item, deleted_at is not null as gone
			  from attachments where id in (${here}, ${onStop}) order by id = ${here} desc`);
		expect(rows).toEqual([
			{ id: here, node: stop.nodeId, item: null, gone: false },
			{ id: onStop, node: stop.nodeId, item: null, gone: false },
		]);
		expect(await ids(me)).not.toContain(`a:${here}`);

		// Undo: back in Trash with the clock it had.
		await retrash(
			me,
			done.map((d) => ({ id: d.id as string, trashedAt: d.trashedAt })),
		);
		const back = await listTrash(me.id);
		const was = back.find((x) => x.id === `a:${here}`);
		expect(Math.abs((was?.trashedAt ?? 0) - ago(5).getTime())).toBeLessThan(
			5000,
		);
		await getDb().execute(
			sql`update items set deleted_at = null where id = ${stop.id}`,
		);

		// On a deleted place (no stop): onto the trip's own media.
		const node = await file(c.tripId, me.id, { nodeId: stop.nodeId });
		await getDb().execute(
			sql`update nodes set deleted_at = now() where id = ${stop.nodeId}`,
		);
		expect((await restoreTrash(me, [`a:${node}`]))[0]?.to).toBe("trip");
		const [r] = await q<{ node: string | null }>(sql`
			select node_id::text as node from attachments where id = ${node} and deleted_at is null`);
		expect(r).toEqual({ node: null });
		await getDb().execute(
			sql`update nodes set deleted_at = null where id = ${stop.nodeId}`,
		);
	});

	it("without edit access or a trip, a photo goes to Saved (objects kept) and a PDF can't", async () => {
		const u = await newUser("Rita");
		const t = await cloneDemoTrip(getDb(), u.id);
		const photo = await file(t.tripId, u.id);
		const pdf = await file(t.tripId, u.id, { kind: "pdf" });
		await getDb().execute(
			sql`update trips set deleted_at = now() where id = ${t.tripId}`,
		);
		const trash = await listTrash(u.id);
		expect(trash.find((x) => x.id === `a:${pdf}`)?.restoreTo).toBeNull();
		expect(trash.find((x) => x.id === `a:${photo}`)?.restoreTo).toBe("saved");
		expect(errorCode(await restoreTrash(u, [`a:${pdf}`]).catch((e) => e))).toBe(
			"CONFLICT",
		);
		const [done] = await restoreTrash(u, [`a:${photo}`]);
		expect(done?.to).toBe("saved");
		const files = await q<{ key: string; savedId: string }>(sql`
			select storage_key as key, saved_id::text as "savedId" from saved_files where user_id = ${u.id}`);
		expect(files).toEqual([
			{ key: `trips/${t.tripId}/${photo}/`, savedId: done?.id?.slice(2) },
		]);
		expect(await q(sql`select 1 from attachments where id = ${photo}`)).toEqual(
			[],
		);
		// Still counted once; a purge of the trip keeps the saved file's object.
		expect(await usedBytes(getDb(), u.id)).toBe(200);
		expect(await ids(u)).toEqual([`a:${pdf}`]);

		// A viewer's own upload deleted by the owner: Restore puts it in their Saved.
		const v = await file(c.tripId, viewer.id);
		await getDb().execute(
			sql`update attachments set deleted_at = now() where id = ${v}`,
		);
		expect((await listTrash(viewer.id))[0]).toMatchObject({
			id: `a:${v}`,
			restoreTo: "saved",
		});
	});

	it("a deleted Saved share comes back to Saved", async () => {
		const u = await newUser("Sam");
		const s = await savedPhoto(u.id, `saved/${u.id}/${randomUUID()}/`);
		await getDb().execute(
			sql`update saved_links set deleted_at = ${ago(4)} where id = ${s}`,
		);
		const [done] = await restoreTrash(u, [`s:${s}`]);
		expect(done).toMatchObject({ id: `s:${s}`, to: "saved" });
		expect(await ids(u)).toEqual([]);
	});
});

describe("delete forever", () => {
	it("drops objects nothing else uses, keeps shared ones; Empty trash takes the rest", async () => {
		const u = await newUser("Dora");
		const t = await cloneDemoTrip(getDb(), u.id);
		const lone = await file(t.tripId, u.id);
		const key = `trips/${t.tripId}/${randomUUID()}/`;
		const shared = await file(t.tripId, u.id, { key });
		await file(t.tripId, u.id, { key }); // a duplicated trip's copy, live
		const s = await savedPhoto(u.id, `saved/${u.id}/${randomUUID()}/`);
		await getDb().execute(sql`
			update attachments set deleted_at = now() where id in (${lone}, ${shared})`);
		await getDb().execute(
			sql`update saved_links set deleted_at = now() where id = ${s}`,
		);
		expect(await usedBytes(getDb(), u.id)).toBe(300);
		dropped.length = 0;
		expect(await deleteForever(u.id, [`a:${lone}`, `a:${shared}`], drop)).toBe(
			2,
		);
		expect(dropped).toContain(`trips/${t.tripId}/${lone}/`);
		expect(dropped).not.toContain(key);
		expect(await usedBytes(getDb(), u.id)).toBe(200);
		// Someone else's ids do nothing.
		expect(await deleteForever(me.id, [`s:${s}`], drop)).toBe(0);
		expect(await emptyTrash(u.id, drop)).toBe(1);
		expect(await ids(u)).toEqual([]);
		expect(await usedBytes(getDb(), u.id)).toBe(100);
	});
});

describe("the purge", () => {
	it("takes files on a stop deleted over 30 days ago, not newer ones", async () => {
		const u = await newUser("Pia");
		const t = await cloneDemoTrip(getDb(), u.id);
		const stops = await q<{ id: string }>(sql`
			select id::text as id from items where trip_id = ${t.tripId} and deleted_at is null limit 2`);
		const [old, recent] = stops.map((s) => s.id) as [string, string];
		const a = await file(t.tripId, u.id, { itemId: old });
		const b = await file(t.tripId, u.id, { itemId: recent });
		await getDb().execute(
			sql`update items set deleted_at = ${ago(31)} where id = ${old}`,
		);
		await getDb().execute(
			sql`update items set deleted_at = ${ago(29)} where id = ${recent}`,
		);
		dropped.length = 0;
		await purge(getDb(), { deletePrefix: drop });
		expect(dropped).toContain(`trips/${t.tripId}/${a}/`);
		expect(await ids(u)).toEqual([`a:${b}`]);
		expect(await usedBytes(getDb(), u.id)).toBe(100);
	});
});

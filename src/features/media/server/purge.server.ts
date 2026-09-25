/**
 * The purge (SPEC §15.5, SECURITY §5 "a lifecycle rule for orphans"), run by
 * `pnpm purge` (scripts/purge.ts). S3 objects always go first, then the rows:
 *
 * - attachments soft-deleted more than 30 days ago, and uploads still
 *   `pending` after 24 h (cancelled or abandoned);
 * - nodes soft-deleted more than 30 days ago (their subtree, the items on
 *   them and every attachment hanging there), unless something live still
 *   points into the subtree;
 * - trips soft-deleted more than 30 days ago (the whole `trips/<id>/` prefix);
 * - anonymous users with no grants and no session updated in 30 days.
 *
 * Objects can be shared: a duplicated trip's attachments re-reference the
 * source's objects (ADDENDUM §9; same `storage_key`, `image_key`,
 * `favicon_key`). A prefix is only deleted when no other attachment row —
 * live, soft-deleted or in another trip — still points into it; the last row
 * to go takes it with it.
 *
 * BullMQ removes its own finished jobs (`removeOnComplete`/`removeOnFail`).
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db/db.server";
import { mediaPrefix } from "@/server/s3.server";
import { hardDeleteTrip } from "@/server/trip-delete.server";
import {
	deletePrefix,
	isAttachmentPrefix,
	listSubPrefixes,
	prefixOfKey,
} from "./storage.server";

export type PurgeReport = {
	attachments: number;
	nodes: number;
	trips: number;
	anonymousUsers: number;
	objects: number;
};

export type PurgeOptions = {
	dryRun?: boolean;
	/** Days after a soft delete (default 30). */
	days?: number;
	/** Hours before a pending upload is abandoned (default 24). */
	pendingHours?: number;
	log?: (line: string) => void;
	/** Injected in tests. */
	deletePrefix?: (prefix: string) => Promise<number>;
	/** Injected in tests: the attachment prefixes stored under a trip prefix. */
	listSubPrefixes?: (tripPrefix: string) => Promise<string[]>;
};

type Row = { id: string; trip_id: string };

type KeyRow = Row & {
	storage_key: string | null;
	image_key: string | null;
	favicon_key: string | null;
};

/** Every attachment prefix a row owns or shares. */
function prefixesOf(a: KeyRow): string[] {
	const out = new Set<string>([mediaPrefix(a.trip_id, a.id)]);
	if (isAttachmentPrefix(a.storage_key)) out.add(a.storage_key);
	for (const k of [a.image_key, a.favicon_key]) {
		const p = prefixOfKey(k);
		if (p) out.add(p);
	}
	return [...out];
}

/** Rows that point into a prefix, other than the ones being purged. */
function pointsInto(prefix: string) {
	return sql`(a.storage_key = ${prefix} or starts_with(a.image_key, ${prefix})
	            or starts_with(a.favicon_key, ${prefix}))`;
}

const KEY_COLS = sql`a.id::text as id, a.trip_id::text as trip_id, a.storage_key, a.image_key, a.favicon_key`;

export async function purge(
	db: Db,
	o: PurgeOptions = {},
): Promise<PurgeReport> {
	const days = o.days ?? 30;
	const hours = o.pendingHours ?? 24;
	const log = o.log ?? (() => {});
	const drop = o.deletePrefix ?? deletePrefix;
	const report: PurgeReport = {
		attachments: 0,
		nodes: 0,
		trips: 0,
		anonymousUsers: 0,
		objects: 0,
	};
	const rows = async (q: ReturnType<typeof sql>) =>
		(await db.execute(q)).rows as Row[];

	const keyRows = async (q: ReturnType<typeof sql>) =>
		(await db.execute(q)).rows as KeyRow[];
	/** Deletes each prefix of `gone` that no row outside `goneIds` points into. */
	const dropUnshared = async (gone: readonly KeyRow[]) => {
		const ids = sql.param(gone.map((g) => g.id));
		const prefixes = new Set(gone.flatMap(prefixesOf));
		for (const p of prefixes) {
			const used = await db.execute(sql`
				select 1 from attachments a
				 where ${pointsInto(p)} and a.id <> all(${ids}::uuid[]) limit 1`);
			if (used.rows.length) {
				log(`kept ${p} (still referenced)`);
				continue;
			}
			report.objects += await drop(p);
		}
	};

	// 1. Attachments: old soft deletes and abandoned uploads.
	const atts = await keyRows(sql`
		select ${KEY_COLS} from attachments a
		 where (a.deleted_at is not null and a.deleted_at < now() - make_interval(days => ${days}))
		    or (a.status = 'pending' and a.created_at < now() - make_interval(hours => ${hours}))
		 limit 5000`);
	for (const a of atts) {
		if (!o.dryRun) {
			await dropUnshared([a]);
			await db.execute(sql`delete from attachments where id = ${a.id}`);
		}
		report.attachments += 1;
	}
	log(`attachments: ${report.attachments}`);

	// 2. Nodes deleted long ago (the top of each deleted subtree), when nothing
	// live remains inside it.
	const nodes = await rows(sql`
		select n.id::text as id, n.trip_id::text as trip_id from nodes n
		 where n.deleted_at is not null and n.deleted_at < now() - make_interval(days => ${days})
		   and not exists (select 1 from nodes p where p.id = n.parent_id and p.deleted_at is not null)
		 limit 1000`);
	for (const n of nodes) {
		const inside = await db.execute(sql`
			with recursive sub(id) as (
				select ${n.id}::uuid
				union all select c.id from nodes c join sub on c.parent_id = sub.id
			)
			select
				(select count(*) from nodes where id in (select id from sub) and deleted_at is null) as live_nodes,
				(select count(*) from items where node_id in (select id from sub) and deleted_at is null) as live_items`);
		const live = inside.rows[0] as { live_nodes: string; live_items: string };
		if (Number(live.live_nodes) > 0 || Number(live.live_items) > 0) {
			log(`node ${n.id}: skipped (something live inside)`);
			continue;
		}
		const hanging = await keyRows(sql`
			with recursive sub(id) as (
				select ${n.id}::uuid
				union all select c.id from nodes c join sub on c.parent_id = sub.id
			),
			its as (select id from items where node_id in (select id from sub))
			select ${KEY_COLS} from attachments a
			 where a.node_id in (select id from sub)
			    or a.item_id in (select id from its)
			    or a.leg_id in (select l.id from legs l
			                     where l.from_item_id in (select id from its)
			                        or l.to_item_id in (select id from its))`);
		if (!o.dryRun) {
			if (hanging.length) await dropUnshared(hanging);
			// Cascades: child nodes, items on them, their legs, bundles.
			await db.execute(sql`delete from nodes where id = ${n.id}`);
		}
		report.nodes += 1;
	}
	log(`nodes: ${report.nodes}`);

	// 3. Trips deleted long ago: the whole prefix, then the row (cascades).
	const trips = await rows(sql`
		select id::text as id, id::text as trip_id from trips
		 where deleted_at is not null and deleted_at < now() - make_interval(days => ${days})
		 limit 200`);
	for (const t of trips) {
		if (!o.dryRun) report.objects += await purgeTrip(db, t.id, o);
		report.trips += 1;
	}
	log(`trips: ${report.trips}`);

	// 4. Anonymous users nobody can come back as.
	const anon = await rows(sql`
		select u.id::text as id, '' as trip_id from "user" u
		 where u.is_anonymous
		   and not exists (select 1 from share_grants g where g.user_id = u.id)
		   and not exists (select 1 from session s where s.user_id = u.id
		                     and s.updated_at > now() - make_interval(days => ${days}))
		 limit 5000`);
	if (!o.dryRun && anon.length)
		await db.execute(sql`
			delete from "user" where id = any(${sql.param(anon.map((a) => a.id))}::text[])`);
	report.anonymousUsers = anon.length;
	log(`anonymous users: ${report.anonymousUsers}`);
	log(`objects deleted: ${report.objects}`);
	return report;
}

/**
 * One trip, now: its media objects (minus any another trip's copies still
 * use), then the row and everything in it (`hardDeleteTrip`, one
 * transaction). The purge runs it for trips soft-deleted > 30 days ago; an
 * operator's cleanup (`scripts/cleanup-test-data.ts`) runs it for trips it
 * was told to remove. Returns the number of S3 objects deleted.
 */
export async function purgeTrip(
	db: Db,
	tripId: string,
	o: Pick<PurgeOptions, "deletePrefix" | "listSubPrefixes" | "log"> = {},
): Promise<number> {
	const log = o.log ?? (() => {});
	const drop = o.deletePrefix ?? deletePrefix;
	const list = o.listSubPrefixes ?? listSubPrefixes;
	const keyRows = async (q: ReturnType<typeof sql>) =>
		(await db.execute(q)).rows as KeyRow[];
	let objects = 0;
	const tripPrefix = `trips/${tripId}/`;
	// Objects elsewhere this trip's copies pointed at (a duplicate of
	// another trip), when nothing else uses them any more.
	const own = await keyRows(sql`
		select ${KEY_COLS} from attachments a where a.trip_id = ${tripId}`);
	for (const p of new Set(own.flatMap(prefixesOf))) {
		if (p.startsWith(tripPrefix)) continue;
		const used = await db.execute(sql`
			select 1 from attachments a
			 where ${pointsInto(p)} and a.trip_id <> ${tripId} limit 1`);
		if (!used.rows.length) objects += await drop(p);
	}
	// This trip's own objects, minus those other trips' copies still use.
	const kept = new Set(
		(
			await keyRows(sql`
				select ${KEY_COLS} from attachments a
				 where a.trip_id <> ${tripId}
				   and (starts_with(a.storage_key, ${tripPrefix})
				        or starts_with(a.image_key, ${tripPrefix})
				        or starts_with(a.favicon_key, ${tripPrefix}))`)
		)
			.flatMap(prefixesOf)
			.filter((p) => p.startsWith(tripPrefix)),
	);
	if (!kept.size) objects += await drop(tripPrefix);
	else {
		for (const p of await list(tripPrefix))
			if (!kept.has(p)) objects += await drop(p);
		log(`trip ${tripId}: kept ${kept.size} shared prefix(es)`);
	}
	await db.transaction((tx) => hardDeleteTrip(tx, tripId));
	return objects;
}

/**
 * ADDENDUM §9 "Duplicate…" (CONTRACTS §4.9): a new trip from an existing one,
 * in ONE transaction, with fresh ids everywhere and an old → new map (a temp
 * table `dup_map`) that every reference goes through: parents, days, items,
 * legs, stays, bundle targets, `due_rule.itemId`, mention tokens (Markdown
 * and inside Yjs note state) and seat member ids.
 *
 * Always copied: the structure (hierarchy, days shifted by the new start,
 * items with their pinned local times, legs incl. flights and stays, timed
 * legs re-dated). By choice: notes (shared notes + my own private notes, and
 * item notes), lists (statuses reset to open; my own private items only),
 * media (rows re-referenced: same `storage_key`, nothing re-uploaded),
 * trip-default budgets, placeholders. Never: members (the caller becomes the
 * owner), share links, expenses/settlements/receipts, proposals, activity,
 * digest state, other members' private items or private notes.
 *
 * Assignments, ratings and mentions survive only for people who exist in the
 * copy (the caller, and placeholders when copied); other mentions become
 * plain "@Name" text so no chip points at a stranger.
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/db/db.server";
import { daysBetween } from "@/lib/engine/time";
import { slugify, uniqueSlug } from "@/lib/engine/tree";
import { newId } from "@/lib/ids";
import { MENTION_TOKEN_RE } from "@/lib/notes/mentions";
import { fail } from "@/server/authz/session.server";
import { shiftTimedLegs } from "@/server/legs.server";

export type DuplicateInclude = {
	notes: boolean;
	lists: boolean;
	media: boolean;
	budgets: boolean;
	placeholders: boolean;
};

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rewrites mention tokens: mapped members keep a chip (new id), others become "@Label". */
export function remapMentions(
	md: string | null,
	members: ReadonlyMap<string, string>,
): string | null {
	if (!md) return md;
	return md.replace(MENTION_TOKEN_RE, (_all, label: string, id: string) => {
		const to = members.get(id.toLowerCase());
		return to
			? `[@${label}](mention:${to})`
			: `@${label.replace(/\\(.)/g, "$1")}`;
	});
}

/** Deep copy of JSON with every `memberId` remapped (dropped when the person isn't in the copy). */
export function remapMemberIds(
	value: unknown,
	members: ReadonlyMap<string, string>,
): unknown {
	if (Array.isArray(value)) return value.map((v) => remapMemberIds(v, members));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (k === "memberId" && typeof v === "string" && UUID_RE.test(v)) {
				const to = members.get(v.toLowerCase());
				if (to) out[k] = to;
				continue;
			}
			out[k] = remapMemberIds(v, members);
		}
		return out;
	}
	return value;
}

/** Replaces each 36-byte uuid in a Yjs update with its (equal-length) new id: the encoding stays valid. */
export function replaceIdsInState(
	state: Buffer,
	ids: ReadonlyMap<string, string>,
): Buffer {
	let buf = state;
	for (const [from, to] of ids) {
		const a = Buffer.from(from, "utf8");
		const b = Buffer.from(to, "utf8");
		if (a.length !== b.length) continue;
		let at = buf.indexOf(a);
		if (at < 0) continue;
		buf = Buffer.from(buf);
		while (at >= 0) {
			b.copy(buf, at);
			at = buf.indexOf(a, at + a.length);
		}
	}
	return buf;
}

function replaceAll(text: string, ids: ReadonlyMap<string, string>): string {
	let out = text;
	for (const [from, to] of ids) out = out.split(from).join(to);
	return out;
}

async function freeSlug(tx: Tx, name: string): Promise<string> {
	const base = slugify(name, crypto.randomUUID()).slice(0, 90);
	const res = await tx.execute(sql`
		select slug from trips where deleted_at is null
		   and (slug = ${base} or slug like ${`${base}-%`})`);
	return uniqueSlug(
		base,
		(res.rows as { slug: string }[]).map((r) => r.slug),
	);
}

type SourceTrip = {
	id: string;
	name: string;
	startDate: string | null;
	defaultTz: string;
	settings: unknown;
	coverAttachmentId: string | null;
};

/**
 * The copy itself. The caller has authorized (a non-guest member of `srcId`)
 * and runs this inside one transaction. Returns the new trip's id and slug.
 */
export async function duplicateTripCore(
	tx: Tx,
	args: {
		srcId: string;
		userId: string;
		srcMemberId: string | null;
		name: string;
		startDate: string;
		include: DuplicateInclude;
	},
): Promise<{ tripId: string; slug: string }> {
	const { srcId, userId, include } = args;
	const srcRes = await tx.execute(sql`
		select id::text as id, name, start_date::text as "startDate", default_tz as "defaultTz",
		       settings, cover_attachment_id::text as "coverAttachmentId"
		  from trips where id = ${srcId} and deleted_at is null`);
	const src = srcRes.rows[0] as SourceTrip | undefined;
	if (!src) return fail("NOT_FOUND");
	const delta = src.startDate ? daysBetween(src.startDate, args.startDate) : 0;

	// ---- the trip and its owner -------------------------------------------
	const slug = await freeSlug(tx, args.name);
	const tripId = newId();
	await tx.execute(sql`
		insert into trips (id, slug, name, default_tz, settings, created_by)
		values (${tripId}, ${slug}, ${args.name}, ${src.defaultTz}, ${JSON.stringify(src.settings ?? {})}::jsonb, ${userId})`);
	const ownerId = newId();
	await tx.execute(sql`
		insert into trip_members (id, trip_id, user_id, status, role, color, joined_at)
		values (${ownerId}, ${tripId}, ${userId}, 'active', 'owner', 0, now())`);

	await tx.execute(sql`
		create temp table dup_map (old uuid primary key, new uuid not null) on commit drop`);
	/** Maps every id the select returns to a fresh UUID v7 (the app's id kind). */
	const map = async (select: ReturnType<typeof sql>) => {
		const res = await tx.execute(sql`select x.id::text as id from (${select}) x
			where not exists (select 1 from dup_map d where d.old = x.id)`);
		const olds = (res.rows as { id: string }[]).map((r) => r.id);
		if (!olds.length) return;
		await tx.execute(sql`
			insert into dup_map (old, new)
			select * from unnest(${sql.param(olds)}::uuid[], ${sql.param(olds.map(() => newId()))}::uuid[])`);
	};

	// ---- people: me (+ placeholders) ---------------------------------------
	if (args.srcMemberId)
		await tx.execute(
			sql`insert into dup_map (old, new) values (${args.srcMemberId}, ${ownerId})`,
		);
	if (include.placeholders) {
		await map(
			sql`select id from trip_members where trip_id = ${srcId} and status = 'placeholder'`,
		);
		await tx.execute(sql`
			insert into trip_members (id, trip_id, status, role, display_name, color)
			select d.new, ${tripId}, 'placeholder', m.role, m.display_name, m.color
			  from trip_members m join dup_map d on d.old = m.id
			 where m.trip_id = ${srcId} and m.status = 'placeholder'`);
	}
	const memberRows = await tx.execute(sql`
		select d.old::text as old, d.new::text as new from dup_map d
		  join trip_members m on m.id = d.old and m.trip_id = ${srcId}`);
	const members = new Map(
		(memberRows.rows as { old: string; new: string }[]).map((r) => [
			r.old,
			r.new,
		]),
	);

	// ---- hierarchy (only nodes reachable through live parents) ------------
	await map(sql`
		select id from (
			with recursive live as (
				select id from nodes where trip_id = ${srcId} and parent_id is null and deleted_at is null
				union all
				select n.id from nodes n join live l on n.parent_id = l.id where n.deleted_at is null
			) select id from live) x`);
	await tx.execute(sql`
		insert into nodes (id, trip_id, parent_id, type, category, status, name, local_name, slug, description,
		                   position, lat, lng, tz, country_code, address, google_place_id, osm_ref, bbox,
		                   time_needed_min, idea_status, shortlist_pin, details, created_by)
		select d.new, ${tripId}, pd.new, n.type, n.category, n.status, n.name, n.local_name, n.slug, n.description,
		       n.position, n.lat, n.lng, n.tz, n.country_code, n.address, n.google_place_id, n.osm_ref, n.bbox,
		       n.time_needed_min, n.idea_status, n.shortlist_pin, n.details, ${userId}
		  from nodes n join dup_map d on d.old = n.id left join dup_map pd on pd.old = n.parent_id
		 where n.trip_id = ${srcId}`);
	await tx.execute(sql`
		insert into node_priorities (trip_id, node_id, member_id, priority, rating_comment)
		select ${tripId}, dn.new, dm.new, p.priority, p.rating_comment
		  from node_priorities p join dup_map dn on dn.old = p.node_id join dup_map dm on dm.old = p.member_id
		 where p.trip_id = ${srcId}`);

	// ---- days, shifted -----------------------------------------------------
	await map(sql`select id from trip_days where trip_id = ${srcId}`);
	await tx.execute(sql`
		insert into trip_days (id, trip_id, date, start_time, title, night_node_id)
		select d.new, ${tripId}, t.date + ${delta}::int, t.start_time, t.title, dn.new
		  from trip_days t join dup_map d on d.old = t.id left join dup_map dn on dn.old = t.night_node_id
		 where t.trip_id = ${srcId}`);
	await tx.execute(sql`
		update trips set start_date = (select min(date) from trip_days where trip_id = ${tripId}),
		                 end_date = (select max(date) from trip_days where trip_id = ${tripId})
		 where id = ${tripId}`);

	// ---- items ---------------------------------------------------------------
	await map(sql`
		select i.id from items i
		 where i.trip_id = ${srcId} and i.deleted_at is null
		   and (i.node_id is null or exists (select 1 from dup_map d where d.old = i.node_id))`);
	await tx.execute(sql`
		insert into items (id, trip_id, day_id, node_id, title, note, position, duration_min, pinned_start,
		                   fixed_date, created_by)
		select d.new, ${tripId}, dd.new, dn.new, i.title, ${include.notes ? sql`i.note` : sql`null`},
		       i.position, i.duration_min, i.pinned_start, i.fixed_date, ${userId}
		  from items i join dup_map d on d.old = i.id
		  left join dup_map dd on dd.old = i.day_id left join dup_map dn on dn.old = i.node_id
		 where i.trip_id = ${srcId}`);
	if (include.notes) {
		const notes = await tx.execute(sql`
			select id::text as id, note from items
			 where trip_id = ${tripId} and note like '%mention:%'`);
		for (const r of notes.rows as { id: string; note: string }[])
			await tx.execute(
				sql`update items set note = ${remapMentions(r.note, members)} where id = ${r.id}`,
			);
	}
	await tx.execute(sql`
		insert into item_assignees (trip_id, item_id, member_id)
		select ${tripId}, di.new, dm.new
		  from item_assignees a join dup_map di on di.old = a.item_id join dup_map dm on dm.old = a.member_id
		 where a.trip_id = ${srcId}`);

	// ---- legs (pairs of copied items, stays of copied days) -----------------
	await map(sql`
		select l.id from legs l
		 where l.trip_id = ${srcId}
		   and ((l.kind = 'pair' and exists (select 1 from dup_map a where a.old = l.from_item_id)
		                          and exists (select 1 from dup_map b where b.old = l.to_item_id))
		     or (l.kind <> 'pair' and exists (select 1 from dup_map c where c.old = l.stay_day_id)))`);
	await tx.execute(sql`
		insert into legs (id, trip_id, kind, from_item_id, to_item_id, stay_day_id, anchor_item_id, mode,
		                  duration_min, distance_m, source, estimate_min, is_edited, dep_at, arr_at, details,
		                  alternatives, queried_for, queried_at, created_by)
		select d.new, ${tripId}, l.kind, df.new, dt.new, ds.new, da.new, l.mode,
		       l.duration_min, l.distance_m, l.source, l.estimate_min, l.is_edited, l.dep_at, l.arr_at, l.details,
		       l.alternatives, l.queried_for, l.queried_at, ${userId}
		  from legs l join dup_map d on d.old = l.id
		  left join dup_map df on df.old = l.from_item_id left join dup_map dt on dt.old = l.to_item_id
		  left join dup_map ds on ds.old = l.stay_day_id left join dup_map da on da.old = l.anchor_item_id
		 where l.trip_id = ${srcId}`);
	const seatLegs = await tx.execute(sql`
		select id::text as id, details from legs
		 where trip_id = ${tripId} and details::text like '%memberId%'`);
	for (const r of seatLegs.rows as { id: string; details: unknown }[])
		await tx.execute(sql`
			update legs set details = ${JSON.stringify(remapMemberIds(r.details, members))}::jsonb
			 where id = ${r.id}`);
	await tx.execute(sql`
		insert into leg_assignees (trip_id, leg_id, member_id)
		select ${tripId}, dl.new, dm.new
		  from leg_assignees a join dup_map dl on dl.old = a.leg_id join dup_map dm on dm.old = a.member_id
		 where a.trip_id = ${srcId}`);
	if (delta !== 0) {
		const days = await tx.execute(
			sql`select id::text as id from trip_days where trip_id = ${tripId}`,
		);
		await shiftTimedLegs(
			tx,
			tripId,
			new Map((days.rows as { id: string }[]).map((d) => [d.id, delta])),
		);
	}

	// A bundle target (node/leg/item/day or the trip root) that exists in the copy.
	const targetOk = (a: string) => sql`
		(${sql.raw(a)}.node_id is null or exists (select 1 from dup_map x where x.old = ${sql.raw(a)}.node_id))
		and (${sql.raw(a)}.leg_id is null or exists (select 1 from dup_map x where x.old = ${sql.raw(a)}.leg_id))
		and (${sql.raw(a)}.item_id is null or exists (select 1 from dup_map x where x.old = ${sql.raw(a)}.item_id))
		and (${sql.raw(a)}.day_id is null or exists (select 1 from dup_map x where x.old = ${sql.raw(a)}.day_id))`;

	// ---- lists (statuses reset; my own private items only) ------------------
	if (include.lists) {
		await map(sql`
			select li.id from list_items li
			 where li.trip_id = ${srcId} and li.deleted_at is null
			   and (not li.is_private or li.created_by = ${userId}) and ${targetOk("li")}`);
		const rows = await tx.execute(sql`
			select d.new::text as id, li.text, li.note, li.due_rule as "dueRule"
			  from list_items li join dup_map d on d.old = li.id where li.trip_id = ${srcId}`);
		await tx.execute(sql`
			insert into list_items (id, trip_id, node_id, leg_id, item_id, day_id, list, text, note, url, status,
			                        due_kind, due_rule, is_private, due_day_id, due_date, due_time, due_tz,
			                        quantity, price_amount, price_currency, price_text, position, created_by)
			select d.new, ${tripId}, dn.new, dl.new, di.new, dd.new, li.list, li.text, li.note, li.url, 'open',
			       li.due_kind, null, li.is_private, ddd.new, li.due_date + ${delta}::int, li.due_time, li.due_tz,
			       li.quantity, li.price_amount, li.price_currency, li.price_text, li.position, ${userId}
			  from list_items li join dup_map d on d.old = li.id
			  left join dup_map dn on dn.old = li.node_id left join dup_map dl on dl.old = li.leg_id
			  left join dup_map di on di.old = li.item_id left join dup_map dd on dd.old = li.day_id
			  left join dup_map ddd on ddd.old = li.due_day_id
			 where li.trip_id = ${srcId}`);
		const itemIds = await tx.execute(sql`
			select d.old::text as old, d.new::text as new from dup_map d
			  join items i on i.id = d.old and i.trip_id = ${srcId}`);
		const items = new Map(
			(itemIds.rows as { old: string; new: string }[]).map((r) => [
				r.old,
				r.new,
			]),
		);
		for (const r of rows.rows as {
			id: string;
			text: string;
			note: string | null;
			dueRule: { itemId?: string } | null;
		}[]) {
			const text = remapMentions(r.text, members) ?? r.text;
			const note = remapMentions(r.note, members);
			const anchor = r.dueRule?.itemId
				? items.get(r.dueRule.itemId)
				: undefined;
			const rule =
				r.dueRule && anchor ? { ...r.dueRule, itemId: anchor } : null;
			if (text === r.text && note === r.note && !rule) continue;
			await tx.execute(sql`
				update list_items set text = ${text}, note = ${note},
				       due_rule = ${rule ? JSON.stringify(rule) : null}::jsonb
				 where id = ${r.id}`);
		}
		await tx.execute(sql`
			insert into list_item_assignees (trip_id, list_item_id, member_id)
			select ${tripId}, dli.new, dm.new
			  from list_item_assignees a join dup_map dli on dli.old = a.list_item_id
			  join dup_map dm on dm.old = a.member_id
			 where a.trip_id = ${srcId}`);
		await tx.execute(sql`
			insert into list_item_targets (trip_id, list_item_id, node_id)
			select ${tripId}, dli.new, dn.new
			  from list_item_targets t join dup_map dli on dli.old = t.list_item_id
			  join dup_map dn on dn.old = t.node_id
			 where t.trip_id = ${srcId}`);
	}

	// ---- notes: shared docs + MY private docs, ids rewritten in the state ---
	if (include.notes) {
		const docs = await tx.execute(sql`
			select y.name, y.node_id::text as "nodeId", y.leg_id::text as "legId", y.item_id::text as "itemId",
			       y.day_id::text as "dayId", y.state, y.json, y.markdown, y.plain_text as "plainText",
			       y.owner_user_id as "ownerUserId"
			  from yjs_documents y
			 where y.trip_id = ${srcId} and (y.owner_user_id is null or y.owner_user_id = ${userId})
			   and ${targetOk("y")}`);
		const all = await tx.execute(
			sql`select old::text as old, new::text as new from dup_map`,
		);
		const ids = new Map(
			(all.rows as { old: string; new: string }[]).map((r) => [r.old, r.new]),
		);
		ids.set(srcId, tripId);
		for (const d of docs.rows as {
			name: string;
			nodeId: string | null;
			legId: string | null;
			itemId: string | null;
			dayId: string | null;
			state: Buffer | null;
			json: unknown;
			markdown: string | null;
			plainText: string | null;
			ownerUserId: string | null;
		}[]) {
			const pick = (id: string | null) => (id ? (ids.get(id) ?? null) : null);
			const idsInDoc = new Map(
				[...ids].filter(([k]) => d.name.includes(k) || members.has(k)),
			);
			await tx.execute(sql`
				insert into yjs_documents (name, trip_id, node_id, leg_id, item_id, day_id, state, json,
				                           markdown, plain_text, updated_by, owner_user_id)
				values (${replaceAll(d.name, idsInDoc)}, ${tripId}, ${pick(d.nodeId)}, ${pick(d.legId)},
				        ${pick(d.itemId)}, ${pick(d.dayId)},
				        ${d.state ? replaceIdsInState(Buffer.from(d.state), members) : null},
				        ${d.json == null ? null : replaceAll(JSON.stringify(d.json), members)}::jsonb,
				        ${d.markdown ? replaceAll(d.markdown, members) : d.markdown},
				        ${d.plainText}, ${userId}, ${d.ownerUserId})`);
		}
	}

	// ---- media: rows re-referenced (same storage keys), never receipts ------
	if (include.media) {
		await map(sql`
			select a.id from attachments a
			 where a.trip_id = ${srcId} and a.deleted_at is null and a.expense_id is null
			   and a.payment_id is null and a.status not in ('pending', 'failed')
			   and ${targetOk("a")}`);
		await tx.execute(sql`
			insert into attachments (id, trip_id, node_id, leg_id, item_id, day_id, kind, status, storage_key, mime,
			                         size_bytes, width, height, duration_sec, thumbhash, taken_at, url, provider,
			                         embed_id, title, description, site_name, author, favicon_url, favicon_key,
			                         image_key, meta, caption, position, visibility, created_by)
			select d.new, ${tripId}, dn.new, dl.new, di.new, dd.new, a.kind, a.status, a.storage_key, a.mime,
			       a.size_bytes, a.width, a.height, a.duration_sec, a.thumbhash, a.taken_at, a.url, a.provider,
			       a.embed_id, a.title, a.description, a.site_name, a.author, a.favicon_url, a.favicon_key,
			       a.image_key, a.meta || jsonb_build_object('copiedFrom', a.id::text), a.caption, a.position,
			       a.visibility, ${userId}
			  from attachments a join dup_map d on d.old = a.id
			  left join dup_map dn on dn.old = a.node_id left join dup_map dl on dl.old = a.leg_id
			  left join dup_map di on di.old = a.item_id left join dup_map dd on dd.old = a.day_id
			 where a.trip_id = ${srcId}`);
		if (src.coverAttachmentId)
			await tx.execute(sql`
				update trips set cover_attachment_id = (select new from dup_map where old = ${src.coverAttachmentId})
				 where id = ${tripId}`);
	}

	// ---- budgets: trip defaults only ------------------------------------------
	if (include.budgets) {
		await map(
			sql`select id from budget_lines where trip_id = ${srcId} and member_id is null`,
		);
		await tx.execute(sql`
			insert into budget_lines (id, trip_id, node_id, category, member_id, amount_minor, kind, created_by)
			select d.new, ${tripId}, dn.new, b.category, null, b.amount_minor, b.kind, ${userId}
			  from budget_lines b join dup_map d on d.old = b.id left join dup_map dn on dn.old = b.node_id
			 where b.trip_id = ${srcId} and b.member_id is null
			   and (b.node_id is null or dn.new is not null)`);
	}

	return { tripId, slug };
}

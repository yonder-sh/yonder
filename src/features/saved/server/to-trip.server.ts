/**
 * Many saved items into a trip at once (Select's "Add to trip", a city's
 * "Add all to a trip", "Plan a trip from these"), one transaction. Each
 * becomes an idea, nothing asked: under the trip's city of its place (the
 * country and city made when missing), else the nearest city of where it is,
 * else at the trip's top; its link and photos go on it. One already in that
 * trip is left as it is (`saved_link_trips`: one row per item and trip).
 * Undo takes the ideas, the places made for them and the "in trip" marks out.
 *
 * A suggester's become suggestions, the normal way: one per new country,
 * city and idea, and one per link (each needs the one it goes on); photos
 * stay in Saved, as for one added alone. Marked "in trip" at once (onto the
 * idea's chosen id): a mark counts while its idea exists or an open
 * suggestion will make it (`liveMark`). Undo withdraws them.
 */
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "@/db/db.server";
import type { SavedPlace } from "@/db/schema/saved";
import {
	nearestCity,
	type ParentPlan,
	whereParent,
} from "@/features/home/share-classify";
import { insertLink } from "@/features/media/server/proposable.server";
import { can } from "@/lib/auth/roles";
import type { ProposalOp } from "@/lib/schemas/proposals";
import type { AuthUser } from "@/server/auth.server";
import { rateLimitPer } from "@/server/cache.server";
import { createNodeCore, deleteNodeCore } from "@/server/cores/nodes.server";
import { indexTx } from "@/server/legs.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { requireDirect } from "@/server/proposals/proposable.server";
import { loadDef, proposeChange } from "@/server/proposals/propose.server";
import { actorOf, type CoreCtx } from "@/server/proposals/types";
import { closeDependants } from "@/server/proposals/withdraw.server";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import { ideaName } from "../lib";
import { countryName } from "../where";
import { attachSavedIn } from "./files.server";
import { liveMark } from "./saved.server";

/** Items per call (the app sends more in turns). */
export const BULK_MAX = 50;

export type AddedToTrip = {
	/** Each item added and its new idea. */
	added: { savedId: string; nodeId: string }[];
	/** Already in that trip: left as they were. */
	already: number;
	/** Countries and cities made for them (Undo takes them out when empty). */
	made: string[];
	/** The cities they went under, first seen first (the new trip's route). */
	cities: string[];
	/** A suggester's: the suggestions made (Undo withdraws them). */
	proposals: string[];
};

type Row = {
	id: string;
	url: string | null;
	text: string | null;
	provider: string | null;
	siteName: string | null;
	previewTitle: string | null;
	place: SavedPlace | null;
	countryCode: string | null;
	city: string | null;
	cityLat: number | null;
	cityLng: number | null;
	spotLat: number | null;
	spotLng: number | null;
	files: number;
	inTrip: boolean;
};

type TreeNode = {
	id: string;
	parentId: string | null;
	type: string;
	name: string;
	lat: number | null;
	lng: number | null;
	countryCode?: string | null;
};

async function rowsOf(
	tx: Tx,
	userId: string,
	tripId: string,
	ids: readonly string[],
): Promise<Row[]> {
	const res = await tx.execute(sql`
		select l.id::text as id, l.url, l.text, l.provider, l.site_name as "siteName",
		       l.preview_title as "previewTitle", l.place, l.country_code as "countryCode", l.city,
		       l.city_lat as "cityLat", l.city_lng as "cityLng", f.lat as "spotLat", f.lng as "spotLng",
		       (select count(*)::int from saved_files x
		         where x.saved_id = l.id and x.deleted_at is null and x.status in ('processing', 'ready')) as files,
		       exists (select 1 from saved_link_trips t
		                where t.saved_id = l.id and t.trip_id = ${tripId} and ${liveMark("t")}) as "inTrip"
		  from saved_links l
		  left join lateral (
		    select lat, lng from saved_files
		     where saved_id = l.id and deleted_at is null and lat is not null and lng is not null
		     order by position limit 1) f on true
		 where l.user_id = ${userId} and l.deleted_at is null
		   and l.id = any(${sql.param([...ids])}::uuid[])
		 for update of l`);
	const byId = new Map((res.rows as Row[]).map((r) => [r.id, r]));
	// In the order asked (the grid's).
	return [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
}

/** Adds the caller's saved items to a trip they can edit, or suggests them (see the file comment). */
export async function addSavedToTrip(
	user: AuthUser,
	p: { tripId: string; ids: readonly string[] },
): Promise<AddedToTrip> {
	const access = await requireDirect("addSavedToTrip", p.tripId, user);
	await rateLimitPer(`saved-bulk:${user.id}`, 60, 3600);
	const ctx: CoreCtx = {
		access,
		user,
		actor: actorOf(user),
		dryRun: false,
	};
	return withTripTx(
		p.tripId,
		(tx, out) => addIn(tx, out, ctx, p),
		mutationMeta(access, user),
	);
}

async function addIn(
	tx: Tx,
	out: TxOutbox,
	ctx: CoreCtx,
	p: { tripId: string; ids: readonly string[] },
): Promise<AddedToTrip> {
	const { tripId } = p;
	const suggest = !can(ctx.access, "edit");
	const rows = await rowsOf(tx, ctx.user.id, tripId, p.ids);
	const nodes: TreeNode[] = (await indexTx(tx, tripId)).outline.map((n) => ({
		id: n.id,
		parentId: n.parentId,
		type: n.type,
		name: n.name,
		lat: n.lat ?? null,
		lng: n.lng ?? null,
		countryCode: n.countryCode ?? null,
	}));
	const result: AddedToTrip = {
		added: [],
		already: 0,
		made: [],
		cities: [],
		proposals: [],
	};
	/** Applies `op`, or (a suggester) suggests it; `input.id` is chosen here either way. */
	const run = async (op: ProposalOp, input: Record<string, unknown>) => {
		if (!suggest) {
			if (op === "node.create")
				await createNodeCore(tx, out, input as never, ctx);
			else await insertLink(tx, out, input as never, ctx);
			return;
		}
		const def = await loadDef(op);
		const r = await proposeChange(tx, out, {
			op,
			def,
			input: def.input.parse(input),
			flag: undefined,
			access: ctx.access,
			user: ctx.user,
			tripId,
			bulk: true,
		});
		result.proposals.push(r.proposed.id);
	};
	const make = async (node: Omit<TreeNode, "id">): Promise<string> => {
		const id = uuidv7();
		await run("node.create", {
			tripId,
			id,
			parentId: node.parentId,
			type: node.type,
			name: node.name,
			...(node.lat != null && node.lng != null
				? { lat: node.lat, lng: node.lng }
				: {}),
			...(node.countryCode ? { countryCode: node.countryCode } : {}),
		});
		nodes.push({ ...node, id });
		result.made.push(id);
		return id;
	};
	for (const r of rows) {
		if (r.inTrip) {
			result.already++;
			continue;
		}
		const at =
			r.place ??
			(r.spotLat != null ? { lat: r.spotLat, lng: r.spotLng } : null);
		const spot =
			at?.lat != null && at.lng != null ? { lat: at.lat, lng: at.lng } : null;
		const where = r.countryCode
			? { countryCode: r.countryCode, city: r.city }
			: null;
		// Like one added alone: its city (or country), made when missing; else
		// the nearest city of where it is; else the top.
		let plan: ParentPlan | null = whereParent(nodes, where);
		if (!plan && where) {
			await make({
				parentId: null,
				type: "country",
				name: countryName(where.countryCode),
				lat: null,
				lng: null,
				countryCode: where.countryCode,
			});
			plan = whereParent(nodes, where);
		}
		if (!plan && spot) {
			const city = nearestCity(nodes, spot);
			if (city) plan = { parentId: city.id, create: [] };
		}
		let parentId = plan?.parentId ?? null;
		if (plan?.create.length && r.city)
			parentId = await make({
				parentId,
				type: "city",
				name: r.city,
				lat: r.cityLat,
				lng: r.cityLng,
				countryCode: r.countryCode,
			});
		const parent = nodes.find((n) => n.id === parentId);
		if (parent?.type === "city" && !result.cities.includes(parent.id))
			result.cities.push(parent.id);
		const nodeId = uuidv7();
		await run("node.create", {
			tripId,
			id: nodeId,
			parentId,
			type: "place",
			name: ideaName({
				...r,
				files: r.files ? [{ kind: "photo" }] : [],
			}),
			...(spot ?? {}),
			...(r.place?.address ? { address: r.place.address.slice(0, 500) } : {}),
			...(!r.url && r.text ? { description: r.text.slice(0, 500) } : {}),
		});
		if (r.url && /^https?:\/\//i.test(r.url) && r.url.length <= 2000)
			await run("attachment.link", {
				tripId,
				target: { kind: "node", nodeId },
				url: r.url,
			});
		// Suggesters never upload: the photos stay in Saved (as for one alone).
		if (r.files && !suggest)
			await attachSavedIn(tx, out, ctx.user, {
				savedId: r.id,
				tripId,
				nodeId,
			});
		// A dead mark (its suggestion closed) gives way.
		await tx.execute(sql`
			insert into saved_link_trips (saved_id, trip_id, node_id)
			values (${r.id}, ${tripId}, ${nodeId})
			on conflict (saved_id, trip_id) do update set node_id = excluded.node_id, added_at = now()`);
		await tx.execute(
			sql`update saved_links set updated_at = now() where id = ${r.id}`,
		);
		result.added.push({ savedId: r.id, nodeId });
	}
	return result;
}

/**
 * Undo of `addSavedToTrip`: its suggestions withdrawn; its ideas (and the
 * places made for them, when nothing else went there) out; the "in trip"
 * marks off (a suggester's only while their idea isn't in the trip).
 */
export async function undoSavedToTrip(
	user: AuthUser,
	p: {
		tripId: string;
		added: readonly { savedId: string; nodeId: string }[];
		made: readonly string[];
		proposals?: readonly string[];
	},
): Promise<{ ok: true }> {
	const access = await requireDirect("undoSavedToTrip", p.tripId, user);
	const edit = can(access, "edit");
	const ctx: CoreCtx = {
		access,
		user,
		actor: actorOf(user),
		dryRun: false,
	};
	await withTripTx(
		p.tripId,
		async (tx, out) => {
			if (p.proposals?.length) {
				const res = await tx.execute(sql`
					update proposals set status = 'withdrawn', review_note = null, updated_at = now()
					 where trip_id = ${p.tripId} and status = 'open' and author_user_id = ${user.id}
					   and id = any(${sql.param([...p.proposals])}::uuid[])
					returning id::text as id`);
				const ids = (res.rows as { id: string }[]).map((r) => r.id);
				await closeDependants(tx, p.tripId, ids, "withdrawn");
				if (ids.length) out.emit({ keys: ["proposals"] });
			}
			// Only the marks this add made (the item's own, onto that idea).
			const gone = await tx.execute(sql`
				delete from saved_link_trips t
				 using unnest(${sql.param(p.added.map((a) => a.savedId))}::uuid[],
				              ${sql.param(p.added.map((a) => a.nodeId))}::uuid[]) as u(saved_id, node_id)
				 where t.trip_id = ${p.tripId} and t.saved_id = u.saved_id and t.node_id = u.node_id
				   and exists (select 1 from saved_links s where s.id = t.saved_id and s.user_id = ${user.id})
				   and (${edit} or not exists (select 1 from nodes n where n.id = t.node_id))
				 returning t.node_id::text as id`);
			if (!edit) return;
			const ideas = (gone.rows as { id: string }[]).map((r) => r.id);
			for (const id of ideas) await dropNode(tx, out, ctx, id);
			// Cities before their countries; a place someone added since keeps one.
			for (const id of [...p.made].reverse()) {
				const kids = await tx.execute(sql`
					select 1 from nodes where parent_id = ${id} and deleted_at is null limit 1`);
				if (!kids.rows.length) await dropNode(tx, out, ctx, id);
			}
		},
		mutationMeta(access, user),
	);
	return { ok: true };
}

/** Deletes a live node of the trip (gone already: nothing to do). */
async function dropNode(tx: Tx, out: TxOutbox, ctx: CoreCtx, nodeId: string) {
	const live = await tx.execute(sql`
		select 1 from nodes where id = ${nodeId} and trip_id = ${ctx.access.tripId} and deleted_at is null`);
	if (live.rows.length) await deleteNodeCore(tx, out, { nodeId }, ctx);
}

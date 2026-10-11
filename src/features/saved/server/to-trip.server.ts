/**
 * Many saved items into a trip at once (Select's "Add to trip", a city's
 * "Add all to a trip", "Plan a trip from these"): edit access only, one
 * transaction. Each becomes an idea, nothing asked: under the trip's city of
 * its place (the country's, the city made under it, like one added alone),
 * else at the trip's top; its link and photos go on it. One already in that
 * trip is left as it is (`saved_link_trips`: one row per item and trip).
 * `places` (a new trip) makes the countries too. Undo takes the ideas, the
 * cities made for them and the "in trip" marks back out.
 */
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "@/db/db.server";
import type { SavedPlace } from "@/db/schema/saved";
import { type ParentPlan, whereParent } from "@/features/home/share-classify";
import { insertLink } from "@/features/media/server/proposable.server";
import type { AuthUser } from "@/server/auth.server";
import { rateLimitPer } from "@/server/cache.server";
import { createNodeCore, deleteNodeCore } from "@/server/cores/nodes.server";
import { indexTx } from "@/server/legs.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { requireEditOnly } from "@/server/proposals/proposable.server";
import { actorOf, type CoreCtx } from "@/server/proposals/types";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import { ideaName } from "../lib";
import { countryName } from "../where";
import { attachSavedIn } from "./files.server";

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
		       exists (select 1 from saved_link_trips t where t.saved_id = l.id and t.trip_id = ${tripId}) as "inTrip"
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

/** Adds the caller's saved items to a trip they can edit (see the file comment). */
export async function addSavedToTrip(
	user: AuthUser,
	p: { tripId: string; ids: readonly string[]; places?: boolean },
): Promise<AddedToTrip> {
	const access = await requireEditOnly("addSavedToTrip", p.tripId, user);
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
	p: { tripId: string; ids: readonly string[]; places?: boolean },
): Promise<AddedToTrip> {
	const { tripId } = p;
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
	const result: AddedToTrip = { added: [], already: 0, made: [], cities: [] };
	const make = async (node: Omit<TreeNode, "id">): Promise<string> => {
		const { nodeId } = await createNodeCore(
			tx,
			out,
			{
				tripId,
				parentId: node.parentId,
				type: node.type as "city",
				name: node.name,
				...(node.lat != null && node.lng != null
					? { lat: node.lat, lng: node.lng }
					: {}),
				...(node.countryCode ? { countryCode: node.countryCode } : {}),
			},
			ctx,
		);
		nodes.push({ ...node, id: nodeId });
		result.made.push(nodeId);
		return nodeId;
	};
	for (const r of rows) {
		if (r.inTrip) {
			result.already++;
			continue;
		}
		const where = r.countryCode
			? { countryCode: r.countryCode, city: r.city }
			: null;
		let plan: ParentPlan | null = whereParent(nodes, where);
		if (!plan && where && p.places) {
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
		const at =
			r.place ??
			(r.spotLat != null ? { lat: r.spotLat, lng: r.spotLng } : null);
		const nodeId = uuidv7();
		await createNodeCore(
			tx,
			out,
			{
				tripId,
				id: nodeId,
				parentId,
				type: "place",
				name: ideaName({
					...r,
					files: r.files ? [{ kind: "photo" }] : [],
				}),
				...(at?.lat != null && at.lng != null
					? { lat: at.lat, lng: at.lng }
					: {}),
				...(r.place?.address ? { address: r.place.address.slice(0, 500) } : {}),
				...(!r.url && r.text ? { description: r.text.slice(0, 500) } : {}),
			},
			ctx,
		);
		const target = { kind: "node" as const, nodeId };
		if (r.url && /^https?:\/\//i.test(r.url) && r.url.length <= 2000)
			await insertLink(tx, out, { tripId, target, url: r.url }, ctx);
		if (r.files)
			await attachSavedIn(tx, out, ctx.user, {
				savedId: r.id,
				tripId,
				nodeId,
			});
		await tx.execute(sql`
			insert into saved_link_trips (saved_id, trip_id, node_id)
			values (${r.id}, ${tripId}, ${nodeId}) on conflict do nothing`);
		await tx.execute(
			sql`update saved_links set updated_at = now() where id = ${r.id}`,
		);
		result.added.push({ savedId: r.id, nodeId });
	}
	return result;
}

/** Undo of `addSavedToTrip`: its ideas (and the places made for them, when nothing else went there) out, the "in trip" marks off. */
export async function undoSavedToTrip(
	user: AuthUser,
	p: {
		tripId: string;
		added: readonly { savedId: string; nodeId: string }[];
		made: readonly string[];
	},
): Promise<{ ok: true }> {
	const access = await requireEditOnly("undoSavedToTrip", p.tripId, user);
	const ctx: CoreCtx = {
		access,
		user,
		actor: actorOf(user),
		dryRun: false,
	};
	await withTripTx(
		p.tripId,
		async (tx, out) => {
			// Only the marks this add made (the item's own, onto that idea).
			const gone = await tx.execute(sql`
				delete from saved_link_trips t
				 using unnest(${sql.param(p.added.map((a) => a.savedId))}::uuid[],
				              ${sql.param(p.added.map((a) => a.nodeId))}::uuid[]) as u(saved_id, node_id)
				 where t.trip_id = ${p.tripId} and t.saved_id = u.saved_id and t.node_id = u.node_id
				   and exists (select 1 from saved_links s where s.id = t.saved_id and s.user_id = ${user.id})
				 returning t.node_id::text as id`);
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

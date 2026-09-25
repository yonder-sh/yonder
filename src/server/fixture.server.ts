/**
 * Writing a `TripGraph` into the database (SPEC §17.1): the dev seed
 * (`pnpm db:seed`, fixed UUIDs, slug `demo`) and `POST /api/test/fixture`
 * (a fresh clone with new ids under a random slug, one per e2e test) both
 * come from the one demo fixture (`src/lib/fixtures/demo.ts`).
 *
 * Positions are re-keyed per scope (the fixture's keys are readable, not
 * valid fractional-indexing keys), preserving order. Never run against
 * production data: the seed refuses `NODE_ENV=production`, and the test route
 * is off unless `ENABLE_TEST_ROUTES=1` on a localhost URL.
 */
import { randomBytes } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db, Tx } from "@/db/db.server";
import {
	attachments,
	itemAssignees,
	items,
	legAssignees,
	legs,
	listItems,
	listItemTargets,
	nodePriorities,
	nodes,
	shareLinks,
	tripDays,
	tripMembers,
	trips,
	user,
	yjsDocuments,
} from "@/db/schema";
import { can, type ShareRole } from "@/lib/auth/roles";
import { compareKeys } from "@/lib/engine/graph-index";
import type { TripGraph } from "@/lib/engine/types";
import {
	DEMO_MEMBERS,
	DEMO_TRIP_ID,
	demo,
	scenario,
} from "@/lib/fixtures/demo";
import { mentionToken } from "@/lib/notes/mentions";
import { markdownToYdoc } from "@/lib/notes/ydoc.server";
import { type LegDetails, readLegDetails } from "@/lib/schemas/legs";
import { newSlugTail, withSlugTail } from "@/lib/trip-slug";
import type { AuthUser } from "./auth.server";
import { freshKeys } from "./position.server";
import { hardDeleteTripsWhere } from "./trip-delete.server";

// ---------------------------------------------------------------------------
// The generic writer
// ---------------------------------------------------------------------------

export type WriteGraphOptions = {
	slug: string;
	/** The slug's random tail (`src/lib/trip-slug.ts`); none for the seed's fixed `demo`. */
	slugTail?: string | null;
	name: string;
	/** The user who becomes the owner member (the fixture's owner row). */
	ownerUserId: string;
	/** Fixture member id → user id for other active members; unmapped non-owners become placeholders. */
	memberUsers?: Record<string, string>;
	/** Extra active members appended after the fixture's own. */
	extraMembers?: {
		userId: string;
		role: "editor" | "suggester" | "viewer";
	}[];
	/** New ids for everything (clones); false keeps the fixture's fixed UUIDs (the dev seed). */
	remapIds: boolean;
};

export type WrittenGraph = {
	tripId: string;
	/** Fixture id → written id. */
	id: (fixtureId: string) => string;
	/** Member ids of the extra members, in order. */
	extraMemberIds: string[];
	ownerMemberId: string;
};

/** Re-keys `rows` per scope, in `(position, id)` order. */
function rekeyByScope<T extends { id: string; position: string }>(
	rows: readonly T[],
	scopeOf: (r: T) => string,
): Map<string, string> {
	const byScope = new Map<string, T[]>();
	for (const r of rows) {
		const k = scopeOf(r);
		byScope.set(k, [...(byScope.get(k) ?? []), r]);
	}
	const out = new Map<string, string>();
	for (const list of byScope.values()) {
		list.sort(
			(a, b) => compareKeys(a.position, b.position) || compareKeys(a.id, b.id),
		);
		const keys = freshKeys(list.length);
		for (const [i, r] of list.entries()) out.set(r.id, keys[i] as string);
	}
	return out;
}

/** Remaps the leg ids a flight's connection points at. */
function remapDetails(
	details: LegDetails,
	id: (x: string) => string,
): LegDetails {
	if (details.kind !== "flight" || !details.flight.connection) return details;
	const c = details.flight.connection;
	return {
		...details,
		flight: {
			...details.flight,
			connection: {
				...(c.prevLegId ? { prevLegId: id(c.prevLegId) } : {}),
				...(c.nextLegId ? { nextLegId: id(c.nextLegId) } : {}),
			},
		},
	};
}

export async function writeTripGraph(
	tx: Tx,
	graph: TripGraph,
	opts: WriteGraphOptions,
): Promise<WrittenGraph> {
	const ids = new Map<string, string>();
	const id = (x: string): string => {
		if (!opts.remapIds) return x;
		let v = ids.get(x);
		if (!v) {
			v = uuidv7();
			ids.set(x, v);
		}
		return v;
	};
	const tripId = id(graph.trip.id);
	const g = graph;

	await tx.insert(trips).values({
		id: tripId,
		slug: opts.slug,
		slugTail: opts.slugTail ?? null,
		name: opts.name,
		startDate: g.trip.startDate,
		endDate: g.trip.endDate,
		defaultTz: g.trip.defaultTz,
		settings: g.trip.settings,
		createdBy: opts.ownerUserId,
	});

	// Members: the owner row becomes the owner user; others map to users or placeholders.
	const owner = g.members.find((m) => m.role === "owner");
	if (!owner) throw new Error("fixture has no owner member");
	let maxColor = 0;
	for (const m of g.members) {
		const userId =
			m.id === owner.id ? opts.ownerUserId : opts.memberUsers?.[m.id];
		maxColor = Math.max(maxColor, m.color);
		await tx.insert(tripMembers).values({
			id: id(m.id),
			tripId,
			userId: userId ?? null,
			status: userId ? "active" : "placeholder",
			role:
				m.id === owner.id ? "owner" : m.role === "owner" ? "editor" : m.role,
			displayName: userId ? null : m.name,
			color: m.color % 8,
			joinedAt: userId ? new Date() : null,
		});
	}
	const extraMemberIds: string[] = [];
	for (const [i, e] of (opts.extraMembers ?? []).entries()) {
		const memberId = uuidv7();
		extraMemberIds.push(memberId);
		await tx.insert(tripMembers).values({
			id: memberId,
			tripId,
			userId: e.userId,
			status: "active",
			role: e.role,
			color: (maxColor + 1 + i) % 8,
			joinedAt: new Date(),
		});
	}

	// Nodes, parents first.
	const nodePos = rekeyByScope(g.nodes, (n) => n.parentId ?? "");
	const done = new Set<string>();
	const pending = [...g.nodes];
	while (pending.length) {
		const before = pending.length;
		for (let i = 0; i < pending.length; ) {
			const n = pending[i];
			if (!n) break;
			if (n.parentId && !done.has(n.parentId)) {
				i++;
				continue;
			}
			await tx.insert(nodes).values({
				id: id(n.id),
				tripId,
				parentId: n.parentId ? id(n.parentId) : null,
				type: n.type,
				category: n.type === "place" ? (n.category ?? "other") : null,
				status: n.status,
				name: n.name,
				localName: n.localName,
				slug: n.slug,
				description: n.description,
				position: nodePos.get(n.id) as string,
				lat: n.lat,
				lng: n.lng,
				tz: n.tz,
				countryCode: n.countryCode,
				address: n.address,
				googlePlaceId: n.googlePlaceId,
				bbox: n.bbox,
				timeNeededMin: n.timeNeededMin,
				details: n.details,
				createdBy: opts.ownerUserId,
			});
			done.add(n.id);
			pending.splice(i, 1);
		}
		if (pending.length === before)
			throw new Error("fixture nodes have a missing parent");
	}
	for (const n of g.nodes) {
		for (const [memberId, priority] of Object.entries(n.priorities)) {
			await tx.insert(nodePriorities).values({
				tripId,
				nodeId: id(n.id),
				memberId: id(memberId),
				priority,
			});
		}
	}

	if (g.days.length) {
		await tx.insert(tripDays).values(
			g.days.map((d) => ({
				id: id(d.id),
				tripId,
				date: d.date,
				startTime: d.startTime,
				title: d.title,
				nightNodeId: d.nightNodeId ? id(d.nightNodeId) : null,
			})),
		);
	}

	const itemPos = rekeyByScope(g.items, (i) => i.dayId ?? "");
	if (g.items.length) {
		await tx.insert(items).values(
			g.items.map((it) => ({
				id: id(it.id),
				tripId,
				dayId: it.dayId ? id(it.dayId) : null,
				nodeId: it.nodeId ? id(it.nodeId) : null,
				title: it.title,
				note: it.note,
				position: itemPos.get(it.id) as string,
				durationMin: it.durationMin,
				pinnedStart: it.pinnedStart,
				createdBy: opts.ownerUserId,
			})),
		);
	}
	for (const it of g.items) {
		for (const m of it.assigneeIds)
			await tx
				.insert(itemAssignees)
				.values({ tripId, itemId: id(it.id), memberId: id(m) });
	}

	for (const l of g.legs) {
		const details = remapDetails(readLegDetails(l.details), id);
		await tx.insert(legs).values({
			id: id(l.id),
			tripId,
			kind: l.kind,
			fromItemId: l.fromItemId ? id(l.fromItemId) : null,
			toItemId: l.toItemId ? id(l.toItemId) : null,
			stayDayId: l.stayDayId ? id(l.stayDayId) : null,
			anchorItemId: l.anchorItemId ? id(l.anchorItemId) : null,
			mode: l.mode,
			durationMin: l.durationMin,
			distanceM: l.distanceM,
			source: l.source,
			estimateMin: l.estimateMin,
			isEdited: l.isEdited,
			depAt: l.depAt ? new Date(l.depAt) : null,
			arrAt: l.arrAt ? new Date(l.arrAt) : null,
			details: details.kind === "none" ? {} : details,
			createdBy: opts.ownerUserId,
		});
		for (const m of l.assigneeIds)
			await tx
				.insert(legAssignees)
				.values({ tripId, legId: id(l.id), memberId: id(m) });
	}

	return { tripId, id, extraMemberIds, ownerMemberId: id(owner.id) };
}

// ---------------------------------------------------------------------------
// The demo trip (SPEC §17.1)
// ---------------------------------------------------------------------------

export const DEMO_SLUG = "demo";
export const DEMO_NAME = "Demo · Japan & Korea";
export const DEMO_USERS = {
	dev: { email: "dev@example.com", firstName: "Dev", lastName: "User" },
	maya: { email: "maya@example.com", firstName: "Maya", lastName: "Chen" },
} as const;

async function upsertUser(
	tx: Tx,
	u: { email: string; firstName: string; lastName: string },
): Promise<string> {
	const [existing] = await tx
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, u.email));
	if (existing) return existing.id;
	const [row] = await tx
		.insert(user)
		.values({
			id: randomBytes(16).toString("hex"),
			email: u.email,
			emailVerified: true,
			firstName: u.firstName,
			lastName: u.lastName,
			name: `${u.firstName} ${u.lastName}`,
			isAnonymous: false,
		})
		.returning({ id: user.id });
	if (!row) throw new Error("seed: user insert returned no row");
	return row.id;
}

/**
 * The bundle rows the demo shows off (§17.1): two todos (one due), two
 * shopping items (one mentioning Maya, with two candidate shops), a link, an
 * item note, a day note and the trip-root note (written with markdownToYdoc).
 */
async function writeDemoExtras(
	tx: Tx,
	w: WrittenGraph,
	opts: { mayaMemberId: string | null; createdBy: string },
): Promise<void> {
	const { tripId, id } = w;
	const I = demo.I;
	const D = demo.D;
	const N = demo.N;
	const nid = (k: string) => id(N[k] as string);
	const pos = freshKeys(4);
	await tx.insert(listItems).values([
		{
			tripId,
			nodeId: nid("shibuyaSky"),
			list: "todo",
			text: "Book Shibuya Sky sunset slot",
			dueDate: "2027-09-15",
			position: pos[0] as string,
			createdBy: opts.createdBy,
		},
		{
			tripId,
			list: "todo",
			text: "Get a Suica card",
			position: pos[1] as string,
			createdBy: opts.createdBy,
		},
		{
			tripId,
			nodeId: nid("hands"),
			list: "shopping",
			text: opts.mayaMemberId
				? `Washi tape for ${mentionToken("Maya Chen", opts.mayaMemberId)}`
				: "Washi tape",
			quantity: 3,
			position: pos[2] as string,
			createdBy: opts.createdBy,
		},
		{
			tripId,
			nodeId: nid("knifeShop"),
			list: "shopping",
			text: "Petty knife",
			priceAmount: 12000,
			priceCurrency: "JPY",
			position: pos[3] as string,
			createdBy: opts.createdBy,
		},
	]);
	const [washi] = await tx
		.select({ id: listItems.id })
		.from(listItems)
		.where(
			sql`${listItems.tripId} = ${tripId} and ${listItems.text} like 'Washi tape%'`,
		);
	if (washi) {
		// Extra candidate shops only: the primary shop (Hands) is `node_id`.
		await tx
			.insert(listItemTargets)
			.values([{ tripId, listItemId: washi.id, nodeId: nid("loft") }]);
		if (opts.mayaMemberId)
			await tx.execute(sql`
				insert into mentions (id, trip_id, member_id, list_item_id, node_id, excerpt, created_by)
				values (${uuidv7()}, ${tripId}, ${opts.mayaMemberId}, ${washi.id}, ${nid("hands")}, 'Washi tape for @Maya Chen', ${opts.createdBy})`);
	}
	await tx.insert(attachments).values({
		tripId,
		nodeId: nid("shibuyaSky"),
		kind: "link",
		status: "ready",
		url: "https://www.shibuya-scramble-square.com/sky/",
		title: "SHIBUYA SKY",
		siteName: "Shibuya Scramble Square",
		meta: { fetch: "unfetched" },
		position: freshKeys(1)[0] as string,
		createdBy: opts.createdBy,
	});
	const sky = I.sky ? id(I.sky) : null;
	if (sky)
		await tx
			.update(items)
			.set({
				note: "Sunset is around **17:45** in October — be up there by 17:30.",
			})
			.where(eq(items.id, sky));

	const notes: { name: string; dayId?: string; md: string }[] = [
		{
			name: `trip/${tripId}/root`,
			md: "# Demo trip\n\n- Passports valid until 2028\n- **Pack light**: we move every few days\n\nSee the [JNTO guide](https://www.japan.travel/en/).",
		},
	];
	const d1 = D.d1 ? id(D.d1) : null;
	if (d1)
		notes.push({
			name: `trip/${tripId}/day/${d1}`,
			dayId: d1,
			md: "Arrival day: keep it light. Luggage forwarding from the airport.",
		});
	for (const n of notes) {
		const snap = markdownToYdoc(n.md);
		await tx.insert(yjsDocuments).values({
			name: n.name,
			tripId,
			dayId: n.dayId ?? null,
			state: snap.state,
			json: snap.json,
			markdown: snap.markdown,
			plainText: snap.plainText,
			updatedBy: opts.createdBy,
		});
	}
}

/**
 * Tests only (`POST /api/test/link`, db tests): makes the trip's live link of
 * `role` the one its address opens (switched on, no expiry, the newest),
 * creating it if needed, WITHOUT retiring the trip's other live rows or
 * giving the address a tail. So a test lets a viewer guest in, then an
 * editor guest, and each keeps the role they came in with, as the old
 * per-role fixture links did. The app itself keeps one live link per trip
 * (`setShareLink` and `resetShareLink` retire the others), and a role change
 * there applies to every guest. `role: null` switches every live row off
 * and removes their guests, like turning the link off.
 */
export async function pinTestLink(
	exec: Pick<Db, "execute" | "insert">,
	tripId: string,
	role: ShareRole | null,
	createdBy: string | null = null,
): Promise<void> {
	if (role === null) {
		await exec.execute(sql`
			delete from share_grants g using share_links l
			 where g.share_link_id = l.id and l.trip_id = ${tripId} and l.revoked_at is null`);
		await exec.execute(sql`
			update share_links set enabled = false
			 where trip_id = ${tripId} and revoked_at is null`);
		return;
	}
	const res = await exec.execute(sql`
		update share_links
		   set enabled = true, expires_at = null, created_at = clock_timestamp()
		 where trip_id = ${tripId} and role = ${role} and revoked_at is null
		returning id`);
	if (res.rows.length) return;
	await exec.insert(shareLinks).values({
		tripId,
		role,
		enabled: true,
		createdBy,
		createdAt: sql`clock_timestamp()`,
	});
}

/**
 * Tests only: `userId` opens the trip's address as a link guest of `role`
 * (`pinTestLink`, then the real `openTripLink`). Throws when they aren't let
 * in (an active member, a deleted trip).
 */
export async function joinTestLink(
	db: Db,
	trip: { tripId: string; slug: string },
	userId: string,
	role: ShareRole,
): Promise<void> {
	await pinTestLink(db, trip.tripId, role);
	const { openTripLink } = await import("./authz/share-links.server");
	const opened = await openTripLink(trip.slug, userId);
	if (!opened) throw new Error(`joinTestLink: ${trip.slug} didn't open`);
}

export type SeedDevResult = {
	tripId: string;
	slug: string;
	users: { dev: string; maya: string };
};

/**
 * `pnpm db:seed` (SPEC §17.1): in ONE transaction, hard-deletes trip `demo`
 * and the demo users (cascading), then recreates them from the fixture with
 * its fixed UUIDs. Running it twice gives the same result.
 */
export async function seedDev(db: Db): Promise<SeedDevResult> {
	if (process.env.NODE_ENV === "production")
		throw new Error("refusing to seed with NODE_ENV=production");
	return db.transaction(async (tx) => {
		await hardDeleteTripsWhere(tx, { slug: DEMO_SLUG, id: DEMO_TRIP_ID });
		await tx
			.delete(user)
			.where(
				inArray(user.email, [DEMO_USERS.dev.email, DEMO_USERS.maya.email]),
			);
		const dev = await upsertUser(tx, DEMO_USERS.dev);
		const maya = await upsertUser(tx, DEMO_USERS.maya);
		const w = await writeTripGraph(tx, demo.graph, {
			slug: DEMO_SLUG,
			name: DEMO_NAME,
			ownerUserId: dev,
			extraMembers: [{ userId: maya, role: "editor" }],
			remapIds: false,
		});
		await writeDemoExtras(tx, w, {
			mayaMemberId: w.extraMemberIds[0] ?? null,
			createdBy: dev,
		});
		return {
			tripId: w.tripId,
			slug: DEMO_SLUG,
			users: { dev, maya },
		};
	});
}

export type FixtureClone = {
	tripId: string;
	/**
	 * `demo-<tail>`: a real address tail, so turning the link on keeps it.
	 * The link starts off: tests let guests in with `pinTestLink`
	 * (`POST /api/test/link`) and the address.
	 */
	slug: string;
	/** Fixture id → clone id, for the demo's keyed ids (`demo.I.sky` → …). */
	ids: {
		items: Record<string, string>;
		days: Record<string, string>;
		nodes: Record<string, string>;
		legs: Record<string, string>;
	};
	members: { owner: string; maya: string | null; audrey: string };
};

export type FixtureOptions = {
	/** Maya's role in the clone (default editor; QA runs suggester flows as her). */
	mayaRole?: "editor" | "suggester" | "viewer";
	/**
	 * Seed the demo's suggestions (`scenario.proposals` by Maya) through the
	 * real propose path, so review flows run live (EXTENSIONS §3.5). Needs Maya
	 * to be seeded and at least a suggester.
	 */
	proposals?: boolean;
};

export type FixtureCloneResult = FixtureClone & {
	/** With `proposals: true`: the seeded proposal ids, and ops that didn't fit. */
	proposals?: { ids: string[]; skipped: { op: string; reason: string }[] };
};

/**
 * `POST /api/test/fixture` (§18.5): a fresh copy of the demo trip with new ids
 * under a random slug, owned by `ownerUserId`; Maya (if seeded) is an editor
 * (or `opts.mayaRole`).
 */
export async function cloneDemoTrip(
	db: Db,
	ownerUserId: string,
	opts: FixtureOptions = {},
): Promise<FixtureCloneResult> {
	const { clone, id, mayaUserId } = await db.transaction(async (tx) => {
		const [maya] = await tx
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, DEMO_USERS.maya.email));
		const slugTail = newSlugTail();
		const slug = withSlugTail("demo", slugTail);
		const w = await writeTripGraph(tx, demo.graph, {
			slug,
			slugTail,
			name: DEMO_NAME,
			ownerUserId,
			extraMembers:
				maya && maya.id !== ownerUserId
					? [{ userId: maya.id, role: opts.mayaRole ?? "editor" }]
					: [],
			remapIds: true,
		});
		const mayaMemberId = w.extraMemberIds[0] ?? null;
		await writeDemoExtras(tx, w, { mayaMemberId, createdBy: ownerUserId });
		const mapKeys = (r: Record<string, string>) =>
			Object.fromEntries(Object.entries(r).map(([k, v]) => [k, w.id(v)]));
		const clone: FixtureClone = {
			tripId: w.tripId,
			slug,
			ids: {
				items: mapKeys(demo.I),
				days: mapKeys(demo.D),
				nodes: mapKeys(demo.N),
				legs: mapKeys(demo.L),
			},
			members: {
				owner: w.ownerMemberId,
				maya: mayaMemberId,
				audrey: w.id(DEMO_MEMBERS.audrey),
			},
		};
		return {
			clone,
			id: w.id,
			mayaUserId: mayaMemberId ? (maya?.id ?? null) : null,
		};
	});
	if (!opts.proposals) return clone;
	return {
		...clone,
		proposals: await seedDemoProposals(clone.tripId, mayaUserId, id),
	};
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every uuid string in a JSON value mapped through `id` (fixture → clone). */
function remapUuids(v: unknown, id: (x: string) => string): unknown {
	if (typeof v === "string") return UUID_RE.test(v) ? id(v) : v;
	if (Array.isArray(v)) return v.map((x) => remapUuids(x, id));
	if (v && typeof v === "object")
		return Object.fromEntries(
			Object.entries(v).map(([k, x]) => [k, remapUuids(x, id)]),
		);
	return v;
}

/**
 * Maya's demo suggestions, proposed for real (dry run, base, summary, ghosts)
 * in the clone. Ops whose fixture payload doesn't fit (the guest's flight,
 * Audrey's stacked move: no account) are reported as skipped.
 */
async function seedDemoProposals(
	tripId: string,
	mayaUserId: string | null,
	id: (x: string) => string,
): Promise<{ ids: string[]; skipped: { op: string; reason: string }[] }> {
	const skipped: { op: string; reason: string }[] = [];
	const ids: string[] = [];
	const [{ db }, { getTripAccess }, propose, { mutationMeta, withTripTx }] =
		await Promise.all([
			import("@/db/db.server"),
			import("@/server/authz/access.server"),
			import("@/server/proposals/propose.server"),
			import("@/server/tx.server"),
		]);
	if (!mayaUserId) {
		skipped.push({ op: "*", reason: "maya@example.com isn't seeded" });
		return { ids, skipped };
	}
	const [row] = await db.select().from(user).where(eq(user.id, mayaUserId));
	const maya = row as unknown as AuthUser;
	const access = maya ? await getTripAccess(tripId, maya) : null;
	if (!access || !can(access, "propose")) {
		skipped.push({ op: "*", reason: "Maya can't suggest in this trip" });
		return { ids, skipped };
	}
	for (const p of scenario.proposals) {
		if (p.author.name !== "Maya") {
			skipped.push({ op: p.op, reason: `authored by ${p.author.name}` });
			continue;
		}
		try {
			const def = await propose.loadDef(p.op);
			const parsed = def.input.safeParse(remapUuids(p.payload, id));
			if (!parsed.success) {
				skipped.push({ op: p.op, reason: "the fixture payload doesn't parse" });
				continue;
			}
			const res = await withTripTx(
				tripId,
				async (tx, out) => {
					const r = await propose.proposeChange(tx, out, {
						op: p.op,
						def,
						input: parsed.data as Record<string, unknown>,
						flag: undefined,
						access,
						user: maya,
						tripId,
					});
					// Seeded rows don't count against Maya's 60-per-hour budget:
					// every `{ proposals: true }` clone proposes as the same user.
					await tx.execute(sql`
						update proposals set created_at = now() - interval '2 hours'
						 where id = ${r.proposed.id} and trip_id = ${tripId}`);
					return r;
				},
				mutationMeta(access, maya),
			);
			ids.push(res.proposed.id);
		} catch (e) {
			skipped.push({
				op: p.op,
				reason: e instanceof Error ? e.message.slice(0, 200) : String(e),
			});
		}
	}
	return { ids, skipped };
}

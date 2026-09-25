/**
 * Writes an `ImportPlan` into the database (SPEC §17.3). The caller owns the
 * transaction, so the whole import is one transaction (QA SEED-13: a failure
 * leaves no partial trip) and the QA seed can add its fixtures in the same one.
 */
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/db.server";
import {
	attachments,
	itemAssignees,
	items,
	legAssignees,
	legs,
	listItemAssignees,
	listItems,
	listItemTargets,
	nodePriorities,
	nodes,
	tripDays,
	tripMembers,
	trips,
	user,
	yjsDocuments,
} from "@/db/schema";
import { markdownToYdoc } from "@/lib/notes/ydoc.server";
import { hardDeleteTrip } from "@/server/trip-delete.server";
import type { ProcessedPhoto } from "./media";
import type { ImportPlan, MemberKey, Target } from "./plan";

/** The trip slug is taken and `--replace` wasn't given. */
export class ImportRefused extends Error {
	override name = "ImportRefused";
}

export type Person = { email: string; firstName: string; lastName: string };

/**
 * Finds the user by email, or creates a verified one (SPEC §17.3 step 1). An
 * existing user keeps their names; a blank last name on a new user sends them
 * through `/welcome` on first sign-in.
 */
export async function findOrCreateUser(
	tx: Tx,
	p: Person,
): Promise<{ id: string; created: boolean }> {
	const email = p.email.trim().toLowerCase();
	const [existing] = await tx
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email));
	if (existing) return { id: existing.id, created: false };
	const name = [p.firstName, p.lastName].filter((s) => s.trim()).join(" ");
	const [row] = await tx
		.insert(user)
		.values({
			id: randomBytes(16).toString("hex"),
			email,
			emailVerified: true,
			firstName: p.firstName.trim(),
			lastName: p.lastName.trim(),
			name: name || email,
			isAnonymous: false,
		})
		.returning({ id: user.id });
	if (!row) throw new Error("user insert returned no row");
	return { id: row.id, created: true };
}

/**
 * The live trip an import at `slug` would replace: the one at exactly that
 * address (a seed's fixed `asia-2027`), else the one whose readable part it
 * is (`asia-2027-k7m2qxw9`: imports get a random tail, `src/lib/trip-slug.ts`)
 * and that `ownerUserId` made. Several of those refuse: a duplicate named
 * like the original must never be the one deleted.
 *
 * Without `replace`, refuses when there is one. With it, hard-deletes that
 * trip (everything cascades) and returns its id and address so the caller
 * can keep the address and delete its S3 prefix after the commit.
 */
export async function clearSlug(
	tx: Tx,
	slug: string,
	replace: boolean,
	ownerUserId?: string | null,
): Promise<{ id: string; slug: string; slugTail: string | null } | null> {
	const found = (
		await tx.execute(sql`
			select id::text as id, slug, slug_tail as "slugTail" from trips
			 where deleted_at is null
			   and (slug = ${slug}
			        or (slug_tail is not null and slug = ${slug} || '-' || slug_tail
			            and ${ownerUserId ?? null}::text is not null and created_by = ${ownerUserId ?? null}))
			 order by (slug = ${slug}) desc`)
	).rows as { id: string; slug: string; slugTail: string | null }[];
	const exact = found.find((t) => t.slug === slug);
	if (!exact && found.length > 1)
		throw new ImportRefused(
			`${found.length} trips have the address /t/${slug}-…: ${found.map((t) => t.slug).join(", ")}; pass the whole address with --slug`,
		);
	const existing = exact ?? found[0];
	if (!existing) return null;
	if (!replace)
		throw new ImportRefused(
			`a trip at /t/${existing.slug} already exists (${existing.id}); run again with --replace to delete and re-import it`,
		);
	await hardDeleteTrip(tx, existing.id);
	return existing;
}

/**
 * Deletes a trip and everything in it. Most rows cascade from `trips`, but
 * a few foreign keys are NO ACTION on purpose: money rows → members (members
 * with money are retired, never deleted), a merged placeholder → the member it
 * merged into, and items → days. A cascade that reaches `trip_members` or
 * `trip_days` before those rows fails, so they go first, explicitly.
 */

type TargetCols = {
	nodeId: string | null;
	legId: string | null;
	itemId: string | null;
	dayId: string | null;
};
function cols(t: Target): TargetCols {
	return {
		nodeId: t.kind === "node" ? t.nodeId : null,
		legId: t.kind === "leg" ? t.legId : null,
		itemId: t.kind === "item" ? t.itemId : null,
		dayId: t.kind === "day" ? t.dayId : null,
	};
}

export function noteDocName(tripId: string, t: Target): string {
	switch (t.kind) {
		case "root":
			return `trip/${tripId}/root`;
		case "node":
			return `trip/${tripId}/node/${t.nodeId}`;
		case "leg":
			return `trip/${tripId}/leg/${t.legId}`;
		case "item":
			return `trip/${tripId}/item/${t.itemId}`;
		case "day":
			return `trip/${tripId}/day/${t.dayId}`;
	}
}

async function insertChunks<T>(
	rows: readonly T[],
	write: (chunk: T[]) => Promise<unknown>,
	size = 400,
) {
	for (let i = 0; i < rows.length; i += size)
		await write(rows.slice(i, i + size));
}

export type WriteOptions = {
	ownerUserId: string;
	/** Member key → user id for members that are real users (the QA seed links Audrey). */
	memberUsers?: Partial<Record<MemberKey, string>>;
	/** Processed photos by attachment id; photos without one are skipped. */
	photos: ReadonlyMap<string, ProcessedPhoto>;
};

export async function writePlan(
	tx: Tx,
	plan: ImportPlan,
	o: WriteOptions,
): Promise<void> {
	const tripId = plan.trip.id;
	const by = o.ownerUserId;
	const memberId = new Map(plan.members.map((m) => [m.key, m.id]));
	const mid = (k: MemberKey) => memberId.get(k) as string;
	const photoIds = new Set(
		plan.attachments
			.filter((a) => a.kind === "photo" && o.photos.has(a.id))
			.map((a) => a.id),
	);

	await tx.insert(trips).values({
		id: tripId,
		slug: plan.trip.slug,
		slugTail: plan.trip.slugTail ?? null,
		name: plan.trip.name,
		startDate: plan.trip.startDate,
		endDate: plan.trip.endDate,
		defaultTz: plan.trip.defaultTz,
		settings: plan.trip.settings,
		coverAttachmentId:
			plan.trip.coverAttachmentId && photoIds.has(plan.trip.coverAttachmentId)
				? plan.trip.coverAttachmentId
				: null,
		createdBy: by,
	});

	const now = new Date();
	await tx.insert(tripMembers).values(
		plan.members.map((m) => {
			const userId = m.key === "owner" ? by : (o.memberUsers?.[m.key] ?? null);
			return {
				id: m.id,
				tripId,
				userId,
				status: userId ? ("active" as const) : ("placeholder" as const),
				role: m.role,
				displayName: userId ? null : m.displayName,
				color: m.color,
				joinedAt: userId ? now : null,
				invitedBy: userId && m.key !== "owner" ? by : null,
			};
		}),
	);

	await insertChunks(plan.nodes, (chunk) =>
		tx.insert(nodes).values(
			chunk.map((n) => ({
				id: n.id,
				tripId,
				parentId: n.parentId,
				type: n.type,
				category: n.category,
				status: n.status,
				name: n.name,
				slug: n.slug,
				description: n.description,
				position: n.position,
				lat: n.lat,
				lng: n.lng,
				tz: n.tz,
				countryCode: n.countryCode,
				timeNeededMin: n.timeNeededMin,
				details: n.details,
				createdBy: by,
			})),
		),
	);
	const prios = plan.nodes.flatMap((n) =>
		(
			Object.entries(n.priorities) as [
				MemberKey,
				NonNullable<(typeof n.priorities)[MemberKey]>,
			][]
		).map(([k, priority]) => ({
			tripId,
			nodeId: n.id,
			memberId: mid(k),
			priority,
		})),
	);
	await insertChunks(prios, (chunk) => tx.insert(nodePriorities).values(chunk));

	await tx.insert(tripDays).values(
		plan.days.map((d) => ({
			id: d.id,
			tripId,
			date: d.date,
			startTime: d.startTime,
			title: d.title,
			nightNodeId: d.nightNodeId,
		})),
	);

	await insertChunks(plan.items, (chunk) =>
		tx.insert(items).values(
			chunk.map((it) => ({
				id: it.id,
				tripId,
				dayId: it.dayId,
				nodeId: it.nodeId,
				title: it.title,
				note: it.note,
				position: it.position,
				durationMin: it.durationMin,
				pinnedStart: it.pinnedStart,
				fixedDate: it.fixedDate,
				createdBy: by,
			})),
		),
	);
	const itemTags = plan.items.flatMap((it) =>
		it.assignees.map((k) => ({ tripId, itemId: it.id, memberId: mid(k) })),
	);
	if (itemTags.length) await tx.insert(itemAssignees).values(itemTags);

	if (plan.legs.length)
		await tx.insert(legs).values(
			plan.legs.map((l) => ({
				id: l.id,
				tripId,
				kind: l.kind,
				fromItemId: l.fromItemId,
				toItemId: l.toItemId,
				mode: l.mode,
				durationMin: l.mode === "flight" ? null : l.durationMin,
				source: "manual" as const,
				isEdited: true,
				depAt: l.depAt ? new Date(l.depAt) : null,
				arrAt: l.arrAt ? new Date(l.arrAt) : null,
				details: l.details.kind === "none" ? {} : l.details,
				createdBy: by,
			})),
		);

	const legTags = plan.legs.flatMap((l) =>
		l.assignees.map((k) => ({ tripId, legId: l.id, memberId: mid(k) })),
	);
	if (legTags.length) await tx.insert(legAssignees).values(legTags);

	await insertChunks(plan.listItems, (chunk) =>
		tx.insert(listItems).values(
			chunk.map((li) => ({
				id: li.id,
				tripId,
				...cols(li.target),
				list: li.list,
				text: li.text,
				note: li.note,
				url: li.url,
				status: li.status,
				doneAt: li.status === "open" ? null : now,
				doneBy: li.status === "open" ? null : by,
				dueKind: li.dueKind,
				dueRule: li.dueRule,
				dueDate: li.dueDate,
				dueTime: li.dueTime,
				dueTz: li.dueTime ? li.dueTz : null,
				priceAmount: li.priceAmount,
				priceCurrency: li.priceCurrency,
				priceText: li.priceText,
				position: li.position,
				createdBy: by,
			})),
		),
	);
	const extra = plan.listItems.flatMap((li) =>
		li.extraTargets.map((nodeId) => ({ tripId, listItemId: li.id, nodeId })),
	);
	if (extra.length) await tx.insert(listItemTargets).values(extra);
	const liTags = plan.listItems.flatMap((li) =>
		li.assignees.map((k) => ({ tripId, listItemId: li.id, memberId: mid(k) })),
	);
	if (liTags.length) await tx.insert(listItemAssignees).values(liTags);

	const atts = plan.attachments.filter(
		(a) => a.kind === "link" || photoIds.has(a.id),
	);
	await insertChunks(atts, (chunk) =>
		tx.insert(attachments).values(
			chunk.map((a) => {
				const p = a.kind === "photo" ? o.photos.get(a.id) : undefined;
				return {
					id: a.id,
					tripId,
					...cols(a.target),
					kind: a.kind,
					status: "ready" as const,
					visibility: "everyone" as const,
					storageKey: p ? `trips/${tripId}/${a.id}/` : null,
					mime: p ? p.contentType : null,
					sizeBytes: p ? p.sizeBytes : null,
					width: p ? p.width : null,
					height: p ? p.height : null,
					thumbhash: p ? p.thumbhash : null,
					url: a.url,
					provider: a.kind === "link" ? "web" : null,
					title: a.title,
					siteName: a.siteName,
					author: a.author,
					caption: a.caption,
					meta: a.meta,
					position: a.position,
					createdBy: by,
				};
			}),
		),
	);

	for (const n of plan.notes) {
		const snap = markdownToYdoc(n.markdown);
		await tx.insert(yjsDocuments).values({
			name: noteDocName(tripId, n.target),
			tripId,
			...cols(n.target),
			state: snap.state,
			json: snap.json,
			markdown: snap.markdown,
			plainText: snap.plainText,
			updatedBy: by,
		});
	}
}

export { hardDeleteTrip };

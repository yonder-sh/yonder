/**
 * Writes an `ImportPlan` into the database (SPEC §17.3). The caller owns the
 * transaction, so the whole import is one transaction (QA SEED-13: a failure
 * leaves no partial trip) and the QA seed can add its fixtures in the same one.
 */
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
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
 * Without `replace`, refuses when a live trip already has the slug. With it,
 * hard-deletes that trip (everything cascades) and returns its id so the
 * caller can delete its S3 prefix after the commit.
 */
export async function clearSlug(
	tx: Tx,
	slug: string,
	replace: boolean,
): Promise<string | null> {
	const [existing] = await tx
		.select({ id: trips.id })
		.from(trips)
		.where(and(eq(trips.slug, slug), isNull(trips.deletedAt)));
	if (!existing) return null;
	if (!replace)
		throw new ImportRefused(
			`a trip with the slug "${slug}" already exists (${existing.id}); run again with --replace to delete and re-import it`,
		);
	await hardDeleteTrip(tx, existing.id);
	return existing.id;
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

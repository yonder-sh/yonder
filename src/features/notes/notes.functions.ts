/**
 * WP-Lists: note reads (SPEC §13.5). Note BODIES are Yjs documents edited
 * over the collab socket; this function returns their derived JSON / plain
 * text for rollups, previews and offline reading (never the `state` bytes).
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { yjsDocuments } from "@/db/schema";
import type { Json } from "@/functions/graph.functions";
import { requireTripRole } from "@/server/authz/access.server";
import { withUser } from "@/server/authz/middleware";

export type NoteDto = {
	name: string;
	/** Set on the caller's own PRIVATE notes (ADDENDUM §7.2); others' never appear. */
	ownerUserId: string | null;
	nodeId: string | null;
	legId: string | null;
	itemId: string | null;
	dayId: string | null;
	json: Json | null;
	plainText: string | null;
	updatedAt: string;
	updatedBy: string | null;
};

export const listTripNotes = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(z.object({ tripId: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<NoteDto[]> => {
		await requireTripRole(data.tripId, "viewer", context.user);
		const rows = await db
			.select({
				name: yjsDocuments.name,
				ownerUserId: yjsDocuments.ownerUserId,
				nodeId: yjsDocuments.nodeId,
				legId: yjsDocuments.legId,
				itemId: yjsDocuments.itemId,
				dayId: yjsDocuments.dayId,
				json: yjsDocuments.json,
				plainText: yjsDocuments.plainText,
				updatedAt: yjsDocuments.updatedAt,
				updatedBy: yjsDocuments.updatedBy,
			})
			.from(yjsDocuments)
			.where(
				and(
					eq(yjsDocuments.tripId, data.tripId),
					// Private notes: only the caller's own (ADDENDUM §7.2, F read filter).
					or(
						isNull(yjsDocuments.ownerUserId),
						eq(yjsDocuments.ownerUserId, context.user.id),
					),
				),
			)
			.orderBy(desc(yjsDocuments.updatedAt));
		return rows.map((r) => ({
			...r,
			json: (r.json ?? null) as Json | null,
			updatedAt: r.updatedAt.toISOString(),
		}));
	});

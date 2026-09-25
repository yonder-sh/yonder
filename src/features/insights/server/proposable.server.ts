/**
 * WP-Insights' proposable def (EXTENSIONS §4.4): `node.hours` =
 * `setOpeningHours`. Writes `details.openingHours` with `source: 'manual'`
 * (a person confirmed them, whatever they were parsed from); null removes
 * them. `expectedUpdatedAt` → CONFLICT when the place changed meanwhile.
 * Activity: "updated hours of Itoya".
 */
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { nodes } from "@/db/schema";
import { OpeningHours } from "@/lib/schemas/hours";
import { NodeDetails } from "@/lib/schemas/nodes";
import { logActivity } from "@/server/activity.server";
import { fail } from "@/server/authz/session.server";
import { rowTrip } from "@/server/proposals/trip-of.server";
import { defineProposable } from "@/server/proposals/types";

export const SetOpeningHoursInput = z
	.object({
		nodeId: z.uuid(),
		hours: OpeningHours.nullable(),
		expectedUpdatedAt: z.string().optional(),
	})
	.strict();

export const defs = {
	"node.hours": defineProposable({
		input: SetOpeningHoursInput,
		tripIdOf: (i, exec) => rowTrip(exec, "nodes", i.nodeId),
		entityOf: (i) => ({ kind: "node", id: i.nodeId }),
		fields: () => ["details.openingHours"],
		core: async (tx, out, data, ctx): Promise<{ updatedAt: string }> => {
			const tripId = ctx.access.tripId;
			const [row] = await tx
				.select({
					id: nodes.id,
					name: nodes.name,
					details: nodes.details,
					updatedAt: nodes.updatedAt,
				})
				.from(nodes)
				.where(
					and(
						eq(nodes.id, data.nodeId),
						eq(nodes.tripId, tripId),
						isNull(nodes.deletedAt),
					),
				)
				.for("update");
			if (!row) return fail("NOT_FOUND");
			if (
				data.expectedUpdatedAt &&
				Date.parse(data.expectedUpdatedAt) !== row.updatedAt.getTime()
			)
				return fail(
					"CONFLICT",
					"Someone changed this place while you were editing. Review and save again.",
				);
			const details: Record<string, unknown> = {
				...((row.details ?? {}) as Record<string, unknown>),
			};
			const now = new Date();
			if (data.hours)
				details.openingHours = {
					...data.hours,
					source: "manual",
					updatedAt: now.toISOString(),
				};
			else delete details.openingHours;
			const checked = NodeDetails.safeParse(details);
			if (!checked.success)
				return fail("VALIDATION", "These hours are too long to save.");
			const [updated] = await tx
				.update(nodes)
				.set({ details: checked.data, updatedAt: now })
				.where(and(eq(nodes.id, row.id), eq(nodes.tripId, tripId)))
				.returning({ updatedAt: nodes.updatedAt });
			if (!updated) return fail("NOT_FOUND");
			await logActivity(tx, out, {
				tripId,
				actor: ctx.actor,
				verb: "node.hours",
				summary: data.hours
					? `updated hours of ${row.name}`
					: `removed hours of ${row.name}`,
				nodeId: row.id,
				meta: { name: row.name },
			});
			out.emit({ entity: "node", ids: [row.id] });
			return { updatedAt: updated.updatedAt.toISOString() };
		},
	}),
};

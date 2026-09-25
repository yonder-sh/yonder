/**
 * WP-Media's proposable defs (EXTENSIONS §3.3, §1.4): links, caption/target
 * updates and deletes. Uploads stay edit-only (receipts on an expense need
 * `manageExpenses`). Cores are DB-only: the link preview runs as a job via
 * `out.job('links', 'links.preview', …)` after COMMIT.
 *
 * Guests: a `members`-visibility row or a receipt answers NOT_FOUND, exactly
 * as `listTripMedia` hides it (ADDENDUM §9).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Tx } from "@/db/db.server";
import { attachments } from "@/db/schema";
import { can } from "@/lib/auth/roles";
import { HttpUrl } from "@/lib/schemas/common";
import {
	AttachmentTarget,
	attachmentTargetColumns,
	attachmentTargetOf,
	BundleTarget,
} from "@/lib/schemas/targets";
import { fail } from "@/server/authz/session.server";
import { rateLimit } from "@/server/cache.server";
import { assertFreshIds } from "@/server/cores/ids.server";
import { positionFor } from "@/server/position.server";
import { rowTrip } from "@/server/proposals/trip-of.server";
import { type CoreCtx, defineProposable } from "@/server/proposals/types";
import { mediaPrefix } from "@/server/s3.server";
import { canonicalLink, classifyUrl } from "../embeds";
import type { MediaDto } from "../types";
import {
	type AttachmentRow,
	assertAttachmentTarget,
	canSeeRow,
	toDto,
} from "./dto.server";
import { logMediaAdd, logMediaChange } from "./media-activity.server";

export const AddLinkInput = z
	.object({
		tripId: z.uuid(),
		/** EXTENSIONS §2.2: a chosen id; an existing one is CONFLICT. */
		id: z.uuid().optional(),
		target: BundleTarget,
		url: HttpUrl.max(2000),
		caption: z.string().max(2000).optional(),
	})
	.strict();

export const UpdateAttachmentInput = z
	.object({
		id: z.uuid(),
		caption: z.string().max(2000).nullable().optional(),
		target: AttachmentTarget.optional(),
		afterId: z.uuid().optional(),
		expectedUpdatedAt: z.string().optional(),
	})
	.strict();

export const DeleteAttachmentInput = z.object({ id: z.uuid() }).strict();

/** The live row for a core, or NOT_FOUND (also for rows this caller may not see). */
export async function rowForCore(
	tx: Tx,
	id: string,
	ctx: Pick<CoreCtx, "access" | "user">,
	opts: { includePending?: boolean } = {},
): Promise<AttachmentRow> {
	const [row] = await tx
		.select()
		.from(attachments)
		.where(
			and(
				eq(attachments.tripId, ctx.access.tripId),
				eq(attachments.id, id),
				isNull(attachments.deletedAt),
			),
		)
		.for("update");
	if (!row) return fail("NOT_FOUND");
	if (!(await canSeeRow(tx, ctx.access, ctx.user.id, row, opts)))
		return fail("NOT_FOUND");
	return row;
}

/**
 * Receipts are money, and money is a ledger (EXTENSIONS §3.3 X5): members
 * with `manageExpenses` (suggesters too) edit and delete them directly, never
 * as proposals. Evaluated by the gate inside the transaction.
 */
async function receiptDirect(
	id: string,
	access: Parameters<typeof can>[0],
	tx: Tx,
): Promise<boolean> {
	if (!can(access, "manageExpenses")) return false;
	const res = await tx.execute(sql`
		select 1 from attachments where id = ${id} and expense_id is not null and deleted_at is null`);
	return res.rows.length > 0;
}

/** Plain caption text: trimmed, empty → null. Markdown stays as typed (rendered without HTML). */
function cleanCaption(v: string | null | undefined): string | null {
	const s = v?.trim();
	return s ? s : null;
}

export const defs = {
	"attachment.link": defineProposable({
		input: AddLinkInput,
		tripIdOf: async (i) => i.tripId,
		entityOf: (i) => ({ kind: "att", id: i.id ?? null }),
		fields: () => [],
		core: async (tx, out, data, ctx): Promise<MediaDto> => {
			const tripId = ctx.access.tripId;
			if (!ctx.dryRun)
				await rateLimit(`links:${ctx.user.id}`, ctx.access.isGuest ? 10 : 30);
			if (data.id) await assertFreshIds(tx, "attachments", [data.id]);
			await assertAttachmentTarget(tx, tripId, data.target, ctx.user.id);
			const c = classifyUrl(data.url);
			const id = data.id ?? uuidv7();
			const position = await positionFor(tx, {
				table: "attachments",
				tripId,
				target: data.target,
			});
			const url =
				c.kind === "embed" && c.provider === "instagram"
					? (canonicalLink("instagram", c.embedId, data.url, c.igType) ??
						data.url)
					: data.url;
			const [row] = await tx
				.insert(attachments)
				.values({
					id,
					tripId,
					...attachmentTargetColumns(data.target),
					kind: c.kind,
					status: "processing",
					visibility: "everyone",
					url,
					provider: c.provider,
					embedId: c.kind === "embed" ? c.embedId : null,
					author:
						c.kind === "embed" && c.provider === "instagram" ? c.author : null,
					storageKey: mediaPrefix(tripId, id),
					caption: cleanCaption(data.caption),
					meta: {
						fetch: "unfetched",
						...(c.kind === "embed" ? { aspect: c.aspect } : {}),
						...(c.kind === "embed" && c.provider === "instagram"
							? { igType: c.igType }
							: {}),
					},
					position,
					createdBy: ctx.user.id,
				})
				.returning();
			if (!row) return fail("CONFLICT");
			await logMediaAdd(tx, out, {
				tripId,
				actor: ctx.actor,
				target: data.target,
				kind: c.kind,
				visibility: "everyone",
				dryRun: ctx.dryRun,
			});
			out.job(
				"links",
				"links.preview",
				{ tripId, attachmentId: id, url },
				{ dedupeId: `links:${id}` },
			);
			out.emit({ keys: ["media", "counts"] });
			return toDto(row, ctx.user.id);
		},
	}),
	"attachment.update": defineProposable({
		input: UpdateAttachmentInput,
		tripIdOf: (i, exec) => rowTrip(exec, "attachments", i.id),
		entityOf: (i) => ({ kind: "att", id: i.id }),
		fields: (i) =>
			(["caption", "target"] as const).filter((k) => i[k] !== undefined),
		directIf: (i, access, tx) =>
			!i.target || i.target.kind === "expense"
				? receiptDirect(i.id, access, tx)
				: Promise.resolve(false),
		core: async (tx, out, data, ctx): Promise<{ updatedAt: string }> => {
			const tripId = ctx.access.tripId;
			const row = await rowForCore(tx, data.id, ctx);
			if (
				data.expectedUpdatedAt &&
				row.updatedAt.toISOString() !== data.expectedUpdatedAt
			)
				return fail(
					"CONFLICT",
					"Someone changed this at the same time. Try again.",
				);
			const patch: Partial<typeof attachments.$inferInsert> = {
				updatedAt: new Date(),
			};
			if (data.caption !== undefined)
				patch.caption = cleanCaption(data.caption);
			let targetChanged = false;
			if (data.target) {
				// Receipts are money: moving onto or off an expense needs manageExpenses.
				const money = data.target.kind === "expense" || !!row.expenseId;
				if (money && !can(ctx.access, "manageExpenses"))
					return fail("FORBIDDEN", "not allowed: manageExpenses");
				await assertAttachmentTarget(tx, tripId, data.target, ctx.user.id);
				Object.assign(patch, attachmentTargetColumns(data.target));
				targetChanged = true;
				patch.position = await positionFor(
					tx,
					{ table: "attachments", tripId, target: data.target },
					{ afterId: data.afterId ?? null, exclude: [row.id] },
				);
				// A receipt always hides from guests (they never see money anyway).
				if (data.target.kind === "expense") patch.visibility = "members";
			} else if (data.afterId !== undefined) {
				patch.position = await positionFor(
					tx,
					{
						table: "attachments",
						tripId,
						target: attachmentTargetOf(row),
					},
					{ afterId: data.afterId, exclude: [row.id] },
				);
			}
			const [updated] = await tx
				.update(attachments)
				.set(patch)
				.where(and(eq(attachments.tripId, tripId), eq(attachments.id, row.id)))
				.returning({ updatedAt: attachments.updatedAt });
			const captionChanged =
				patch.caption !== undefined && patch.caption !== row.caption;
			if (targetChanged || captionChanged)
				await logMediaChange(tx, out, {
					tripId,
					actor: ctx.actor,
					target: attachmentTargetOf(row),
					kind: row.kind,
					visibility: row.visibility,
					change: targetChanged ? "move" : "caption",
					to: targetChanged ? data.target : undefined,
				});
			out.emit({ keys: targetChanged ? ["media", "counts"] : ["media"] });
			return { updatedAt: (updated?.updatedAt ?? new Date()).toISOString() };
		},
	}),
	"attachment.delete": defineProposable({
		input: DeleteAttachmentInput,
		tripIdOf: (i, exec) => rowTrip(exec, "attachments", i.id),
		entityOf: (i) => ({ kind: "att", id: i.id }),
		fields: () => ["deletedAt"],
		directIf: (i, access, tx) => receiptDirect(i.id, access, tx),
		core: async (tx, out, data, ctx): Promise<{ deletedAt: string }> => {
			const tripId = ctx.access.tripId;
			// The uploader may also drop their own cancelled (pending) upload.
			const row = await rowForCore(tx, data.id, ctx, {
				includePending: true,
			});
			if (row.expenseId && !can(ctx.access, "manageExpenses"))
				return fail("FORBIDDEN", "not allowed: manageExpenses");
			const res = await tx.execute(sql`
				update attachments set deleted_at = date_trunc('milliseconds', now()), updated_at = now()
				 where trip_id = ${tripId} and id = ${row.id}
				 returning deleted_at as "deletedAt"`);
			const deletedAt = (
				res.rows[0] as { deletedAt: Date | string } | undefined
			)?.deletedAt;
			if (row.status !== "pending")
				await logMediaChange(tx, out, {
					tripId,
					actor: ctx.actor,
					target: attachmentTargetOf(row),
					kind: row.kind,
					visibility: row.visibility,
					change: "delete",
				});
			out.emit({ keys: ["media", "counts"] });
			return {
				deletedAt: new Date(deletedAt ?? Date.now()).toISOString(),
			};
		},
	}),
};

/**
 * Row → DTO, read rules and visibility defaults for attachments.
 *
 * Read rules (CONTRACTS §1 rule 11, ADDENDUM §6/§9), the same everywhere
 * (list, route, cores): link guests never get receipts (`expense_id`) nor
 * `visibility = 'members'` rows; a private expense's receipts reach only the
 * expense's creator; `pending` rows are nobody's business but the uploader's
 * (they never appear in lists).
 */
import { sql } from "drizzle-orm";
import type { attachments } from "@/db/schema";
import { mustRedact, type TripAccess } from "@/lib/auth/roles";
import type { AttachmentMeta } from "@/lib/schemas/attachments";
import type { AttachmentKind, AttachmentVisibility } from "@/lib/schemas/enums";
import {
	type AttachmentTarget,
	attachmentTargetOf,
} from "@/lib/schemas/targets";
import { fail } from "@/server/authz/session.server";
import type { SqlExec } from "@/server/graph.server";
import { assertBundleTarget } from "@/server/perms.server";
import type { MediaDto } from "../types";
import { decodeEntities } from "./entities";

export type AttachmentRow = typeof attachments.$inferSelect;

/** WP-Media's keys inside `attachments.meta` (a loose object; F's keys stay as they are). */
export type MediaMeta = AttachmentMeta & {
	thumb?: boolean;
	pages?: number;
	pageCount?: number;
	igType?: string;
	fileName?: string;
	imageW?: number;
	imageH?: number;
};

export function metaOf(row: Pick<AttachmentRow, "meta">): MediaMeta {
	return (row.meta ?? {}) as MediaMeta;
}

export function toDto(row: AttachmentRow, userId: string | null): MediaDto {
	const m = metaOf(row);
	// Previews stored before `cleanText` decoded entities (VIS-16) read clean too.
	const fetched = row.kind === "link" || row.kind === "embed";
	const text = (v: string | null) => (fetched ? decodeEntities(v) : v);
	const imageAspect = m.imageW && m.imageH ? m.imageW / m.imageH : null;
	const ownAspect = row.width && row.height ? row.width / row.height : null;
	return {
		id: row.id,
		target: attachmentTargetOf(row),
		kind: row.kind,
		status: row.status,
		visibility: row.visibility,
		mime: row.mime,
		width: row.width,
		height: row.height,
		durationSec: row.durationSec,
		thumbhash: row.thumbhash,
		takenAt: row.takenAt?.toISOString() ?? null,
		url: row.url,
		provider: row.provider,
		embedId: row.embedId,
		title: text(row.title),
		siteName: text(row.siteName),
		caption: row.caption,
		position: row.position,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		description: text(row.description),
		author: text(row.author),
		sizeBytes: row.sizeBytes,
		hasThumb:
			m.thumb === true ||
			(row.kind === "photo" && row.status === "ready" && !!row.thumbhash),
		hasImage: !!row.imageKey,
		hasFavicon: !!row.faviconKey,
		aspect:
			m.aspect ??
			(row.kind === "link" || row.kind === "embed"
				? (imageAspect ?? ownAspect)
				: ownAspect),
		pages: row.kind === "pdf" ? (m.pages ?? 0) : 0,
		pageCount: row.kind === "pdf" ? (m.pageCount ?? null) : null,
		igType: m.igType ?? null,
		license: m.license ?? null,
		licenseUrl: m.licenseUrl ?? null,
		sourceUrl: m.sourceUrl ?? null,
		fetch: m.fetch ?? null,
		mine: !!userId && row.createdBy === userId,
	};
}

/**
 * Whether this caller may see the row (see the file comment). `exec` is
 * needed only for receipts (the expense's privacy).
 */
export async function canSeeRow(
	exec: SqlExec,
	access: Pick<TripAccess, "role" | "isGuest">,
	userId: string,
	row: Pick<
		AttachmentRow,
		"expenseId" | "visibility" | "status" | "createdBy" | "deletedAt"
	>,
	opts: { includeDeleted?: boolean; includePending?: boolean } = {},
): Promise<boolean> {
	if (row.deletedAt && !opts.includeDeleted) return false;
	if (
		row.status === "pending" &&
		!(opts.includePending && row.createdBy === userId)
	)
		return false;
	if (mustRedact(access)) {
		if (row.expenseId || row.visibility !== "everyone") return false;
		if (row.status === "failed") return false;
		return true;
	}
	if (row.expenseId) {
		const res = await exec.execute(sql`
			select 1 from expenses e
			 where e.id = ${row.expenseId}
			   and (not e.is_private or e.created_by = ${userId})`);
		return res.rows.length > 0;
	}
	return true;
}

/**
 * Where an attachment may be written (uploads, moves): `assertBundleTarget`
 * (the target is in this trip), and a private expense is its creator's alone
 * — anyone else gets NOT_FOUND, like every other money operation on it
 * (ADDENDUM §6, EXTENSIONS §8.3; SEC-R1-07).
 */
export async function assertAttachmentTarget(
	exec: SqlExec,
	tripId: string,
	target: AttachmentTarget,
	userId: string,
): Promise<void> {
	await assertBundleTarget(exec, tripId, target);
	if (target.kind !== "expense") return;
	const res = await exec.execute(sql`
		select 1 from expenses e
		 where e.id = ${target.expenseId} and e.trip_id = ${tripId}
		   and (not e.is_private or e.created_by = ${userId})`);
	if (!res.rows.length) fail("NOT_FOUND", "expense");
}

/**
 * ADDENDUM §9: PDFs on flights, stays, reserved transit and expenses start
 * hidden from guests (booking confirmations, e-tickets, receipts). Everything
 * else — photos, videos, embeds, links, general PDFs — starts `everyone`.
 */
export async function defaultVisibility(
	exec: SqlExec,
	tripId: string,
	target: AttachmentTarget,
	kind: AttachmentKind,
): Promise<AttachmentVisibility> {
	if (target.kind === "expense") return "members";
	if (kind !== "pdf") return "everyone";
	if (target.kind === "leg") {
		const res = await exec.execute(sql`
			select kind::text as kind, mode::text as mode, details
			  from legs where id = ${target.legId} and trip_id = ${tripId}`);
		const leg = res.rows[0] as
			| {
					kind: string;
					mode: string | null;
					details: Record<string, unknown> | null;
			  }
			| undefined;
		if (!leg) return "everyone";
		if (leg.kind !== "pair") return "members"; // a stay's morning/evening leg
		if (leg.mode === "flight") return "members";
		const d = leg.details ?? {};
		if (d.kind === "transit" && (d.fixed || d.booking)) return "members"; // reserved transit
		return "everyone";
	}
	const lodging = async (nodeSql: ReturnType<typeof sql>) => {
		const res = await exec.execute(sql`
			select 1 from nodes n where n.trip_id = ${tripId} and n.id = (${nodeSql})
			   and n.category::text = 'lodging'`);
		return res.rows.length > 0;
	};
	if (target.kind === "node")
		return (await lodging(sql`${target.nodeId}::uuid`))
			? "members"
			: "everyone";
	if (target.kind === "item")
		return (await lodging(
			sql`select node_id from items where id = ${target.itemId} and trip_id = ${tripId}`,
		))
			? "members"
			: "everyone";
	return "everyone";
}

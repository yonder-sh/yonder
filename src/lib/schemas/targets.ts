/**
 * Where a bundle (notes, media, links, todos, shopping) hangs, and how a leg is
 * addressed before its row exists (SPEC §6.5).
 *
 * A bundle target always names a leg **row** (`legId`); callers get one from
 * `ensureLeg(LegTarget)`, which creates a `mode: null` row if there isn't one yet.
 */
import { z } from "zod";
import { Id } from "./common";

export const BundleTarget = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("trip") }),
	z.object({ kind: z.literal("node"), nodeId: Id }),
	z.object({ kind: z.literal("leg"), legId: Id }),
	z.object({ kind: z.literal("item"), itemId: Id }),
	z.object({ kind: z.literal("day"), dayId: Id }),
]);
export type BundleTarget = z.infer<typeof BundleTarget>;

export const LegTarget = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("pair"), fromItemId: Id, toItemId: Id }),
	z.object({
		kind: z.literal("stay"),
		dayId: Id,
		end: z.enum(["start", "end"]),
	}),
]);
export type LegTarget = z.infer<typeof LegTarget>;

/** The four nullable target columns shared by attachments, list_items and yjs_documents. */
export type BundleTargetColumns = {
	nodeId: string | null;
	legId: string | null;
	itemId: string | null;
	dayId: string | null;
};

/** BundleTarget → the row's target columns (all null = the trip root). */
export function bundleTargetColumns(target: BundleTarget): BundleTargetColumns {
	const cols: BundleTargetColumns = {
		nodeId: null,
		legId: null,
		itemId: null,
		dayId: null,
	};
	switch (target.kind) {
		case "trip":
			return cols;
		case "node":
			return { ...cols, nodeId: target.nodeId };
		case "leg":
			return { ...cols, legId: target.legId };
		case "item":
			return { ...cols, itemId: target.itemId };
		case "day":
			return { ...cols, dayId: target.dayId };
	}
}

/** A row's target columns → BundleTarget. The DB CHECK guarantees at most one is set. */
export function bundleTargetOf(row: BundleTargetColumns): BundleTarget {
	if (row.nodeId) return { kind: "node", nodeId: row.nodeId };
	if (row.legId) return { kind: "leg", legId: row.legId };
	if (row.itemId) return { kind: "item", itemId: row.itemId };
	if (row.dayId) return { kind: "day", dayId: row.dayId };
	return { kind: "trip" };
}

/**
 * Where an ATTACHMENT hangs: any bundle target, or an expense (E5 receipts,
 * EXTENSIONS §8.1 `attachments.expense_id`). Only media can hang on an
 * expense, so lists and notes keep the narrower `BundleTarget`.
 */
export const AttachmentTarget = z.discriminatedUnion("kind", [
	...BundleTarget.options,
	z.object({
		kind: z.literal("expense"),
		expenseId: Id,
		/** ADDENDUM §7.3/§9: the receipt of one payment (deposit, final bill) of that expense. */
		paymentId: Id.optional(),
	}),
]);
export type AttachmentTarget = z.infer<typeof AttachmentTarget>;

export type AttachmentTargetColumns = BundleTargetColumns & {
	expenseId: string | null;
	/** A qualifier of `expenseId` (never set without it). */
	paymentId: string | null;
};

/** AttachmentTarget → the attachment row's target columns. */
export function attachmentTargetColumns(
	target: AttachmentTarget,
): AttachmentTargetColumns {
	if (target.kind === "expense")
		return {
			nodeId: null,
			legId: null,
			itemId: null,
			dayId: null,
			expenseId: target.expenseId,
			paymentId: target.paymentId ?? null,
		};
	return { ...bundleTargetColumns(target), expenseId: null, paymentId: null };
}

/** An attachment row's target columns → AttachmentTarget. */
export function attachmentTargetOf(
	row: AttachmentTargetColumns,
): AttachmentTarget {
	if (row.expenseId)
		return row.paymentId
			? { kind: "expense", expenseId: row.expenseId, paymentId: row.paymentId }
			: { kind: "expense", expenseId: row.expenseId };
	return bundleTargetOf(row);
}

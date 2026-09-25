/**
 * ADDENDUM §10 "one inbox": ONE bell (WP-Shell `InboxBell`) with one read
 * state for everything that asks for a person's attention. The feed is F
 * (`listInbox` / `markInboxRead` in `src/functions/inbox.functions.ts`) and
 * is also the future email source (ROADMAP "Email notifications").
 *
 * Items are DERIVED, never stored; each has a stable `key` and the read state
 * lives in `inbox_reads` (per user, per key). A key changes when the thing
 * changes in a way that should notify again (a moved booking window, a new
 * balance delta, a new trip default), so the bell lights up again.
 *
 * Privacy (server-side, like every F read): private list items, private
 * notes and private expenses never produce an item for anyone but their
 * author; link guests get an empty feed; money items only reach members.
 */
import { z } from "zod";
import type { DUE_KIND_VALUES, EXPENSE_CATEGORY_VALUES } from "./enums";

export const INBOX_KIND_VALUES = [
	/** Someone @mentioned me (notes, list items, item notes). */
	"mention",
	/** Open suggestions waiting for my review (reviewers only; one item per trip). */
	"review",
	/** My suggestion was accepted or rejected (with the reviewer's note). */
	"proposal_result",
	/** A todo due soon / overdue, or a booking window opening, assigned to me or to nobody. */
	"due",
	/** ADDENDUM §7.3: my balance changed since my last settlement. */
	"balance_changed",
	/** ADDENDUM §7.1: a trip-default budget changed while my custom value stays. */
	"budget_notice",
] as const;
export const InboxKind = z.enum(INBOX_KIND_VALUES);
export type InboxKind = z.infer<typeof InboxKind>;

/** Stable key builders (≤ 200 chars; `inbox_reads.item_key`). */
export const inboxKey = {
	mention: (mentionId: string) => `mention:${mentionId}`,
	/** Re-notifies when the newest open proposal changes. */
	review: (tripId: string, newestProposalId: string) =>
		`review:${tripId}:${newestProposalId}`,
	proposalResult: (proposalId: string) => `result:${proposalId}`,
	/** `at` = the due instant (epoch ms): a moved window notifies again. */
	due: (listItemId: string, at: number) => `due:${listItemId}:${at}`,
	/**
	 * `stamp` = my latest settlement (epoch ms) and the delta since it, so the
	 * item turns unread again only when MY balance moves (QA MONEY-21), not on
	 * every edit by anyone.
	 */
	balance: (tripId: string, memberId: string, stamp: string | number) =>
		`balance:${tripId}:${memberId}:${stamp}`,
	/** `defaultMinor` = the trip default's new amount. */
	budget: (budgetLineId: string, defaultMinor: number) =>
		`budget:${budgetLineId}:${defaultMinor}`,
} as const;

/** Where a click goes: the trip slug plus workspace search (resolved client-side). */
export type InboxLink = {
	tripSlug: string;
	/** `sel` encoding (`n.<id>`, `i.<id>`, `p.<id>`, …). */
	sel?: string;
	tab?: "plan" | "notes" | "lists" | "money" | "media";
	list?: "todo" | "shopping";
	/** Open the review drawer (review items). */
	review?: true;
};

type InboxBase = {
	key: string;
	tripId: string;
	tripName: string;
	/** Sort key, newest first (ISO). */
	at: string;
	read: boolean;
	/** Who caused it (null for reminders). */
	actor: { name: string; memberId: string | null } | null;
	/** One plain-text line, never Markdown. Money amounts only in the caller's own items. */
	title: string;
	link: InboxLink;
};

export type InboxItem = InboxBase &
	(
		| {
				kind: "mention";
				mentionId: string;
				excerpt: string | null;
				/**
				 * The place, item or day it sits on ("Shibuya Sky", "Day 3"), for
				 * "… mentioned you in Shibuya Sky" where no graph is loaded (the
				 * dashboard). Not part of `title`.
				 */
				where?: string | null;
		  }
		| { kind: "review"; count: number }
		| {
				kind: "proposal_result";
				proposalId: string;
				decision: "accepted" | "rejected";
				note: string | null;
		  }
		| {
				kind: "due";
				listItemId: string;
				dueKind: (typeof DUE_KIND_VALUES)[number];
				/** The effective due instant (relative rules resolved), ISO. */
				dueAt: string;
				state: "overdue" | "open_now" | "today" | "soon";
		  }
		| {
				kind: "balance_changed";
				/** In the trip's home currency, minor units; + = I'm owed more. */
				deltaMinor: number;
				currency: string;
				/** "Maya edited Ramen Ichiran" (from `expense.*` activity). */
				cause: string | null;
		  }
		| {
				kind: "budget_notice";
				budgetLineId: string;
				nodeId: string | null;
				category: (typeof EXPENSE_CATEGORY_VALUES)[number] | null;
				defaultMinor: number;
				mineMinor: number;
				currency: string;
		  }
	);

export type InboxDto = {
	items: InboxItem[];
	/** Unread items (the bell's dot/count). */
	unread: number;
};

export const INBOX_MAX = 100;

export const ListInboxInput = z
	.object({
		/** One trip (the workspace bell); omitted = every trip of mine (dashboard). */
		tripId: z.uuid().optional(),
		limit: z.number().int().min(1).max(INBOX_MAX).optional(),
	})
	.strict();

export const MarkInboxReadInput = z.union([
	z
		.object({
			keys: z.array(z.string().min(1).max(200)).min(1).max(200),
		})
		.strict(),
	z.object({ all: z.literal(true), tripId: z.uuid().optional() }).strict(),
]);

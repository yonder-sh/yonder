/**
 * WP-Lists: todo and shopping list server functions (SPEC §13.5; EXTENSIONS
 * §7). The proposable functions run through the gate; their inputs and
 * DB-only cores are in `server/proposable.server.ts`. Reads apply the
 * ADDENDUM §7.2 privacy filter (private rows only for their creator).
 * Keys: lists, counts.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "@/db/db.server";
import type { DueKind, ListItemStatus, ListKind } from "@/lib/schemas/enums";
import type { DueRule } from "@/lib/schemas/lists";
import type { BundleTarget } from "@/lib/schemas/targets";
import { requireTripRole } from "@/server/authz/access.server";
import { withNamedUser, withUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { tripOf } from "@/server/perms.server";
import {
	proposable,
	requireEditOnly,
} from "@/server/proposals/proposable.server";
import { actorOf } from "@/server/proposals/types";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import { readListItems } from "./server/lists.server";
import {
	CreateListItemInput,
	DeleteListItemInput,
	MoveListItemInput,
	RestoreListItemInput,
	restoreListItemCore,
	SetListItemAssigneesInput,
	SetListItemStatusInput,
	SetListItemTargetsInput,
	UpdateListItemInput,
} from "./server/proposable.server";

export type ListItemDto = {
	id: string;
	target: BundleTarget;
	list: ListKind;
	/** One line of inline Markdown, may contain mention tokens. */
	text: string;
	note: string | null;
	url: string | null;
	status: ListItemStatus;
	dueDayId: string | null;
	dueDate: string | null;
	dueTime: string | null;
	dueTz: string | null;
	/** E4. */
	dueKind: DueKind;
	/** ADDENDUM §10: relative booking window (null = absolute fields). */
	dueRule: DueRule | null;
	quantity: number | null;
	priceAmount: number | null;
	priceCurrency: string | null;
	position: string;
	/** ADDENDUM §7.2: only ever true in its creator's own list. */
	isPrivate: boolean;
	assigneeIds: string[];
	extraTargetNodeIds: string[];
	createdAt: string;
	updatedAt: string;
	/**
	 * When it was ticked off or skipped (null while open). Always set by
	 * `listTripListItems`; optional so other packages' fixtures need not.
	 */
	doneAt?: string | null;
	/** Created by the caller (only the author may make an item private). Always set by the read. */
	mine?: boolean;
};

/** Every live list item the caller may see, ordered by `(position, id)`. */
export const listTripListItems = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(z.object({ tripId: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<ListItemDto[]> => {
		await requireTripRole(data.tripId, "viewer", context.user);
		return readListItems(db, data.tripId, context.user.id);
	});

/** `list.create`. Keys: lists, counts. */
export const createListItem = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(CreateListItemInput))
	.handler(proposable.run("list.create"));

/** `list.update`. */
export const updateListItem = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(UpdateListItemInput))
	.handler(proposable.run("list.update"));

/** `list.status`: an assignee ticks their own row directly (suggesters too). */
export const setListItemStatus = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SetListItemStatusInput))
	.handler(proposable.run("list.status"));

/** `list.move`. */
export const moveListItem = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(MoveListItemInput))
	.handler(proposable.run("list.move"));

/** `list.targets`: extra candidate shops. */
export const setListItemTargets = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SetListItemTargetsInput))
	.handler(proposable.run("list.targets"));

/** `list.assignees`. */
export const setListItemAssignees = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SetListItemAssigneesInput))
	.handler(proposable.run("list.assignees"));

/** `list.delete`. */
export const deleteListItem = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(DeleteListItemInput))
	.handler(proposable.run("list.delete"));

/** Undo of `deleteListItem` (edit-only, never a proposal). Keys: lists, counts. */
export const restoreListItem = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(RestoreListItemInput)
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const tripId =
			(await tripOf("list_items", data.id, { includeDeleted: true })) ??
			fail("NOT_FOUND");
		const access = await requireEditOnly(
			"restoreListItem",
			tripId,
			context.user,
		);
		return withTripTx(
			tripId,
			(tx, out) =>
				restoreListItemCore(tx, out, data, {
					access,
					user: context.user,
					actor: actorOf(context.user),
					inputRedacted: false,
					dryRun: false,
				}),
			mutationMeta(access, context.user),
		);
	});

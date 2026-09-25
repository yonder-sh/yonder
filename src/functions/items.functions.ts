/**
 * Timeline items (SPEC §7.7–§7.10, §13.1). Each proposable function is a
 * literal `createServerFn` whose handler is the gate (EXTENSIONS §3.4); the
 * inputs and DB-only cores live in `src/server/cores/items.server.ts`.
 * Results are `R | Proposed`.
 */
import { createServerFn } from "@tanstack/react-start";
import { withNamedUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import type { SequenceResult } from "@/server/cores/items.server";
import {
	CreateItemInput,
	DeleteItemInput,
	MoveItemInput,
	RestoreItemInput,
	restoreItemCore,
	SetItemAssigneesInput,
	UpdateItemInput,
} from "@/server/cores/items.server";
import { tripOf } from "@/server/perms.server";
import {
	proposable,
	requireEditOnly,
} from "@/server/proposals/proposable.server";
import { actorOf } from "@/server/proposals/types";
import { mutationMeta, withTripTx } from "@/server/tx.server";

export type { SequenceResult } from "@/server/cores/items.server";

/** `item.create`. Keys: graph. */
export const createItem = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(CreateItemInput))
	.handler(proposable.run("item.create"));

/** `item.update`. Keys: graph (+ mention). */
export const updateItem = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(UpdateItemInput))
	.handler(proposable.run("item.update"));

/** `item.move`: `dayId: null` unschedules it. Flight blocks move as one (§7.9). Keys: graph. */
export const moveItem = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(MoveItemInput))
	.handler(proposable.run("item.move"));

/** `item.delete`: the whole block for flight items. Keys: graph, counts. */
export const deleteItem = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(DeleteItemInput))
	.handler(proposable.run("item.delete"));

/** Undo of `deleteItem` (edit-only, never a proposal). Keys: graph, counts. */
export const restoreItem = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(RestoreItemInput)
	.handler(async ({ data, context }): Promise<SequenceResult> => {
		const tripId =
			(await tripOf("items", data.itemId, { includeDeleted: true })) ??
			fail("NOT_FOUND");
		const access = await requireEditOnly("restoreItem", tripId, context.user);
		return withTripTx(
			tripId,
			(tx, out) =>
				restoreItemCore(tx, out, data, {
					access,
					user: context.user,
					actor: actorOf(context.user),
					inputRedacted: false,
					dryRun: false,
				}),
			mutationMeta(access, context.user),
		);
	});

/** `item.assignees`: members of this trip only (never guests). Keys: graph. */
export const setItemAssignees = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SetItemAssigneesInput))
	.handler(proposable.run("item.assignees"));

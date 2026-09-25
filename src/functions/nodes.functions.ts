/**
 * The place hierarchy (SPEC §7.1–§7.4, §13.1). Each proposable function is a
 * literal `createServerFn` whose handler is the gate (EXTENSIONS §3.4); the
 * inputs and DB-only cores live in `src/server/cores/nodes.server.ts`.
 * Results are `R | Proposed` (`isProposed` from `@/lib/schemas/proposals`).
 */
import { createServerFn } from "@tanstack/react-start";
import { withNamedUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import {
	CreateNodeInput,
	CreateNodePathInput,
	DeleteNodeInput,
	MoveNodeInput,
	RestoreNodeInput,
	restoreNodeCore,
	SetNodePriorityInput,
	UpdateNodeInput,
} from "@/server/cores/nodes.server";
import { tripOf } from "@/server/perms.server";
import {
	proposable,
	requireEditOnly,
} from "@/server/proposals/proposable.server";
import { actorOf } from "@/server/proposals/types";
import { mutationMeta, withTripTx } from "@/server/tx.server";

/** `node.create`. Keys: graph. */
export const createNode = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(CreateNodeInput))
	.handler(proposable.run("node.create"));

/** `node.createPath`: the missing ancestors, then the leaf, atomically (the places filing chip). Keys: graph. */
export const createNodePath = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(CreateNodePathInput))
	.handler(proposable.run("node.createPath"));

/** `node.update`: re-slugs on rename; sets tz on relocate. Keys: graph. */
export const updateNode = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(UpdateNodeInput))
	.handler(proposable.run("node.update"));

/** `node.move`: re-parent and/or reorder. Keys: graph. */
export const moveNode = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(MoveNodeInput))
	.handler(proposable.run("node.move"));

/** `node.delete`: soft-deletes the subtree and its items (undo with restoreNode). Keys: graph, counts. */
export const deleteNode = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(DeleteNodeInput))
	.handler(proposable.run("node.delete"));

/** Undo of `deleteNode` (edit-only, never a proposal). Keys: graph, counts. */
export const restoreNode = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(RestoreNodeInput)
	.handler(async ({ data, context }): Promise<{ slug: string }> => {
		const tripId =
			(await tripOf("nodes", data.nodeId, { includeDeleted: true })) ??
			fail("NOT_FOUND");
		const access = await requireEditOnly("restoreNode", tripId, context.user);
		return withTripTx(
			tripId,
			(tx, out) =>
				restoreNodeCore(tx, out, data, {
					access,
					user: context.user,
					actor: actorOf(context.user),
					inputRedacted: false,
					dryRun: false,
				}),
			mutationMeta(access, context.user),
		);
	});

/** `node.priority`: a member's priority for a node (null clears it; own priority is direct for suggesters). Keys: graph. */
export const setNodePriority = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SetNodePriorityInput))
	.handler(proposable.run("node.priority"));

/**
 * Trash in the app (`./server/trash.server.ts`), the caller's own uploads only:
 * list, Restore (and its Undo), Delete forever, Empty trash.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { withAccount } from "@/server/authz/middleware";
import {
	deleteForever,
	emptyTrash,
	listTrash,
	restoreTrash,
	retrash,
} from "./server/trash.server";
import type { Restored, TrashItem } from "./types";

const Ids = z
	.object({ ids: z.array(z.string().max(40)).min(1).max(500) })
	.strict();

export const listTrashItems = createServerFn({ method: "GET" })
	.middleware([withAccount])
	.handler(
		async ({ context }): Promise<TrashItem[]> => listTrash(context.user.id),
	);

export const restoreTrashItems = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(Ids)
	.handler(
		async ({ data, context }): Promise<Restored[]> =>
			restoreTrash(context.user, data.ids),
	);

/** Undo of Restore. */
export const retrashItems = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		z
			.object({
				items: z
					.array(
						z
							.object({ id: z.string().max(40), trashedAt: z.number() })
							.strict(),
					)
					.min(1)
					.max(500),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		await retrash(context.user, data.items);
		return { ok: true };
	});

export const deleteTrashItems = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(Ids)
	.handler(
		async ({ data, context }): Promise<{ count: number }> => ({
			count: await deleteForever(context.user.id, data.ids),
		}),
	);

export const emptyTrashItems = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.handler(
		async ({ context }): Promise<{ count: number }> => ({
			count: await emptyTrash(context.user.id),
		}),
	);

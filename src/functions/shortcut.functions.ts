/**
 * The iPhone Shortcut "Save to Yonder" in the app (src/server/shortcut.server.ts):
 *
 * - `getShortcutSetup`: the Shortcut's iCloud link (null = not offered on
 *   this server) and the caller's connected phones.
 * - `startShortcutPairing`: a one-time setup code for the clipboard (5 minutes).
 * - `removeShortcutDevice`: disconnects a phone (its key stops working).
 * - `takeShortcutShares`: the links the Shortcut sent, handed over once.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "@/db/db.server";
import { SHORTCUT_PAIR } from "@/server/auth/shortcut-key";
import { withAccount } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { rateLimitPer } from "@/server/cache.server";
import { getEnv } from "@/server/env.server";
import {
	listDevices,
	newPairingCode,
	removeDevice,
	type ShortcutDevice,
	type TakenShare,
	takeShares,
} from "@/server/shortcut.server";

export type { ShortcutDevice, TakenShare };

export const getShortcutSetup = createServerFn({ method: "GET" })
	.middleware([withAccount])
	.handler(
		async ({
			context,
		}): Promise<{ icloudUrl: string | null; devices: ShortcutDevice[] }> => ({
			icloudUrl: getEnv().SHORTCUT_ICLOUD_URL ?? null,
			devices: await listDevices(db, context.user.id),
		}),
	);

export const startShortcutPairing = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.handler(
		async ({ context }): Promise<{ code: string; expiresAt: number }> => {
			await rateLimitPer(`shortcut-code:${context.user.id}`, 10, 600);
			return {
				code: await newPairingCode(db, context.user.id),
				expiresAt: Date.now() + SHORTCUT_PAIR.seconds * 1000,
			};
		},
	);

export const removeShortcutDevice = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(z.object({ id: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		if (!(await removeDevice(db, context.user.id, data.id)))
			return fail("NOT_FOUND");
		return { ok: true };
	});

export const takeShortcutShares = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.handler(
		async ({
			context,
		}): Promise<{ shares: TakenShare[]; connected: string | null }> =>
			takeShares(db, context.user.id),
	);

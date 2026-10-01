import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { db } from "@/db/db.server";
import { authEnv } from "@/server/auth/env.server";
import {
	clientIp,
	pair,
	shortcutReply,
	smallJson,
} from "@/server/shortcut.server";
import { shortcutOverLimit } from "@/server/shortcut-limits.server";

/**
 * `POST /api/shortcut/pair` (the Shortcut's setup run): `{ code, name? }` →
 * `{ ok, key }`. The code is the one-time `yonder-pair:…` the app copied;
 * `name` is the phone's name. 10 tries per 10 minutes per IP.
 */
const Body = z.object({
	code: z.string().max(100),
	name: z.string().max(200).optional(),
});

export const Route = createFileRoute("/api/shortcut/pair")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const ip = clientIp(request, authEnv().ipAddressHeaders);
				if (await shortcutOverLimit(`pair:${ip}`, 10, 600))
					return shortcutReply(429, {
						ok: false,
						message: "Too many tries. Wait a few minutes, then run it again.",
					});
				const body = Body.safeParse(await smallJson(request));
				const result = body.success
					? await pair(db, body.data.code.trim(), body.data.name)
					: ({ ok: false, reason: "code" } as const);
				if (result.ok) return shortcutReply(200, { ok: true, key: result.key });
				return shortcutReply(400, {
					ok: false,
					message:
						result.reason === "devices"
							? "This account has 10 phones connected. Remove one in Yonder (Save from other apps), then try again."
							: "The setup code ran out or was already used. In Yonder, open Save from other apps, tap Copy setup code, then run Save to Yonder again.",
				});
			},
		},
	},
});

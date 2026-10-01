import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { db } from "@/db/db.server";
import { authEnv } from "@/server/auth/env.server";
import {
	checkKey,
	clientIp,
	SHORTCUT,
	saveShare,
	shareInput,
	shortcutReply,
	smallJson,
} from "@/server/shortcut.server";
import { shortcutOverLimit } from "@/server/shortcut-limits.server";

/**
 * `POST /api/shortcut/save` (every share): `X-Api-Key: ysk_…` and
 * `{ input }`, what was shared (a link, or text with a link in it). Stores it
 * for the key's owner; the app picks it up when it opens. Cookies are never
 * read here, and no CORS headers are sent, so a web page can't call it.
 * Unknown keys: 30 per minute per IP. Saves: 60 an hour per phone (the key's
 * own limit).
 */
const Body = z.object({ input: z.string().max(SHORTCUT.textMax * 2) });

export const Route = createFileRoute("/api/shortcut/save")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const devKey = request.headers.get("x-api-key")?.trim() ?? "";
				const checked = devKey
					? await checkKey(devKey)
					: ({ ok: false, reason: "key" } as const);
				if (!checked.ok && checked.reason === "limit")
					return shortcutReply(429, {
						ok: false,
						message: "That's a lot of saves. Try again in a little while.",
					});
				if (!checked.ok) {
					const ip = clientIp(request, authEnv().ipAddressHeaders);
					const over = await shortcutOverLimit(`badkey:${ip}`, 30, 60);
					return shortcutReply(over ? 429 : 401, {
						ok: false,
						reconnect: !over,
						message:
							"This phone isn't connected to Yonder. In Yonder, open Save from other apps, tap Copy setup code, then run Save to Yonder once.",
					});
				}
				const body = Body.safeParse(await smallJson(request));
				const share = body.success ? shareInput(body.data.input) : null;
				if (!share || (!share.url && !share.text))
					return shortcutReply(400, {
						ok: false,
						message:
							"There was nothing to save. Share a link to Save to Yonder.",
					});
				await saveShare(db, checked.device, share);
				return shortcutReply(200, { ok: true });
			},
		},
	},
});

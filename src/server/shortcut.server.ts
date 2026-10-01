/**
 * The iPhone Shortcut "Save to Yonder" (owner, 2026-10-01). iOS can't hand a
 * link to a home-screen web app, so the Shortcut sends it here with its own
 * key, then opens the app (`webapp://<host>`), which picks it up
 * (`takeShares`) and opens the save screen.
 *
 * Both secrets are Better Auth API keys (`@better-auth/api-key`, configured in
 * auth/options.server.ts, `SHORTCUT_KEY` / `SHORTCUT_PAIR`): stored hashed,
 * never a session, and made, checked and removed only here (their HTTP
 * endpoints are disabled).
 *
 * - Setup code (`yonder-pair_…`): the app copies it; the person runs the
 *   Shortcut once, which trades it (`pair`) for a phone key. One use, 5
 *   minutes, only "shortcut: pair".
 * - Phone key (`ysk_…`): kept by the Shortcut in iCloud Drive. Only
 *   "shortcut: save" (a link into its owner's `shortcut_shares`), 60 an hour.
 *   Removable in the app; deleting the account removes it.
 *
 * Limits: 10 phones per account (a phone connecting again under the same
 * name replaces its key), 50 pending links, links expire after 7 days.
 */
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbOrTx } from "@/db/db.server";
import { firstUrl } from "@/features/home/share-classify";
import { SHORTCUT_KEY, SHORTCUT_PAIR } from "@/server/auth/shortcut-key";
import { auth } from "@/server/auth.server";
import { key, redis } from "@/server/live/redis.server";

type Exec = Pick<DbOrTx, "execute">;

export const SHORTCUT = {
	maxDevices: 10,
	maxPending: 50,
	shareTtlDays: 7,
	textMax: 2000,
	labelMax: 60,
} as const;

/** "Shortcut connected" waits here (a day) for the app to say it. */
const connectedKey = (userId: string) => key("shortcut-connected", userId);

/** A new one-time setup code for `userId`; older unused codes are dropped. */
export async function newPairingCode(
	db: Exec,
	userId: string,
): Promise<string> {
	await db.execute(sql`
		delete from apikey where reference_id = ${userId} and config_id = ${SHORTCUT_PAIR.config}`);
	const created = await auth.api.createApiKey({
		body: {
			configId: SHORTCUT_PAIR.config,
			userId,
			name: "Setup code",
			expiresIn: SHORTCUT_PAIR.seconds,
			remaining: 1,
			permissions: { shortcut: [...SHORTCUT_PAIR.permissions.shortcut] },
		},
	});
	return created.key;
}

export type PairResult =
	| { ok: true; key: string }
	| { ok: false; reason: "code" | "devices" };

/** Trades a setup code (once) for a new phone key. */
export async function pair(
	db: Exec,
	code: string,
	label: string | undefined,
): Promise<PairResult> {
	if (!code.startsWith(SHORTCUT_PAIR.prefix) || code.length > 200)
		return { ok: false, reason: "code" };
	const checked = await auth.api.verifyApiKey({
		body: {
			configId: SHORTCUT_PAIR.config,
			key: code,
			permissions: { shortcut: ["pair"] },
		},
	});
	if (!checked.valid || !checked.key) return { ok: false, reason: "code" };
	const userId = checked.key.referenceId;
	await db.execute(sql`delete from apikey where id = ${checked.key.id}`);
	const name =
		label?.replace(/\s+/g, " ").trim().slice(0, SHORTCUT.labelMax) ||
		"iPhone Shortcut";
	// The same phone connecting again replaces its old key (one row per phone).
	await db.execute(sql`
		delete from apikey
		 where reference_id = ${userId} and config_id = ${SHORTCUT_KEY.config} and name = ${name}`);
	const count = await db.execute(sql`
		select count(*)::int as n from apikey
		 where reference_id = ${userId} and config_id = ${SHORTCUT_KEY.config}`);
	if ((count.rows[0] as { n: number }).n >= SHORTCUT.maxDevices)
		return { ok: false, reason: "devices" };
	const created = await auth.api.createApiKey({
		body: {
			configId: SHORTCUT_KEY.config,
			userId,
			name,
			permissions: { shortcut: [...SHORTCUT_KEY.permissions.shortcut] },
		},
	});
	await redis().set(connectedKey(userId), name, "EX", 86_400);
	return { ok: true, key: created.key };
}

export type KeyCheck =
	| { ok: true; device: { id: string; userId: string } }
	| { ok: false; reason: "key" | "limit" };

/** The phone a key belongs to, if it may save now (counts one use). */
export async function checkKey(devKey: string): Promise<KeyCheck> {
	if (!devKey.startsWith(SHORTCUT_KEY.prefix) || devKey.length > 200)
		return { ok: false, reason: "key" };
	const checked = await auth.api.verifyApiKey({
		body: {
			configId: SHORTCUT_KEY.config,
			key: devKey,
			permissions: { shortcut: ["save"] },
		},
	});
	if (checked.valid && checked.key)
		return {
			ok: true,
			device: { id: checked.key.id, userId: checked.key.referenceId },
		};
	return {
		ok: false,
		reason: checked.error?.code === "RATE_LIMITED" ? "limit" : "key",
	};
}

/** Splits what the Shortcut sent into a link and the words around it. */
export function shareInput(input: string): {
	url: string | null;
	text: string | null;
} {
	const s = input.trim().slice(0, SHORTCUT.textMax * 2);
	let url = firstUrl(s);
	if (url) {
		try {
			const u = new URL(url);
			url =
				(u.protocol === "https:" || u.protocol === "http:") &&
				url.length <= SHORTCUT.textMax
					? u.toString()
					: null;
		} catch {
			url = null;
		}
	}
	// The words around the link name the idea; stray punctuation goes.
	const rest = (url ? s.replace(firstUrl(s) ?? "", " ") : s)
		.replace(/\s+([.,;:!?]+)(?=\s|$)/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return {
		url,
		text: /[\p{L}\p{N}]/u.test(rest) ? rest.slice(0, SHORTCUT.textMax) : null,
	};
}

/** Stores a link for the device's owner (oldest dropped past the cap). */
export async function saveShare(
	db: Exec,
	device: { id: string; userId: string },
	share: { url: string | null; text: string | null },
): Promise<void> {
	await db.execute(sql`
		insert into shortcut_shares (id, user_id, device_id, url, text)
		values (${uuidv7()}, ${device.userId}, ${device.id}, ${share.url}, ${share.text})`);
	await db.execute(sql`
		delete from shortcut_shares
		 where user_id = ${device.userId}
		   and (created_at < now() - make_interval(days => ${SHORTCUT.shareTtlDays})
		        or id not in (select id from shortcut_shares where user_id = ${device.userId}
		                       order by created_at desc limit ${SHORTCUT.maxPending}))`);
}

export type TakenShare = {
	id: string;
	url: string | null;
	text: string | null;
	createdAt: number;
};

/**
 * Hands the account's pending links to the app and deletes them here, plus
 * the name of a phone connected since the app last looked ("Shortcut
 * connected"), once.
 */
export async function takeShares(
	db: Exec,
	userId: string,
): Promise<{ shares: TakenShare[]; connected: string | null }> {
	const taken = await db.execute(sql`
		delete from shortcut_shares
		 where user_id = ${userId}
		   and created_at >= now() - make_interval(days => ${SHORTCUT.shareTtlDays})
		returning id::text as id, url, text, created_at as "createdAt"`);
	await db.execute(sql`delete from shortcut_shares where user_id = ${userId}`);
	const connected = await redis().getdel(connectedKey(userId));
	const shares = (
		taken.rows as {
			id: string;
			url: string | null;
			text: string | null;
			createdAt: Date | string;
		}[]
	)
		.map((r) => ({
			id: r.id,
			url: r.url,
			text: r.text,
			createdAt: new Date(r.createdAt).getTime(),
		}))
		.sort((a, b) => a.createdAt - b.createdAt);
	return { shares, connected };
}

export type ShortcutDevice = {
	id: string;
	label: string;
	createdAt: string;
	lastUsedAt: string | null;
};

export async function listDevices(
	db: Exec,
	userId: string,
): Promise<ShortcutDevice[]> {
	const res = await db.execute(sql`
		select id, name as label, created_at as "createdAt", last_request as "lastUsedAt"
		  from apikey where reference_id = ${userId} and config_id = ${SHORTCUT_KEY.config}
		 order by created_at`);
	return (
		res.rows as {
			id: string;
			label: string | null;
			createdAt: Date | string;
			lastUsedAt: Date | string | null;
		}[]
	).map((r) => ({
		id: r.id,
		label: r.label ?? "iPhone Shortcut",
		createdAt: new Date(r.createdAt).toISOString(),
		lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
	}));
}

/** Removes one of the caller's devices (its key stops working at once). */
export async function removeDevice(
	db: Exec,
	userId: string,
	deviceId: string,
): Promise<boolean> {
	const res = await db.execute(sql`
		delete from apikey
		 where id = ${deviceId} and reference_id = ${userId} and config_id = ${SHORTCUT_KEY.config}
		returning id`);
	return res.rows.length > 0;
}

/** The caller's IP, from the headers the deployment trusts (like Better Auth's limiter). */
export function clientIp(request: Request, headers: string[]): string {
	for (const h of headers) {
		const v = request.headers.get(h)?.split(",")[0]?.trim();
		if (v) return v;
	}
	return "unknown";
}

/** Reads a small JSON body (at most 16 KB), or null. */
export async function smallJson(request: Request): Promise<unknown> {
	const len = Number(request.headers.get("content-length") ?? 0);
	if (len > 16_384) return null;
	const raw = await request.text();
	if (raw.length > 16_384) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** A JSON answer the Shortcut can show: `message` is what it puts in its alert. */
export function shortcutReply(
	status: number,
	body: { ok: boolean; message?: string; key?: string },
): Response {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

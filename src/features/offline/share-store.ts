/**
 * E8 Share to Yonder (EXTENSIONS §10): the on-device inbox of things shared
 * into the app. The service worker (`src/sw.ts`) receives the share-target
 * POST, stores one entry here and redirects to `/share?id=`; `ShareInbox`
 * reads it, saves it to a trip and deletes it. Nothing is queued to the
 * server. Entries expire after 7 days; sign-out clears the store.
 *
 * Isomorphic between the page and the service worker (no DOM-only APIs).
 */
import { createStore, del, entries, get, set } from "idb-keyval";

export const SHARE_DB = "yonder-share";
export const SHARE_STORE = "inbox";
export const SHARE_TTL_MS = 7 * 24 * 3_600_000;

/** EXTENSIONS §10 caps: 10 files, text and title ≤ 2,000, http(s) URLs only. */
export const SHARE_LIMITS = {
	files: 10,
	text: 2000,
	fileBytes: 1024 * 1024 * 1024,
} as const;

export const SHARE_FILE_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/avif",
	"video/mp4",
	"video/quicktime",
	"video/webm",
] as const;

export type SharedFile = {
	name: string;
	type: string;
	size: number;
	blob: Blob;
};

export type SharedEntry = {
	id: string;
	createdAt: number;
	title: string | null;
	text: string | null;
	url: string | null;
	files: SharedFile[];
};

let store: ReturnType<typeof createStore> | null = null;
function shareStore() {
	store ??= createStore(SHARE_DB, SHARE_STORE);
	return store;
}

/** Trims to the caps; keeps only http(s) URLs and allowed file types. */
export function sanitizeShared(
	input: {
		title?: unknown;
		text?: unknown;
		url?: unknown;
		files?: SharedFile[];
	},
	id: string,
	now = Date.now(),
): SharedEntry {
	const str = (v: unknown) =>
		typeof v === "string" && v.trim()
			? v.trim().slice(0, SHARE_LIMITS.text)
			: null;
	let url = str(input.url);
	if (url) {
		try {
			const u = new URL(url);
			url =
				u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
		} catch {
			url = null;
		}
	}
	const files = (input.files ?? [])
		.filter(
			(f) =>
				(SHARE_FILE_TYPES as readonly string[]).includes(f.type) &&
				f.size > 0 &&
				f.size <= SHARE_LIMITS.fileBytes,
		)
		.slice(0, SHARE_LIMITS.files);
	return {
		id,
		createdAt: now,
		title: str(input.title),
		text: str(input.text),
		url,
		files,
	};
}

export async function putShared(entry: SharedEntry): Promise<void> {
	await set(entry.id, entry, shareStore());
}

export async function getShared(id: string): Promise<SharedEntry | null> {
	const e = (await get(id, shareStore())) as SharedEntry | undefined;
	if (!e) return null;
	if (Date.now() - e.createdAt > SHARE_TTL_MS) {
		await del(id, shareStore());
		return null;
	}
	return e;
}

export async function deleteShared(id: string): Promise<void> {
	await del(id, shareStore());
}

/** Live entries, newest first (expired ones are dropped on the way). */
export async function listShared(): Promise<SharedEntry[]> {
	try {
		const all = (await entries(shareStore())) as [string, SharedEntry][];
		const now = Date.now();
		const live: SharedEntry[] = [];
		for (const [k, e] of all) {
			if (!e || now - e.createdAt > SHARE_TTL_MS) await del(k, shareStore());
			else live.push(e);
		}
		return live.sort((a, b) => b.createdAt - a.createdAt);
	} catch {
		return [];
	}
}

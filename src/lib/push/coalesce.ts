/**
 * Coalescing (pure logic over a small store): events of one group for the
 * same person and trip within a window become one notification. The first
 * event opens the window and schedules one flush at its end; everything
 * that arrives before the flush rides along ("Maya made 5 suggestions").
 *
 * Event groups wait ~2 minutes (which also gives the in-app inbox a chance:
 * what the person reads meanwhile is not pushed). Reminders fire at their
 * instant; their short window only merges ones due together ("3 booking
 * windows opening soon").
 *
 * The worker's store is Redis (`src/server/push/coalesce.server.ts`); tests
 * use `MemoryCoalesceStore`.
 */
import { isReminderGroup, type PushGroup, type PushItem } from "./types";

export const EVENT_WINDOW_MS = 120_000;
export const REMINDER_WINDOW_MS = 10_000;

export function coalesceWindowMs(group: PushGroup): number {
	return isReminderGroup(group) ? REMINDER_WINDOW_MS : EVENT_WINDOW_MS;
}

export type CoalesceTarget = {
	userId: string;
	tripId: string;
	group: PushGroup;
};

export interface CoalesceStore {
	/**
	 * Adds an entry under `key`; true when it opened a new window (nothing
	 * was pending), so the caller schedules the flush.
	 */
	append(key: string, entry: string, windowMs: number): Promise<boolean>;
	/** Takes (and clears) everything buffered under `key`, oldest first. */
	take(key: string): Promise<string[]>;
}

export function coalesceKey(t: CoalesceTarget): string {
	return `${t.userId}|${t.tripId}|${t.group}`;
}

/**
 * Buffers one item; when it opens a window, `schedule(delayMs)` must arrange
 * the flush (the worker enqueues a delayed `push.flush`).
 */
export async function bufferItem(
	store: CoalesceStore,
	target: CoalesceTarget,
	item: PushItem,
	schedule: (delayMs: number) => Promise<unknown>,
): Promise<boolean> {
	const windowMs = coalesceWindowMs(target.group);
	const opened = await store.append(
		coalesceKey(target),
		JSON.stringify(item),
		windowMs,
	);
	if (opened) await schedule(windowMs);
	return opened;
}

function isItem(v: unknown): v is PushItem {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.key === "string" &&
		typeof o.at === "number" &&
		typeof o.headline === "string" &&
		typeof o.url === "string"
	);
}

/** The window's items, oldest first; one per key (the newest wins). */
export async function takeItems(
	store: CoalesceStore,
	target: CoalesceTarget,
): Promise<PushItem[]> {
	const raw = await store.take(coalesceKey(target));
	const byKey = new Map<string, PushItem>();
	for (const r of raw) {
		let v: unknown;
		try {
			v = JSON.parse(r);
		} catch {
			continue;
		}
		if (!isItem(v)) continue;
		const prev = byKey.get(v.key);
		if (!prev || prev.at <= v.at) byKey.set(v.key, v);
	}
	return [...byKey.values()].sort((a, b) => a.at - b.at);
}

/** In-memory store (tests, and a process without Redis). */
export class MemoryCoalesceStore implements CoalesceStore {
	private readonly lists = new Map<string, string[]>();

	async append(key: string, entry: string, _windowMs = 0): Promise<boolean> {
		const list = this.lists.get(key);
		if (list) {
			list.push(entry);
			return false;
		}
		this.lists.set(key, [entry]);
		return true;
	}

	async take(key: string): Promise<string[]> {
		const list = this.lists.get(key) ?? [];
		this.lists.delete(key);
		return list;
	}
}

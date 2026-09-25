import { CLOSE_LIMIT } from "@/lib/realtime/protocol";

/**
 * Abuse caps for the collab socket (SECURITY §3 "Caps", §4, §10 table):
 * - one WebSocket frame ≤ MAX_MESSAGE_BYTES (enforced by `ws` via `maxPayload`);
 * - per document connection: ≤ MAX_MESSAGES and ≤ MAX_BYTES per WINDOW_MS
 *   (typing produces one small update per keystroke; this leaves ample room);
 * - a note document stops accepting writes once it grows past MAX_DOC_BYTES;
 * - one user holds at most MAX_DOCS_PER_USER open documents on this instance
 *   (all tabs together; SECURITY §10 "WS connections per principal").
 * Exceeding a cap closes that document connection with reason `limit-exceeded`.
 */
export const LIMITS = {
	MAX_MESSAGE_BYTES: 2 * 1024 * 1024,
	WINDOW_MS: 10_000,
	MAX_MESSAGES: 400,
	MAX_BYTES: 6 * 1024 * 1024,
	MAX_DOC_BYTES: 8 * 1024 * 1024,
	MAX_DOCS_PER_USER: 200,
} as const;

export type Limits = { [K in keyof typeof LIMITS]: number };

export class LimitError extends Error {
	readonly reason = CLOSE_LIMIT;
	readonly code = 4429;
	constructor(detail: string) {
		super(`limit exceeded: ${detail}`);
		this.name = "LimitError";
	}
}

type Window = { start: number; messages: number; bytes: number };

/** Fixed-window counters keyed by any object (one per Hocuspocus Connection). */
export class RateLimiter<K extends object> {
	private readonly windows = new WeakMap<K, Window>();

	constructor(
		private readonly limits: Pick<
			Limits,
			"WINDOW_MS" | "MAX_MESSAGES" | "MAX_BYTES"
		> = LIMITS,
		private readonly now: () => number = Date.now,
	) {}

	/** Counts one message; throws LimitError when the window's budget is exceeded. */
	hit(k: K, bytes: number): void {
		const t = this.now();
		let w = this.windows.get(k);
		if (!w || t - w.start >= this.limits.WINDOW_MS) {
			w = { start: t, messages: 0, bytes: 0 };
			this.windows.set(k, w);
		}
		w.messages += 1;
		w.bytes += bytes;
		if (w.messages > this.limits.MAX_MESSAGES)
			throw new LimitError("too many messages");
		if (w.bytes > this.limits.MAX_BYTES) throw new LimitError("too many bytes");
	}
}

/**
 * Approximate encoded size per document: the stored state size (exact, refreshed
 * on every store) plus the updates applied since. Deletions only shrink it at the
 * next store, so it errs on the large side.
 */
export class DocSizes<K extends object> {
	private readonly sizes = new WeakMap<K, number>();
	constructor(private readonly max: number = LIMITS.MAX_DOC_BYTES) {}
	set(k: K, bytes: number): void {
		this.sizes.set(k, bytes);
	}
	add(k: K, bytes: number): void {
		this.sizes.set(k, (this.sizes.get(k) ?? 0) + bytes);
	}
	get(k: K): number {
		return this.sizes.get(k) ?? 0;
	}
	isOversized(k: K): boolean {
		return this.get(k) > this.max;
	}
}

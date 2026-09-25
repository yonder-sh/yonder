import {
	HocuspocusProvider,
	HocuspocusProviderWebsocket,
	WebSocketStatus,
} from "@hocuspocus/provider";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { AUTH_FAILURE, COOKIE_TOKEN } from "./protocol";

/**
 * The browser's ONE collab WebSocket and the documents multiplexed on it
 * (SPEC §10.3 "collab-client.ts"; spikes/collab gotchas 3, 6, 12).
 *
 * - `acquire(name)` returns a lease on a document: the Y.Doc, its provider and a
 *   small status store. Leases are ref-counted; the provider is destroyed a moment
 *   after the last lease is released (so React StrictMode and quick route hops
 *   don't churn documents).
 * - Authentication uses the session cookie of the same-origin upgrade: providers
 *   send the `'cookie'` placeholder token (a function can supply a bearer token
 *   instead, for Node clients and tests).
 * - When the server closes ONE document (an `access` event, a limit), the provider
 *   re-authenticates on the still-open socket, so a removed member gets
 *   `authenticationFailed` within a second and a downgraded editor comes back
 *   read-only. A retryable refusal (`server-unavailable`) is retried with backoff.
 *
 * Framework-free (usable from Node); the React hooks wrap it.
 */

export type DocStatus = "connecting" | "authenticated" | "denied";

export type DocSnapshot = {
	status: DocStatus;
	/** The first sync with the server finished (content is there). */
	synced: boolean;
	/** The server accepts no writes from us (viewer, or the channel doc). */
	readOnly: boolean;
	/** Why authentication failed (`AUTH_FAILURE` values), else null. */
	reason: string | null;
};

export type SocketSnapshot = {
	status: "connecting" | "connected" | "disconnected";
	/** Has the socket ever been open (distinguishes "connecting" from "reconnecting"). */
	everConnected: boolean;
	/** `Date.now()` since when the socket has not been open; null while connected. */
	downSince: number | null;
};

export type CollabClientOptions = {
	/** `ws(s)://…`; defaults to VITE_COLLAB_URL or same-origin `/collab`. */
	url?: string;
	/** Token per document; default `'cookie'` (the session cookie authenticates). */
	token?: string | ((documentName: string) => string | Promise<string>);
	/** A WebSocket implementation for Node (tests). */
	WebSocketPolyfill?: unknown;
	/** Keep a released document this long before destroying it. Default 1500 ms. */
	lingerMs?: number;
};

type Listener = () => void;

class SnapshotStore<T extends object> {
	private listeners = new Set<Listener>();
	constructor(private value: T) {}
	get = (): T => this.value;
	set(patch: Partial<T>) {
		const next = { ...this.value, ...patch };
		if (
			Object.keys(next).every(
				(k) => next[k as keyof T] === this.value[k as keyof T],
			)
		)
			return;
		this.value = next;
		for (const l of [...this.listeners]) l();
	}
	subscribe = (l: Listener): (() => void) => {
		this.listeners.add(l);
		return () => {
			this.listeners.delete(l);
		};
	};
}

/** A lease on one collab document. Call `release()` exactly once when done. */
export type DocLease = {
	readonly name: string;
	readonly doc: Y.Doc;
	readonly provider: HocuspocusProvider;
	readonly awareness: Awareness | null;
	getSnapshot(): DocSnapshot;
	subscribe(listener: Listener): () => void;
	/** Stateless payloads from the server for this document. */
	onStateless(cb: (payload: string) => void): () => void;
	release(): void;
};

type Entry = {
	name: string;
	doc: Y.Doc;
	provider: HocuspocusProvider;
	store: SnapshotStore<DocSnapshot>;
	refs: number;
	linger?: ReturnType<typeof setTimeout>;
	reauth?: ReturnType<typeof setTimeout>;
	reauthAttempts: number;
};

/** VITE_COLLAB_URL, else same-origin `/collab` (Vite proxies it in dev, the ingress routes it in prod). */
export function defaultCollabUrl(): string {
	const configured = import.meta.env?.VITE_COLLAB_URL as string | undefined;
	if (configured) return configured;
	if (typeof window === "undefined") {
		throw new Error("defaultCollabUrl() needs a browser (pass `url` in Node)");
	}
	const { protocol, host } = window.location;
	return `${protocol === "https:" ? "wss" : "ws"}://${host}/collab`;
}

export class CollabClient {
	readonly socket: HocuspocusProviderWebsocket;
	private readonly entries = new Map<string, Entry>();
	private readonly socketStore: SnapshotStore<SocketSnapshot>;
	private readonly lingerMs: number;
	private destroyed = false;

	constructor(private readonly options: CollabClientOptions = {}) {
		this.lingerMs = options.lingerMs ?? 1_500;
		this.socketStore = new SnapshotStore<SocketSnapshot>({
			status: "connecting",
			everConnected: false,
			downSince: Date.now(),
		});
		this.socket = new HocuspocusProviderWebsocket({
			url: options.url ?? defaultCollabUrl(),
			...(options.WebSocketPolyfill
				? { WebSocketPolyfill: options.WebSocketPolyfill }
				: {}),
			// Retry forever with capped backoff; `offline` is derived from the timings.
			maxAttempts: 0,
			delay: 1_000,
			maxDelay: 15_000,
			onStatus: ({ status }) => {
				const s =
					status === WebSocketStatus.Connected
						? "connected"
						: status === WebSocketStatus.Connecting
							? "connecting"
							: "disconnected";
				const prev = this.socketStore.get();
				if (prev.status === s) return;
				this.socketStore.set({
					status: s,
					downSince: s === "connected" ? null : (prev.downSince ?? Date.now()),
					everConnected: prev.everConnected || s === "connected",
				});
				if (s !== "connected") {
					for (const e of this.entries.values()) {
						if (e.store.get().status !== "denied")
							e.store.set({ status: "connecting", synced: false });
					}
				}
			},
		});
	}

	getSocketSnapshot = (): SocketSnapshot => this.socketStore.get();
	subscribeSocket = (l: Listener): (() => void) =>
		this.socketStore.subscribe(l);

	/** A lease on `name` (see DocLease). Creates the provider on first use. */
	acquire(name: string, opts: { awareness?: boolean } = {}): DocLease {
		if (this.destroyed) throw new Error("CollabClient was destroyed");
		let entry = this.entries.get(name);
		if (entry) {
			if (entry.linger) {
				clearTimeout(entry.linger);
				entry.linger = undefined;
			}
		} else {
			entry = this.create(name, opts.awareness ?? true);
			this.entries.set(name, entry);
		}
		entry.refs += 1;
		const e = entry;
		let released = false;
		return {
			name,
			doc: e.doc,
			provider: e.provider,
			awareness: e.provider.awareness,
			getSnapshot: e.store.get,
			subscribe: e.store.subscribe,
			onStateless: (cb) => {
				const h = ({ payload }: { payload: string }) => cb(payload);
				e.provider.on("stateless", h);
				return () => {
					e.provider.off("stateless", h);
				};
			},
			release: () => {
				if (released) return;
				released = true;
				this.release(e);
			},
		};
	}

	private create(name: string, awareness: boolean): Entry {
		const doc = new Y.Doc();
		const { token } = this.options;
		const provider = new HocuspocusProvider({
			websocketProvider: this.socket,
			name,
			document: doc,
			...(awareness ? {} : { awareness: null }),
			token:
				typeof token === "function"
					? async () => token(name)
					: (token ?? COOKIE_TOKEN),
		});
		const entry: Entry = {
			name,
			doc,
			provider,
			store: new SnapshotStore<DocSnapshot>({
				status: "connecting",
				synced: false,
				readOnly: false,
				reason: null,
			}),
			refs: 0,
			reauthAttempts: 0,
		};
		provider.on("authenticated", ({ scope }: { scope: string }) => {
			entry.reauthAttempts = 0;
			entry.store.set({
				status: "authenticated",
				readOnly: scope === "readonly",
				reason: null,
			});
		});
		provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
			entry.store.set({ status: "denied", synced: false, reason });
			// Not an access decision: try again (backoff) on the same socket.
			if (reason === AUTH_FAILURE.unavailable) this.scheduleReauth(entry);
		});
		provider.on("synced", ({ state }: { state: boolean }) => {
			entry.store.set({ synced: state });
		});
		provider.on("close", () => {
			// With the socket still open, the SERVER closed just this document
			// (access change, limit): authenticate again. Socket-level closes are
			// handled by the provider itself when the socket reopens.
			if (this.socket.status === WebSocketStatus.Connected) {
				entry.store.set({ status: "connecting", synced: false });
				this.scheduleReauth(entry);
			}
		});
		provider.attach(); // required with a shared socket (spikes/collab gotcha 6)
		return entry;
	}

	private scheduleReauth(entry: Entry) {
		if (entry.reauth || this.destroyed || entry.refs === 0) return;
		const attempt = entry.reauthAttempts++;
		const delay = Math.min(200 * 2 ** attempt, 30_000);
		entry.reauth = setTimeout(() => {
			entry.reauth = undefined;
			const open = this.socket.receivedOnOpenPayload;
			if (
				!this.entries.has(entry.name) ||
				this.socket.status !== WebSocketStatus.Connected ||
				!open
			)
				return;
			// Re-sends the token and sync step 1 for this document only.
			void entry.provider.onOpen(open);
		}, delay);
	}

	private release(entry: Entry) {
		entry.refs -= 1;
		if (entry.refs > 0) return;
		entry.linger = setTimeout(() => {
			if (entry.refs > 0) return;
			this.dispose(entry);
		}, this.lingerMs);
	}

	private dispose(entry: Entry) {
		if (entry.linger) clearTimeout(entry.linger);
		if (entry.reauth) clearTimeout(entry.reauth);
		this.entries.delete(entry.name);
		entry.provider.destroy(); // detaches: the server closes this document connection
		entry.doc.destroy();
	}

	/** Names of the documents currently open (tests, debugging). */
	openDocuments(): string[] {
		return [...this.entries.keys()];
	}

	/**
	 * Re-opens the socket, keeping every document: the new upgrade request
	 * carries the CURRENT session cookie and each document authenticates again
	 * (after signing back in in place, QA ERR-07).
	 */
	reconnect() {
		if (this.destroyed) return;
		const socket = this.socket;
		if (socket.status === WebSocketStatus.Disconnected) {
			void socket.connect();
			return;
		}
		// `connect()` is a no-op until the old socket has actually closed.
		const reopen = () => {
			socket.off("disconnect", reopen);
			if (!this.destroyed) void socket.connect();
		};
		socket.on("disconnect", reopen);
		socket.disconnect();
	}

	/** Closes every document and the socket. The client is unusable afterwards. */
	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		for (const e of [...this.entries.values()]) this.dispose(e);
		this.socket.destroy();
	}
}

// ---------------------------------------------------------------------------
// The browser singleton
// ---------------------------------------------------------------------------

let browserClient: CollabClient | null = null;

/** The page's collab client (created on first use). Null during SSR. */
export function getCollabClient(): CollabClient | null {
	if (typeof window === "undefined") return null;
	browserClient ??= new CollabClient();
	return browserClient;
}

/**
 * Drops every provider and the socket. Call on sign-out and before signing in as
 * someone else (SECURITY §11): the next `getCollabClient()` opens a fresh socket
 * with the new session cookie.
 */
export function resetCollabClient(): void {
	browserClient?.destroy();
	browserClient = null;
	for (const l of [...resetListeners]) l();
}

/** Same account, new session (re-auth in place): reconnect with the new cookie. */
export function reconnectCollabClient(): void {
	browserClient?.reconnect();
}

const resetListeners = new Set<Listener>();
/** Notified after `resetCollabClient()` (hooks re-acquire from the new client). */
export function onCollabClientReset(l: Listener): () => void {
	resetListeners.add(l);
	return () => {
		resetListeners.delete(l);
	};
}

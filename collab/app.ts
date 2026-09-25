import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import {
	Connection,
	type Document,
	type Hocuspocus,
	Server,
} from "@hocuspocus/server";
import { Redis } from "ioredis";
import * as Y from "yjs";
import {
	AUTH_FAILURE,
	CLOSE_ACCESS_CHANGED,
	CLOSE_DOC_GONE,
	type DocRef,
	type HelloMessage,
	type NotesEvent,
	noteDocName,
	parseDocName,
} from "@/lib/realtime/protocol";
import {
	authorizeConnection,
	CollabAuthError,
	type CollabContext,
	loadTripAccess,
	mayOpen,
	readOnlyFor,
	type SessionLookup,
	sessionHeaders,
} from "./auth";
import { sanitizeAwarenessUpdateLive } from "./awareness";
import {
	CursorGuard,
	dbAnchorLookup,
	installGuestAwarenessFilter,
} from "./cursors";
import type { CollabDb } from "./db";
import {
	DocSizes,
	LIMITS,
	LimitError,
	type Limits,
	RateLimiter,
} from "./limits";
import {
	notesHooks as defaultNotesHooks,
	type NotesHooks,
} from "./notes-hooks";
import { createPersistence, fetchNoteState } from "./persistence";
import { type Relay, startRelay } from "./relay";

/**
 * The collab server (SPEC §10; ADDENDUM §2): Hocuspocus 4 with
 * - @hocuspocus/extension-redis, so several collab instances share documents and
 *   awareness (it runs first, then the Postgres persistence);
 * - Better Auth session + DB role check per document (`auth.ts`), read-only
 *   channel docs and viewers, an Origin check on the upgrade;
 * - the awareness sanitizer, per-connection rate caps and a document size cap;
 * - the Redis → channel-document relay for live trip events;
 * - a `hello` (current `trips.version` + the connection's role) for every client
 *   that joins a trip channel, so a reconnect refetches only when it missed events;
 * - access re-checks on OPEN connections (SECURITY §4 MUST): a writable
 *   connection re-validates its session and trip access at most every
 *   RECHECK_MS before a message is applied; a sweep every RECHECK_MS re-checks
 *   every connection whose check is older than that, read-only ones included
 *   (a link that expires or a session revoked in the DB sends no event, and a
 *   viewer never writes: QA SEC-R1-06); and every connection is re-checked
 *   after the relay re-subscribes (events published meanwhile are lost). A
 *   connection that lost access, or whose read-only mode changed, is closed
 *   with `access-changed`, so the provider re-authenticates. Revocation no
 *   longer depends only on the best-effort Redis `access` event.
 *
 * `startCollabServer` is the composition-free core (tests start it on port 0);
 * `collab/server.ts` wires it to the environment.
 */
export type CollabServerOptions = {
	port: number;
	host?: string;
	db: CollabDb;
	lookupSession: SessionLookup;
	originAllowed: (origin: string | null | undefined) => boolean;
	redis: {
		url: string;
		/** `key('trip', '*')` */
		tripPattern: string;
		/** `key('hp')`: namespace of @hocuspocus/extension-redis. */
		hocuspocusPrefix: string;
		/** Connection-name suffix (tests find the subscriber by it for CLIENT KILL). */
		name?: string;
	};
	notesHooks?: NotesHooks;
	/** onStoreDocument debounce; SPEC §10.6: 2000 / 10000. */
	debounce?: number;
	maxDebounce?: number;
	limits?: Partial<Limits>;
	/** Access re-check interval for every open connection (tests shorten it). */
	recheckMs?: number;
	quiet?: boolean;
	log?: (msg: string) => void;
	/**
	 * `GET /health` (Kubernetes probes): 200 when this resolves true, else
	 * 503. Default: always healthy. `/healthz` stays a plain liveness 200.
	 */
	health?: () => Promise<boolean>;
};

/** How long `/health` waits for its check before answering 503. */
export const HEALTH_TIMEOUT_MS = 2_000;

/**
 * How stale a connection's access check may be: before a writable
 * connection's next message, and for every connection at the periodic sweep.
 */
export const RECHECK_MS = 15_000;

/** Thrown from beforeHandleMessage: closes the connection with `access-changed` (4403). */
class AccessChangedError extends Error {
	readonly code = 4403;
	readonly reason = CLOSE_ACCESS_CHANGED;
	constructor() {
		super("access changed");
		this.name = "AccessChangedError";
	}
}

/** What a connection was admitted with, for re-checks. Keyed by its context. */
type Admission = {
	doc: DocRef;
	headers: Headers;
	readOnly: boolean;
	checkedAt: number;
};

export type CollabServer = {
	server: Server<CollabContext>;
	hocuspocus: Hocuspocus<CollabContext>;
	relay: Relay;
	port: number;
	/** `ws://host:port` */
	url: string;
	stop(): Promise<void>;
};

async function readVersion(
	db: CollabDb,
	tripId: string,
): Promise<number | null> {
	try {
		const { rows } = await db.pool.query<{ version: string | number }>(
			"select version from trips where id = $1",
			[tripId],
		);
		return rows[0] ? Number(rows[0].version) : null;
	} catch (e) {
		console.error(
			"[collab] reading trips.version failed:",
			e instanceof Error ? e.message : e,
		);
		return null;
	}
}

function rejectUpgrade(
	socket: { write(s: string): void; destroy(): void },
	status: string,
) {
	try {
		socket.write(
			`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
		);
	} finally {
		socket.destroy();
	}
}

export async function startCollabServer(
	opts: CollabServerOptions,
): Promise<CollabServer> {
	const log = opts.log ?? ((m: string) => console.log(`[collab] ${m}`));
	const limits: Limits = { ...LIMITS, ...opts.limits };
	const rate = new RateLimiter<object>(limits);
	const sizes = new DocSizes<Document>(limits.MAX_DOC_BYTES);
	/** Open document connections per user on this instance. */
	const openPerUser = new Map<string, number>();
	/** Keyed by `context.admissionKey` (Hocuspocus copies the context object). */
	const admissions = new Map<string, Admission>();
	const admissionOf = (ctx: CollabContext | undefined) =>
		ctx?.admissionKey ? admissions.get(ctx.admissionKey) : undefined;
	const recheckMs = opts.recheckMs ?? RECHECK_MS;
	// FB-17: live-cursor fields are validated, rate-limited and privacy-checked
	// inbound, and link guests never receive members-only anchors outbound.
	const cursorGuard = new CursorGuard({ lookup: dbAnchorLookup(opts.db.pool) });
	installGuestAwarenessFilter(
		Connection.prototype as unknown as Parameters<
			typeof installGuestAwarenessFilter
		>[0],
	);

	/**
	 * True while the connection may keep its current mode: same signed-in user,
	 * still has access, may still open the doc, and read-only hasn't changed.
	 * DB errors count as "still allowed" (a blip must not kick everyone); the
	 * next check retries.
	 */
	async function stillAllowed(
		context: CollabContext,
		adm: Admission,
	): Promise<boolean> {
		try {
			const user = await opts.lookupSession(adm.headers);
			if (!user || user.id !== context.userId) return false;
			const access = await loadTripAccess(
				opts.db.pool,
				context.tripId,
				user.id,
			);
			if (!access || !mayOpen(adm.doc, access, user.id)) return false;
			return readOnlyFor(adm.doc, access) === adm.readOnly;
		} catch (e) {
			console.error(
				"[collab] access re-check failed:",
				e instanceof Error ? e.message : e,
			);
			return true;
		}
	}

	/**
	 * Re-checks open connections: all of them (after a relay re-subscribe), or
	 * only those whose last check is at least `olderThanMs` old (the sweep).
	 */
	async function recheckAll(olderThanMs = 0): Promise<void> {
		const conns: {
			conn: { close(e?: { code: number; reason: string }): void };
			ctx: CollabContext;
			adm: Admission;
		}[] = [];
		for (const doc of hocuspocusRef?.documents.values() ?? []) {
			for (const conn of doc.getConnections()) {
				const ctx = conn.context as CollabContext | undefined;
				const adm = admissionOf(ctx);
				if (ctx && adm && Date.now() - adm.checkedAt >= olderThanMs)
					conns.push({ conn, ctx, adm });
			}
		}
		let closed = 0;
		for (const { conn, ctx, adm } of conns) {
			if (await stillAllowed(ctx, adm)) {
				adm.checkedAt = Date.now();
			} else {
				conn.close({ code: 4403, reason: CLOSE_ACCESS_CHANGED });
				closed += 1;
			}
		}
		if (closed)
			log(
				`re-check${olderThanMs ? "" : " after re-subscribe"} closed ${closed} connection(s)`,
			);
	}
	/**
	 * Note documents whose target was removed (QA P1: a deleted day): never
	 * stored again, so they unload once their editors are closed. Names embed
	 * the target's uuid and never come back; entries expire after a day.
	 */
	const goneDocs = new Map<string, number>();
	const isGone = (name: string) => {
		const at = goneDocs.get(name);
		if (at !== undefined && Date.now() - at > 86_400_000) goneDocs.delete(name);
		return goneDocs.has(name);
	};

	/** Applies `update` to `name`: the live document if loaded, else a direct connection (stored normally). */
	async function foldInto(name: string, update: Uint8Array): Promise<void> {
		const hp = hocuspocusRef;
		if (!hp) return;
		const live = hp.documents.get(name);
		if (live) {
			Y.applyUpdate(live, update);
			return;
		}
		// No user context: the store records no author (private notes log nothing).
		const dc = await hp.openDirectConnection(name, {} as CollabContext);
		try {
			await dc.transact((doc) => Y.applyUpdate(doc, update));
		} finally {
			await dc.disconnect();
		}
	}

	/**
	 * Retires the loaded note documents `gone` names (a name also covers its
	 * private variants `…/u/<user>`): a private one's unsaved text goes to its
	 * owner's private trip note, then its editors are closed with
	 * `doc-gone` (re-authenticating answers `gone`, so they stop taking
	 * typing) and it is never stored again. `refresh` names loaded documents
	 * whose stored state gained text server-side: they fold it in now, so an
	 * open editor shows it and never stores over it.
	 */
	async function retireNotes(gone: string[], refresh: string[]): Promise<void> {
		const hp = hocuspocusRef;
		if (!hp) return;
		const hit = (name: string) =>
			gone.some((g) => name === g || name.startsWith(`${g}/u/`));
		for (const [name, doc] of [...hp.documents]) {
			if (!hit(name) || isGone(name)) continue;
			goneDocs.set(name, Date.now());
			const ref = parseDocName(name);
			if (ref?.kind === "note" && ref.ownerUserId) {
				try {
					await foldInto(
						noteDocName(ref.tripId, { kind: "trip" }, ref.ownerUserId),
						Y.encodeStateAsUpdate(doc),
					);
				} catch (e) {
					console.error(
						`[collab] keeping ${name} failed:`,
						e instanceof Error ? e.message : e,
					);
				}
			}
			let closed = 0;
			for (const conn of doc.getConnections()) {
				conn.close({ code: 4404, reason: CLOSE_DOC_GONE });
				closed += 1;
			}
			log(`note ${name} is gone: closed ${closed} connection(s)`);
		}
		for (const name of refresh) {
			const doc = hp.documents.get(name);
			if (!doc) continue;
			try {
				const stored = await fetchNoteState(opts.db.pool, name);
				if (stored) Y.applyUpdate(doc, stored);
			} catch (e) {
				console.error(
					`[collab] refreshing ${name} failed:`,
					e instanceof Error ? e.message : e,
				);
			}
		}
	}
	const onNotes = (e: NotesEvent) =>
		retireNotes(
			[...e.gone, ...e.moved.map((m) => m.from)],
			[...new Set(e.moved.map((m) => m.to))],
		).catch((err: unknown) => console.error("[collab] notes event:", err));

	const connName = opts.redis.name ? `-${opts.redis.name}` : "";
	const identifier = `${hostname()}:${process.pid}${connName}`;

	let hocuspocusRef: Hocuspocus<CollabContext> | undefined;

	const server = new Server<CollabContext>({
		name: `yonder-collab${connName}`,
		port: opts.port,
		address: opts.host ?? "127.0.0.1",
		quiet: opts.quiet ?? true,
		stopOnSignals: false,
		debounce: opts.debounce ?? 2_000,
		maxDebounce: opts.maxDebounce ?? 10_000,
		websocketOptions: { maxPayload: limits.MAX_MESSAGE_BYTES },
		extensions: [
			new RedisExtension({
				identifier,
				prefix: opts.redis.hocuspocusPrefix,
				createClient: () =>
					new Redis(opts.redis.url, { connectionName: `yonder-hp${connName}` }),
			}),
			createPersistence({
				db: opts.db,
				hooks: opts.notesHooks ?? defaultNotesHooks,
				onStored: (name, bytes) => {
					const doc = hocuspocusRef?.documents.get(name);
					if (doc) sizes.set(doc, bytes);
				},
				isGone,
				// No `notes` event arrived (another instance's, or lost): same handling.
				onTargetGone: (name) => retireNotes([name], []),
			}),
		],

		async onUpgrade({ request, socket }) {
			const origin = request.headers.origin;
			if (!opts.originAllowed(origin)) {
				log(`refused an upgrade from origin ${origin}`);
				rejectUpgrade(socket, "403 Forbidden");
				// A falsy rejection stops Hocuspocus without an error (spikes/collab gotcha 4).
				return Promise.reject(null);
			}
		},

		async onConnect({ requestHeaders }) {
			if (!opts.originAllowed(requestHeaders.get("origin"))) {
				throw new CollabAuthError(AUTH_FAILURE.origin);
			}
		},

		async onAuthenticate({
			documentName,
			requestHeaders,
			token,
			connectionConfig,
		}) {
			try {
				const { context, readOnly } = await authorizeConnection(
					{ pool: opts.db.pool, lookupSession: opts.lookupSession },
					{ doc: parseDocName(documentName), requestHeaders, token },
				);
				if (
					(openPerUser.get(context.userId) ?? 0) >= limits.MAX_DOCS_PER_USER
				) {
					throw new CollabAuthError(AUTH_FAILURE.tooMany);
				}
				// v4: `connectionConfig.readOnly`, not `connection.readOnly` (spikes/collab gotcha 1).
				connectionConfig.readOnly = readOnly;
				const doc = parseDocName(documentName);
				if (!doc) return context;
				const admissionKey = randomUUID();
				admissions.set(admissionKey, {
					doc,
					headers: sessionHeaders(requestHeaders, token),
					readOnly,
					checkedAt: Date.now(),
				});
				return { ...context, admissionKey };
			} catch (e) {
				if (e instanceof CollabAuthError) throw e;
				console.error("[collab] onAuthenticate failed:", e);
				throw new CollabAuthError(AUTH_FAILURE.unavailable);
			}
		},

		async connected({ connection, context, documentName }) {
			openPerUser.set(
				context.userId,
				(openPerUser.get(context.userId) ?? 0) + 1,
			);
			const doc = parseDocName(documentName);
			if (doc?.kind !== "channel") return;
			const hello: HelloMessage = {
				type: "hello",
				tripId: doc.tripId,
				version: await readVersion(opts.db, doc.tripId),
				you: {
					userId: context.userId,
					memberId: context.memberId,
					role: context.role,
					guest: context.guest,
					color: context.color,
					name: context.name,
				},
			};
			connection.sendStateless(JSON.stringify(hello));
		},

		async onDisconnect({ context }) {
			const ctx = context as CollabContext | undefined;
			if (ctx?.admissionKey) admissions.delete(ctx.admissionKey);
			const userId = ctx?.userId;
			if (!userId) return;
			const n = (openPerUser.get(userId) ?? 1) - 1;
			if (n > 0) openPerUser.set(userId, n);
			else openPerUser.delete(userId);
		},

		async afterLoadDocument({ document, documentName }) {
			if (parseDocName(documentName)?.kind === "note") {
				sizes.set(document, Y.encodeStateAsUpdate(document).byteLength);
			}
		},

		async onChange({ document, update }) {
			sizes.add(document, update.byteLength);
		},

		async beforeHandleMessage({ connection, update, document, context }) {
			rate.hit(connection, update.byteLength);
			if (!connection.readOnly && sizes.isOversized(document)) {
				throw new LimitError(
					`document ${document.name} is larger than ${limits.MAX_DOC_BYTES} bytes`,
				);
			}
			// SECURITY §4: a writable connection re-validates before applying a
			// message once its last check is older than RECHECK_MS.
			const ctx = context as CollabContext | undefined;
			const adm = admissionOf(ctx);
			if (
				ctx &&
				adm &&
				!connection.readOnly &&
				Date.now() - adm.checkedAt >= recheckMs
			) {
				adm.checkedAt = Date.now();
				if (!(await stillAllowed(ctx, adm))) throw new AccessChangedError();
			}
		},

		async beforeHandleAwareness({ states, context, document, connection }) {
			if (!context) return; // server-internal or another instance (already sanitized)
			await sanitizeAwarenessUpdateLive(
				states,
				document.awareness.getStates() as Map<number, Record<string, unknown>>,
				context,
				cursorGuard,
				connection ?? context,
			);
		},

		async onRequest({ request, response }) {
			const path = (request.url ?? "").split("?")[0];
			if (path === "/healthz") {
				response.writeHead(200, { "content-type": "text/plain" });
				response.end("ok");
				return Promise.reject(null);
			}
			if (path === "/health") {
				let ok = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					ok = await Promise.race([
						opts.health ? opts.health() : Promise.resolve(true),
						new Promise<boolean>((resolve) => {
							timer = setTimeout(() => resolve(false), HEALTH_TIMEOUT_MS);
						}),
					]);
				} catch {
					ok = false;
				} finally {
					clearTimeout(timer);
				}
				response.writeHead(ok ? 200 : 503, {
					"content-type": "text/plain",
					"cache-control": "no-store",
				});
				response.end(ok ? "ok" : "redis unreachable");
				return Promise.reject(null);
			}
		},
	});

	hocuspocusRef = server.hocuspocus;
	/** The periodic sweep (one at a time; a slow DB never stacks them up). */
	let sweeping = false;
	const sweep = setInterval(() => {
		if (sweeping) return;
		sweeping = true;
		void recheckAll(recheckMs).finally(() => {
			sweeping = false;
		});
	}, recheckMs);
	sweep.unref();
	await server.listen();

	const relay = startRelay({
		hocuspocus: server.hocuspocus,
		sub: new Redis(opts.redis.url, {
			connectionName: `yonder-relay${connName}`,
			autoResubscribe: false,
			maxRetriesPerRequest: null,
			lazyConnect: true,
		}),
		pattern: opts.redis.tripPattern,
		log: (m) => log(`relay: ${m}`),
		// Events published while unsubscribed are lost: re-check every connection.
		onResubscribe: () => {
			void recheckAll();
		},
		onNotes: (e) => void onNotes(e),
	});
	await relay.ready;

	const port = server.address.port;
	const host = opts.host ?? "127.0.0.1";
	log(`listening on ws://${host}:${port}`);

	let stopping: Promise<void> | undefined;
	return {
		server,
		hocuspocus: server.hocuspocus,
		relay,
		port,
		url: `ws://${host}:${port}`,
		stop() {
			stopping ??= (async () => {
				clearInterval(sweep);
				await relay.stop();
				// Flushes pending debounced stores, closes connections, runs onDestroy.
				await server.destroy();
			})();
			return stopping;
		},
	};
}

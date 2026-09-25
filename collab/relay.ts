import type { Hocuspocus } from "@hocuspocus/server";
import type { Redis } from "ioredis";
import {
	CLOSE_ACCESS_CHANGED,
	channelDocName,
	type NotesEvent,
	parseDocName,
	parseTripEvent,
	type ResyncEvent,
	type TripEvent,
} from "@/lib/realtime/protocol";
import type { CollabContext } from "./auth";

/**
 * Redis → Hocuspocus relay (SPEC §10.6, ADDENDUM §2).
 *
 * PSUBSCRIBEs `${REDIS_PREFIX}:trip:*`. For each validated event:
 * - `access`: closes the affected users' connections on every document of that
 *   trip (only on THIS instance: every collab instance runs its own relay). The
 *   provider re-authenticates at once, and the DB role check refuses, downgrades
 *   (read-only) or re-admits it.
 * - `notes`: removed/merged note documents, handled by collab (`onNotes`),
 *   never sent to clients.
 * - anything else: sent to the connections of this instance on the trip's channel
 *   document with `relayStateless` (not `broadcastStateless`, which would make
 *   @hocuspocus/extension-redis forward it to every other instance, and each of
 *   those already got it from Redis → duplicates). An `invalidate` with
 *   `userIds` (a private note's store) goes only to those users' connections.
 *
 * Pub/sub is fire-and-forget: messages published while the subscriber is down are
 * lost. So after every RE-subscribe the relay sends `resync` to every channel
 * document it serves, and clients refetch (SPEC acceptance: CLIENT KILL → resync),
 * and `onResubscribe` lets the server re-check every open connection's access
 * (a lost `access` event must not leave a revoked socket open).
 */
export type Relay = {
	/** Resolves once the first PSUBSCRIBE succeeded. */
	ready: Promise<void>;
	stop(): Promise<void>;
	/** Handles one raw message as if it came from Redis (tests). */
	handle(channel: string, raw: string): void;
};

export function startRelay(opts: {
	hocuspocus: Hocuspocus;
	sub: Redis;
	/** `${REDIS_PREFIX}:trip:*` */
	pattern: string;
	log?: (msg: string) => void;
	/** Called after every RE-subscribe (not the first subscribe). */
	onResubscribe?: () => void;
	/** `notes` events (removed/merged note documents); never sent to clients. */
	onNotes?: (e: NotesEvent) => void;
}): Relay {
	const { hocuspocus, sub, pattern } = opts;
	const log = opts.log ?? ((m: string) => console.log(`[collab:relay] ${m}`));
	const channelPrefix = pattern.slice(0, -1); // "…:trip:"
	let subscribedOnce = false;
	let stopped = false;
	let resolveReady!: () => void;
	const ready = new Promise<void>((r) => {
		resolveReady = r;
	});

	function closeAffected(e: Extract<TripEvent, { type: "access" }>) {
		const users = e.userIds ? new Set(e.userIds) : null;
		let closed = 0;
		for (const [name, doc] of hocuspocus.documents) {
			if (parseDocName(name)?.tripId !== e.tripId) continue;
			for (const conn of doc.getConnections()) {
				const ctx = conn.context as CollabContext | undefined;
				if (!users || (ctx && users.has(ctx.userId))) {
					conn.close({ code: 4403, reason: CLOSE_ACCESS_CHANGED });
					closed += 1;
				}
			}
		}
		if (closed)
			log(`access change on trip ${e.tripId}: closed ${closed} connection(s)`);
	}

	function handle(channel: string, raw: string) {
		if (!channel.startsWith(channelPrefix)) return;
		const tripId = channel.slice(channelPrefix.length);
		const e = parseTripEvent(raw);
		if (!e || e.tripId !== tripId) {
			log(`dropped a malformed event on ${channel}`);
			return;
		}
		if (e.type === "access") {
			closeAffected(e);
			return;
		}
		if (e.type === "notes") {
			opts.onNotes?.(e);
			return;
		}
		const doc = hocuspocus.documents.get(channelDocName(tripId));
		if (!doc) return;
		// An `invalidate` for a private note reaches only its owner (ADDENDUM §7.2).
		const only =
			e.type === "invalidate" && e.userIds ? new Set(e.userIds) : null;
		doc.relayStateless(
			JSON.stringify(e),
			only
				? (conn) => {
						const ctx = conn.context as CollabContext | undefined;
						return !!ctx && only.has(ctx.userId);
					}
				: undefined,
		);
	}

	function resyncAll() {
		let n = 0;
		for (const [name, doc] of hocuspocus.documents) {
			const ref = parseDocName(name);
			if (ref?.kind !== "channel") continue;
			const msg: ResyncEvent = { type: "resync", tripId: ref.tripId };
			doc.relayStateless(JSON.stringify(msg));
			n += 1;
		}
		log(`re-subscribed; sent resync to ${n} trip channel(s)`);
	}

	sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
		try {
			handle(channel, message);
		} catch (e) {
			console.error("[collab:relay] handler failed:", e);
		}
	});

	// 'ready' fires on the first connect and after every reconnect. The subscriber
	// is created with autoResubscribe:false, so the relay knows exactly when the
	// subscription is live again before telling clients to resync.
	const onReady = () => {
		if (stopped) return;
		sub
			.psubscribe(pattern)
			.then(() => {
				if (subscribedOnce) {
					resyncAll();
					opts.onResubscribe?.();
				}
				subscribedOnce = true;
				resolveReady();
			})
			.catch((e: unknown) => {
				console.error("[collab:relay] PSUBSCRIBE failed:", e);
			});
	};
	sub.on("ready", onReady);

	if (sub.status === "ready") onReady();
	else if (sub.status === "wait") void sub.connect().catch(() => {});

	return {
		ready,
		handle,
		async stop() {
			stopped = true;
			sub.off("ready", onReady);
			// No PUNSUBSCRIBE round trip: it would wait forever if Redis is down.
			sub.disconnect(false);
		},
	};
}

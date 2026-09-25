import type { QueryClient } from "@tanstack/react-query";
import {
	keysToInvalidate,
	meKeys,
	type TripKey,
	tripKeys,
} from "@/lib/query/keys";
import type { CollabClient, DocLease, DocSnapshot } from "./collab-client";
import {
	type Actor,
	AUTH_FAILURE,
	type ChannelMessage,
	channelDocName,
	type FlashHint,
	type HelloMessage,
	type JobEvent,
	parseChannelMessage,
} from "./protocol";
import { getTabId } from "./tab-id";

/**
 * Live invalidation for one trip (SPEC §10.5 "client handling"; ADDENDUM §2).
 *
 * Joins the trip's channel document and turns its stateless messages into
 * TanStack Query invalidations:
 * - `invalidate` → the named keys (skipped when this tab caused it), plus flash
 *   hints for the "Maya changed this" glow;
 * - a skipped version (`version > last + 1`), `resync`, `access`, a `hello` whose
 *   version differs from what this tab has seen, or the tab becoming visible after
 *   60 s hidden → every `['trip', id]` query;
 * - `mention` naming me → `['me', 'mentions']`; `job` → `onJob` (progress toast).
 * If the server refuses the channel (removed, link reset, signed out) it calls
 * `onAccessLost` (purge offline data, toast, go home).
 *
 * Framework-free so it can be tested in Node; `useTripLive` wraps it for React.
 */
export type TripLiveOptions = {
	queryClient: QueryClient;
	/** The `trips.version` the loaded data reflects (the graph's `trip.version`). */
	baseVersion?: number | null;
	/** Defaults to this tab's `getTabId()`. */
	tabId?: string;
	onFlash?: (hint: FlashHint, actor: Actor | undefined) => void;
	onJob?: (event: JobEvent) => void;
	/** The server refused this trip's channel: access is gone (reason: AUTH_FAILURE). */
	onAccessLost?: (reason: string) => void;
	/** Every parsed message, after it was handled (debugging, e2e hooks). */
	onMessage?: (message: ChannelMessage) => void;
	/** Refetch everything when the tab was hidden at least this long. Default 60 s. */
	hiddenRefetchMs?: number;
	/** Invalidations arriving within this window are merged. Default 30 ms. */
	coalesceMs?: number;
};

export type TripLiveState = {
	status: DocSnapshot["status"];
	reason: string | null;
	/** Highest `trips.version` this tab knows its data reflects (or has been told about). */
	version: number | null;
	/** The server's view of this connection (role, member id, colour). */
	you: HelloMessage["you"] | null;
	/** `Date.now()` of the last event (any type). */
	lastEventAt: number | null;
};

/** Refusals that mean "your access to this trip is gone" (not transient). */
const ACCESS_LOST: ReadonlySet<string> = new Set([
	AUTH_FAILURE.forbidden,
	AUTH_FAILURE.unauthorized,
	AUTH_FAILURE.nameRequired,
]);

export class TripLiveController {
	private lease: DocLease | null = null;
	private unsubs: (() => void)[] = [];
	private listeners = new Set<() => void>();
	private state: TripLiveState;
	private readonly tabId: string;
	private pendingKeys = new Set<TripKey>();
	private pendingAll = false;
	private pendingMentions = false;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private hiddenAt: number | null = null;
	private accessLostReported = false;

	constructor(
		private readonly client: CollabClient,
		readonly tripId: string,
		private readonly options: TripLiveOptions,
	) {
		this.tabId = options.tabId ?? getTabId();
		this.state = {
			status: "connecting",
			reason: null,
			version: options.baseVersion ?? null,
			you: null,
			lastEventAt: null,
		};
	}

	getSnapshot = (): TripLiveState => this.state;

	subscribe = (l: () => void): (() => void) => {
		this.listeners.add(l);
		return () => {
			this.listeners.delete(l);
		};
	};

	/** The channel document lease (presence uses its awareness). Null before start(). */
	get channel(): DocLease | null {
		return this.lease;
	}

	start(): void {
		if (this.lease) return;
		const lease = this.client.acquire(channelDocName(this.tripId));
		this.lease = lease;
		this.unsubs.push(
			lease.onStateless((payload) => {
				const msg = parseChannelMessage(payload);
				if (msg && msg.tripId === this.tripId) this.handleMessage(msg);
			}),
			lease.subscribe(() => this.onLeaseChange(lease.getSnapshot())),
		);
		this.onLeaseChange(lease.getSnapshot());
		if (typeof document !== "undefined") {
			const onVisibility = () =>
				this.onVisibility(document.visibilityState === "visible");
			document.addEventListener("visibilitychange", onVisibility);
			this.unsubs.push(() =>
				document.removeEventListener("visibilitychange", onVisibility),
			);
		}
	}

	stop(): void {
		for (const u of this.unsubs.splice(0)) u();
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		this.lease?.release();
		this.lease = null;
	}

	/** The graph was (re)loaded at `version`: data up to it is already in the cache. */
	setBaseVersion(version: number | null | undefined): void {
		if (version === null || version === undefined) return;
		const current = this.state.version;
		if (current === null || version > current) this.set({ version });
	}

	/** Handles one channel message (public for tests). */
	handleMessage(msg: ChannelMessage): void {
		this.set({ lastEventAt: Date.now() });
		switch (msg.type) {
			case "hello": {
				const known = this.state.version;
				this.set({ you: msg.you });
				// Unknown on either side, or different: we may have missed events.
				if (msg.version === null || known === null || msg.version !== known)
					this.invalidateAll();
				if (msg.version !== null) this.set({ version: msg.version });
				break;
			}
			case "invalidate": {
				const known = this.state.version;
				const gap = known !== null && msg.version > known + 1;
				if (known === null || msg.version > known)
					this.set({ version: msg.version });
				if (gap) this.invalidateAll();
				if (msg.by === this.tabId) break;
				if (!gap) for (const k of msg.keys) this.pendingKeys.add(k);
				for (const h of msg.hints ?? []) this.options.onFlash?.(h, msg.actor);
				this.scheduleFlush();
				break;
			}
			case "access":
			case "resync":
				this.invalidateAll();
				break;
			case "mention": {
				const me = this.state.you?.memberId;
				if (me && msg.memberIds.includes(me)) {
					this.pendingMentions = true;
					this.scheduleFlush();
				}
				break;
			}
			case "job":
				this.options.onJob?.(msg);
				break;
		}
		this.options.onMessage?.(msg);
	}

	private onLeaseChange(s: DocSnapshot) {
		this.set({ status: s.status, reason: s.reason });
		if (s.status === "denied" && s.reason && ACCESS_LOST.has(s.reason)) {
			if (!this.accessLostReported) {
				this.accessLostReported = true;
				this.options.onAccessLost?.(s.reason);
			}
		} else if (s.status === "authenticated") {
			this.accessLostReported = false;
		}
	}

	private onVisibility(visible: boolean) {
		if (!visible) {
			this.hiddenAt = Date.now();
			return;
		}
		const hiddenFor = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt;
		this.hiddenAt = null;
		if (hiddenFor >= (this.options.hiddenRefetchMs ?? 60_000))
			this.invalidateAll();
	}

	private invalidateAll() {
		this.pendingAll = true;
		this.scheduleFlush();
	}

	private scheduleFlush() {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flush();
		}, this.options.coalesceMs ?? 30);
	}

	private flush() {
		const qc = this.options.queryClient;
		const prefixes: (readonly unknown[])[] = [];
		if (this.pendingAll) {
			prefixes.push(tripKeys.trip(this.tripId), meKeys.deadlines, meKeys.inbox);
		} else {
			for (const k of this.pendingKeys)
				prefixes.push(...keysToInvalidate(this.tripId, k));
		}
		if (this.pendingMentions) prefixes.push(meKeys.mentions, meKeys.inbox);
		this.pendingAll = false;
		this.pendingKeys.clear();
		this.pendingMentions = false;
		for (const queryKey of prefixes) void qc.invalidateQueries({ queryKey });
	}

	private set(patch: Partial<TripLiveState>) {
		const next = { ...this.state, ...patch };
		const same = (Object.keys(patch) as (keyof TripLiveState)[]).every(
			(k) => next[k] === this.state[k],
		);
		if (same) return;
		this.state = next;
		for (const l of [...this.listeners]) l();
	}
}

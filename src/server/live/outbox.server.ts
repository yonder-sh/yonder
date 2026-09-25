import { type SQL, sql } from "drizzle-orm";
import type { TripKey } from "@/lib/query/keys";
import {
	type AccessEvent,
	type Actor,
	type FlashHint,
	MAX_ACCESS_USER_IDS,
	MAX_EVENT_BYTES,
	MAX_HINTS,
	type TripEvent,
} from "@/lib/realtime/protocol";
import type { LegTarget } from "@/lib/schemas/targets";
import {
	type EnqueueOptions,
	enqueue,
	type JobData,
	type JobName,
	type QueueName,
} from "./jobs.server";
import {
	type ChangeSpec,
	publishTripChange,
	resolveHints,
	resolveKeys,
} from "./realtime.server";

/**
 * The mutation transaction helper (SPEC §10.5, §12.3; ADDENDUM §2 "publish only
 * after commit, never inside the tx").
 *
 *   const withTripTx = createWithTripTx(db)          // once, next to `db`
 *   await withTripTx(tripId, async (tx, out) => {
 *     …writes…
 *     out.emit({ entity: 'item', ids: [itemId] })     // or { keys: ['graph'] }
 *     out.job('media', 'media.variants', { tripId, attachmentId })
 *   }, { by: tabIdFromHeaders(headers), actor })
 *
 * Inside the transaction it takes the trip's advisory lock (serialises one trip's
 * order-sensitive writes) and bumps `trips.version` by exactly 1 (a note body's
 * store passes `bumpVersion: false`: see OutboxMeta). After COMMIT it
 * publishes ONE `invalidate` (all `emit` calls merged) with that version, the
 * `access`/`mention` events, and adds the jobs. If the transaction throws, nothing
 * is published or enqueued. Publishing failures are logged, never thrown.
 */

/** Anything that runs a drizzle `sql` query: a drizzle db or transaction (pg or postgres-js). */
export type SqlExecutor = { execute(query: SQL): Promise<unknown> };

/** A drizzle database (or anything with the same `transaction` shape). */
export type TripTxDb<Tx> = {
	transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};

/** Normalises `execute` results: node-postgres returns `{ rows }`, postgres-js an array. */
export function rowsOf(res: unknown): Record<string, unknown>[] {
	if (Array.isArray(res)) return res as Record<string, unknown>[];
	if (res && typeof res === "object" && "rows" in res) {
		const rows = (res as { rows: unknown }).rows;
		if (Array.isArray(rows)) return rows as Record<string, unknown>[];
	}
	return [];
}

/** `pg_advisory_xact_lock` on the trip: held until COMMIT/ROLLBACK. */
export async function lockTrip(tx: SqlExecutor, tripId: string): Promise<void> {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${tripId}, 0))`,
	);
}

/**
 * `trips.version = version + 1`, returning the new version. Call it inside the
 * mutation's transaction (withTripTx does). Throws when the trip does not exist.
 */
export async function bumpTripVersion(
	tx: SqlExecutor,
	tripId: string,
): Promise<number> {
	const rows = rowsOf(
		await tx.execute(
			sql`update trips set version = version + 1 where id = ${tripId} returning version`,
		),
	);
	const v = rows[0]?.version;
	if (v === undefined || v === null)
		throw new Error(`trip ${tripId} not found`);
	return Number(v);
}

/** `withTripTx({ bumpVersion: false })`: the version as it is; throws like the bump. */
async function currentTripVersion(
	tx: SqlExecutor,
	tripId: string,
): Promise<number> {
	const v = await readTripVersion(tx, tripId);
	if (v === null) throw new Error(`trip ${tripId} not found`);
	return v;
}

/** The trip's current version, or null when the trip does not exist. */
export async function readTripVersion(
	tx: SqlExecutor,
	tripId: string,
): Promise<number | null> {
	const rows = rowsOf(
		await tx.execute(sql`select version from trips where id = ${tripId}`),
	);
	const v = rows[0]?.version;
	return v === undefined || v === null ? null : Number(v);
}

export type OutboxMeta = {
	/** The originating tab (`tabIdFromHeaders(getRequestHeaders())`); it skips its own event. */
	by?: string | null;
	/** Who did it: shown as "Maya changed this" and with the flash glow (§10.8). */
	actor?: Actor | null;
	/**
	 * `false`: not a change to the structured data (a note body, SPEC D10). The
	 * trip is still locked, but `trips.version` stays where it is and the
	 * events carry the current version: no client sees a gap, and nobody's
	 * reviewed `expectedVersion` (date changes) goes stale because someone typed
	 * in a note (QA NOTE-VERSION-CONFLICT). Default `true`.
	 */
	bumpVersion?: boolean;
	/**
	 * Only these users' connections receive the `invalidate` (collab filters):
	 * a private note's owner (ADDENDUM §7.2), so no one else learns it changed.
	 * Omitted = everyone on the trip.
	 */
	audience?: readonly string[];
};

type PendingJob = {
	queue: QueueName;
	name: string;
	data: unknown;
	opts?: EnqueueOptions;
};

export type OutboxDeps = {
	publish: (event: TripEvent) => Promise<unknown>;
	enqueue: (
		queue: QueueName,
		name: string,
		data: unknown,
		opts?: EnqueueOptions,
	) => Promise<unknown>;
};

const defaultDeps: OutboxDeps = {
	publish: publishTripChange,
	enqueue: (queue, name, data, opts) =>
		// The generic signature is checked at `out.job(...)`; here it is just forwarded.
		(
			enqueue as (
				q: QueueName,
				n: string,
				d: unknown,
				o?: EnqueueOptions,
			) => Promise<unknown>
		)(queue, name, data, opts),
};

/** Collects what a transaction wants published / enqueued, until after COMMIT. */
export class TxOutbox {
	/** `trips.version` after this transaction's bump, or the current one with `bumpVersion: false` (set by withTripTx). */
	version: number | null = null;
	private readonly keys = new Set<TripKey>();
	private readonly hints = new Map<string, FlashHint>();
	private accessUsers: Set<string> | "everyone" | null = null;
	private readonly mentions = new Set<string>();
	private readonly goneDocs = new Set<string>();
	private readonly movedDocs = new Map<string, string>();
	private readonly jobs: PendingJob[] = [];
	private flushed = false;

	constructor(
		readonly tripId: string,
		readonly meta: OutboxMeta = {},
	) {}

	/** Announce changed data: explicit `keys`, or an `entity` (+ `ids` for flash hints). */
	emit(spec: ChangeSpec): this {
		for (const k of resolveKeys(spec)) this.keys.add(k);
		for (const h of resolveHints(spec)) {
			if (this.hints.size < MAX_HINTS) this.hints.set(`${h.kind}:${h.id}`, h);
		}
		return this;
	}

	/**
	 * Access changed (member removed, role changed, link toggled/reset, guest removed):
	 * collab closes these users' sockets so they re-authenticate (§11.4). Omit
	 * `userIds` for everyone on the trip. Also invalidates `sharing` and `graph`.
	 */
	access(userIds?: readonly string[]): this {
		if (!userIds) this.accessUsers = "everyone";
		else if (this.accessUsers !== "everyone") {
			this.accessUsers ??= new Set();
			for (const u of userIds) this.accessUsers.add(u);
		}
		this.keys.add("sharing");
		this.keys.add("graph");
		return this;
	}

	/** Members newly @mentioned: their mention bells refetch. */
	mention(memberIds: readonly string[]): this {
		for (const m of memberIds) this.mentions.add(m);
		return this;
	}

	/**
	 * Note documents this transaction removed (`gone`) or merged server-side
	 * (`moved`: from → to), e.g. a removed day's notes (QA P1). Collab folds
	 * unsaved text into the target, refreshes an open target and closes the
	 * removed ones, so no editor stores over the merge or takes typing it
	 * can't save (`NotesEvent`).
	 */
	notes(spec: {
		gone?: readonly string[];
		moved?: readonly { from: string; to: string }[];
	}): this {
		for (const g of spec.gone ?? []) this.goneDocs.add(g);
		for (const m of spec.moved ?? []) this.movedDocs.set(m.from, m.to);
		return this;
	}

	/** Enqueue a job after COMMIT (never before: the worker must see the committed rows). */
	job<Q extends QueueName, N extends JobName<Q>>(
		queue: Q,
		name: N,
		data: JobData<Q, N>,
		opts?: EnqueueOptions,
	): this {
		this.jobs.push({ queue, name, data, opts });
		return this;
	}

	/** The events `flush()` publishes, in order (exposed for tests and logging). */
	events(): TripEvent[] {
		const out: TripEvent[] = [];
		const version = this.version;
		if (this.accessUsers !== null && version !== null) {
			const userIds =
				this.accessUsers === "everyone" ? undefined : [...this.accessUsers];
			out.push(accessEvent(this.tripId, version, userIds));
		}
		// An audience of no one publishes no `invalidate` (never "everyone").
		const audience = this.meta.audience
			? [...new Set(this.meta.audience)]
			: null;
		if (this.keys.size > 0 && version !== null && audience?.length !== 0) {
			const hints = [...this.hints.values()];
			out.push({
				type: "invalidate",
				tripId: this.tripId,
				version,
				keys: [...this.keys],
				...(audience ? { userIds: audience } : {}),
				...(this.meta.by ? { by: this.meta.by } : {}),
				...(this.meta.actor ? { actor: this.meta.actor } : {}),
				...(hints.length ? { hints } : {}),
			});
		}
		if (this.mentions.size > 0) {
			out.push({
				type: "mention",
				tripId: this.tripId,
				memberIds: [...this.mentions].slice(0, 200),
			});
		}
		// In chunks (≤ 40 names each keeps an event far below MAX_EVENT_BYTES).
		const moved = [...this.movedDocs].map(([from, to]) => ({ from, to }));
		const gone = [...this.goneDocs].filter((g) => !this.movedDocs.has(g));
		for (let i = 0; i < Math.max(moved.length, gone.length); i += 20) {
			out.push({
				type: "notes",
				tripId: this.tripId,
				gone: gone.slice(i, i + 20),
				moved: moved.slice(i, i + 20),
			});
		}
		return out;
	}

	/** Publish the events, then add the jobs. Idempotent; never throws. */
	async flush(deps: OutboxDeps = defaultDeps): Promise<void> {
		if (this.flushed) return;
		this.flushed = true;
		for (const e of this.events()) {
			try {
				await deps.publish(e);
			} catch (err) {
				console.error("[live] outbox publish failed:", err);
			}
		}
		for (const j of this.jobs) {
			try {
				await deps.enqueue(j.queue, j.name, j.data, j.opts);
			} catch (err) {
				console.error(
					`[live] outbox enqueue ${j.queue}/${j.name} failed:`,
					err,
				);
			}
		}
	}
}

/**
 * The `access` event for these users, or the "everyone on the trip" form when
 * the list would not fit: over MAX_ACCESS_USER_IDS ids, or over MAX_EVENT_BYTES
 * once serialized (Better Auth ids are 32 characters, so ~460 ids already
 * exceed 16 KB). An access event must never be dropped: a revocation that
 * isn't delivered leaves removed guests with open, writable sockets.
 */
export function accessEvent(
	tripId: string,
	version: number,
	userIds?: readonly string[],
): AccessEvent {
	const everyone: AccessEvent = { type: "access", tripId, version };
	if (!userIds) return everyone;
	if (userIds.length > MAX_ACCESS_USER_IDS) return everyone;
	const event: AccessEvent = { ...everyone, userIds: [...userIds] };
	return JSON.stringify(event).length > MAX_EVENT_BYTES ? everyone : event;
}

/**
 * Binds the helper to a database. The app does `export const withTripTx =
 * createWithTripTx(db)` (src/server/tx.server.ts); collab does the same with its own
 * pool (note persistence).
 */
export function createWithTripTx<Tx extends SqlExecutor>(
	db: TripTxDb<Tx>,
	deps: OutboxDeps = defaultDeps,
) {
	return async function withTripTx<T>(
		tripId: string,
		fn: (tx: Tx, out: TxOutbox) => Promise<T>,
		meta?: OutboxMeta,
	): Promise<T> {
		const out = new TxOutbox(tripId, meta);
		const result = await db.transaction(async (tx) => {
			await lockTrip(tx, tripId);
			out.version =
				meta?.bumpVersion === false
					? await currentTripVersion(tx, tripId)
					: await bumpTripVersion(tx, tripId);
			return fn(tx, out);
		});
		await out.flush(deps);
		return result;
	};
}

export type WithTripTx<Tx extends SqlExecutor> = ReturnType<
	typeof createWithTripTx<Tx>
>;

/** The BullMQ deduplication id of a leg's autofill job (SPEC §10.9). */
export function autofillDedupeId(target: LegTarget): string {
	return target.kind === "pair"
		? `autofill:${target.fromItemId}>${target.toItemId}`
		: `autofill:stay:${target.dayId}:${target.end}`;
}

/**
 * Queues leg autofill after COMMIT (SPEC §10.9): one job per target, never twice
 * while one is waiting. Pass `enabled: trip.settings.autofillLegs !== false`.
 * Callers: `reconcileLegs` (new pairs), `setDayStay` / changed stay anchors, the importer.
 */
export function enqueueAutofill(
	out: TxOutbox,
	targets: readonly LegTarget[],
	opts: { enabled?: boolean } = {},
): void {
	if (opts.enabled === false) return;
	for (const target of targets) {
		out.job(
			"autofill",
			"autofill",
			{ tripId: out.tripId, target },
			{ dedupeId: autofillDedupeId(target) },
		);
	}
}

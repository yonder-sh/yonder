import {
	type Actor,
	ENTITY_KEYS,
	type FlashHint,
	hintsFor,
	type InvalidateEvent,
	MAX_EVENT_BYTES,
	MAX_HINTS,
	type TripEntity,
	TripEvent,
	type TripKey,
} from "@/lib/realtime/protocol";
import { key, redis } from "./redis.server";

/**
 * Publishing live trip events (SPEC §10.5, ADDENDUM §2).
 *
 * `publishTripChange(event)` PUBLISHes the event on `${REDIS_PREFIX}:trip:<tripId>`.
 * The collab server PSUBSCRIBEs to `${REDIS_PREFIX}:trip:*` and relays it to the
 * trip's channel document; clients invalidate the named TanStack Query keys.
 *
 * Call it only AFTER the mutation's transaction committed — normally you don't call
 * it at all: `withTripTx` (outbox.server.ts) collects `out.emit(...)` calls and
 * publishes them after COMMIT with the transaction's `trips.version`.
 *
 * Publishing is best effort by design: the data is already committed, so a Redis
 * failure is logged and swallowed (never turned into a failed request). Clients heal
 * through the version check on their next event or reconnect.
 */

/** The Redis channel of one trip. */
export function tripChannel(tripId: string): string {
	return key("trip", tripId);
}

/** The PSUBSCRIBE pattern covering every trip channel of this prefix. */
export function tripChannelPattern(): string {
	return key("trip", "*");
}

const PUBLISH_TIMEOUT_MS = 2_000;

/**
 * Validates and publishes one event. Resolves to the number of subscribers that
 * received it (0 when no collab server listens), or null when it could not be
 * published. Never throws.
 */
export async function publishTripChange(
	event: TripEvent,
): Promise<number | null> {
	// A revocation is never dropped: an access event that doesn't validate or fit
	// is widened to "everyone on the trip" (they all re-authenticate; harmless).
	if (event.type === "access" && event.userIds) {
		const tooBig =
			!TripEvent.safeParse(event).success ||
			JSON.stringify(event).length > MAX_EVENT_BYTES;
		if (tooBig) {
			const { userIds: _dropped, ...everyone } = event;
			event = everyone;
		}
	}
	const parsed = TripEvent.safeParse(event);
	if (!parsed.success) {
		console.error(
			"[live] refusing to publish an invalid trip event:",
			parsed.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; "),
		);
		return null;
	}
	const payload = JSON.stringify(parsed.data);
	if (payload.length > MAX_EVENT_BYTES) {
		console.error(
			`[live] trip event too large (${payload.length} bytes, type=${event.type}); dropped`,
		);
		return null;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(new Error(`publish timed out after ${PUBLISH_TIMEOUT_MS} ms`)),
				PUBLISH_TIMEOUT_MS,
			);
		});
		return await Promise.race([
			redis().publish(tripChannel(parsed.data.tripId), payload),
			timeout,
		]);
	} catch (e) {
		console.error(
			`[live] publish failed for trip ${event.tripId} (${event.type}):`,
			e instanceof Error ? e.message : e,
		);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** What changed, in either vocabulary: explicit TripKeys, or an entity (+ ids). */
export type ChangeSpec = {
	/** Explicit keys; merged with the entity's defaults when both are given. */
	keys?: readonly TripKey[];
	/** ADDENDUM vocabulary: `entity` + `ids` → default keys (ENTITY_KEYS) and flash hints. */
	entity?: TripEntity;
	ids?: readonly string[];
	/** Extra flash hints (items/nodes/legs/days that should glow on other clients). */
	hints?: readonly FlashHint[];
};

/** Union of the explicit keys and the entity's default keys, in a stable order. */
export function resolveKeys(spec: ChangeSpec): TripKey[] {
	const out = new Set<TripKey>(spec.keys ?? []);
	if (spec.entity) for (const k of ENTITY_KEYS[spec.entity]) out.add(k);
	return [...out];
}

/** Flash hints from `hints` plus `entity`/`ids`, de-duplicated and capped. */
export function resolveHints(spec: ChangeSpec): FlashHint[] {
	const seen = new Set<string>();
	const out: FlashHint[] = [];
	const add = (h: FlashHint) => {
		const id = `${h.kind}:${h.id}`;
		if (seen.has(id) || out.length >= MAX_HINTS) return;
		seen.add(id);
		out.push(h);
	};
	for (const h of spec.hints ?? []) add(h);
	if (spec.entity)
		for (const h of hintsFor(spec.entity, spec.ids) ?? []) add(h);
	return out;
}

/**
 * Builds an `invalidate` event (the ADDENDUM's
 * `publishTripChange({ tripId, entity, ids, version, actorId })` shape maps onto it).
 */
export function invalidateEvent(
	input: ChangeSpec & {
		tripId: string;
		version: number;
		/** The originating tab (`x-tab-id`); that tab skips the event. */
		by?: string | null;
		actor?: Actor | null;
	},
): InvalidateEvent {
	const keys = resolveKeys(input);
	if (keys.length === 0)
		throw new Error("invalidateEvent: no keys or entity given");
	const hints = resolveHints(input);
	return {
		type: "invalidate",
		tripId: input.tripId,
		version: input.version,
		keys,
		...(input.by ? { by: input.by } : {}),
		...(input.actor ? { actor: input.actor } : {}),
		...(hints.length ? { hints } : {}),
	};
}

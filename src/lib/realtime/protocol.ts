/**
 * The realtime protocol shared by the browser, the app server, the collab server
 * and the worker (SPEC §10, ADDENDUM §2). Isomorphic: no Node or DOM imports.
 *
 * - Document names (§10.2): one channel document per trip (`trip/<tripId>`: presence
 *   plus stateless events, never persisted, always read-only) and one Y.Doc per
 *   note (`trip/<tripId>/root`, `trip/<tripId>/{node,leg,item,day}/<id>`), plus a
 *   member's PRIVATE note on the same target with `/u/<userId>` appended
 *   (ADDENDUM §7.2: only that user may open it; never in anyone else's counts,
 *   search, digest, activity or mentions).
 * - Trip events (§10.5): JSON published on Redis `${REDIS_PREFIX}:trip:<tripId>`
 *   after a mutation commits, relayed by collab as Hocuspocus stateless messages
 *   on the trip's channel document.
 * - Awareness (§10.7): the presence state each client publishes on the channel
 *   document. The server overwrites `user` and validates the rest (§10.4).
 */
import { z } from "zod";
import { TRIP_KEYS, type TripKey } from "@/lib/query/keys";
import { TRIP_ROLE_VALUES } from "@/lib/schemas/enums";
import type { BundleTarget } from "@/lib/schemas/targets";
import { ViewUi } from "./view-protocol";

export type { TripKey } from "@/lib/query/keys";

// ---------------------------------------------------------------------------
// Document names
// ---------------------------------------------------------------------------

/** A canonical lower-case UUID. Stricter than §10.2's `[0-9a-f-]{36}`, never looser. */
const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Better Auth user ids: opaque, url-safe. */
const USER_ID_SRC = "[A-Za-z0-9_-]{1,64}";
const DOC_NAME_RE = new RegExp(
	`^trip/(${UUID_SRC})(?:/(?:(root)|(node|leg|item|day)/(${UUID_SRC}))(?:/u/(${USER_ID_SRC}))?)?$`,
);
const UUID_RE = new RegExp(`^${UUID_SRC}$`);

export function isUuid(v: unknown): v is string {
	return typeof v === "string" && UUID_RE.test(v);
}

export type NoteTargetKind = "node" | "leg" | "item" | "day";

/** Where a note document hangs. `root` = the trip-level note. */
export type NoteTarget =
	| { kind: "root" }
	| { kind: NoteTargetKind; id: string };

export type DocRef =
	| { kind: "channel"; name: string; tripId: string }
	| {
			kind: "note";
			name: string;
			tripId: string;
			target: NoteTarget;
			/** Set for a private note: only this user may open it. */
			ownerUserId: string | null;
	  };

/**
 * Strict parser for untrusted document names (SECURITY §4): exact shape, lower-case
 * UUIDs only, no extra segments. Returns null for anything else.
 */
export function parseDocName(name: unknown): DocRef | null {
	if (typeof name !== "string" || name.length > 120) return null;
	const m = DOC_NAME_RE.exec(name);
	if (!m) return null;
	const [, tripId, root, kind, id, owner] = m;
	if (!tripId) return null;
	const ownerUserId = owner ?? null;
	if (root)
		return {
			kind: "note",
			name,
			tripId,
			target: { kind: "root" },
			ownerUserId,
		};
	if (kind && id) {
		return {
			kind: "note",
			name,
			tripId,
			target: { kind: kind as NoteTargetKind, id },
			ownerUserId,
		};
	}
	return { kind: "channel", name, tripId };
}

/** The per-trip channel document: presence + live events. */
export function channelDocName(tripId: string): string {
	return `trip/${tripId}`;
}

/**
 * The note document of a bundle target (the same targets as attachments and
 * lists). Pass `ownerUserId` for the caller's PRIVATE note on that target.
 */
export function noteDocName(
	tripId: string,
	target: BundleTarget,
	ownerUserId?: string | null,
): string {
	const own = ownerUserId ? `/u/${ownerUserId}` : "";
	switch (target.kind) {
		case "trip":
			return `trip/${tripId}/root${own}`;
		case "node":
			return `trip/${tripId}/node/${target.nodeId}${own}`;
		case "leg":
			return `trip/${tripId}/leg/${target.legId}${own}`;
		case "item":
			return `trip/${tripId}/item/${target.itemId}${own}`;
		case "day":
			return `trip/${tripId}/day/${target.dayId}${own}`;
	}
}

/** The XmlFragment TipTap's Collaboration extension binds to (spikes/collab gotcha 12). */
export const NOTE_FRAGMENT = "default";

/**
 * Providers send this instead of a real token: the collab server authenticates the
 * Better Auth session cookie of the WebSocket upgrade (§10.3). Any other non-empty
 * token is treated as a Better Auth bearer token (Node clients, tests).
 */
export const COOKIE_TOKEN = "cookie";

// ---------------------------------------------------------------------------
// Close / failure reasons (what `onAuthenticationFailed` / `onClose` receive)
// ---------------------------------------------------------------------------

export const AUTH_FAILURE = {
	/** The document name failed `parseDocName`. */
	badDoc: "bad-doc",
	/** No valid Better Auth session (signed out, expired, revoked). */
	unauthorized: "unauthorized",
	/** A signed-in (non-anonymous) user without first and last name (§11.2). */
	nameRequired: "name-required",
	/** No role on the trip. */
	forbidden: "forbidden",
	/** The note's target (a day, a leg…) is not (or no longer) in the trip: a removed day. */
	gone: "gone",
	/** The upgrade's Origin is not an allowed app origin (SECURITY §4 CSWSH). */
	origin: "origin-not-allowed",
	/** The server could not decide (DB/Redis error). Retryable: NOT an access change. */
	unavailable: "server-unavailable",
	/** This user already has too many documents open (all tabs together). */
	tooMany: "too-many-documents",
} as const;
export type AuthFailure = (typeof AUTH_FAILURE)[keyof typeof AUTH_FAILURE];

/** Reason on a server-side close after an `access` event; the client re-authenticates. */
export const CLOSE_ACCESS_CHANGED = "access-changed";
/** Reason when a connection exceeds the message rate or the document size cap. */
export const CLOSE_LIMIT = "limit-exceeded";
/**
 * Reason on a server-side close when a note's target was removed (a deleted
 * day, QA P1 private day note): re-authenticating then fails with `gone`, so
 * the editor stops taking typing it could never save.
 */
export const CLOSE_DOC_GONE = "doc-gone";

// ---------------------------------------------------------------------------
// Trip events (Redis → collab → channel doc stateless) — §10.5
// ---------------------------------------------------------------------------

export const HINT_KINDS = ["item", "node", "leg", "day"] as const;
export type HintKind = (typeof HINT_KINDS)[number];
/** At most this many flash hints per event; more are dropped (the keys still invalidate). */
export const MAX_HINTS = 40;
/** At most this many user ids in an `access` event. */
export const MAX_ACCESS_USER_IDS = 500;
/** Serialized events above this size are rejected by the publisher (Redis has no limit; clients do). */
export const MAX_EVENT_BYTES = 16_384;

export const JOB_KINDS = ["autofill", "media", "links"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

const TripId = z.string().regex(UUID_RE);
const Version = z.number().int().nonnegative();
const UserIdStr = z.string().min(1).max(255);

export const Actor = z.object({
	userId: UserIdStr,
	name: z.string().max(200),
	/** Presence colour index 0..7 (`--presence-(n+1)`). */
	color: z.number().int().min(0).max(7),
});
export type Actor = z.infer<typeof Actor>;

export const FlashHint = z.object({
	kind: z.enum(HINT_KINDS),
	id: z.string().regex(UUID_RE),
});
export type FlashHint = z.infer<typeof FlashHint>;

export const InvalidateEvent = z.object({
	type: z.literal("invalidate"),
	tripId: TripId,
	/**
	 * `trips.version` after the mutation's transaction (every structured-data
	 * mutation bumps it by 1; a note body's store keeps it and sends the
	 * current one, so it never looks like a gap).
	 */
	version: Version,
	keys: z.array(z.enum(TRIP_KEYS)).min(1).max(TRIP_KEYS.length),
	/**
	 * Only these users' connections receive it (a private note's owner,
	 * ADDENDUM §7.2); omitted = everyone on the trip. Collab filters on it.
	 */
	userIds: z.array(UserIdStr).min(1).max(MAX_ACCESS_USER_IDS).optional(),
	/** The `x-tab-id` of the tab that caused it; that tab skips the event. */
	by: z.string().max(64).optional(),
	actor: Actor.optional(),
	hints: z.array(FlashHint).max(MAX_HINTS).optional(),
});
export type InvalidateEvent = z.infer<typeof InvalidateEvent>;

export const AccessEvent = z.object({
	type: z.literal("access"),
	tripId: TripId,
	version: Version,
	/** The users whose access changed; omitted = everyone on the trip. */
	userIds: z.array(UserIdStr).max(MAX_ACCESS_USER_IDS).optional(),
});
export type AccessEvent = z.infer<typeof AccessEvent>;

export const MentionEvent = z.object({
	type: z.literal("mention"),
	tripId: TripId,
	memberIds: z.array(z.string().regex(UUID_RE)).min(1).max(200),
});
export type MentionEvent = z.infer<typeof MentionEvent>;

export const JobEvent = z.object({
	type: z.literal("job"),
	tripId: TripId,
	kind: z.enum(JOB_KINDS),
	remaining: z.number().int().nonnegative(),
	total: z.number().int().nonnegative(),
});
export type JobEvent = z.infer<typeof JobEvent>;

const NoteDocName = z
	.string()
	.max(300)
	.refine((s) => parseDocName(s)?.kind === "note");

/**
 * Note documents a mutation removed or merged server-side (a removed day,
 * ADDENDUM §7.2). Collab only, never relayed to clients:
 * - `moved`: a private note's saved text was merged into another document
 *   (`from` → the owner's private trip note). Collab folds any unsaved text
 *   of a loaded `from` into `to`, and refreshes a loaded `to` from the
 *   database, so an open editor shows it and never stores over it.
 * - `gone` (and every `from`): their target is gone. Collab closes them
 *   (`CLOSE_DOC_GONE`) and drops them without storing.
 */
export const NotesEvent = z.object({
	type: z.literal("notes"),
	tripId: TripId,
	gone: z.array(NoteDocName).max(100),
	moved: z.array(z.object({ from: NoteDocName, to: NoteDocName })).max(100),
});
export type NotesEvent = z.infer<typeof NotesEvent>;

/** Sent by collab itself after its Redis subscription reconnects (events may be lost). */
export const ResyncEvent = z.object({
	type: z.literal("resync"),
	tripId: TripId,
});
export type ResyncEvent = z.infer<typeof ResyncEvent>;

export const TripEvent = z.discriminatedUnion("type", [
	InvalidateEvent,
	AccessEvent,
	MentionEvent,
	JobEvent,
	ResyncEvent,
	NotesEvent,
]);
export type TripEvent = z.infer<typeof TripEvent>;

/**
 * Sent by collab to ONE connection right after it joins a trip's channel document
 * (not relayed through Redis). `version` is the trip's current `trips.version`, so a
 * (re)connecting client refetches only when it actually missed something. `you` is
 * the server's view of this connection (the role decides `readOnly` on note docs).
 */
export const HelloMessage = z.object({
	type: z.literal("hello"),
	tripId: TripId,
	version: Version.nullable(),
	you: z.object({
		userId: UserIdStr,
		memberId: z.string().regex(UUID_RE).nullable(),
		role: z.enum(TRIP_ROLE_VALUES),
		guest: z.boolean(),
		color: z.number().int().min(0).max(7),
		name: z.string(),
	}),
});
export type HelloMessage = z.infer<typeof HelloMessage>;

/** Everything a client can receive as a stateless payload on a channel document. */
export const ChannelMessage = z.discriminatedUnion("type", [
	InvalidateEvent,
	AccessEvent,
	MentionEvent,
	JobEvent,
	ResyncEvent,
	NotesEvent,
	HelloMessage,
]);
export type ChannelMessage = z.infer<typeof ChannelMessage>;

/** Parses a stateless payload / Redis message. Null for non-JSON or an unknown shape. */
export function parseChannelMessage(raw: string): ChannelMessage | null {
	if (raw.length > MAX_EVENT_BYTES * 2) return null;
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const r = ChannelMessage.safeParse(json);
	return r.success ? r.data : null;
}

/** Like `parseChannelMessage`, but only the events that may travel over Redis. */
export function parseTripEvent(raw: string): TripEvent | null {
	const m = parseChannelMessage(raw);
	return m && m.type !== "hello" ? m : null;
}

/**
 * Default TripKeys per changed entity, for callers that think in entities
 * (ADDENDUM's `publishTripChange({ entity, ids })`). Pass explicit keys to override.
 */
export const ENTITY_KEYS = {
	trip: ["graph", "counts", "activity"],
	member: ["graph", "sharing"],
	shareLink: ["sharing"],
	node: ["graph", "activity"],
	day: ["graph", "activity"],
	item: ["graph", "activity"],
	leg: ["graph", "activity"],
	attachment: ["media", "counts"],
	listItem: ["lists", "counts"],
	note: ["notes", "counts"],
	activity: ["activity"],
	// F-ext0
	proposal: ["proposals", "activity"],
	expense: ["money", "counts", "activity"],
	settlement: ["money"],
	budget: ["money"],
} as const satisfies Record<string, readonly TripKey[]>;
export type TripEntity = keyof typeof ENTITY_KEYS;

/** Flash hints for entities that have them (items, nodes, legs, days), capped at MAX_HINTS. */
export function hintsFor(
	entity: TripEntity,
	ids: readonly string[] | undefined,
): FlashHint[] | undefined {
	if (!ids?.length) return undefined;
	if (!(HINT_KINDS as readonly string[]).includes(entity)) return undefined;
	const kind = entity as HintKind;
	return ids
		.filter((id) => UUID_RE.test(id))
		.slice(0, MAX_HINTS)
		.map((id) => ({ kind, id }));
}

// ---------------------------------------------------------------------------
// Awareness (presence) — §10.7
// ---------------------------------------------------------------------------

export const LENSES = ["country", "region", "city", "area", "place"] as const;
/** Workspace tabs a peer can be on (mirrors `src/lib/workspace/search.ts` TABS). */
export const TABS = [
	"overview",
	"plan",
	"places",
	"media",
	"lists",
	"notes",
	"money",
] as const;
export const EDITING_KINDS = [
	"item",
	"node",
	"note",
	"list",
	"leg",
	"day",
] as const;

/** Server-written identity of a peer (never trust a client's own `user`). */
export type AwarenessUser = {
	id: string;
	memberId: string | null;
	name: string;
	/** Presence colour index 0..7 (`--presence-(n+1)`). */
	color: number;
	guest: boolean;
	/** FB-16: the avatar URL (`/api/avatar/<userId>?v=…`), when they have one. */
	image?: string | null;
};

/** Where a peer is looking (channel document only). `path` must stay inside `/t/<slug>`. */
export const AwarenessView = z.object({
	scopeId: z.string().regex(UUID_RE).nullable(),
	scopeName: z.string().max(200),
	lens: z.enum(LENSES),
	tab: z.enum(TABS),
	days: z.string().max(40).nullable(),
	sel: z.string().max(120).nullable(),
	path: z.string().max(600),
	/**
	 * FB-21: ephemeral view state beyond the URL (plan folds, sub-views…),
	 * `view-protocol.ts`. The server re-validates it and caps its size.
	 */
	ui: ViewUi.optional(),
});
export type AwarenessView = z.infer<typeof AwarenessView>;

/** What a peer is editing (drives "Maya is editing" rules, §10.8). */
export const AwarenessEditing = z
	.object({
		kind: z.enum(EDITING_KINDS),
		id: z.string().min(1).max(120),
		field: z.string().max(60).optional(),
	})
	.nullable();
export type AwarenessEditing = z.infer<typeof AwarenessEditing>;

export type AwarenessState = {
	user: AwarenessUser;
	view?: AwarenessView;
	editing?: AwarenessEditing;
	/**
	 * Note documents: the TipTap CollaborationCaret selection (opaque relative
	 * positions). The channel document: the live mouse cursor (FB-17,
	 * `AwarenessCursor` in `cursor-protocol.ts`; parse it before use).
	 */
	cursor?: unknown;
	/** Channel doc (FB-17d): the latest emoji reaction (`AwarenessReact`). */
	react?: unknown;
	/** Channel doc (FB-17a): the user id this client follows, or null. */
	following?: string | null;
	/** Channel doc (FB-17b): "Ask everyone to follow me" while set. */
	spotlight?: { id: string } | null;
	/** Channel doc (FB-22): my map camera (`AwarenessCam`, parse before use). */
	cam?: unknown;
	/** Channel doc (FB-21c): the media I have open (`AwarenessMedia`). */
	media?: unknown;
	/** Channel doc (FB-23): what I am dragging (`AwarenessDrag`). */
	drag?: unknown;
	/** Channel doc (FB-24): the editor / dialog I have open (`AwarenessForm`). */
	form?: unknown;
	/** Channel doc (FB-25): my open menu (`AwarenessMenu`). */
	menu?: unknown;
};

/** A peer as the UI sees it: one per user (several tabs collapse into one). */
export type Peer = AwarenessState & { clientId: number };

/** `view.path` shape (§10.4); the server also requires it to start with `/t/<slug>`. */
export const VIEW_PATH_RE = /^\/t\/[a-z0-9-]+(\/[a-z0-9-]+)*(\?[^#]*)?$/;

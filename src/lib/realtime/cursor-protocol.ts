/**
 * Live cursors, cursor chat, emoji reactions, Follow and Spotlight on the
 * trip's channel awareness (FB-17, 17a–d). Isomorphic: no DOM, no Node.
 *
 * Every field below rides on the channel document's awareness next to `user`,
 * `view` and `editing` (SPEC §10.7). The collab server validates each one
 * (`collab/cursors.ts`), rate-limits it, drops anchors on private things, and
 * strips members-only anchors before an awareness update reaches a link guest.
 *
 * A cursor is anchored SEMANTICALLY so it lands on the same thing on any
 * screen size or layout:
 * - over the map: `{ k: "map", lng, lat }`;
 * - over a card, day, tree row, list row, tab… (`data-cursor-anchor="<id>"`):
 *   `{ k: "el", id, fx, fy }`, fractions of that element's box;
 * - anywhere else (menus, dialogs, the notes editor, private things): `null`,
 *   and the cursor fades out for everyone.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Timing and caps
// ---------------------------------------------------------------------------

/** Cursors travel at ~20 Hz (one awareness update per 50 ms at most). */
export const CURSOR_SEND_MS = 50;
/** The server's per-connection budget: a burst of this many cursor updates… */
export const CURSOR_BURST = 40;
/** …refilled at this rate per second (≈ 1.5× the client's 20 Hz). */
export const CURSOR_REFILL_PER_S = 30;
/** Receivers show at most this many cursors (the most recently active). */
export const MAX_CURSORS = 8;
/** A cursor that hasn't moved for this long fades out. */
export const CURSOR_IDLE_MS = 5_000;

/** Cursor chat: at most this many characters. */
export const CHAT_MAX = 80;
/** A sent chat message stays up this long after Enter. */
export const CHAT_LINGER_MS = 5_000;
/** At most this many new chat messages per connection per minute. */
export const CHAT_PER_MIN = 12;

/** Emoji reactions: at most this many per connection per 10 s window… */
export const REACT_PER_10S = 8;
/** …and this many per minute. */
export const REACT_PER_MIN = 40;
/** A reaction is shown only when it reaches us within this long of being made. */
export const REACT_FRESH_MS = 4_000;

/** The reactions on offer (a fixed set: the server refuses anything else). */
export const REACTIONS = [
	"👍",
	"❤️",
	"😮",
	"😂",
	"🔥",
	"🎉",
	"👀",
	"🙏",
] as const;
export type Reaction = (typeof REACTIONS)[number];

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/**
 * Anchor kinds, each with who may see an anchor of that kind:
 * - `all`: anyone who can open the trip (the plan's structure);
 * - `members`: trip members, never link guests (money, booking documents);
 * - `lookup`: decided per row by the server (private to-dos and expenses are
 *   never sent; receipts and "Hide from guests" media are members-only).
 */
export const ANCHOR_KINDS = {
	/** A timeline card (`item:<itemId>`). */
	item: "all",
	/**
	 * A day section on the timeline (`day:<dayId>`; one drawing of a day split
	 * across bands: `day:<dayId>_<firstItemId>`, `copyAnchorId`).
	 */
	day: "all",
	/** A day header (`dayh:<dayId>`, a drawing's: `dayh:<dayId>_<firstItemId>`). */
	dayh: "all",
	/** A leg row between two stops (`leg:<sel>`, e.g. `leg:l.<from>.<to>`). */
	leg: "all",
	/** An Outline row (`tree:<nodeId>`). */
	tree: "all",
	/** An Ideas bin row (`idea:<nodeId>`). */
	idea: "all",
	/** A centre tab (`tab:plan`…); `tab:money` is members-only. */
	tab: "all",
	/** A whole pane (`pane:plan`, `pane:outline`…); `pane:money` is members-only. */
	pane: "all",
	/** The inspector (`insp:<sel>`, e.g. `insp:i.<itemId>`). */
	insp: "all",
	/** A note block outside the editor itself (`note:<target>`). */
	note: "all",
	/** A to-do or shopping row (`list:<listItemId>`); private rows never travel. */
	list: "lookup",
	/** A media tile (`media:<attachmentId>`); receipts and hidden-from-guests ones are members-only. */
	media: "lookup",
	/** An expense row (`exp:<expenseId>`); private ones never travel. */
	exp: "lookup",
	/** A money section (`money:summary`, `money:balances`…). */
	money: "members",
	/** A budget line (`budget:<id>`). */
	budget: "members",
	/**
	 * FB-25: a cursor over someone's open menu (`menu:open`, fractions of the
	 * menu). Receivers resolve it to that person's menu ghost; with no ghost
	 * (a menu they may not see) it has nowhere to go and hides.
	 */
	menu: "all",
} as const satisfies Record<string, "all" | "members" | "lookup">;
export type AnchorKind = keyof typeof ANCHOR_KINDS;

/** `<kind>:<rest>`: a known kind, then ids, dots and dashes only (never markup). */
export const ANCHOR_ID_RE = /^([a-z]{2,8}):([A-Za-z0-9._-]{1,110})$/;
export const MAX_ANCHOR_ID = 120;

/**
 * One thing drawn more than once on the same screen: at the coarse lenses a
 * day that crosses two countries has a section (and a header) in each
 * country's band. Each drawing then carries its own anchor id,
 * `<id>_<copy>`, where `<copy>` names that drawing the same way on every
 * screen (a band's day: the first card it shows), so a cursor on the second
 * drawing lands on the second drawing. `_` never occurs in a plain anchor id
 * (uuids, sels, fixed words): the plain id is everything before it.
 */
export const ANCHOR_COPY_SEP = "_";

/** `id` qualified with the drawing `copy` (plain when there is none). */
export function copyAnchorId(
	id: string,
	copy: string | null | undefined,
): string {
	return copy ? `${id}${ANCHOR_COPY_SEP}${copy}` : id;
}

/** The plain id of an anchor id (the thing, whichever drawing of it). */
export function plainAnchorId(id: string): string {
	const i = id.indexOf(ANCHOR_COPY_SEP);
	return i < 0 ? id : id.slice(0, i);
}

export const CURSOR_VIS = ["all", "members"] as const;
export type CursorVis = (typeof CURSOR_VIS)[number];

/** The kind of an anchor id, or null when the id is malformed or its kind unknown. */
export function anchorKind(id: string): AnchorKind | null {
	if (id.length > MAX_ANCHOR_ID) return null;
	const m = ANCHOR_ID_RE.exec(id);
	const kind = m?.[1];
	return kind && Object.hasOwn(ANCHOR_KINDS, kind)
		? (kind as AnchorKind)
		: null;
}

/**
 * Who may see an anchor, from its id alone: `all`, `members`, `lookup` (the
 * server asks the database) or null (unknown: never sent).
 */
export function anchorPolicy(id: string): "all" | "members" | "lookup" | null {
	const kind = anchorKind(id);
	if (!kind) return null;
	if (
		(kind === "tab" || kind === "pane") &&
		plainAnchorId(id).slice(kind.length + 1) === "money"
	)
		return "members";
	return ANCHOR_KINDS[kind];
}

/** The stricter of two visibilities. */
export function stricterVis(a: CursorVis, b: CursorVis): CursorVis {
	return a === "members" || b === "members" ? "members" : "all";
}

const AnchorId = z
	.string()
	.max(MAX_ANCHOR_ID)
	.refine((s) => anchorKind(s) !== null, "unknown anchor");
const Fraction = z.number().finite().min(0).max(1);

export const MapAnchor = z.object({
	k: z.literal("map"),
	lng: z.number().finite().min(-180).max(180),
	lat: z.number().finite().min(-90).max(90),
});
export type MapAnchor = z.infer<typeof MapAnchor>;

/** Fractions of one anchored element's box. */
const ElementSpot = z.object({ id: AnchorId, fx: Fraction, fy: Fraction });

export const ElementAnchor = z.object({
	k: z.literal("el"),
	id: AnchorId,
	fx: Fraction,
	fy: Fraction,
	/**
	 * The nearest enclosing anchor (a card's day, a day's pane) with the same
	 * point in ITS box: receivers whose screen doesn't render the element (a
	 * day scrolled far away is only a placeholder) still place the cursor
	 * there, or its edge arrow.
	 */
	p: ElementSpot.optional(),
});
export type ElementAnchor = z.infer<typeof ElementAnchor>;

export const CursorAnchor = z.discriminatedUnion("k", [
	MapAnchor,
	ElementAnchor,
]);
export type CursorAnchor = z.infer<typeof CursorAnchor>;

/** Rounds an anchor for the wire (≈ 0.1 m on the map, 0.01 % of an element). */
export function roundAnchor(a: CursorAnchor): CursorAnchor {
	if (a.k === "map")
		return { k: "map", lng: round(a.lng, 6), lat: round(a.lat, 6) };
	return {
		k: "el",
		id: a.id,
		fx: round(a.fx, 4),
		fy: round(a.fy, 4),
		...(a.p
			? { p: { id: a.p.id, fx: round(a.p.fx, 4), fy: round(a.p.fy, 4) } }
			: {}),
	};
}

export function sameAnchor(
	a: CursorAnchor | null | undefined,
	b: CursorAnchor | null | undefined,
): boolean {
	if (!a || !b) return !a && !b;
	if (a.k === "map" && b.k === "map") return a.lng === b.lng && a.lat === b.lat;
	if (a.k === "el" && b.k === "el")
		return a.id === b.id && a.fx === b.fx && a.fy === b.fy;
	return false;
}

function round(v: number, digits: number): number {
	const f = 10 ** digits;
	return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// Chat text
// ---------------------------------------------------------------------------

/**
 * Cursor chat text as it may travel: no control, format (bidi overrides,
 * zero-width joiners are kept for emoji) or line-break characters, whitespace
 * collapsed, at most CHAT_MAX characters (by code point). Rendered as text only.
 */
export function cleanChatText(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const cleaned = raw
		// C0/C1 controls and line/paragraph separators → space.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
		// Bidi overrides/isolates and other invisible format marks (not ZWJ U+200D, emoji need it).
		.replace(
			/[\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
			"",
		)
		.replace(/\s+/g, " ")
		.trimStart();
	return [...cleaned].slice(0, CHAT_MAX).join("");
}

export const CursorChat = z.object({
	/** Increases with every new message (the rate limit counts these). */
	n: z
		.number()
		.int()
		.min(0)
		.max(2 ** 31),
	text: z.string().max(CHAT_MAX * 4),
});
export type CursorChat = z.infer<typeof CursorChat>;

// ---------------------------------------------------------------------------
// Awareness fields
// ---------------------------------------------------------------------------

/**
 * `cursor` on the channel doc. `a: null` = hidden (fades out). `m` is the
 * pointer: `touch` never hovers, it sends a tap (`tap` increases per tap) and
 * receivers show a ripple. `v` is who may see the anchor (server-enforced).
 */
export const AwarenessCursor = z.object({
	a: CursorAnchor.nullable(),
	v: z.enum(CURSOR_VIS),
	m: z.enum(["mouse", "touch"]),
	tap: z
		.number()
		.int()
		.min(0)
		.max(2 ** 31)
		.optional(),
	chat: CursorChat.nullable().optional(),
});
export type AwarenessCursor = z.infer<typeof AwarenessCursor>;

/** The latest emoji reaction (`n` increases per reaction; receivers float the new one). */
export const AwarenessReact = z.object({
	n: z
		.number()
		.int()
		.min(0)
		.max(2 ** 31),
	e: z.enum(REACTIONS),
	a: CursorAnchor,
	v: z.enum(CURSOR_VIS),
});
export type AwarenessReact = z.infer<typeof AwarenessReact>;

/** The user id this client is following (drives "Audrey is following you"). */
export const AwarenessFollowing = z
	.string()
	.regex(/^[A-Za-z0-9_-]{1,64}$/)
	.nullable();

/** Spotlight (FB-17b): "Ask everyone to follow me". `id` is new per spotlight. */
export const AwarenessSpotlight = z
	.object({ id: z.string().regex(/^[a-z0-9]{6,24}$/) })
	.nullable();
export type AwarenessSpotlight = z.infer<typeof AwarenessSpotlight>;

/** A short random id (spotlights, tests). */
export function randomId(len = 12): string {
	const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
	let s = "";
	const bytes = new Uint8Array(len);
	globalThis.crypto.getRandomValues(bytes);
	for (const b of bytes) s += abc[b % abc.length];
	return s;
}

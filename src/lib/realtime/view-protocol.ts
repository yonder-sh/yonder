/**
 * Follow + collaboration polish (FEEDBACK-4: FB-21…FB-25): the awareness
 * fields that carry what someone is looking at beyond their URL, and what
 * they are doing with their hands. Isomorphic: no DOM, no Node.
 *
 * Every piece of view state is either in the URL (linkable: `view.path`) or
 * here, ephemeral, on the trip's channel awareness:
 * - `view.ui` (FB-21a/d): plan folds, the lists/money sub-views, the open
 *   note… Small, low-frequency; it rides with `view` (debounced).
 * - `cam` (FB-22): the map camera (center, zoom, bearing, pitch, globe) and
 *   the size of the area it frames, so a follower can FIT the same view.
 * - `media` (FB-21c): the open lightbox / PDF item and video play state.
 * - `drag` (FB-23): what I am dragging and where it would land.
 * - `form` (FB-24): the editor / dialog I have open (never field values).
 * - `menu` (FB-25): my open context / ⋯ menu as plain-text labels.
 *
 * The collab server validates each one with these schemas (`collab/cursors.ts`),
 * rate-limits it per connection, drops anything anchored on a private thing
 * (the FB-17a lookups) and strips members-only ones before they reach a link
 * guest. Receivers parse again and act only on ids they can see themselves.
 */
import { z } from "zod";
import {
	anchorKind,
	CURSOR_VIS,
	type CursorVis,
	MAX_ANCHOR_ID,
} from "./cursor-protocol";

// ---------------------------------------------------------------------------
// Rate limits (per connection; over them the previous value stays)
// ---------------------------------------------------------------------------

/** Token buckets: a burst, refilled per second. */
export const RATES = {
	/** `view` (path + ui). The client debounces it at 250 ms. */
	view: { burst: 20, perS: 5 },
	/** `cam`: the leader sends ~8 Hz while the map moves. */
	cam: { burst: 24, perS: 12 },
	/** `media`: open / next / close / play / pause / seek. */
	media: { burst: 12, perS: 4 },
	/** `drag`: start, each new drop target, end. */
	drag: { burst: 30, perS: 12 },
	/** `form`: open, the field in focus, close. */
	form: { burst: 12, perS: 3 },
	/** `menu`: open, the hovered entry, close. */
	menu: { burst: 30, perS: 12 },
} as const satisfies Record<string, { burst: number; perS: number }>;
export type RateField = keyof typeof RATES;

// ---------------------------------------------------------------------------
// view.ui (FB-21a, FB-21d)
// ---------------------------------------------------------------------------

/** A fold / band / block key: ids, visit keys (`<rep>#<n>`), `|` and `:`. */
export const UI_KEY_RE = /^[A-Za-z0-9:#._|>-]{1,120}$/;
/** At most this many keys per fold list (more are dropped by the sender). */
export const MAX_UI_KEYS = 48;
/** A serialized `view.ui` above this is dropped whole by the server. */
export const MAX_UI_JSON = 3_000;

const Keys = z.array(z.string().regex(UI_KEY_RE)).max(MAX_UI_KEYS);
const Uuid = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** The Plan's folds (FB-21a). Keys are the Plan's own entry keys. */
export const PlanFolds = z.object({
	/** Opened "N days elsewhere" folds (`fold:<dayId>`). */
	of: Keys.optional(),
	/** Collapsed country / city bands (`band:<visitKey>`). */
	cb: Keys.optional(),
	/** Every band collapsed ("Collapse all"; `cb` is then ignored). */
	ca: z.literal(1).optional(),
	/** Collapsed area blocks (`<dayId>|<visitKey>`). */
	ck: Keys.optional(),
	/** Opened per-day stretch folds (`<daySectionKey>|<firstItemId>`). */
	os: Keys.optional(),
});
export type PlanFolds = z.infer<typeof PlanFolds>;

/** Short enum-like values (sort orders, groupings, sub-views). */
const Word = z.string().regex(/^[a-z0-9-]{1,24}$/);
/** At most this many fields in one flat part. */
export const MAX_UI_FIELDS = 12;

/**
 * A flat part: a few named switches of one screen (`group: "place"`,
 * `near: true`, `who: <memberId>`). Names are short camel-case words; values
 * booleans, short words or uuids — never free text.
 */
const Flat = z
	.record(
		z.string().regex(/^[a-z][a-zA-Z]{0,15}$/),
		z.union([z.boolean(), Word, Uuid]),
	)
	.refine((r) => Object.keys(r).length <= MAX_UI_FIELDS, "too many fields");

/**
 * Ephemeral view state beyond the URL. Every part is optional: a part is
 * present while the component that owns it is on screen. `money` never
 * reaches a link guest (`guestView`).
 */
export const ViewUi = z.object({
	plan: PlanFolds.optional(),
	/** Lists (FB-21d): the list, grouping, "Near", dropped rows, the inspector's scope. */
	lists: Flat.optional(),
	/** Money (FB-21d): the breakdown's grouping, the budget view. Members only. */
	money: Flat.optional(),
	/** Media (FB-21d): the inspector's scope and filter. */
	media: Flat.optional(),
	/** Notes (FB-21d): the inspector's "This visit only". */
	notes: Flat.optional(),
	/** The map (FB-21d): the layer panel, what it shows, the day mode. */
	map: Flat.optional(),
	/** The Outline (FB-21d): its level, the Ideas bin and its sort. */
	outline: Flat.optional(),
	/** The Places tab (docs/PLACES.md): the Rate feed's card in view. */
	places: Flat.optional(),
});
export type ViewUi = z.infer<typeof ViewUi>;
/** The flat parts (`<part>.<field>` paths). */
export type FlatPart = Exclude<keyof ViewUi, "plan">;
export type FlatValue = boolean | string;

/** A `view.ui` as it may travel: validated and small, else null. */
export function cleanViewUi(raw: unknown): ViewUi | null {
	const r = ViewUi.safeParse(raw);
	if (!r.success) return null;
	try {
		if (JSON.stringify(r.data).length > MAX_UI_JSON) return null;
	} catch {
		return null;
	}
	return r.data;
}

/**
 * My `view.ui` for the wire: each part that validates, in a fixed order,
 * as long as the whole stays under MAX_UI_JSON (a part that would overflow
 * it is left out rather than losing everything).
 */
export function fitViewUi(parts: Record<string, unknown>): ViewUi {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(ViewUi.shape).sort()) {
		if (parts[key] === undefined) continue;
		const next = cleanViewUi({ ...out, [key]: parts[key] });
		if (next) out[key] = (next as Record<string, unknown>)[key];
	}
	return out as ViewUi;
}

/** Keys for the wire: at most MAX_UI_KEYS valid ones, sorted (stable JSON). */
export function wireKeys(keys: Iterable<string>): string[] {
	const out: string[] = [];
	for (const k of keys) {
		if (UI_KEY_RE.test(k)) out.push(k);
	}
	return out.sort().slice(0, MAX_UI_KEYS);
}

/**
 * The Plan's folds for the wire. `bands` are every band on screen: when all
 * of them are collapsed it says so (`ca`) instead of listing them.
 */
export function encodePlanFolds(s: {
	openFolds: Iterable<string>;
	collapsedBands: ReadonlySet<string>;
	collapsedBlocks: Iterable<string>;
	openStretch: Iterable<string>;
	bands: readonly string[];
}): PlanFolds {
	const all =
		s.bands.length > 0 && s.bands.every((b) => s.collapsedBands.has(b));
	const out: PlanFolds = {};
	const of = wireKeys(s.openFolds);
	const cb = all ? [] : wireKeys(s.collapsedBands);
	const ck = wireKeys(s.collapsedBlocks);
	const os = wireKeys(s.openStretch);
	if (of.length) out.of = of;
	if (all) out.ca = 1;
	if (cb.length) out.cb = cb;
	if (ck.length) out.ck = ck;
	if (os.length) out.os = os;
	return out;
}

/** The fold sets a follower applies (`bands` = the bands on ITS screen). */
export function decodePlanFolds(
	f: PlanFolds,
	bands: readonly string[],
): {
	openFolds: Set<string>;
	collapsedBands: Set<string>;
	collapsedBlocks: Set<string>;
	openStretch: Set<string>;
} {
	return {
		openFolds: new Set(f.of ?? []),
		collapsedBands: new Set(f.ca ? bands : (f.cb ?? [])),
		collapsedBlocks: new Set(f.ck ?? []),
		openStretch: new Set(f.os ?? []),
	};
}

// ---------------------------------------------------------------------------
// cam (FB-22)
// ---------------------------------------------------------------------------

export const MAX_ZOOM = 22;

/**
 * The map camera. `c` is the lng/lat at the centre of the part of the map
 * the leader can actually see (not under the inspector or the sheet); `w`×`h`
 * is that part's size in CSS px. `g` is the globe projection. `n` increases
 * with every update (a follower eases on each new one).
 */
export const AwarenessCam = z.object({
	c: z.tuple([
		z.number().finite().min(-180).max(180),
		z.number().finite().min(-90).max(90),
	]),
	z: z.number().finite().min(0).max(MAX_ZOOM),
	b: z.number().finite().min(-360).max(360),
	p: z.number().finite().min(0).max(85),
	g: z.boolean(),
	w: z.number().int().min(40).max(10_000),
	h: z.number().int().min(40).max(10_000),
	n: z
		.number()
		.int()
		.min(0)
		.max(2 ** 31),
});
export type AwarenessCam = z.infer<typeof AwarenessCam>;

/**
 * Fit the VIEW, not the zoom number: the follower's zoom so that its visible
 * area (fw × fh px) shows at least what the leader's (lw × lh) shows. The
 * visible ground span at zoom z is size / 2^z (mercator and globe alike), so
 * z' = z + log2(min(fw / lw, fh / lh)). Clamped to [0, MAX_ZOOM].
 */
export function followZoom(
	leader: { z: number; w: number; h: number },
	follower: { w: number; h: number },
): number {
	const lw = Math.max(1, leader.w);
	const lh = Math.max(1, leader.h);
	const fw = Math.max(1, follower.w);
	const fh = Math.max(1, follower.h);
	const z = leader.z + Math.log2(Math.min(fw / lw, fh / lh));
	if (!Number.isFinite(z)) return leader.z;
	return Math.min(MAX_ZOOM, Math.max(0, z));
}

/** Rounds a camera for the wire (≈ 1 cm; zoom to 1/1000). */
export function roundCam(c: AwarenessCam): AwarenessCam {
	const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
	return {
		c: [r(c.c[0], 6), r(c.c[1], 6)],
		z: r(c.z, 3),
		b: r(c.b, 2),
		p: r(c.p, 2),
		g: c.g,
		w: Math.round(c.w),
		h: Math.round(c.h),
		n: c.n,
	};
}

/** True when two cameras frame the same view (a resend of the same thing). */
export function sameCam(
	a: AwarenessCam | null | undefined,
	b: AwarenessCam | null | undefined,
): boolean {
	if (!a || !b) return !a && !b;
	return (
		a.c[0] === b.c[0] &&
		a.c[1] === b.c[1] &&
		a.z === b.z &&
		a.b === b.b &&
		a.p === b.p &&
		a.g === b.g &&
		a.w === b.w &&
		a.h === b.h
	);
}

// ---------------------------------------------------------------------------
// media (FB-21c)
// ---------------------------------------------------------------------------

/** A follower's video catches up when it is more than this far off (s). */
export const VIDEO_DRIFT_S = 1.5;

export const MediaPlay = z.object({
	s: z.enum(["play", "pause"]),
	/** Playback position when the event happened (s). */
	t: z.number().finite().min(0).max(86_400),
	/** Increases with every play / pause / seek. */
	n: z
		.number()
		.int()
		.min(0)
		.max(2 ** 31),
});
export type MediaPlay = z.infer<typeof MediaPlay>;

/**
 * The open media: `k` `lb` (the lightbox: photos, videos, embeds) or `pdf`.
 * `p` only for uploaded videos. `v` is who may see the item (server-set).
 */
export const AwarenessMedia = z.object({
	id: Uuid,
	k: z.enum(["lb", "pdf"]),
	p: MediaPlay.nullable().optional(),
	v: z.enum(CURSOR_VIS),
});
export type AwarenessMedia = z.infer<typeof AwarenessMedia>;

/** Where a follower's video should be now, `sinceS` after the event reached it. */
export function expectedVideoTime(p: MediaPlay, sinceS: number): number {
	return p.s === "play" ? p.t + Math.max(0, sinceS) : p.t;
}

/** True when a follower's video must seek to catch up. */
export function videoOff(current: number, expected: number): boolean {
	return Math.abs(current - expected) > VIDEO_DRIFT_S;
}

// ---------------------------------------------------------------------------
// Anchor ids for drags, forms and menus
// ---------------------------------------------------------------------------

const AnchorIdOf = (kinds: readonly string[]) =>
	z
		.string()
		.max(MAX_ANCHOR_ID)
		.refine((s) => {
			const k = anchorKind(s);
			return k !== null && kinds.includes(k);
		}, "anchor kind");

// ---------------------------------------------------------------------------
// drag (FB-23)
// ---------------------------------------------------------------------------

/** What can be dragged: plan cards, outline / ideas rows, list rows. */
export const DRAG_KINDS = ["item", "tree", "idea", "list"] as const;
/** Where it can land. */
export const DROP_KINDS = [
	"item",
	"day",
	"dayh",
	"tree",
	"idea",
	"list",
	"pane",
] as const;
/** A peer's drag with no change for this long is dropped by receivers. */
export const DRAG_IDLE_MS = 20_000;

export const AwarenessDrag = z.object({
	/** The dragged thing (`item:<id>`, `tree:<nodeId>`, `list:<id>`…). */
	a: AnchorIdOf(DRAG_KINDS),
	/** Where it would land now: before / after an element, or at a container's end. */
	o: z
		.object({
			id: AnchorIdOf(DROP_KINDS),
			w: z.enum(["before", "after", "end"]),
		})
		.nullable(),
	v: z.enum(CURSOR_VIS),
});
export type AwarenessDrag = z.infer<typeof AwarenessDrag>;

// ---------------------------------------------------------------------------
// form (FB-24)
// ---------------------------------------------------------------------------

export const FORM_KINDS = [
	"flight",
	"expense",
	"item",
	"place",
	"stay",
	"budget",
	"list",
	"hours",
	"shift",
	"transit",
	"settings",
] as const;
export type FormKind = (typeof FORM_KINDS)[number];

/** Money forms: members only, whatever the client says. */
export const MONEY_FORMS: readonly FormKind[] = ["expense", "budget"];

/** What a form is about (the chip lands on that element). */
export const FORM_TARGET_KINDS = [
	"item",
	"dayh",
	"day",
	"tree",
	"leg",
	"list",
	"exp",
	"budget",
	"money",
] as const;

/** A field label: at most this many characters ("· Seats"). */
export const FORM_FIELD_MAX = 32;

export const AwarenessForm = z.object({
	k: z.enum(FORM_KINDS),
	m: z.enum(["add", "edit"]),
	/** The thing it edits / adds to (an anchor id), when there is one. */
	t: AnchorIdOf(FORM_TARGET_KINDS).nullable().optional(),
	/** The field in focus (a label; cleaned, ≤ FORM_FIELD_MAX). */
	f: z
		.string()
		.max(FORM_FIELD_MAX * 4)
		.optional(),
	v: z.enum(CURSOR_VIS),
});
export type AwarenessForm = z.infer<typeof AwarenessForm>;

// ---------------------------------------------------------------------------
// menu (FB-25)
// ---------------------------------------------------------------------------

export const MENU_MAX_ITEMS = 15;
export const MENU_LABEL_MAX = 40;
/** The anchor id a cursor over an open menu travels as (fractions of the menu). */
export const MENU_CURSOR_ID = "menu:open";

/** Menus open on these (the element the menu belongs to). */
const MENU_ANCHOR_KINDS = [
	"item",
	"day",
	"dayh",
	"leg",
	"tree",
	"idea",
	"list",
	"media",
	"exp",
	"budget",
	"pane",
	"tab",
	"insp",
	"money",
] as const;

const Offset = z.number().finite().min(-3).max(4);

export const AwarenessMenu = z.object({
	/** The element it belongs to. */
	a: AnchorIdOf(MENU_ANCHOR_KINDS),
	/** The menu's top-left corner in fractions of that element's box. */
	fx: Offset,
	fy: Offset,
	/** Its entries (plain text; "" is a separator). */
	items: z
		.array(z.string().max(MENU_LABEL_MAX * 4))
		.min(1)
		.max(MENU_MAX_ITEMS),
	/** The hovered / focused entry, or -1. */
	hi: z
		.number()
		.int()
		.min(-1)
		.max(MENU_MAX_ITEMS - 1),
	v: z.enum(CURSOR_VIS),
});
export type AwarenessMenu = z.infer<typeof AwarenessMenu>;

/**
 * Plain text as it may travel in a label: no controls, bidi or invisible
 * format marks, whitespace collapsed, trimmed, at most `max` code points.
 */
export function cleanLabel(raw: unknown, max: number): string {
	if (typeof raw !== "string") return "";
	const cleaned = raw
		// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
		.replace(
			/[\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();
	return [...cleaned].slice(0, max).join("");
}

/** A menu's labels as they may travel (capped, cleaned; separators kept as ""). */
export function cleanMenuItems(items: readonly unknown[]): string[] {
	return items
		.slice(0, MENU_MAX_ITEMS)
		.map((s) => cleanLabel(s, MENU_LABEL_MAX));
}

// ---------------------------------------------------------------------------
// Guests (FB-17a): what a link guest may receive
// ---------------------------------------------------------------------------

/** The visibility carried by a parsed field (`all` when it doesn't say). */
export function fieldVis(v: unknown): CursorVis {
	return v === "all" ? "all" : "members";
}

/** Removes `itab=money` (the inspector's Money tab) from a view path. */
export function dropMoneyParams(path: string): string {
	return path
		.replace(/([?&])(?:tab|itab)=money(&|$)/g, (_m, a: string, b: string) =>
			b ? a : "",
		)
		.replace(/([?&])(?:tab|itab)=money(&|$)/g, (_m, a: string, b: string) =>
			b ? a : "",
		)
		.replace(/[?&]$/, "");
}

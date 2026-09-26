/**
 * Follow + collaboration polish (FEEDBACK-4: FB-21…FB-25): the awareness
 * fields that carry what someone is looking at beyond their URL, and what
 * they are doing with their hands. Isomorphic: no DOM, no Node.
 *
 * Every piece of view state is either in the URL (linkable: `view.path`) or
 * here, ephemeral, on the trip's channel awareness:
 * - `view.ui` (FB-21a/d): every screen's view state beyond the URL (plan
 *   folds, sub-tabs, open sections, groupings, the open note…) as small
 *   `<part>.<name>` keys. Low-frequency; it rides with `view` (debounced).
 * - `cam` (FB-22): the map camera (center, zoom, bearing, pitch, globe) and
 *   the size of the area it frames, so a follower can FIT the same view.
 * - `media` (FB-21c): the open lightbox / PDF item and video play state.
 * - `drag` (FB-23): what I am dragging and where it would land.
 * - `form` (FB-24): the editor / dialog I have open (never field values).
 * - `menu` (FB-25): my open context / ⋯ menu as plain-text labels.
 * - `look`: what I see of each scrolling list (its top and bottom items)
 *   and whether I'm on the map or the panel, so a follower sees the same.
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
	/** `look`: the client sends at most every LOOK_SEND_MS while scrolling. */
	look: { burst: 16, perS: 6 },
} as const satisfies Record<string, { burst: number; perS: number }>;
export type RateField = keyof typeof RATES;

// ---------------------------------------------------------------------------
// view.ui (FB-21a, FB-21d)
// ---------------------------------------------------------------------------

/** A fold / band / block key: ids, visit keys (`<rep>#<n>`), `|` and `:`. */
export const UI_KEY_RE = /^[A-Za-z0-9:#._|>-]{1,120}$/;
/** At most this many keys per fold list (more are dropped by the sender). */
export const MAX_UI_KEYS = 48;
/** A serialized `view.ui` is cut to this (the least recently changed keys go). */
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

/**
 * Everything else a screen shows beyond the URL, as `<part>.<name>` keys
 * (`lists.group`, `plan.split.open`) with small values: a boolean, a number,
 * a short word or id, null, or a short list of ids. Strings never carry
 * free text (no spaces, no markup), so a typed value can't travel here.
 */
export const UI_PATH_RE = /^[a-z][a-zA-Z0-9]{0,23}(\.[a-zA-Z0-9-]{1,40}){1,2}$/;
/** A string value: a word, an id, an anchor id (`list:<id>`) or empty. */
export const UI_STR_RE = /^[A-Za-z0-9:#._|>-]{0,120}$/;
/** At most this many keys (the Plan's folds count as one). */
export const MAX_UI_ENTRIES = 64;

export type UiValue = boolean | number | string | null | readonly string[];

/** One value as it may travel. */
export const UiValue = z.union([
	z.boolean(),
	z.number().finite().min(-1e9).max(1e9),
	z.string().regex(UI_STR_RE),
	z.null(),
	Keys,
]);

/** `view.ui`: the Plan's folds, and every other key (see UI_PATH_RE). */
export type ViewUi = { plan?: PlanFolds } & { [path: string]: unknown };
export const ViewUi = z
	.object({ plan: PlanFolds.optional() })
	.catchall(UiValue) as unknown as z.ZodType<ViewUi>;

/** Members only, whoever sends it: the money views (`money.*`). */
export function isMembersPath(path: string): boolean {
	return path.startsWith("money.");
}

/**
 * A `view.ui` as it may travel: each key checked on its own (a bad one is
 * left out, never the whole), then cut from the end to MAX_UI_ENTRIES and
 * MAX_UI_JSON (the sender puts its most recently changed keys first).
 */
export function cleanViewUi(raw: unknown): ViewUi {
	const out: Record<string, unknown> = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	let n = 0;
	for (const [path, value] of Object.entries(raw)) {
		if (n >= MAX_UI_ENTRIES) break;
		if (path === "plan") {
			const f = PlanFolds.safeParse(value);
			if (!f.success) continue;
			out.plan = f.data;
		} else {
			if (path.length > 64 || !UI_PATH_RE.test(path)) continue;
			const v = UiValue.safeParse(value);
			if (!v.success) continue;
			out[path] = v.data;
		}
		n += 1;
	}
	return capUi(out);
}

/** Drops keys from the end until the JSON fits MAX_UI_JSON. */
function capUi(ui: Record<string, unknown>): ViewUi {
	let json = JSON.stringify(ui);
	if (json.length <= MAX_UI_JSON) return ui;
	const keys = Object.keys(ui);
	const out = { ...ui };
	while (keys.length && json.length > MAX_UI_JSON) {
		const k = keys.pop() as string;
		delete out[k];
		json = JSON.stringify(out);
	}
	return out;
}

/**
 * My `view.ui` for the wire: the most recently changed keys first, each one
 * that validates, as long as the whole fits (the least recently changed are
 * left out rather than losing everything).
 */
export function fitViewUi(
	entries: Readonly<Record<string, unknown>>,
	at: Readonly<Record<string, number>> = {},
): ViewUi {
	const keys = Object.keys(entries).sort(
		(a, b) => (at[b] ?? 0) - (at[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
	);
	const out: Record<string, unknown> = {};
	let size = 2;
	let n = 0;
	for (const key of keys) {
		if (n >= MAX_UI_ENTRIES) break;
		const one = cleanViewUi({ [key]: entries[key] });
		if (!(key in one)) continue;
		const add = JSON.stringify({ [key]: one[key] }).length - 1;
		if (size + add > MAX_UI_JSON) continue;
		out[key] = one[key];
		size += add;
		n += 1;
	}
	return out;
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
// look: the part of each scrolling list I see, and map or panel
// ---------------------------------------------------------------------------

/** The client sends `look` at most this often (ms). */
export const LOOK_SEND_MS = 200;
/** At most this many scrolling areas. */
export const MAX_LOOK_RANGES = 4;

/**
 * Where my attention is: the map or the panel (a desktop, from my last
 * click, wheel or touch), or a phone's sheet: at its peek (`map`), half
 * or full. A phone follower's sheet goes there.
 */
export const LOOK_FOCUS = ["map", "panel", "half", "full"] as const;
export type LookFocus = (typeof LOOK_FOCUS)[number];

/** Anchors that are chrome (a whole pane, a tab, a menu), not an item in a list. */
const CHROME_KINDS: readonly string[] = ["pane", "tab", "menu", "insp"];

/** True for an item a scroll can aim at (a card, a row, a section). */
export function isItemAnchor(id: string): boolean {
	const k = anchorKind(id);
	return k !== null && !CHROME_KINDS.includes(k);
}

const ItemAnchorId = z
	.string()
	.max(MAX_ANCHOR_ID)
	.refine(isItemAnchor, "item anchor");

/** An item and how far down it an edge of my view falls (0 = its top). */
const LookSpot = z.object({
	id: ItemAnchorId,
	fy: z.number().finite().min(0).max(1),
});

/** One scrolling area: the items at the top and bottom edges of what I see. */
export const LookRange = z.object({
	t: LookSpot,
	b: LookSpot,
	/** Who may see it (server-set). */
	v: z.enum(CURSOR_VIS).optional(),
});
export type LookRange = z.infer<typeof LookRange>;

export const AwarenessLook = z.object({
	f: z.enum(LOOK_FOCUS),
	r: z.array(LookRange).max(MAX_LOOK_RANGES),
});
export type AwarenessLook = z.infer<typeof AwarenessLook>;

/** True when two looks say the same thing. */
export function sameLook(
	a: AwarenessLook | null | undefined,
	b: AwarenessLook | null | undefined,
): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
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

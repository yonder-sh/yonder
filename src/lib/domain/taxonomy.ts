/**
 * Node types, place categories, pin colours, priorities and Time Needed
 * (SPEC §7.1–§7.3, D22). Copied from the TS const in
 * `spikes/research/CATEGORIES.md` §6, with the spec's additions: the `other`
 * category, default durations and the Itinerary's Hotel → `lodging` mapping.
 *
 * Colour carries the pin **family** and the icon carries the exact
 * **category** (22 hues would be unreadable). Every family was checked for
 * colour-vision deficiency in CATEGORIES.md §3; nothing depends on hue alone.
 *
 * The enum VALUES live in `src/lib/schemas/enums.ts` (the database builds its
 * Postgres enums from them); this file adds labels, icons and colours, and the
 * `satisfies` clauses keep both lists in step. Icons are verified lucide-react
 * 1.47.0 exports (some older names are gone in 1.x: use `BuildingComplex`,
 * `TrainFront`, `TreePalm`, never `Building2`, `Train`, `Palmtree`).
 */
import {
	Amphora,
	Bath,
	BedDouble,
	Binoculars,
	BuildingComplex,
	Camera,
	Coffee,
	Flag,
	Houses,
	Landmark,
	type LucideIcon,
	Map as MapIcon,
	MapPin,
	Martini,
	MoonStar,
	Mountain,
	PartyPopper,
	Plane,
	Ship,
	ShoppingBag,
	Store,
	Ticket,
	TrainFront,
	TreePalm,
	Trees,
	Utensils,
	UtensilsCrossed,
} from "lucide-react";
import type { NodeType, PlaceCategory, Priority } from "@/lib/schemas/enums";

export type { NodeType, PlaceCategory, Priority };

/** A colour in both notations: OKLCH for CSS, hex for canvas and map paint. */
export interface Swatch {
	oklch: string;
	hex: string;
}

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/**
 * `rank` orders coarse → fine. Nesting follows rank (a child's rank must be ≥
 * its parent's, SPEC §7.1), so area-under-area and place-under-place are fine;
 * see `canNest` in `src/lib/engine/tree.ts`.
 *
 * Country, region and city use a warm stone ramp so they never compete with the
 * place families. Areas are drawn as labels or tinted polygons (fill at about
 * 0.18 opacity, `stroke` for outlines), not pins. A place uses its category's
 * family colour, so its `color` is null.
 */
export const NODE_TYPES = {
	country: {
		label: "Country",
		rank: 0,
		icon: Flag,
		color: { oklch: "oklch(0.32 0.02 60)", hex: "#3b3129" },
	},
	region: {
		label: "Region",
		rank: 1,
		icon: MapIcon,
		color: { oklch: "oklch(0.44 0.025 60)", hex: "#5d5045" },
	},
	city: {
		label: "City",
		rank: 2,
		icon: BuildingComplex,
		color: { oklch: "oklch(0.54 0.03 60)", hex: "#7c6b5d" },
	},
	area: {
		label: "Area",
		rank: 3,
		icon: Houses,
		color: {
			oklch: "oklch(0.87 0.14 100)",
			hex: "#ead65f",
			stroke: { oklch: "oklch(0.62 0.12 95)", hex: "#9d8519" },
		},
	},
	place: { label: "Place", rank: 4, icon: MapPin, color: null },
} as const satisfies Record<
	NodeType,
	{
		label: string;
		rank: number;
		icon: LucideIcon;
		color: (Swatch & { stroke?: Swatch }) | null;
	}
>;

// ---------------------------------------------------------------------------
// Pin colour families
// ---------------------------------------------------------------------------

const INK = "#1b1b1b";
const WHITE = "#ffffff";

/** `ink` is the glyph colour on the fill, chosen for ≥ 4.5:1 contrast. */
export const PIN_FAMILIES = {
	culture: {
		label: "Culture",
		oklch: "oklch(0.57 0.19 33)",
		hex: "#cf3b1d",
		ink: WHITE,
	},
	food: {
		label: "Food & drink",
		oklch: "oklch(0.77 0.155 72)",
		hex: "#f0a226",
		ink: INK,
	},
	nature: {
		label: "Nature",
		oklch: "oklch(0.66 0.14 158)",
		hex: "#2cab70",
		ink: INK,
	},
	water: {
		label: "Water",
		oklch: "oklch(0.74 0.11 228)",
		hex: "#54b8e1",
		ink: INK,
	},
	activity: {
		label: "Activities",
		oklch: "oklch(0.55 0.15 252)",
		hex: "#1c73c5",
		ink: WHITE,
	},
	shopping: {
		label: "Shopping",
		oklch: "oklch(0.58 0.17 345)",
		hex: "#bc4891",
		ink: WHITE,
	},
	nightlife: {
		label: "Nightlife",
		oklch: "oklch(0.40 0.17 305)",
		hex: "#5e218f",
		ink: WHITE,
	},
	lodging: {
		label: "Stay",
		oklch: "oklch(0.27 0.035 270)",
		hex: "#202638",
		ink: WHITE,
	},
	transit: {
		label: "Transit",
		oklch: "oklch(0.43 0.025 250)",
		hex: "#46515d",
		ink: WHITE,
	},
} as const satisfies Record<string, Swatch & { label: string; ink: string }>;
export type PinFamily = keyof typeof PIN_FAMILIES;

// ---------------------------------------------------------------------------
// Place categories
// ---------------------------------------------------------------------------

/** The sheet category each place category rolls up to. Filter chips match on the group. */
export const PLACE_GROUPS = {
	sight: "Sight",
	temple_shrine: "Temple/Shrine",
	museum: "Museum",
	nature: "Nature",
	food_drink: "Food/Drink",
	bar: "Bar",
	shopping: "Shopping",
	activity: "Activity",
	stay: "Stay",
	transit: "Transit",
} as const;
export type PlaceGroup = keyof typeof PLACE_GROUPS;

export interface CategoryDef {
	label: string;
	/** null: `other` belongs to no filter group. */
	group: PlaceGroup | null;
	family: PinFamily;
	icon: LucideIcon;
	/** Default item duration in minutes (SPEC §7.2). */
	defaultMin: number;
}

export const PLACE_CATEGORIES = {
	sight: {
		label: "Sight",
		group: "sight",
		family: "culture",
		icon: Camera,
		defaultMin: 60,
	},
	temple_shrine: {
		label: "Temple / Shrine",
		group: "temple_shrine",
		family: "culture",
		icon: Landmark,
		defaultMin: 45,
	},
	museum: {
		label: "Museum",
		group: "museum",
		family: "culture",
		icon: Amphora,
		defaultMin: 120,
	},
	viewpoint: {
		label: "Viewpoint",
		group: "sight",
		family: "culture",
		icon: Binoculars,
		defaultMin: 60,
	},
	nature: {
		label: "Nature",
		group: "nature",
		family: "nature",
		icon: Mountain,
		defaultMin: 120,
	},
	park: {
		label: "Park",
		group: "nature",
		family: "nature",
		icon: Trees,
		defaultMin: 60,
	},
	beach: {
		label: "Beach",
		group: "nature",
		family: "water",
		icon: TreePalm,
		defaultMin: 120,
	},
	onsen: {
		label: "Onsen / Spa",
		group: "nature",
		family: "water",
		icon: Bath,
		defaultMin: 90,
	},
	food_drink: {
		label: "Food & Drink",
		group: "food_drink",
		family: "food",
		icon: Utensils,
		defaultMin: 60,
	},
	restaurant: {
		label: "Restaurant",
		group: "food_drink",
		family: "food",
		icon: UtensilsCrossed,
		defaultMin: 75,
	},
	cafe: {
		label: "Café / Tea",
		group: "food_drink",
		family: "food",
		icon: Coffee,
		defaultMin: 45,
	},
	market: {
		label: "Market",
		group: "food_drink",
		family: "food",
		icon: Store,
		defaultMin: 60,
	},
	bar: {
		label: "Bar",
		group: "bar",
		family: "nightlife",
		icon: Martini,
		defaultMin: 90,
	},
	nightlife: {
		label: "Nightlife",
		group: "bar",
		family: "nightlife",
		icon: MoonStar,
		defaultMin: 120,
	},
	shopping: {
		label: "Shopping",
		group: "shopping",
		family: "shopping",
		icon: ShoppingBag,
		defaultMin: 60,
	},
	activity: {
		label: "Activity",
		group: "activity",
		family: "activity",
		icon: Ticket,
		defaultMin: 120,
	},
	event: {
		label: "Event",
		group: "activity",
		family: "activity",
		icon: PartyPopper,
		defaultMin: 120,
	},
	lodging: {
		label: "Stay",
		group: "stay",
		family: "lodging",
		icon: BedDouble,
		defaultMin: 30,
	},
	station: {
		label: "Station",
		group: "transit",
		family: "transit",
		icon: TrainFront,
		defaultMin: 0,
	},
	airport: {
		label: "Airport",
		group: "transit",
		family: "transit",
		icon: Plane,
		defaultMin: 0,
	},
	port: {
		label: "Ferry / Port",
		group: "transit",
		family: "transit",
		icon: Ship,
		defaultMin: 0,
	},
	other: {
		label: "Other",
		group: null,
		family: "transit",
		icon: MapPin,
		defaultMin: 60,
	},
} as const satisfies Record<PlaceCategory, CategoryDef>;

/** The category a node gets when it becomes a `place` (SPEC §7.1). */
export const DEFAULT_PLACE_CATEGORY: PlaceCategory = "other";

/** Default item duration for non-place nodes (SPEC §7.2); a place uses its category's. */
export const TYPE_DEFAULT_MIN = {
	country: 480,
	region: 480,
	city: 480,
	area: 180,
	place: PLACE_CATEGORIES.other.defaultMin,
} as const satisfies Record<NodeType, number>;

/** Sheet "Category" dropdown (and the Itinerary's Hotel) → node type and category. */
export const SHEET_CATEGORY_MAP = {
	Neighborhood: { type: "area" },
	Sight: { type: "place", category: "sight" },
	"Temple/Shrine": { type: "place", category: "temple_shrine" },
	Museum: { type: "place", category: "museum" },
	Nature: { type: "place", category: "nature" },
	"Food/Drink": { type: "place", category: "food_drink" },
	Bar: { type: "place", category: "bar" },
	Shopping: { type: "place", category: "shopping" },
	Activity: { type: "place", category: "activity" },
	Hotel: { type: "place", category: "lodging" },
} as const satisfies Record<
	string,
	{ type: NodeType; category?: PlaceCategory }
>;

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * Palette D "Green → red" (PLACES §1c, owner 2026-09-24): Must deep green,
 * Really want green, Want pale green, Sure neutral, Meh amber, Nah red. Every
 * step also differs in lightness and the label is always shown, so red-green
 * colour blindness still works. `bg`/`fg` fill a pill (a rating that stands
 * alone); `dot` is the 8px dot of the "dot + label" style in dense lists
 * (`PriorityDot`). `pinScale` lets priority drive pin size so colour stays
 * free for the category. Not rated is `null` (no row), never a tier.
 */
export const PRIORITIES = {
	must: {
		label: "Must",
		score: 5,
		light: { bg: "#0f5e38", fg: "#ffffff", dot: "#0f5e38" },
		dark: { bg: "#15803d", fg: "#ffffff", dot: "#34c472" },
		pinScale: 1.25,
		strike: false,
	},
	really_want: {
		label: "Really want",
		score: 4,
		light: { bg: "#2a8454", fg: "#ffffff", dot: "#2a8454" },
		dark: { bg: "#1d5e3e", fg: "#d6f5e3", dot: "#2a8454" },
		pinScale: 1.1,
		strike: false,
	},
	want: {
		label: "Want",
		score: 3,
		light: { bg: "#d3f0de", fg: "#1b5e3a", dot: "#9bd8b3" },
		dark: { bg: "#173b2a", fg: "#a8e8c4", dot: "#2f6f50" },
		pinScale: 1,
		strike: false,
	},
	sure_why_not: {
		label: "Sure, why not",
		score: 2,
		light: { bg: "#f0f0f2", fg: "#55586a", dot: "#cfd0d8" },
		dark: { bg: "#262626", fg: "#d4d4d4", dot: "#5c5c5c" },
		pinScale: 1,
		strike: false,
	},
	meh: {
		label: "Meh",
		score: 1,
		light: { bg: "#fde6cf", fg: "#9a4a0c", dot: "#f0a060" },
		dark: { bg: "#4a2c14", fg: "#ffc28a", dot: "#d98a40" },
		pinScale: 0.85,
		strike: false,
	},
	nah: {
		label: "Nah",
		score: 0,
		light: { bg: "#fbd6d6", fg: "#b3202e", dot: "#e0505c" },
		dark: { bg: "#4d1c22", fg: "#ff9ba3", dot: "#e0566a" },
		pinScale: 0.85,
		strike: true,
	},
} as const satisfies Record<
	Priority,
	{
		label: string;
		score: number;
		light: { bg: string; fg: string; dot: string };
		dark: { bg: string; fg: string; dot: string };
		pinScale: number;
		strike: boolean;
	}
>;

/** A rating level (the six tiers); also the colour band of a group score. */
export type PriorityLevel = Priority;

/**
 * The colour band of a GROUP SCORE chip (PLACES §1c): the same six colours as
 * the ratings. +5 and up Must, +3–4 Really want, +1–2 Want, 0 Sure, −1 Meh,
 * −2 and below Nah. Scores are sums of whole weights; a fraction floors
 * into the band below, and a non-number reads as 0.
 */
export function scoreTier(score: number): PriorityLevel {
	const s = Number.isNaN(score) ? 0 : Math.floor(score);
	if (s >= 5) return "must";
	if (s >= 3) return "really_want";
	if (s >= 1) return "want";
	if (s === 0) return "sure_why_not";
	if (s === -1) return "meh";
	return "nah";
}

/** Highest first. */
export const PRIORITY_ORDER = [
	"must",
	"really_want",
	"want",
	"sure_why_not",
	"meh",
	"nah",
] as const satisfies readonly Priority[];

export const SHEET_PRIORITY_MAP: Readonly<Record<string, Priority>> = {
	Must: "must",
	"Really want": "really_want",
	Want: "want",
	"Sure why not": "sure_why_not",
	Meh: "meh",
	Nah: "nah",
};

/**
 * The sheet's ranking key: `[max(score), sum(score)]` over the members who
 * rated. Unrated entries are ignored; a node nobody rated gives `[-1, -1]` so it
 * sorts after every rated one (`nah` = 0 still counts as a rating).
 */
export function priorityRank(
	ratings: Iterable<Priority | null | undefined>,
): [max: number, sum: number] {
	let max = -1;
	let sum = 0;
	let any = false;
	for (const r of ratings) {
		if (r == null) continue;
		const s = PRIORITIES[r].score;
		any = true;
		sum += s;
		if (s > max) max = s;
	}
	return any ? [max, sum] : [-1, -1];
}

/**
 * Comparator for the Ideas bin and every "sort by priority" (SPEC §7.3): max
 * score desc, then sum desc, then name. `priorities` is the graph's
 * `Record<memberId, Priority>`; pass `memberIds` to rank by a subset (the "who"
 * filter).
 */
export function compareByPriority(
	a: { name: string; priorities: Readonly<Record<string, Priority>> },
	b: { name: string; priorities: Readonly<Record<string, Priority>> },
	memberIds?: readonly string[],
): number {
	const pick = (p: Readonly<Record<string, Priority>>) =>
		memberIds ? memberIds.map((m) => p[m]) : Object.values(p);
	const [amax, asum] = priorityRank(pick(a.priorities));
	const [bmax, bsum] = priorityRank(pick(b.priorities));
	return bmax - amax || bsum - asum || a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------------------
// Time Needed
// ---------------------------------------------------------------------------

/** Time spent AT the place (not travel). `minutes` feeds `nodes.time_needed_min`. */
export const TIME_NEEDED = {
	quick_stop: {
		label: "Quick stop",
		short: "30m",
		minutes: 30,
		light: { bg: "#e4f6fa", fg: "#16556a" },
		dark: { bg: "#1c3138", fg: "#a9d7e2" },
	},
	an_hour: {
		label: "An hour",
		short: "1h",
		minutes: 60,
		light: { bg: "#c4e9f2", fg: "#054a5e" },
		dark: { bg: "#1a434f", fg: "#b9e7f3" },
	},
	few_hours: {
		label: "Few hours",
		short: "2–3h",
		minutes: 150,
		light: { bg: "#93d3e6", fg: "#0a3341" },
		dark: { bg: "#1b5b6e", fg: "#d9f4fb" },
	},
	half_day: {
		label: "Half day",
		short: "½ day",
		minutes: 240,
		light: { bg: "#227995", fg: "#fcfcfc" },
		dark: { bg: "#2e93b1", fg: "#02141b" },
	},
	full_day: {
		label: "Full day",
		short: "Full day",
		minutes: 540,
		light: { bg: "#0a5470", fg: "#fcfcfc" },
		dark: { bg: "#64c7e2", fg: "#02141b" },
	},
} as const;
export type TimeNeeded = keyof typeof TIME_NEEDED;

export const SHEET_TIME_MAP: Readonly<Record<string, TimeNeeded>> = {
	"Quick stop": "quick_stop",
	"An hour": "an_hour",
	"Few hours": "few_hours",
	"Half day": "half_day",
	"Full day": "full_day",
};

/**
 * The Time Needed bucket for a stored `timeNeededMin`: an exact match, else
 * the nearest bucket (ties go to the shorter one). null for null.
 */
export function timeNeededOf(
	minutes: number | null | undefined,
): TimeNeeded | null {
	if (minutes == null || !Number.isFinite(minutes)) return null;
	let best: TimeNeeded | null = null;
	let bestDiff = Number.POSITIVE_INFINITY;
	for (const [key, def] of Object.entries(TIME_NEEDED) as [
		TimeNeeded,
		(typeof TIME_NEEDED)[TimeNeeded],
	][]) {
		const diff = Math.abs(def.minutes - minutes);
		if (diff < bestDiff) {
			best = key;
			bestDiff = diff;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A new item's duration: `node.timeNeededMin ?? categoryDefault ?? typeDefault` (SPEC §7.2). */
export function defaultItemDuration(node: {
	type: NodeType;
	category?: PlaceCategory | null;
	timeNeededMin?: number | null;
}): number {
	if (node.timeNeededMin != null) return node.timeNeededMin;
	if (node.type === "place" && node.category)
		return PLACE_CATEGORIES[node.category].defaultMin;
	return TYPE_DEFAULT_MIN[node.type];
}

/** The glyph for a node: its category icon for places, else its type icon. */
export function nodeIcon(node: {
	type: NodeType;
	category?: PlaceCategory | null;
}): LucideIcon {
	if (node.type === "place")
		return PLACE_CATEGORIES[node.category ?? DEFAULT_PLACE_CATEGORY].icon;
	return NODE_TYPES[node.type].icon;
}

export interface PinStyle {
	/** Fill (hex, for map paint). */
	fill: string;
	/** Fill (OKLCH, for CSS). */
	fillOklch: string;
	/** Glyph colour on the fill. */
	ink: string;
	/** The pin family for places, null for coarser nodes (stone ramp / area sand). */
	family: PinFamily | null;
	icon: LucideIcon;
}

/**
 * Pin fill, glyph ink and icon for a node. Places use their category family;
 * country, region and city use the stone ramp, area the sand label colour.
 */
export function pinStyle(node: {
	type: NodeType;
	category?: PlaceCategory | null;
}): PinStyle {
	if (node.type === "place") {
		const cat = PLACE_CATEGORIES[node.category ?? DEFAULT_PLACE_CATEGORY];
		const fam = PIN_FAMILIES[cat.family];
		return {
			fill: fam.hex,
			fillOklch: fam.oklch,
			ink: fam.ink,
			family: cat.family,
			icon: cat.icon,
		};
	}
	const t = NODE_TYPES[node.type];
	return {
		fill: t.color.hex,
		fillOklch: t.color.oklch,
		ink: node.type === "area" ? INK : WHITE,
		family: null,
		icon: t.icon,
	};
}

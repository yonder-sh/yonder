/**
 * Engine contracts: the trip graph the engine reads (SPEC §6.6), and the
 * results of `buildModel` (§8.3), `rollup` (§8.4) and `computeSchedule` (§9.1).
 *
 * Plain data only. The JSONB and enum types come from the zod schemas in
 * `src/lib/schemas` as TYPE imports, so the engine bundle never pulls in zod.
 * Everything here is framework-agnostic: no React, no database, no I/O.
 */
import type { LineString as GeoLineString } from "geojson";
import type {
	IdeaStatus,
	LegKind,
	LegMode,
	LegSource,
	MemberStatus,
	NodeStatus,
	NodeType,
	PlaceCategory,
	Priority,
	ShortlistPin,
	TripRole,
} from "@/lib/schemas/enums";
import type { StoredLegDetails } from "@/lib/schemas/legs";
import type { BBox, NodeDetails } from "@/lib/schemas/nodes";
import type { TripSettings } from "@/lib/schemas/trips";

export type {
	IdeaStatus,
	LegKind,
	LegMode,
	LegSource,
	MemberStatus,
	NodeStatus,
	NodeType,
	PlaceCategory,
	Priority,
	ShortlistPin,
	TripRole,
	TripSettings,
};

/** The zoom level used to aggregate: a node type. */
export type Lens = NodeType;

/** Inclusive `YYYY-MM-DD` dates (`days=2027-10-05..2027-10-07`). */
export interface DayRange {
	from: string;
	to: string;
}

// ---------------------------------------------------------------------------
// The graph payload (`getTripGraph`, SPEC §6.6)
// ---------------------------------------------------------------------------

export interface GraphTrip {
	id: string;
	slug: string;
	name: string;
	startDate: string | null;
	endDate: string | null;
	/** IANA; validated on write, but the engine still falls back to UTC (§7.4). */
	defaultTz: string;
	coverAttachmentId: string | null;
	settings: TripSettings;
	/** Monotonic per-trip counter for missed-event detection (D10). */
	version: number;
	updatedAt: string;
}

export interface GraphMe {
	userId: string;
	memberId: string | null;
	role: TripRole;
	isGuest: boolean;
	name: string;
	color: number;
	/** `user.image` (FB-16: `/api/avatar/<userId>?v=…`), null without a picture. */
	image?: string | null;
}

export interface GraphMember {
	id: string;
	userId: string | null;
	status: MemberStatus;
	role: TripRole;
	name: string;
	firstName?: string;
	image?: string | null;
	color: number;
	/**
	 * ADDENDUM §10: a placeholder merged into another member (status
	 * `removed`). Old ids (mention tokens in Yjs notes, proposal payloads)
	 * resolve through it: show the member it points at, not "(former member)".
	 */
	mergedIntoId?: string;
}

export interface GraphDay {
	id: string;
	/** `YYYY-MM-DD`. */
	date: string;
	/** `HH:mm`, the planned start in the day's zone (default 09:00). */
	startTime: string;
	title: string | null;
	/** STAY: where you sleep after this day (§7.6). */
	nightNodeId: string | null;
	updatedAt: string;
}

export interface GraphNode {
	id: string;
	/** null = child of the trip root. */
	parentId: string | null;
	type: NodeType;
	category: PlaceCategory | null;
	status: NodeStatus;
	name: string;
	localName: string | null;
	slug: string;
	description: string | null;
	/** fractional-indexing key; siblings sort by `(position, id)`. */
	position: string;
	lat: number | null;
	lng: number | null;
	/** IANA; the server writes it whenever the node gets coordinates (§7.4). */
	tz: string | null;
	countryCode: string | null;
	address: string | null;
	googlePlaceId: string | null;
	/**
	 * OpenStreetMap ref of a Photon result (`N123`, `W45`; `nodes.osm_ref`), for
	 * duplicate checks. Always present from `loadTripGraph`; optional so older
	 * fixtures and ghosts need not set it.
	 */
	osmRef?: string | null;
	bbox: BBox | null;
	timeNeededMin: number | null;
	/**
	 * docs/PLACES.md §3: the lifecycle decision and the shortlist pin. Always
	 * present from `loadTripGraph`; optional so older fixtures and ghosts need
	 * not set them (absent = `idea` / `auto`).
	 */
	ideaStatus?: IdeaStatus;
	shortlistPin?: ShortlistPin;
	details: NodeDetails;
	/** memberId → priority. Unrated members are absent. */
	priorities: Record<string, Priority>;
	/** memberId → that member's comment on their rating (ADDENDUM §10; ≤ 280). */
	ratingComments: Record<string, string>;
	updatedAt: string;
}

export interface GraphItem {
	id: string;
	/** null = Unscheduled (§7.7). */
	dayId: string | null;
	/** null = an unlocated block ("Lunch"). */
	nodeId: string | null;
	/** Overrides the node name when set. */
	title: string | null;
	note: string | null;
	position: string;
	durationMin: number;
	/** `HH:mm` in the item's local zone; before the day's start means after midnight (§9.2). */
	pinnedStart: string | null;
	/**
	 * E2 "Booked for this date" (`items.fixed_date`): the what-if lists it under
	 * "Needs rebooking". Always present from `loadTripGraph`; absent = false.
	 */
	fixedDate?: boolean;
	assigneeIds: string[];
	updatedAt: string;
}

export interface GraphLeg {
	id: string;
	kind: LegKind;
	/** kind 'pair'. */
	fromItemId: string | null;
	toItemId: string | null;
	/** kind 'stay_start' | 'stay_end'. */
	stayDayId: string | null;
	/** Stay legs: the first/last located item the values were computed for. */
	anchorItemId: string | null;
	/** null = not chosen (the row exists because content was attached). */
	mode: LegMode | null;
	durationMin: number | null;
	distanceM: number | null;
	source: LegSource;
	estimateMin: number | null;
	isEdited: boolean;
	/** ISO instants; timed legs only (flights, fixed transit). Written by the server. */
	depAt: string | null;
	arrAt: string | null;
	/** `{}` (the DB default) reads as `{ kind: 'none' }`. */
	details: StoredLegDetails;
	queriedFor: string | null;
	assigneeIds: string[];
	/** Attachments, list items, a non-empty note or assignees exist. */
	hasContent: boolean;
	updatedAt: string;
}

/** SPEC §6.6 names the membership role `Role`. */
export type Role = TripRole;

/** Bundle counts per target (`getTripCounts`, SPEC §6.6). */
export interface Counts {
	/** Photos and videos. */
	media: number;
	links: number;
	/** PDFs (ADDENDUM §9: the Media tab's "Documents"; receipts never count). */
	docs: number;
	todoOpen: number;
	todo: number;
	shopOpen: number;
	shop: number;
	hasNote: boolean;
}

export interface TripCounts {
	root: Counts;
	byNode: Record<string, Counts>;
	byLeg: Record<string, Counts>;
	byItem: Record<string, Counts>;
	byDay: Record<string, Counts>;
}

export interface GraphGuest {
	userId: string;
	name: string;
	color: number;
	image?: string | null;
	lastSeenAt: string;
}

export interface TripGraph {
	trip: GraphTrip;
	me: GraphMe;
	members: GraphMember[];
	/** By date. */
	days: GraphDay[];
	/** Live nodes only. */
	nodes: GraphNode[];
	/** Live items only. */
	items: GraphItem[];
	/** No `alternatives`. */
	legs: GraphLeg[];
	/** Owners only. */
	guests?: GraphGuest[];
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** `${fromItemId}>${toItemId}` */
export type PairKey = `${string}>${string}`;
/** `${dayId}:start` | `${dayId}:end` */
export type StayKey = `${string}:${"start" | "end"}`;
/** Schedule leg keys: a pair, or `stay:${dayId}:start|end`. */
export type LegKey = PairKey | `stay:${StayKey}`;

/** How a cross-day pair P→I is travelled (§8.1). Same-day pairs are `same-day`. */
export type BoundaryKind =
	| "same-day"
	| "timed"
	| "moded"
	| "stay"
	| "overnight";

// ---------------------------------------------------------------------------
// Workspace model (`buildModel`, SPEC §8.3)
// ---------------------------------------------------------------------------

export type RepMode = "exact" | "finer" | "coarser";

export interface Rep {
	id: string;
	mode: RepMode;
}

export interface Visit {
	/** `${repId}#${occurrence}`: stable while the lens and scope stay. */
	key: string;
	repId: string;
	repMode: RepMode;
	/** Located and unlocated items, in order. */
	itemIds: string[];
	dayIds: string[];
	/** 1-based position among all visits. */
	ordinal: number;
	/** 1-based order in which the rep was first visited (the number on the pin). */
	pinNumber: number;
	/** 1-based count of this rep's visits so far (Shibuya's second visit = 2). */
	occurrence: number;
}

export interface Transition {
	/** Visit keys. */
	fromVisit: string;
	toVisit: string;
	/** The located pair that crosses between the visits. */
	fromItemId: string;
	toItemId: string;
	via: "leg" | "stay" | "overnight";
	/** `legByPair(from>to)`; null when no row exists (an unset leg). */
	leg: GraphLeg | null;
	/** via 'stay': the evening leg of the from-day and the morning leg of the to-day (rows, if stored). */
	stayLegs?: { end: GraphLeg | null; start: GraphLeg | null };
}

export interface Ghost {
	dir: "in" | "out";
	/** 'scope': the neighbour is outside the scope; 'days': outside the day range. */
	reason: "scope" | "days";
	visitKey: string;
	insideItemId: string;
	outsideItemId: string;
	/** `repAt(outsideNode, scope?.type ?? 'country', null)`: "→ Kyoto". */
	outsideRepId: string | null;
	/** The pair leg crossing the boundary, if its row exists. */
	leg: GraphLeg | null;
	/** The located pair crossing the boundary. */
	pairKey: string;
}

export type Fold =
	| { kind: "days"; dayIds: string[] }
	| {
			kind: "stretch";
			dayId: string;
			itemIds: string[];
			labelNodeId: string | null;
	  };

export type EdgeMode = LegMode | "unset";

export interface EdgeFeature {
	/** Unique per feature; use `promoteId: 'fid'` for feature-state hover. */
	fid: string;
	edgeKey: string;
	/** Place lens only: the transition's located pair. */
	pairKey: string | null;
	legId: string | null;
	mode: EdgeMode | "stay" | "overnight";
	/** Straight fallback line (no stored geometry): render at 60% opacity. */
	approx: boolean;
	geometry: GeoLineString;
}

export interface MapEdge {
	/** `from>to` for travel; `from>to#stay` and `from>to#overnight` for the other kinds. */
	key: `${string}>${string}`;
	kind: "travel" | "stay" | "overnight";
	fromRepId: string;
	toRepId: string;
	transitions: Transition[];
	/** Leg rows behind the edge (pair rows for travel, stay rows for stay edges). */
	legIds: string[];
	/** Heaviest mode: flight > transit > walk > other; `unset` when no leg has one. */
	mode: EdgeMode;
	/** Some leg has no provider or manual value. */
	estimate: boolean;
	count: number;
	/** The second direction of a two-way pair bows so the lines don't overlap. */
	curved: boolean;
	features: EdgeFeature[];
	/** Stay edges: which stay legs they draw. */
	stays?: { dayId: string; end: "start" | "end" }[];
}

export interface Pin {
	repId: string;
	type: NodeType;
	repMode: RepMode;
	lat: number;
	lng: number;
	/** null for hollow (idea) pins and stay-only pins. */
	number: number | null;
	visits: number;
	/** Sum of item durations across the rep's visits (drives pin size). */
	minutes: number;
	hollow: boolean;
	stay: boolean;
	dayIds: string[];
}

export interface DetachedLeg {
	legId: string;
	/** The from-item's day, else the to-item's (§7.8). */
	dayId: string | null;
	fromItemId: string;
	toItemId: string;
}

export interface WorkspaceModel {
	scopeId: string | null;
	lens: Lens;
	dayRange: DayRange | null;
	visits: Visit[];
	transitions: Transition[];
	ghosts: Ghost[];
	folds: Fold[];
	pins: Pin[];
	edges: MapEdge[];
	detachedLegs: DetachedLeg[];
	/** Unscheduled item ids in scope, in order. */
	unscheduled: string[];
	/** itemId → visit key, for every item inside a visit. */
	visitOfItem: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Schedule (`computeSchedule`, SPEC §9.1)
// ---------------------------------------------------------------------------

export interface Suggestion {
	/** null when neither node has coordinates. */
	mode: LegMode | null;
	/** null: counts 0 ("flight?" or unknown distance). */
	estimateMin: number | null;
	/** Haversine km, null without coordinates. */
	distanceKm: number | null;
	/** "walk ~12m?", "transit ~1h43 est.?", "flight?". */
	label: string;
}

export interface ScheduledItem {
	start: Date;
	end: Date;
	tz: string;
	/** Starts on a later local date than its day (pinned after midnight). */
	startsNextDay: boolean;
	endsNextDay: boolean;
	pinned: boolean;
	freeBeforeMin: number;
	late?: { minutes: number; cause: "pinned" };
}

export interface ScheduledLeg {
	start: Date;
	end: Date;
	minutes: number;
	kind: "pair" | "stay" | "overnight";
	/** No mode chosen. */
	unset: boolean;
	/** Minutes come from suggest.ts, not a provider or a person. */
	estimate: boolean;
	/** Stay leg whose anchor item changed. */
	stale?: boolean;
	timed: boolean;
	crossDay: boolean;
	/** The leg row, when one exists. */
	legId: string | null;
	late?: { minutes: number; cause: "flight" | "departure"; label: string };
	/** A soft warning, never a conflict: a layover under the §7.9 limit. */
	warn?: { kind: "tight_connection"; minutes: number };
	/**
	 * Flights: the departure and arrival the plan uses. Without times (FB-18)
	 * they are assumed (the departure when the stop before ends, the arrival
	 * by the great-circle estimate): `depKnown`/`arrKnown` say which are real.
	 */
	flight?: {
		depMs: number;
		arrMs: number;
		depKnown: boolean;
		arrKnown: boolean;
	};
	suggestion?: Suggestion;
}

export interface ScheduledDay {
	start: Date;
	end: Date;
	tz: string;
	tzChanged: boolean;
	activitiesMin: number;
	travelMin: number;
	freeMin: number;
	capacityMin: number;
	overCapacityMin: number;
	walkKm: number;
	rides: number;
	unsetLegs: number;
	conflicts: number;
	/** Node ids: last night's stay and tonight's. */
	stay: { morning: string | null; night: string | null };
}

export interface ScheduleResult {
	/** Scheduled items only. */
	items: Record<string, ScheduledItem>;
	legs: Record<string, ScheduledLeg>;
	days: Record<string, ScheduledDay>;
}

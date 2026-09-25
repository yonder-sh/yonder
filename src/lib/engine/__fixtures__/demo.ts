/**
 * The engine's test fixture (SPEC §8.6): the demo place tree with fixed UUIDs,
 * plus a small scenario builder that turns a compact itinerary description into
 * a `TripGraph`.
 *
 * Japan › Tokyo › {Shibuya › {Hands, Loft, Shibuya Sky}, Harajuku › {Meiji
 * Jingu}, Asakusa › {Kappabashi (area) › {Knife shop}, Senso-ji}, Itoya (filed
 * directly under Tokyo)}; Japan › Mt. Fuji (region) › Kawaguchiko (area) ›
 * {Kawaguchiko Ryokan (lodging)}; Japan › Kyoto › {Kiyomizu-dera}; Japan › Osaka
 * › KIX; South Korea › Seoul › ICN; Taiwan › Taipei › TPE; Türkiye › Istanbul ›
 * IST; USA › Newark › EWR.
 *
 * Ids are v7-shaped UUIDs made from a counter, so they sort in creation order
 * (Kyoto's id sorts after Tokyo's, which decides which of a two-way edge pair
 * is curved).
 */
import type { MoneyDto } from "@/features/money/money.functions";
import type { FlightDetails, LegDetails } from "@/lib/schemas/legs";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { localDateTimeToEpoch } from "../time";
import type {
	GraphDay,
	GraphItem,
	GraphLeg,
	GraphNode,
	LegMode,
	LegSource,
	NodeType,
	PlaceCategory,
	TripGraph,
	TripSettings,
} from "../types";

export const uuid = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const pos = (i: number) => `a${String(i).padStart(4, "0")}`;
const T0 = "2026-09-22T00:00:00.000Z";

interface NodeSpec {
	key: string;
	parent: string | null;
	type: NodeType;
	name: string;
	at?: [lat: number, lng: number];
	category?: PlaceCategory;
	tz?: string;
	countryCode?: string;
	status?: "active" | "dropped";
	timeNeededMin?: number;
}

const TREE: NodeSpec[] = [
	{ key: "japan", parent: null, type: "country", name: "Japan", at: [36.2048, 138.2529], tz: "Asia/Tokyo", countryCode: "JP" },
	{ key: "tokyo", parent: "japan", type: "city", name: "Tokyo", at: [35.6762, 139.6503] },
	{ key: "shibuya", parent: "tokyo", type: "area", name: "Shibuya", at: [35.6595, 139.7004] },
	{ key: "hands", parent: "shibuya", type: "place", category: "shopping", name: "Hands Shibuya", at: [35.6617, 139.6989] },
	{ key: "loft", parent: "shibuya", type: "place", category: "shopping", name: "Shibuya Loft", at: [35.6612, 139.6987] },
	{ key: "shibuyaSky", parent: "shibuya", type: "place", category: "viewpoint", name: "Shibuya Sky", at: [35.6585, 139.7022] },
	{ key: "harajuku", parent: "tokyo", type: "area", name: "Harajuku", at: [35.6702, 139.7027] },
	{ key: "meijiJingu", parent: "harajuku", type: "place", category: "temple_shrine", name: "Meiji Jingu", at: [35.6764, 139.6993] },
	{ key: "asakusa", parent: "tokyo", type: "area", name: "Asakusa", at: [35.7148, 139.7967] },
	{ key: "kappabashi", parent: "asakusa", type: "area", name: "Kappabashi", at: [35.7143, 139.7883] },
	{ key: "knifeShop", parent: "kappabashi", type: "place", category: "shopping", name: "Kama-asa (knives)", at: [35.7133, 139.7885] },
	{ key: "sensoji", parent: "asakusa", type: "place", category: "temple_shrine", name: "Senso-ji", at: [35.7148, 139.7967] },
	{ key: "itoya", parent: "tokyo", type: "place", category: "shopping", name: "Itoya Ginza", at: [35.6723, 139.7672] },
	{ key: "mtFuji", parent: "japan", type: "region", name: "Mt. Fuji", at: [35.3606, 138.7274] },
	{ key: "kawaguchiko", parent: "mtFuji", type: "area", name: "Kawaguchiko", at: [35.5171, 138.7519] },
	{ key: "ryokan", parent: "kawaguchiko", type: "place", category: "lodging", name: "Kawaguchiko Ryokan", at: [35.51, 138.76] },
	{ key: "kyoto", parent: "japan", type: "city", name: "Kyoto", at: [35.0116, 135.7681] },
	{ key: "kiyomizu", parent: "kyoto", type: "place", category: "temple_shrine", name: "Kiyomizu-dera", at: [34.9949, 135.785] },
	{ key: "osaka", parent: "japan", type: "city", name: "Osaka", at: [34.6937, 135.5023] },
	{ key: "kix", parent: "osaka", type: "place", category: "airport", name: "Kansai Airport (KIX)", at: [34.432, 135.2304] },
	{ key: "southKorea", parent: null, type: "country", name: "South Korea", at: [35.9078, 127.7669], tz: "Asia/Seoul", countryCode: "KR" },
	{ key: "seoul", parent: "southKorea", type: "city", name: "Seoul", at: [37.5665, 126.978] },
	{ key: "icn", parent: "seoul", type: "place", category: "airport", name: "Incheon (ICN)", at: [37.4602, 126.4407] },
	{ key: "taiwan", parent: null, type: "country", name: "Taiwan", at: [23.6978, 120.9605], tz: "Asia/Taipei", countryCode: "TW" },
	{ key: "taipei", parent: "taiwan", type: "city", name: "Taipei", at: [25.033, 121.5654] },
	{ key: "tpe", parent: "taipei", type: "place", category: "airport", name: "Taoyuan (TPE)", at: [25.0797, 121.2342] },
	{ key: "turkiye", parent: null, type: "country", name: "Türkiye", at: [38.9637, 35.2433], tz: "Europe/Istanbul", countryCode: "TR" },
	{ key: "istanbul", parent: "turkiye", type: "city", name: "Istanbul", at: [41.0082, 28.9784] },
	{ key: "ist", parent: "istanbul", type: "place", category: "airport", name: "Istanbul Airport (IST)", at: [41.2753, 28.7519] },
	{ key: "usa", parent: null, type: "country", name: "USA", at: [39.8283, -98.5795], countryCode: "US" },
	{ key: "newark", parent: "usa", type: "city", name: "Newark", at: [40.7357, -74.1724], tz: "America/New_York" },
	{ key: "ewr", parent: "newark", type: "place", category: "airport", name: "Newark (EWR)", at: [40.6895, -74.1745] },
];

export type DemoNodeKey = (typeof TREE)[number]["key"];

/** Node ids by key (`N.tokyo`). */
export const N: Record<string, string> = Object.fromEntries(TREE.map((s, i) => [s.key, uuid(0x100 + i)]));

export const DEMO_TRIP_ID = uuid(1);
export const DEMO_MEMBERS = { dennis: uuid(0x51), audrey: uuid(0x52) } as const;

/** Builds graph nodes from specs; `keys` maps spec keys (and existing keys) to ids. */
export function makeNodes(specs: readonly NodeSpec[], keys: Record<string, string>, startId: number): GraphNode[] {
	return specs.map((s, i) => {
		const id = keys[s.key] ?? uuid(startId + i);
		keys[s.key] = id;
		return {
			id,
			parentId: s.parent ? (keys[s.parent] ?? s.parent) : null,
			type: s.type,
			category: s.type === "place" ? (s.category ?? "other") : null,
			status: s.status ?? "active",
			name: s.name,
			localName: null,
			slug: s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
			description: null,
			position: pos(startId + i),
			lat: s.at?.[0] ?? null,
			lng: s.at?.[1] ?? null,
			tz: s.tz ?? null,
			countryCode: s.countryCode ?? null,
			address: null,
			googlePlaceId: null,
			bbox: null,
			timeNeededMin: s.timeNeededMin ?? null,
			details: {},
			priorities: {},
			ratingComments: {},
			updatedAt: T0,
		};
	});
}

export const demoNodes: GraphNode[] = makeNodes(TREE, { ...N }, 0x100);

// ---------------------------------------------------------------------------
// Scenario builder
// ---------------------------------------------------------------------------

export interface ItemSpec {
	/** Key to refer to the item in legs and assertions. */
	k: string;
	/** Node key or id; omit for an unlocated block ("Lunch"). */
	node?: string;
	title?: string;
	min?: number;
	pin?: string;
}

export interface DaySpec {
	k?: string;
	date?: string;
	start?: string;
	/** Stay node key or id (where you sleep after this day). */
	night?: string;
	items: ItemSpec[];
}

/** A wall time in a zone: `["2027-10-02T23:40", "Asia/Tokyo"]`. */
export type LocalAt = [local: string, tz: string];

export interface LegSpec {
	k?: string;
	/** Pair legs. */
	from?: string;
	to?: string;
	/** Stay legs: the day key and which end. */
	stay?: { day: string; end: "start" | "end" };
	anchor?: string;
	/** Default "walk"; null = a row with no mode (content attached). */
	mode?: LegMode | null;
	min?: number | null;
	distanceM?: number | null;
	source?: LegSource;
	isEdited?: boolean;
	hasContent?: boolean;
	dep?: LocalAt;
	arr?: LocalAt;
	details?: LegDetails;
}

export interface Scenario {
	graph: TripGraph;
	/** Item ids by key. */
	I: Record<string, string>;
	/** Day ids by key (defaults: d1, d2, …). */
	D: Record<string, string>;
	/** Leg ids by key. */
	L: Record<string, string>;
	/** Node ids by key (the demo tree plus extra nodes). */
	N: Record<string, string>;
}

export interface ScenarioSpec {
	/** Date of the first day (default 2027-10-03); later days follow day by day unless dated. */
	firstDate?: string;
	days: DaySpec[];
	unscheduled?: ItemSpec[];
	legs?: LegSpec[];
	/** Extra nodes (parents may be demo keys). */
	nodes?: NodeSpec[];
	settings?: TripSettings;
	defaultTz?: string;
}

const iso = (at: LocalAt | undefined): string | null => {
	if (!at) return null;
	const ms = localDateTimeToEpoch(at[0], at[1]);
	if (ms === null) throw new Error(`bad local time ${at.join(" ")}`);
	return new Date(ms).toISOString();
};

export function addDaysIso(date: string, n: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

function buildScenario(spec: ScenarioSpec): Scenario {
	const keys: Record<string, string> = { ...N };
	const nodes = [...demoNodes, ...makeNodes(spec.nodes ?? [], keys, 0x800)];
	const nodeId = (k: string | undefined) => (k ? (keys[k] ?? k) : null);
	const I: Record<string, string> = {};
	const D: Record<string, string> = {};
	const L: Record<string, string> = {};
	let itemSeq = 0x1000;
	const makeItem = (s: ItemSpec, dayId: string | null, i: number): GraphItem => {
		const id = uuid(itemSeq++);
		if (I[s.k]) throw new Error(`duplicate item key ${s.k}`);
		I[s.k] = id;
		return {
			id,
			dayId,
			nodeId: nodeId(s.node),
			title: s.title ?? (s.node ? null : s.k),
			note: null,
			position: pos(i),
			durationMin: s.min ?? 60,
			pinnedStart: s.pin ?? null,
			assigneeIds: [],
			updatedAt: T0,
		};
	};
	const first = spec.firstDate ?? "2027-10-03";
	const days: GraphDay[] = [];
	const items: GraphItem[] = [];
	spec.days.forEach((d, i) => {
		const id = uuid(0x200 + i);
		D[d.k ?? `d${i + 1}`] = id;
		days.push({
			id,
			date: d.date ?? addDaysIso(first, i),
			startTime: d.start ?? "09:00",
			title: null,
			nightNodeId: nodeId(d.night),
			updatedAt: T0,
		});
		d.items.forEach((s, j) => {
			items.push(makeItem(s, id, j));
		});
	});
	(spec.unscheduled ?? []).forEach((s, j) => {
		items.push(makeItem(s, null, j));
	});
	const legs: GraphLeg[] = (spec.legs ?? []).map((s, i) => {
		const id = uuid(0x3000 + i);
		if (s.k) L[s.k] = id;
		const isStay = !!s.stay;
		return {
			id,
			kind: isStay ? (s.stay?.end === "start" ? "stay_start" : "stay_end") : "pair",
			fromItemId: isStay ? null : ((s.from && I[s.from]) ?? s.from ?? null),
			toItemId: isStay ? null : ((s.to && I[s.to]) ?? s.to ?? null),
			stayDayId: isStay ? (D[s.stay?.day ?? ""] ?? null) : null,
			anchorItemId: s.anchor ? (I[s.anchor] ?? s.anchor) : null,
			mode: s.mode === undefined ? "walk" : s.mode,
			durationMin: s.min ?? null,
			distanceM: s.distanceM ?? null,
			source: s.source ?? "manual",
			estimateMin: null,
			isEdited: s.isEdited ?? false,
			depAt: iso(s.dep),
			arrAt: iso(s.arr),
			details: s.details ?? {},
			queriedFor: null,
			assigneeIds: [],
			hasContent: s.hasContent ?? false,
			updatedAt: T0,
		};
	});
	const graph: TripGraph = {
		trip: {
			id: DEMO_TRIP_ID,
			slug: "demo",
			name: "Demo trip",
			startDate: days[0]?.date ?? null,
			endDate: days.at(-1)?.date ?? null,
			defaultTz: spec.defaultTz ?? "Asia/Tokyo",
			coverAttachmentId: null,
			settings: spec.settings ?? {},
			version: 1,
			updatedAt: T0,
		},
		me: { userId: "user-dennis", memberId: DEMO_MEMBERS.dennis, role: "owner", isGuest: false, name: "Dennis", color: 0 },
		members: [
			{ id: DEMO_MEMBERS.dennis, userId: "user-dennis", status: "active", role: "owner", name: "Dennis", color: 0 },
			{ id: DEMO_MEMBERS.audrey, userId: null, status: "placeholder", role: "editor", name: "Audrey", color: 1 },
		],
		days,
		nodes,
		items,
		legs,
	};
	return { graph, I, D, L, N: keys };
}

/** Flight details for a leg; `from`/`to` are airport node keys of the demo tree (or extra nodes). */
export function flightDetails(opts: {
	number: string;
	from: { iata: string; tz: string; country: string; at: [number, number] };
	to: { iata: string; tz: string; country: string; at: [number, number] };
	dep: string;
	arr: string;
	connection?: FlightDetails["connection"];
}): LegDetails {
	const airport = (a: typeof opts.from) => ({ iata: a.iata, name: a.iata, country: a.country, tz: a.tz, lat: a.at[0], lng: a.at[1] });
	return {
		kind: "flight",
		flight: {
			flightNumber: opts.number,
			from: airport(opts.from),
			to: airport(opts.to),
			depLocal: opts.dep,
			arrLocal: opts.arr,
			seats: [],
			...(opts.connection ? { connection: opts.connection } : {}),
		},
	};
}

/**
 * A small but complete demo itinerary: Tokyo days with a Kyoto day trip, the
 * Fuji Excursion to a ryokan stay, and a KIX → ICN flight.
 */
export const demo: Scenario = buildScenario({
	days: [
		{
			items: [
				{ k: "hands", node: "hands", min: 45 },
				{ k: "loft", node: "loft", min: 45 },
				{ k: "lunch1", title: "Lunch", min: 60 },
				{ k: "meiji", node: "meijiJingu", min: 60 },
				{ k: "sky", node: "shibuyaSky", min: 60, pin: "17:30" },
			],
		},
		{
			items: [
				{ k: "sensoji", node: "sensoji", min: 60 },
				{ k: "knives", node: "knifeShop", min: 90 },
				{ k: "itoya", node: "itoya", min: 60 },
			],
		},
		{
			night: "ryokan",
			items: [
				{ k: "breakfast3", title: "Breakfast", min: 30 },
				{ k: "dropBags", node: "ryokan", title: "Drop bags", min: 30 },
			],
		},
		{
			items: [
				{ k: "ryokanBreakfast", node: "ryokan", title: "Breakfast (ryokan)", min: 60 },
				{ k: "kiyomizu", node: "kiyomizu", min: 90 },
			],
		},
		{
			items: [
				{ k: "kix", node: "kix", min: 120 },
				{ k: "icn", node: "icn", min: 60 },
			],
		},
	],
	unscheduled: [{ k: "backup", node: "itoya", min: 60 }],
	legs: [
		{ k: "handsLoft", from: "hands", to: "loft", mode: "walk", min: 3 },
		{ k: "fuji", from: "itoya", to: "dropBags", mode: "transit", min: 116, isEdited: true },
		{
			k: "flight",
			from: "kix",
			to: "icn",
			mode: "flight",
			dep: ["2027-10-07T13:05", "Asia/Tokyo"],
			arr: ["2027-10-07T15:05", "Asia/Seoul"],
			details: flightDetails({
				number: "KE724",
				from: { iata: "KIX", tz: "Asia/Tokyo", country: "JP", at: [34.432, 135.2304] },
				to: { iata: "ICN", tz: "Asia/Seoul", country: "KR", at: [37.4602, 126.4407] },
				dep: "2027-10-07T13:05",
				arr: "2027-10-07T15:05",
			}),
		},
	],
});

/** The demo graph (`DEMO`-style fixed ids; see `demo.I`, `demo.D`, `demo.L`, `N`). */
export const demoGraph: TripGraph = demo.graph;

// ---------------------------------------------------------------------------
// F-ext0 fixtures (EXTENSIONS §1.2 step 6): every WP renders ghosts and money
// in /dev/fixture. Proposals by Maya (a suggester, colour 2) and a guest.
// ---------------------------------------------------------------------------

type Author = ProposalDto["author"];
const MAYA: Author = { userId: "user-maya", memberId: uuid(0x53), name: "Maya", color: 2, isGuest: false };
const GUEST: Author = { userId: "user-guest-wren", memberId: null, name: "Guest Wren", color: 3, isGuest: true };

function proposal(
	n: number,
	p: Pick<ProposalDto, "op" | "entityKind" | "entityId" | "summary"> &
		Partial<Pick<ProposalDto, "payload" | "fields" | "before" | "createdIds">>,
	author = MAYA,
): ProposalDto {
	const at = new Date(Date.parse("2026-09-22T10:00:00.000Z") + n * 60_000).toISOString();
	return {
		id: uuid(0x5000 + n),
		tripId: DEMO_TRIP_ID,
		op: p.op,
		payload: p.payload ?? {},
		entityKind: p.entityKind,
		entityId: p.entityId,
		createdIds: p.createdIds ?? [],
		requires: [],
		summary: p.summary,
		message: null,
		status: "open",
		author,
		fields: p.fields ?? [],
		before: p.before ?? {},
		reviewedBy: null,
		reviewedAt: null,
		reviewNote: null,
		lastError: null,
		dependants: [],
		createdAt: at,
		updatedAt: at,
	};
}

const newIdea = uuid(0x5100);

/** A create, a move, a delete, a trip.shift, a guest flight.save and two stacked moves of one item. */
export const demoProposals: ProposalDto[] = [
	proposal(1, {
		op: "node.create",
		entityKind: "node",
		entityId: newIdea,
		createdIds: [newIdea],
		summary: "added Nishiki Market",
		payload: { tripId: DEMO_TRIP_ID, id: newIdea, parentId: N.kyoto ?? null, type: "place", name: "Nishiki Market" },
	}),
	proposal(2, {
		op: "item.move",
		entityKind: "item",
		entityId: demo.I.itoya ?? null,
		summary: "moved Itoya Ginza to Day 1",
		fields: ["dayId", "position"],
		payload: { itemId: demo.I.itoya ?? "", dayId: demo.D.d1 ?? null },
	}),
	proposal(3, {
		op: "item.delete",
		entityKind: "item",
		entityId: demo.I.sky ?? null,
		summary: "deleted Shibuya Sky",
		fields: ["deletedAt"],
		payload: { itemId: demo.I.sky ?? "" },
	}),
	proposal(4, {
		op: "trip.shift",
		entityKind: "trip",
		entityId: null,
		summary: "shifted the trip +1 day (Sun 3 Oct → Mon 4 Oct)",
		fields: ["startDate", "endDate"],
		payload: { tripId: DEMO_TRIP_ID, deltaDays: 1 },
	}),
	proposal(
		5,
		{
			op: "flight.save",
			entityKind: "leg",
			entityId: demo.L.flight ?? null,
			summary: "changed flight KE724",
			fields: ["details.flight"],
			payload: {},
		},
		GUEST,
	),
	proposal(6, {
		op: "item.move",
		entityKind: "item",
		entityId: demo.I.knives ?? null,
		summary: "moved Kama-asa (knives) to Day 4",
		fields: ["dayId", "position"],
		payload: { itemId: demo.I.knives ?? "", dayId: demo.D.d4 ?? null },
	}),
	proposal(
		7,
		{
			op: "item.move",
			entityKind: "item",
			entityId: demo.I.knives ?? null,
			summary: "moved Kama-asa (knives) to Day 1",
			fields: ["dayId", "position"],
			payload: { itemId: demo.I.knives ?? "", dayId: demo.D.d1 ?? null },
		},
		{ ...MAYA, userId: "user-audrey", memberId: DEMO_MEMBERS.audrey, name: "Audrey", color: 1 },
	),
];

const payment = (n: number, amountMinor: number, currency: string, memberId: string, paidAt: string) => ({
	id: uuid(0x6100 + n),
	paidAt,
	paidTz: "Asia/Tokyo",
	currency,
	amountMinor,
	homeAmountMinor: currency === "JPY" ? Math.round(amountMinor / 150 * 100) : amountMinor,
	fxRate: currency === "JPY" ? 1 / 150 : 1,
	fxDate: paidAt.slice(0, 10),
	fxSource: currency === "JPY" ? "currency-api" : "same",
	fxManual: false,
	method: "card",
	payers: [{ memberId, amountMinor }],
});

const expense = (
	n: number,
	e: Partial<MoneyDto["expenses"][number]> & Pick<MoneyDto["expenses"][number], "target" | "title" | "category">,
): MoneyDto["expenses"][number] => ({
	id: uuid(0x6000 + n),
	amountMinor: null,
	currency: null,
	homeAmountMinor: null,
	homeCurrency: "USD",
	fxRate: null,
	fxDate: null,
	fxSource: null,
	fxManual: false,
	points: null,
	expectedOn: null,
	status: "paid",
	splitMode: "equal",
	shares: [
		{ memberId: DEMO_MEMBERS.dennis, amountMinor: null },
		{ memberId: DEMO_MEMBERS.audrey, amountMinor: null },
	],
	lines: [],
	fees: [],
	payments: [],
	isPrivate: false,
	taxFreePending: false,
	refundOfId: null,
	listItemId: null,
	note: null,
	createdBy: "user-dennis",
	createdAt: T0,
	updatedAt: T0,
	...e,
});

/** 3 expenses (one private) and one ¥ settlement. */
export const demoMoney: MoneyDto = {
	homeCurrency: "USD",
	ratesAsOf: "2027-10-04",
	expenses: [
		expense(1, {
			target: { kind: "item", itemId: demo.I.kiyomizu ?? "" },
			title: "Kiyomizu-dera tickets",
			category: "activities",
			amountMinor: 1_000,
			currency: "JPY",
			homeAmountMinor: 667,
			payments: [payment(1, 1_000, "JPY", DEMO_MEMBERS.dennis, "2027-10-06T10:15:00+09:00")],
		}),
		expense(2, {
			target: { kind: "day", dayId: demo.D.d3 ?? "" },
			title: "Kawaguchiko Ryokan",
			category: "lodging",
			amountMinor: 60_000,
			currency: "JPY",
			homeAmountMinor: 40_000,
			status: "partial",
			expectedOn: "2027-10-05",
			payments: [payment(2, 10_000, "JPY", DEMO_MEMBERS.audrey, "2027-06-01T12:00:00+09:00")],
		}),
		expense(3, {
			target: { kind: "node", nodeId: N.itoya ?? "" },
			title: "Fountain pen (gift)",
			category: "shopping",
			amountMinor: 18_000,
			currency: "JPY",
			homeAmountMinor: 12_000,
			isPrivate: true,
			shares: [],
			payments: [payment(3, 18_000, "JPY", DEMO_MEMBERS.dennis, "2027-10-04T16:40:00+09:00")],
		}),
	],
	settlements: [
		{
			id: uuid(0x6200),
			fromMemberId: DEMO_MEMBERS.audrey,
			toMemberId: DEMO_MEMBERS.dennis,
			amountMinor: 500,
			currency: "JPY",
			homeAmountMinor: 333,
			homeCurrency: "USD",
			fxRate: 1 / 150,
			settledAt: "2027-10-06T20:00:00+09:00",
			settledTz: "Asia/Tokyo",
			method: "cash",
			note: null,
			scope: { nodeId: N.kyoto ?? "" },
			netAfter: {
				[DEMO_MEMBERS.dennis]: 0,
				[DEMO_MEMBERS.audrey]: 0,
			},
			createdAt: T0,
		},
	],
	budgets: [
		{ id: uuid(0x6300), nodeId: null, category: null, memberId: null, amountMinor: 350_000, kind: "total", defaultSeenMinor: null },
		// A trip default for Japan food, and Dennis's custom value set against an older default.
		{ id: uuid(0x6302), nodeId: N.japan ?? null, category: "food_drink", memberId: null, amountMinor: 80_000, kind: "total", defaultSeenMinor: null },
		{ id: uuid(0x6301), nodeId: N.japan ?? null, category: "food_drink", memberId: DEMO_MEMBERS.dennis, amountMinor: 60_000, kind: "total", defaultSeenMinor: 70_000 },
	],
	privateBudgetMemberIds: [],
};

/**
 * The scenario builder, plus the F-ext0 fixtures every WP renders in
 * `/dev/fixture`: `scenario.proposals` (ghosts) and `scenario.money`.
 */
export const scenario = Object.assign(buildScenario, {
	proposals: demoProposals,
	money: demoMoney,
});

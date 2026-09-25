/**
 * The Asia 2027 import as a PURE transform (SPEC §17.3 as overridden by
 * ADDENDUM §8 and §10): the validated sheet export → an `ImportPlan` holding
 * every row the writer inserts, with ids, slugs and positions already chosen,
 * plus the report's facts. No database, no network, no S3: the unit tests run
 * it on the real `seed/data` and check the QA SEED counts.
 *
 * Decisions the SPEC leaves open are recorded in `plan.report.notes`.
 */
import { v7 as uuidv7 } from "uuid";
import {
	PRIORITIES,
	SHEET_CATEGORY_MAP,
	SHEET_PRIORITY_MAP,
	SHEET_TIME_MAP,
	TIME_NEEDED,
} from "@/lib/domain/taxonomy";
import { ROOT_RESERVED_SLUGS, slugify, uniqueSlug } from "@/lib/engine/tree";
import type {
	DueKind,
	LegMode,
	ListItemStatus,
	NodeStatus,
	NodeType,
	PlaceCategory,
	Priority,
} from "@/lib/schemas/enums";
import type { LegDetails } from "@/lib/schemas/legs";
import type { DueRule } from "@/lib/schemas/lists";
import type { NodeDetails } from "@/lib/schemas/nodes";
import type { TripSettings } from "@/lib/schemas/trips";
import type {
	ActionRow,
	CityRow,
	Hint,
	ItineraryRow,
	MediaEntry,
	PlaceRow,
	SheetData,
	ShoppingRow,
} from "./data";
import {
	absoluteDue,
	actionDueKind,
	actionTarget,
	addDaysIso,
	knownWindow,
	resolveWindow,
} from "./due";
import { freshKeysPure } from "./keys";
import {
	blocks,
	type CellLink,
	cellMarkdown,
	escapeInline,
	hostOf,
	hrsToMin,
	isGenericAnchor,
	isHttpUrl,
	linkTitle,
	normName,
	saysBooked,
	stripArrow,
	yenAmount,
} from "./text";
import { quoteHolds, SHEET_TIMES, type SheetTime } from "./times";

// ---------------------------------------------------------------------------
// Plan shapes
// ---------------------------------------------------------------------------

export type MemberKey = "owner" | "audrey";

export type Target =
	| { kind: "root" }
	| { kind: "node"; nodeId: string }
	| { kind: "item"; itemId: string }
	| { kind: "leg"; legId: string }
	| { kind: "day"; dayId: string };

export type PlanMember = {
	id: string;
	key: MemberKey;
	role: "owner" | "editor";
	/** Placeholders only (the owner's name comes from the user). */
	displayName: string | null;
	color: number;
};

export type PlanNode = {
	id: string;
	/** Lookup key: `Country`, `Country|City`, `Country|City|Area`, `Country|City|Area|Place`. */
	key: string;
	parentId: string | null;
	type: NodeType;
	category: PlaceCategory | null;
	status: NodeStatus;
	name: string;
	slug: string;
	description: string | null;
	position: string;
	lat: number | null;
	lng: number | null;
	tz: string | null;
	countryCode: string | null;
	timeNeededMin: number | null;
	details: NodeDetails & Record<string, unknown>;
	priorities: Partial<Record<MemberKey, Priority>>;
	/** Markdown for the node's shared note (Yjs), or null. */
	note: string | null;
	/** Where the coordinates came from ("hint", "override", "alias", "none"). */
	geo: "hint" | "override" | "alias" | "parent" | "none";
	/** Sheet provenance for the report ("Places!D29"). */
	source: string;
};

export type PlanDay = {
	id: string;
	date: string;
	startTime: string;
	title: string | null;
	nightNodeId: string | null;
};

export type PlanItem = {
	id: string;
	dayId: string | null;
	nodeId: string | null;
	title: string | null;
	note: string | null;
	position: string;
	durationMin: number;
	pinnedStart: string | null;
	fixedDate: boolean;
	assignees: MemberKey[];
	source: string;
};

export type PlanLeg = {
	id: string;
	kind: "pair";
	fromItemId: string;
	toItemId: string;
	mode: LegMode;
	durationMin: number | null;
	details: LegDetails;
	depAt: string | null;
	arrAt: string | null;
	/** Markdown for the leg's note (Yjs), or null. */
	note: string | null;
	label: string;
	/** Travellers (`leg_assignees`). */
	assignees: MemberKey[];
	source: string;
};

export type PlanListItem = {
	id: string;
	list: "todo" | "shopping";
	target: Target;
	text: string;
	note: string | null;
	url: string | null;
	status: ListItemStatus;
	dueKind: DueKind;
	dueRule: DueRule | null;
	dueDate: string | null;
	dueTime: string | null;
	dueTz: string | null;
	priceAmount: number | null;
	priceCurrency: string | null;
	priceText: string | null;
	position: string;
	assignees: MemberKey[];
	/** Extra candidate shops (`list_item_targets`). */
	extraTargets: string[];
	source: string;
};

export type PlanPhoto = {
	file: string;
	contentType: string;
	width: number;
	height: number;
	bytes: number;
};

export type PlanAttachment = {
	id: string;
	kind: "link" | "photo";
	target: Target;
	url: string | null;
	title: string | null;
	siteName: string | null;
	author: string | null;
	caption: string | null;
	meta: Record<string, unknown>;
	position: string;
	photo: PlanPhoto | null;
	source: string;
};

export type PlanNote = { target: Target; markdown: string };

export type PlanOptions = {
	slug: string;
	name: string;
	/** The JFK departure day (ADDENDUM §8). */
	start: string;
	/** Itinerary Day 1 (the Tokyo arrival). */
	day1: string;
	end: string;
	actionTimeline: boolean;
	/** Also import the Flight and Points rows (off by default: SPEC §17.3 step 8, gate Q3). */
	flightRows: boolean;
	/** Chosen ids (tests pass a counter). */
	newId?: () => string;
};

export type ReportFacts = {
	counts: Record<string, number>;
	geocode: {
		fromHints: number;
		overrides: number;
		aliases: number;
		misses: string[];
	};
	unmatched: string[];
	created: string[];
	actionTimeline: {
		row: number;
		what: string;
		target: string;
		due: string;
		rule: string | null;
	}[];
	/** Clock times taken from the sheet's words (`times.ts`). */
	times: { what: string; at: string; quote: string; applied: boolean }[];
	notes: string[];
};

export type ImportPlan = {
	trip: {
		id: string;
		/** The whole address; `runImport` gives it a random tail (`slugTail`). */
		slug: string;
		slugTail?: string | null;
		name: string;
		startDate: string;
		endDate: string;
		defaultTz: string;
		settings: TripSettings;
		coverAttachmentId: string | null;
	};
	members: PlanMember[];
	nodes: PlanNode[];
	days: PlanDay[];
	items: PlanItem[];
	legs: PlanLeg[];
	listItems: PlanListItem[];
	attachments: PlanAttachment[];
	notes: PlanNote[];
	report: ReportFacts;
};

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

const REGION_CITIES = new Set(["mt. fuji", "ha long bay"]);
const RYOKAN_NAME = "Kawaguchiko Ryokan";

type TargetKey = string;
const targetKey = (t: Target): TargetKey =>
	t.kind === "root"
		? "root"
		: `${t.kind}:${t.kind === "node" ? t.nodeId : t.kind === "item" ? t.itemId : t.kind === "leg" ? t.legId : t.dayId}`;

function dayCity(row: ItineraryRow): string {
	const raw = row._day.city ?? row.Day.split(/\s+backup\b/iu)[0] ?? "";
	return (raw.split("→")[0] ?? raw).trim();
}

/** The day title: the label after the first "·" ("3 · Tokyo · Nakano + Shinjuku" → "Tokyo · Nakano + Shinjuku"). */
export function dayTitle(label: string): string | null {
	const i = label.indexOf("·");
	return i < 0 ? null : label.slice(i + 1).trim() || null;
}

export function buildPlan(data: SheetData, o: PlanOptions): ImportPlan {
	const newId = o.newId ?? uuidv7;
	const report: ReportFacts = {
		counts: {},
		geocode: { fromHints: 0, overrides: 0, aliases: 0, misses: [] },
		unmatched: [],
		created: [],
		actionTimeline: [],
		times: [],
		notes: [],
	};

	// ---- hints -------------------------------------------------------------
	const hintBy = new Map<string, Hint & { iso2?: string }>();
	for (const h of data.hints.countries) hintBy.set(h.key, h);
	for (const h of data.hints.cities) hintBy.set(h.key, h);
	for (const h of data.hints.areas) hintBy.set(h.key, h);
	for (const h of data.hints.places) hintBy.set(h.key, h);
	const areaAlias = new Map(
		data.hints.itinerary_area_aliases.map((a) => [a.itinerary, a.maps_to]),
	);
	const placeAlias = new Map(
		data.hints.itinerary_aliases.map((a) => [a.itinerary_place, a]),
	);

	// ---- members -----------------------------------------------------------
	const members: PlanMember[] = [
		{ id: newId(), key: "owner", role: "owner", displayName: null, color: 0 },
		{
			id: newId(),
			key: "audrey",
			role: "editor",
			displayName: "Audrey",
			color: 1,
		},
	];
	const memberByFirst = new Map<string, MemberKey>([
		["dennis", "owner"],
		["audrey", "audrey"],
	]);

	// ---- nodes -------------------------------------------------------------
	const nodes: PlanNode[] = [];
	const byKey = new Map<string, PlanNode>();
	const byId = new Map<string, PlanNode>();
	const children = new Map<string | null, PlanNode[]>();
	/** City node id → normalized area name → area node (areas nest). */
	const areasOfCity = new Map<string, Map<string, PlanNode>>();

	function geoFor(
		keys: readonly string[],
	): { hint: Hint; how: PlanNode["geo"]; key: string } | null {
		for (const k of keys) {
			const ov = data.overrides[k];
			if (ov && "skip" in ov) return null;
			if (ov)
				return { hint: { lat: ov.lat, lng: ov.lng }, how: "override", key: k };
		}
		for (const k of keys) {
			const h = hintBy.get(k);
			if (h) return { hint: h, how: "hint", key: k };
		}
		return null;
	}

	function addNode(
		n: Omit<
			PlanNode,
			"id" | "slug" | "position" | "lat" | "lng" | "tz" | "geo" | "details"
		> & {
			details?: PlanNode["details"];
		},
		geoKeys: readonly string[],
		fallback?: { hint: Hint; how: PlanNode["geo"] },
	): PlanNode {
		const g = geoFor(geoKeys) ?? fallback ?? null;
		const node: PlanNode = {
			...n,
			id: newId(),
			slug: "",
			position: "",
			lat: g?.hint.lat ?? null,
			lng: g?.hint.lng ?? null,
			tz: g?.hint.timezone ?? null,
			geo: g?.how ?? "none",
			details: { ...(n.details ?? {}) },
		};
		if (g?.hint.confidence) node.details.geocodeConfidence = g.hint.confidence;
		if (!g) report.geocode.misses.push(`${n.key} (${n.source})`);
		else if (g.how === "override") report.geocode.overrides++;
		else if (g.how === "alias") report.geocode.aliases++;
		else if (g.how === "hint") report.geocode.fromHints++;
		nodes.push(node);
		byKey.set(n.key, node);
		byId.set(node.id, node);
		const sibs = children.get(n.parentId) ?? [];
		sibs.push(node);
		children.set(n.parentId, sibs);
		return node;
	}

	/** Names (normalized) → nodes, for matching. */
	function nodesNamed(name: string, within?: PlanNode | null): PlanNode[] {
		const want = normName(name);
		const out: PlanNode[] = [];
		const walk = (parentId: string | null) => {
			for (const c of children.get(parentId) ?? []) {
				if (normName(c.name) === want) out.push(c);
				walk(c.id);
			}
		};
		walk(within ? within.id : null);
		if (within && normName(within.name) === want) out.unshift(within);
		return out;
	}

	const cityOf = (n: PlanNode): PlanNode | null => {
		let cur: PlanNode | undefined = n;
		while (cur) {
			if (cur.type === "city" || cur.type === "region") return cur;
			cur = cur.parentId ? byId.get(cur.parentId) : undefined;
		}
		return null;
	};

	// Countries (Cities order, then any extra from Places).
	const countryNames: string[] = [];
	for (const r of [...data.cities.rows, ...data.places.rows])
		if (!countryNames.includes(r.Country)) countryNames.push(r.Country);
	for (const c of countryNames) {
		const h = data.hints.countries.find((x) => x.key === c);
		addNode(
			{
				key: c,
				parentId: null,
				type: "country",
				category: null,
				status: "active",
				name: c,
				description: null,
				countryCode: h?.iso2 ?? null,
				timeNeededMin: null,
				priorities: {},
				note: null,
				source: "geocode-hints countries",
			},
			[c],
		);
	}

	const links: {
		target: Target;
		url: string;
		title: string;
		siteName: string | null;
		source: string;
	}[] = [];
	function addLink(
		target: Target,
		anchor: string,
		url: string | null | undefined,
		about: string,
		source: string,
		kind: "guide" | "link" = "link",
	): void {
		if (!isHttpUrl(url)) return;
		const a = stripArrow(anchor);
		const title =
			kind === "guide" && /^guide$/iu.test(a)
				? `${about} guide`
				: isGenericAnchor(anchor, url)
					? linkTitle(anchor, url, about)
					: /^\S+$/u.test(a)
						? `${hostOf(url) ?? ""}: ${a}`
						: a.slice(0, 200);
		links.push({ target, url, title, siteName: hostOf(url), source });
	}

	// Cities tab (step 4).
	for (const r of data.cities.rows) addCity(r);
	function addCity(r: CityRow): PlanNode {
		const country = byKey.get(r.Country) as PlanNode;
		const region = REGION_CITIES.has(normName(r.City));
		const node = addNode(
			{
				key: `${r.Country}|${r.City}`,
				parentId: country.id,
				type: region ? "region" : "city",
				category: null,
				status: r.Status === "Dropped" ? "dropped" : "active",
				name: r.City,
				description: null,
				countryCode: null,
				timeNeededMin: null,
				priorities: {},
				note: cellMarkdown(r.Notes, r.Notes_links ?? []) || null,
				source: `Cities!B${r._row}`,
				details: r.Days != null ? { plannedDays: r.Days } : {},
			},
			[`${r.Country}|${r.City}`],
		);
		const t: Target = { kind: "node", nodeId: node.id };
		for (const l of r.Notes_links ?? [])
			addLink(t, l.text, l.url, r.City, `Cities!E${r._row}`);
		if (r.Guide_url)
			addLink(
				t,
				r.Guide ?? "Guide",
				r.Guide_url,
				r.City,
				`Cities!F${r._row}`,
				"guide",
			);
		return node;
	}

	function ensureCity(country: string, city: string, source: string): PlanNode {
		const found = byKey.get(`${country}|${city}`);
		if (found) return found;
		const parent = byKey.get(country) as PlanNode;
		const node = addNode(
			{
				key: `${country}|${city}`,
				parentId: parent.id,
				type: REGION_CITIES.has(normName(city)) ? "region" : "city",
				category: null,
				status: "active",
				name: city,
				description: null,
				countryCode: null,
				timeNeededMin: null,
				priorities: {},
				note: null,
				source,
				details: { notInCitiesTab: true },
			},
			[`${country}|${city}`],
		);
		report.created.push(`${city} (city, only in Places: ${source})`);
		return node;
	}

	function areaMap(city: PlanNode): Map<string, PlanNode> {
		let m = areasOfCity.get(city.id);
		if (!m) {
			m = new Map();
			areasOfCity.set(city.id, m);
		}
		return m;
	}

	/** Find or create the area `name` of `city` (under `parent`, default the city). */
	function ensureArea(
		country: string,
		city: PlanNode,
		name: string,
		source: string,
		parent?: PlanNode,
	): PlanNode {
		const m = areaMap(city);
		const found = m.get(normName(name));
		if (found) return found;
		const node = addNode(
			{
				key: `${country}|${city.name}|${name}`,
				parentId: (parent ?? city).id,
				type: "area",
				category: null,
				status: "active",
				name,
				description: null,
				countryCode: null,
				timeNeededMin: null,
				priorities: {},
				note: null,
				source,
			},
			[
				`${country}|${city.name}|${name}`,
				`${country}|${city.name}||${name}`,
				...(parent && parent.type === "area"
					? [`${country}|${city.name}|${parent.name}|${name}`]
					: []),
			],
		);
		m.set(normName(name), node);
		return node;
	}

	// Places tab (step 5).
	const knifeGuide = data.cities.rows
		.flatMap((c) => c.Notes_links ?? [])
		.find((l) => /kappabashi-knife/iu.test(l.url));
	const priorities = (r: PlaceRow): PlanNode["priorities"] => {
		const out: PlanNode["priorities"] = {};
		const d = r["Priority (Dennis)"];
		const a = r["Priority (Audrey)"];
		if (d && SHEET_PRIORITY_MAP[d]) out.owner = SHEET_PRIORITY_MAP[d];
		if (a && SHEET_PRIORITY_MAP[a]) out.audrey = SHEET_PRIORITY_MAP[a];
		return out;
	};
	const timeNeeded = (t: string | null): number | null => {
		const k = t ? SHEET_TIME_MAP[t] : undefined;
		return k ? TIME_NEEDED[k].minutes : null;
	};
	const placeNote = (r: PlaceRow): string | null => {
		const extra: CellLink[] = [];
		// Places J29: "Knife shopping guide ↗" is styled as a link with no URL
		// stored; the intended page is the Tokyo Cheapo guide linked from Cities E2.
		if (
			r.Notes?.includes("Knife shopping guide ↗") &&
			!(r.Notes_links ?? []).some((l) =>
				l.text.includes("Knife shopping guide"),
			) &&
			knifeGuide
		) {
			extra.push({ text: "Knife shopping guide ↗", url: knifeGuide.url });
			report.notes.push(
				`Places J${r._row}: "Knife shopping guide ↗" has no stored URL; linked to ${knifeGuide.url} (Cities E2).`,
			);
		}
		return cellMarkdown(r.Notes, r.Notes_links ?? [], extra) || null;
	};

	for (const r of data.places.rows) {
		const cityNode = ensureCity(r.Country, r.City, `Places!B${r._row}`);
		const areaParent = r.Area
			? ensureArea(r.Country, cityNode, r.Area, `Places!C${r._row}`)
			: null;
		const fields = {
			description: r.Description,
			timeNeededMin: timeNeeded(r["Time Needed"]),
			priorities: priorities(r),
			note: placeNote(r),
		};
		let node: PlanNode;
		if (r.Category === "Neighborhood") {
			// The row IS an area: merged with a same-named area of the city.
			const existing = areaMap(cityNode).get(normName(r.Place));
			node =
				existing ??
				ensureArea(
					r.Country,
					cityNode,
					r.Place,
					`Places!D${r._row}`,
					areaParent ?? undefined,
				);
			Object.assign(node, fields);
			node.details.sheetCategory = "Neighborhood";
			node.source = `Places!D${r._row}`;
			if (node.geo === "none" || node.geo === "parent") {
				const g = geoFor([`${r.Country}|${r.City}|${r.Area ?? ""}|${r.Place}`]);
				if (g) {
					node.lat = g.hint.lat;
					node.lng = g.hint.lng;
					node.tz = g.hint.timezone ?? node.tz;
					node.geo = g.how;
				}
			}
		} else {
			const map =
				SHEET_CATEGORY_MAP[
					(r.Category ?? "") as keyof typeof SHEET_CATEGORY_MAP
				];
			const type: NodeType = map?.type ?? "place";
			const category: PlaceCategory | null =
				type === "place"
					? ((map && "category" in map ? map.category : undefined) ?? "other")
					: null;
			node = addNode(
				{
					key: `${r.Country}|${r.City}|${r.Area ?? ""}|${r.Place}`,
					parentId: (areaParent ?? cityNode).id,
					type,
					category,
					status: "active",
					name: r.Place,
					countryCode: null,
					source: `Places!D${r._row}`,
					...fields,
					details: r.Category ? { sheetCategory: r.Category } : {},
				},
				[`${r.Country}|${r.City}|${r.Area ?? ""}|${r.Place}`],
			);
		}
		if (r.Link_url)
			addLink(
				{ kind: "node", nodeId: node.id },
				r.Link ?? "Link ↗",
				r.Link_url,
				r.Place,
				`Places!K${r._row}`,
			);
		for (const l of r.Notes_links ?? [])
			addLink(
				{ kind: "node", nodeId: node.id },
				l.text,
				l.url,
				r.Place,
				`Places!J${r._row}`,
			);
	}

	// ---- days --------------------------------------------------------------
	const days: PlanDay[] = [];
	for (let d = o.start; d <= o.end; d = addDaysIso(d, 1))
		days.push({
			id: newId(),
			date: d,
			startTime: "09:00",
			title: null,
			nightNodeId: null,
		});
	const dayByDate = new Map(days.map((d) => [d.date, d]));
	if (o.start < o.day1) {
		const first = dayByDate.get(o.start);
		if (first) first.title = "Fly JFK → Tokyo";
	}

	// ---- itinerary (step 6) -------------------------------------------------
	const items: PlanItem[] = [];
	const legs: PlanLeg[] = [];
	const listItems: PlanListItem[] = [];
	const notes: PlanNote[] = [];
	const itemRows = new Map<string, ItineraryRow>();
	let ryokan: PlanNode | null = null;

	function ensureRyokan(row: ItineraryRow): PlanNode {
		if (ryokan) return ryokan;
		const alias = placeAlias.get(row.Place);
		const areaKey = alias?.maps_to ?? "Japan|Mt. Fuji|Kawaguchiko";
		const [country, cityName, areaName] = areaKey.split("|") as [
			string,
			string,
			string,
		];
		const city = byKey.get(`${country}|${cityName}`) as PlanNode;
		const area = ensureArea(country, city, areaName, `Itinerary!C${row._row}`);
		const areaHint = hintBy.get(areaKey);
		ryokan = addNode(
			{
				key: `${country}|${cityName}|${areaName}|${RYOKAN_NAME}`,
				parentId: area.id,
				type: "place",
				category: "lodging",
				status: "active",
				name: RYOKAN_NAME,
				description: "Fuji-view room with a private onsen (not booked yet)",
				countryCode: null,
				timeNeededMin: null,
				priorities: {},
				note: null,
				source: `Itinerary!C${row._row}`,
				details: { sheetCategory: "Hotel" },
			},
			[`${country}|${cityName}|${areaName}|${RYOKAN_NAME}`],
			areaHint
				? { hint: { ...areaHint, confidence: "low" }, how: "alias" }
				: undefined,
		);
		report.created.push(
			`${RYOKAN_NAME} (lodging under Mt. Fuji › ${areaName}, pinned at the ${areaName} area: not booked yet)`,
		);
		return ryokan;
	}

	/** The area node an itinerary row's Area names (area aliases applied). */
	function rowArea(row: ItineraryRow): PlanNode | null {
		if (!row.Area) return null;
		const raw = `Japan|${dayCity(row)}|${row.Area}`;
		const key = areaAlias.get(raw) ?? raw;
		const [country, cityName, areaName] = key.split("|") as [
			string,
			string,
			string,
		];
		const city = byKey.get(`${country}|${cityName}`);
		if (!city) {
			report.unmatched.push(
				`Itinerary!B${row._row}: area "${row.Area}" (no city ${cityName})`,
			);
			return null;
		}
		const found = areaMap(city).get(normName(areaName));
		if (found) return found;
		// An Area that names a place (or an unknown area): create it from its hint.
		return ensureArea(country, city, areaName, `Itinerary!B${row._row}`);
	}

	function rowNode(row: ItineraryRow): PlanNode | null {
		const alias = placeAlias.get(row.Place);
		if (alias?.maps_to) {
			const k = alias.maps_to;
			const parts = k.split("|");
			if (parts.length === 4) {
				const hit =
					byKey.get(k) ??
					nodesNamed(
						parts[3] as string,
						byKey.get(`${parts[0]}|${parts[1]}`),
					)[0];
				if (hit) return hit;
			}
		}
		const area = rowArea(row);
		const cityNode = byKey.get(`Japan|${dayCity(row)}`) ?? null;
		const scopes = [area, area ? cityOf(area) : null, cityNode];
		for (const s of scopes) {
			if (!s) continue;
			const hit = nodesNamed(row.Place, s)[0];
			if (hit) return hit;
		}
		const global = nodesNamed(row.Place);
		if (global.length === 1) return global[0] as PlanNode;
		return null;
	}

	type Pending = { row: ItineraryRow; after: number };
	const dayRows = new Map<string | null, ItineraryRow[]>();
	for (const r of data.itinerary.rows) {
		const date =
			r._day.is_backup || r._day.number == null
				? null
				: addDaysIso(o.day1, r._day.number - 1);
		const day = date ? dayByDate.get(date) : null;
		if (date && !day) {
			report.unmatched.push(
				`Itinerary!A${r._row}: day ${r._day.number} (${date}) is outside the trip dates`,
			);
			continue;
		}
		const k = day ? day.id : null;
		dayRows.set(k, [...(dayRows.get(k) ?? []), r]);
		if (day && !day.title) day.title = dayTitle(r.Day);
		const start = day ? sheetTime("dayStart", r) : null;
		if (day && start) day.startTime = start;
	}
	// A rule whose row is gone (or moved to another day) is reported, not applied.
	for (const t of SHEET_TIMES)
		if (
			!data.itinerary.rows.some(
				(r) => r._day.number === t.day && r.Place === t.place,
			)
		)
			report.times.push({
				what: `${t.kind === "pin" ? "pin" : "day start"} ${t.at} for sheet day ${t.day} · ${t.place}: no such row`,
				at: t.at,
				quote: t.quote,
				applied: false,
			});

	/** The sheet-stated time of `kind` for this row (and the report line), or null. */
	function sheetTime(
		kind: SheetTime["kind"],
		row: ItineraryRow,
	): string | null {
		const t = SHEET_TIMES.find(
			(x) =>
				x.kind === kind && x.day === row._day.number && x.place === row.Place,
		);
		if (!t) return null;
		const applied = quoteHolds(t, row);
		const day = `${addDaysIso(o.day1, t.day - 1)} (sheet day ${t.day})`;
		report.times.push({
			what:
				kind === "pin"
					? `${row.Place} on ${day} pinned at ${t.at}: ${t.why}`
					: `${day} starts at ${t.at}: ${t.why}`,
			at: t.at,
			quote: t.quote,
			applied,
		});
		return applied ? t.at : null;
	}

	const addTodo = (
		target: Target,
		text: string,
		source: string,
		extra: Partial<PlanListItem> = {},
	) => {
		listItems.push({
			id: newId(),
			list: "todo",
			target,
			text,
			note: null,
			url: null,
			status: "open",
			dueKind: "due",
			dueRule: null,
			dueDate: null,
			dueTime: null,
			dueTz: null,
			priceAmount: null,
			priceCurrency: null,
			priceText: null,
			position: "",
			assignees: [],
			extraTargets: [],
			source,
			...extra,
		});
	};

	for (const [dayId, rows] of dayRows) {
		const dayItems: PlanItem[] = [];
		const travels: Pending[] = [];
		for (const row of rows) {
			const src = `Itinerary!C${row._row}`;
			const hours = row["Open Hours"]?.trim() || null;
			const notesMd = cellMarkdown(row.Notes);
			const durationMin = hrsToMin(row.Hrs) ?? 60;
			if (row.Category === "Travel") {
				travels.push({ row, after: dayItems.length });
				continue;
			}
			let nodeId: string | null = null;
			let title: string | null = row.Place;
			let note: string | null = notesMd || null;
			if (row.Category === "Meal") {
				if (/\(ryokan\b/iu.test(row.Place)) nodeId = ensureRyokan(row).id;
				else nodeId = rowArea(row)?.id ?? null;
				note =
					blocks(hours ? `Hours: ${escapeInline(hours)}` : null, notesMd) ||
					null;
			} else if (row.Category === "Hotel") {
				const r = ensureRyokan(row);
				nodeId = r.id;
				note =
					blocks(hours ? `Hours: ${escapeInline(hours)}` : null, notesMd) ||
					null;
				if (/check-?in/iu.test(row.Place) && dayId) {
					const day = days.find((d) => d.id === dayId);
					if (day) day.nightNodeId = r.id;
				}
				if (row["Book ahead"] === "Yes") r.details.bookAhead = true;
			} else {
				let node = rowNode(row);
				if (!node) {
					const area = rowArea(row);
					const city = byKey.get(`Japan|${dayCity(row)}`) ?? null;
					const map =
						SHEET_CATEGORY_MAP[
							(row.Category ?? "") as keyof typeof SHEET_CATEGORY_MAP
						];
					node = addNode(
						{
							key: `Japan|${dayCity(row)}|${row.Area ?? ""}|${row.Place}`,
							parentId: (area ?? city)?.id ?? null,
							type: map?.type ?? "place",
							category:
								(map?.type ?? "place") === "place"
									? ((map && "category" in map ? map.category : undefined) ??
										"other")
									: null,
							status: "active",
							name: row.Place,
							description: null,
							countryCode: null,
							timeNeededMin: null,
							priorities: {},
							note: null,
							source: src,
						},
						[`Japan|${dayCity(row)}|${row.Area ?? ""}|${row.Place}`],
					);
					report.created.push(`${row.Place} (new place from ${src})`);
				}
				nodeId = node.id;
				title = normName(row.Place) === normName(node.name) ? null : row.Place;
				if (hours && !node.details.openHoursText)
					node.details.openHoursText = hours;
				if (row["Book ahead"] === "Yes") node.details.bookAhead = true;
			}
			const item: PlanItem = {
				id: newId(),
				dayId,
				nodeId,
				title,
				note,
				position: "",
				durationMin,
				pinnedStart: sheetTime("pin", row),
				fixedDate: saysBooked(row.Notes, row["Open Hours"]),
				assignees: [],
				source: src,
			};
			dayItems.push(item);
			itemRows.set(item.id, row);
			if (row["Book ahead"] === "Yes")
				addTodo(
					{ kind: "item", itemId: item.id },
					"Book ahead",
					`Itinerary!F${row._row}`,
				);
		}
		// Travel rows: the leg between the neighbouring located items (§17.3 step 6).
		for (const t of travels) {
			const before = dayItems
				.slice(0, t.after)
				.filter((i) => i.nodeId)
				.at(-1);
			const after = dayItems.slice(t.after).find((i) => i.nodeId);
			const src = `Itinerary!C${t.row._row}`;
			if (!before || !after || before.nodeId === after.nodeId) {
				report.unmatched.push(
					`${src}: travel "${t.row.Place}" has no located items on both sides`,
				);
				continue;
			}
			const durationMin = hrsToMin(t.row.Hrs);
			const bus = /^bus\b/iu.test(t.row.Place);
			const label = t.row.Place.slice(0, 80);
			// A direct ride between two known stations (geocode-hints route) is one
			// segment, so the leg shows its line ("Fuji Excursion"); multi-stop
			// routes have no per-segment times in the sheet and stay a label.
			const stops = (placeAlias.get(t.row.Place)?.route ?? []).map((name) =>
				data.hints.transit_points.find((p) => p.name === name),
			);
			const direct =
				!bus &&
				stops.length === 2 &&
				stops.every(Boolean) &&
				durationMin !== null
					? [
							{
								mode: "rail" as const,
								lineName: (t.row.Place.split(" (")[0] ?? label).slice(0, 200),
								from: {
									name: stops[0]?.name as string,
									lat: stops[0]?.lat,
									lng: stops[0]?.lng,
								},
								to: {
									name: stops[1]?.name as string,
									lat: stops[1]?.lat,
									lng: stops[1]?.lng,
								},
								durationMin,
							},
						]
					: [];
			const details: LegDetails = bus
				? { kind: "other", otherKind: "bus", label }
				: {
						kind: "transit",
						route: {
							id: "sheet",
							source: "manual",
							durationMin: durationMin ?? 0,
							walkMin: 0,
							transfers: 0,
							segments: direct,
							label,
						},
						chosenId: "sheet",
					};
			const hours = t.row["Open Hours"]?.trim() || null;
			const leg: PlanLeg = {
				id: newId(),
				kind: "pair",
				fromItemId: before.id,
				toItemId: after.id,
				mode: bus ? "other" : "transit",
				durationMin,
				details,
				depAt: null,
				arrAt: null,
				note:
					blocks(
						hours ? escapeInline(hours) : null,
						cellMarkdown(t.row.Notes),
					) || null,
				label: t.row.Place,
				assignees: [],
				source: src,
			};
			legs.push(leg);
			if (t.row["Book ahead"] === "Yes")
				addTodo(
					{ kind: "leg", legId: leg.id },
					"Book ahead",
					`Itinerary!F${t.row._row}`,
				);
		}
		const keys = freshKeysPure(dayItems.length);
		dayItems.forEach((it, i) => {
			it.position = keys[i] as string;
		});
		items.push(...dayItems);
	}

	const capacity = data.itinerary.summary.rows.find(
		(r) => r.kind === "capacity",
	);
	const capHrs = Number(
		String(capacity?.hrs ?? capacity?.label ?? "").replace(/[^\d.]/g, ""),
	);
	const settings: TripSettings = {
		// The home currency (ADDENDUM §7.2): the travellers are US-based.
		currency: "USD",
		dayCapacityMin:
			Number.isFinite(capHrs) && capHrs > 0 ? Math.round(capHrs * 60) : 750,
	};

	// ---- shopping list (step 7) --------------------------------------------
	const cityNamed = (name: string): PlanNode | null =>
		nodes.find(
			(n) =>
				(n.type === "city" || n.type === "region" || n.type === "country") &&
				normName(n.name) === normName(name),
		) ?? null;
	const ancestors = (n: PlanNode): PlanNode[] => {
		const out: PlanNode[] = [];
		let cur: PlanNode | undefined = n;
		while (cur) {
			out.unshift(cur);
			cur = cur.parentId ? byId.get(cur.parentId) : undefined;
		}
		return out;
	};
	const commonAncestor = (ns: PlanNode[]): PlanNode | null => {
		if (!ns.length) return null;
		let common = ancestors(ns[0] as PlanNode);
		for (const n of ns.slice(1)) {
			const a = ancestors(n);
			let i = 0;
			while (i < common.length && i < a.length && common[i]?.id === a[i]?.id)
				i++;
			common = common.slice(0, i);
		}
		return common.at(-1) ?? null;
	};

	for (const r of data.shopping.rows) planShopping(r);
	function planShopping(r: ShoppingRow): void {
		const cityNames = (r.City ?? "")
			.split(/\s*[/,]\s*|\s+and\s+/u)
			.map((s) => s.trim())
			.filter(Boolean);
		const cityNodes = cityNames
			.map((c) => cityNamed(c))
			.filter((n): n is PlanNode => n !== null);
		const scope = cityNodes.length === 1 ? cityNodes[0] : null;
		const matches: PlanNode[] = [];
		const unmatchedWhere: string[] = [];
		for (const seg of (r.Where ?? "").split(/\s+·\s+|\s+—\s+/u)) {
			const s = seg.trim();
			if (!s) continue;
			const inScope = scope ? nodesNamed(s, scope) : [];
			const hit =
				inScope[0] ??
				(() => {
					const g = nodesNamed(s).filter(
						(n) => n.type === "place" || n.type === "area",
					);
					return g.length === 1 ? g[0] : undefined;
				})();
			if (hit && !matches.includes(hit)) matches.push(hit);
			else if (!hit) unmatchedWhere.push(s);
		}
		let primary: Target;
		if (matches[0]) primary = { kind: "node", nodeId: matches[0].id };
		else {
			const anc = commonAncestor(cityNodes);
			primary =
				anc && cityNodes.length === cityNames.length && cityNames.length > 0
					? { kind: "node", nodeId: anc.id }
					: { kind: "root" };
		}
		const assignees = (r.For ?? "")
			.split(",")
			.map((s) => memberByFirst.get(normName(s)))
			.filter((m): m is MemberKey => m !== undefined);
		const status: ListItemStatus = /^(bought|done)$/iu.test(r.Status ?? "")
			? "done"
			: /^skipped$/iu.test(r.Status ?? "")
				? "skipped"
				: "open";
		const sources = (r.Sources_links ?? []).filter((l) => isHttpUrl(l.url));
		const yen = yenAmount(r["Rough budget"]);
		const where =
			!matches.length && r.Where ? `Where: ${escapeInline(r.Where)}` : null;
		listItems.push({
			id: newId(),
			list: "shopping",
			target: primary,
			text: r.Item,
			note: blocks(cellMarkdown(r.Notes), where) || null,
			url: sources[0]?.url ?? null,
			status,
			dueKind: "due",
			dueRule: null,
			dueDate: null,
			dueTime: null,
			dueTz: null,
			priceAmount: yen,
			priceCurrency: yen !== null ? "JPY" : null,
			priceText: r["Rough budget"],
			position: "",
			assignees,
			extraTargets: matches.slice(1).map((m) => m.id),
			source: `Shopping List!A${r._row}`,
		});
		for (const l of sources.slice(1))
			addLink(primary, l.text, l.url, r.Item, `Shopping List!H${r._row}`);
	}

	// ---- Action Timeline (step 8; ADDENDUM §8, §10) --------------------------
	if (o.actionTimeline) for (const r of data.actions.rows) planAction(r);
	function planAction(r: ActionRow): void {
		const skip = (r.Type === "Flight" || r.Type === "Points") && !o.flightRows;
		const at = `Action Timeline!A${r._row}`;
		if (skip) {
			report.actionTimeline.push({
				row: r._row,
				what: r.What,
				target: "(skipped: flight/points row)",
				due: "",
				rule: null,
			});
			return;
		}
		const t = actionTarget(r.What, r.Type);
		let target: Target = { kind: "root" };
		let targetLabel = "trip root";
		let anchorItem: PlanItem | null = null;
		if (t.kind === "place") {
			const hit =
				nodesNamed(t.name).find(
					(n) => n.type === "place" || n.type === "area",
				) ??
				nodes.find(
					(n) =>
						n.type === "place" &&
						normName(t.name).startsWith(`${normName(n.name)} `),
				);
			if (hit) {
				target = { kind: "node", nodeId: hit.id };
				targetLabel = hit.name;
				anchorItem = items.find((i) => i.nodeId === hit.id) ?? null;
			} else
				report.unmatched.push(
					`${at}: "${r.What}" → trip root (no place named "${t.name}")`,
				);
		} else if (t.kind === "node") {
			const hit =
				t.key === "ryokan"
					? ryokan
					: t.key === "Japan"
						? byKey.get("Japan")
						: cityNamed(t.key);
			if (hit) {
				target = { kind: "node", nodeId: hit.id };
				targetLabel = hit.name;
				if (t.key === "ryokan")
					anchorItem = items.find((i) => i.nodeId === hit.id) ?? null;
			}
		} else if (t.kind === "leg") {
			const leg = legs.find((l) => /^fuji excursion/iu.test(l.label));
			if (leg) {
				target = { kind: "leg", legId: leg.id };
				targetLabel = `leg ${leg.label}`;
				// The ride's day, through the item it leads to ("Drop bags at ryokan"):
				// a rule shown as "1 month before Breakfast" would read oddly.
				anchorItem = items.find((i) => i.id === leg.toItemId) ?? null;
			}
		}
		if (targetLabel === "trip root" && t.kind !== "root" && t.kind !== "place")
			report.unmatched.push(`${at}: "${r.What}" → trip root`);

		const abs = absoluteDue(r["Booking opens"], r["Time (ET)"]);
		const known = knownWindow(r.What, r.Type);
		let dueRule: DueRule | null = null;
		let due = abs;
		let ruleText: string | null = null;
		if (known) {
			// A flight row anchors only on a FLIGHT leaving on its travel date (its
			// departure item). The ANA rows are alternative departure dates, so
			// without that flight on the plan they keep the sheet's absolute time.
			const anchor =
				known.anchor === "flight"
					? (flightDepartureOn(r["For travel date"]) ?? null)
					: anchorItem;
			if (anchor) {
				dueRule = { ...known.rule, itemId: anchor.id } as DueRule;
				const anchorDay = days.find((d) => d.id === anchor.dayId);
				due = anchorDay
					? resolveWindow(known.rule, anchorDay.date)
					: { dueDate: null, dueTime: null, dueTz: null };
				ruleText = `${describeRule(known.rule)}, anchored on "${itemLabel(anchor)}" (${anchorDay ? anchorDay.date : "Unscheduled: TBD until it's scheduled"}); ${known.why}`;
			} else {
				ruleText = `no anchor item on the plan; kept ${abs.dueDate ? "absolute" : "TBD"} (${known.why})`;
			}
		}
		const status: ListItemStatus = /^(done|booked)$/iu.test(r.Status ?? "")
			? "done"
			: "open";
		addTodo(target, r.What, at, {
			note: cellMarkdown(r.Notes) || null,
			status,
			dueKind: actionDueKind(r.Type, r.Notes),
			dueRule,
			...due,
		});
		report.actionTimeline.push({
			row: r._row,
			what: r.What,
			target: targetLabel,
			due: due.dueDate
				? `${due.dueDate}${due.dueTime ? ` ${due.dueTime} ${due.dueTz}` : ""}`
				: "TBD",
			rule: ruleText,
		});
	}
	function flightDepartureOn(date: string | null): PlanItem | undefined {
		if (!date) return undefined;
		for (const l of legs) {
			if (l.mode !== "flight") continue;
			const from = items.find((i) => i.id === l.fromItemId);
			const day = from && days.find((d) => d.id === from.dayId);
			if (day?.date === date) return from;
		}
		return undefined;
	}
	function itemLabel(i: PlanItem): string {
		return i.title ?? (i.nodeId ? byId.get(i.nodeId)?.name : null) ?? "item";
	}

	// ---- photos (step 10) ---------------------------------------------------
	const attachments: PlanAttachment[] = [];
	const photos = [...data.media].sort(
		(a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)),
	);
	let cover: string | null = null;
	for (const m of photos) {
		const node = mediaNode(m);
		if (!node) {
			report.unmatched.push(
				`media ${m.file}: no ${m.level} "${m.placeName ?? m.city}" in ${m.city}`,
			);
			continue;
		}
		const id = newId();
		attachments.push({
			id,
			kind: "photo",
			target: { kind: "node", nodeId: node.id },
			url: isHttpUrl(m.pageUrl) ? m.pageUrl : null,
			title: null,
			siteName:
				m.source === "wikimedia"
					? "Wikimedia Commons"
					: m.pageUrl
						? hostOf(m.pageUrl)
						: null,
			author: m.author ?? null,
			caption: m.caption ? escapeInline(m.caption) : null,
			meta: {
				...(m.license ? { license: m.license } : {}),
				...(isHttpUrl(m.licenseUrl) ? { licenseUrl: m.licenseUrl } : {}),
				source: m.source,
				...(isHttpUrl(m.sourceUrl) ? { sourceUrl: m.sourceUrl } : {}),
				aspect: m.width / m.height,
			},
			position: "",
			photo: {
				file: m.file,
				contentType: m.contentType,
				width: m.width,
				height: m.height,
				bytes: m.bytes,
			},
			source: `media ${m.file}`,
		});
		if (
			!cover &&
			m.level === "city" &&
			normName(m.city) === "tokyo" &&
			m.primary
		)
			cover = id;
	}
	function mediaNode(m: MediaEntry): PlanNode | null {
		const city = byKey.get(`${m.country}|${m.city}`);
		if (!city) return null;
		if (m.level === "city") return city;
		const area = typeof m.area === "string" ? m.area : "";
		return (
			byKey.get(`${m.country}|${m.city}|${area}|${m.placeName}`) ??
			nodesNamed(m.placeName ?? "", city)[0] ??
			null
		);
	}
	for (const l of links)
		attachments.push({
			id: newId(),
			kind: "link",
			target: l.target,
			url: l.url,
			title: l.title,
			siteName: l.siteName,
			author: null,
			caption: null,
			meta: { fetch: "unfetched" },
			position: "",
			photo: null,
			source: l.source,
		});

	// ---- notes ---------------------------------------------------------------
	for (const n of nodes)
		if (n.note)
			notes.push({ target: { kind: "node", nodeId: n.id }, markdown: n.note });
	for (const l of legs)
		if (l.note)
			notes.push({ target: { kind: "leg", legId: l.id }, markdown: l.note });

	// ---- slugs and positions ---------------------------------------------------
	for (const [parentId, sibs] of children) {
		const taken: string[] = parentId === null ? [...ROOT_RESERVED_SLUGS] : [];
		const keys = freshKeysPure(sibs.length);
		sibs.forEach((n, i) => {
			n.slug = uniqueSlug(slugify(n.name, n.id), taken);
			taken.push(n.slug);
			n.position = keys[i] as string;
		});
	}
	// Parents before children (the writer inserts in this order).
	const ordered: PlanNode[] = [];
	const visit = (parentId: string | null) => {
		for (const c of children.get(parentId) ?? []) {
			ordered.push(c);
			visit(c.id);
		}
	};
	visit(null);
	positionByTarget(listItems, (l) => `${targetKey(l.target)}:${l.list}`);
	positionByTarget(attachments, (a) => targetKey(a.target));

	// ---- report counts -------------------------------------------------------
	const count = (xs: readonly unknown[]) => xs.length;
	report.counts = {
		countries: ordered.filter((n) => n.type === "country").length,
		citiesAndRegions: ordered.filter(
			(n) => n.type === "city" || n.type === "region",
		).length,
		citiesDropped: ordered.filter(
			(n) =>
				(n.type === "city" || n.type === "region") && n.status === "dropped",
		).length,
		areas: ordered.filter((n) => n.type === "area").length,
		places: ordered.filter((n) => n.type === "place").length,
		nodes: count(ordered),
		priorities: ordered.reduce(
			(s, n) => s + Object.keys(n.priorities).length,
			0,
		),
		days: count(days),
		itemsScheduled: items.filter((i) => i.dayId).length,
		itemsUnscheduled: items.filter((i) => !i.dayId).length,
		legs: count(legs),
		todos: listItems.filter((l) => l.list === "todo").length,
		todosBookAhead: listItems.filter(
			(l) => l.list === "todo" && l.text === "Book ahead",
		).length,
		todosActionTimeline: listItems.filter(
			(l) => l.list === "todo" && l.source.startsWith("Action Timeline"),
		).length,
		todosRelative: listItems.filter((l) => l.dueRule).length,
		shopping: listItems.filter((l) => l.list === "shopping").length,
		shoppingExtraTargets: listItems.reduce(
			(s, l) => s + l.extraTargets.length,
			0,
		),
		links: attachments.filter((a) => a.kind === "link").length,
		linksOnListItems: listItems.filter((l) => l.url).length,
		photos: attachments.filter((a) => a.kind === "photo").length,
		notes: count(notes),
	};
	report.notes.push(
		"Random Notes are not imported (ADDENDUM §8).",
		"Audrey is a placeholder member (editor) carrying her ratings; she claims it when she signs up (ADDENDUM §8).",
	);

	return {
		trip: {
			id: newId(),
			slug: o.slug,
			name: o.name,
			startDate: o.start,
			endDate: o.end,
			defaultTz: byKey.get("Japan")?.tz ?? "Asia/Tokyo",
			settings,
			coverAttachmentId: cover,
		},
		members,
		nodes: ordered,
		days,
		items,
		legs,
		listItems,
		attachments,
		notes,
		report,
	};
}

function positionByTarget<T extends { position: string }>(
	rows: T[],
	scope: (r: T) => string,
): void {
	const groups = new Map<string, T[]>();
	for (const r of rows)
		groups.set(scope(r), [...(groups.get(scope(r)) ?? []), r]);
	for (const g of groups.values()) {
		const keys = freshKeysPure(g.length);
		g.forEach((r, i) => {
			r.position = keys[i] as string;
		});
	}
}

function describeRule(r: {
	kind: "days" | "months";
	days?: number;
	months?: number;
	dayOfMonth?: number;
	time: string;
	tz: string;
}): string {
	const at = `${r.time} ${r.tz}`;
	if (r.kind === "days") return `${r.days} days before, ${at}`;
	const m = r.months === 1 ? "1 month" : `${r.months} months`;
	return r.dayOfMonth
		? `the ${ordinal(r.dayOfMonth)} of the month ${m} before, ${at}`
		: `${m} before, ${at}`;
}

function ordinal(n: number): string {
	const s = ["th", "st", "nd", "rd"];
	const v = n % 100;
	return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Priority label for the report ("Really want"). */
export const priorityLabel = (p: Priority): string => PRIORITIES[p].label;

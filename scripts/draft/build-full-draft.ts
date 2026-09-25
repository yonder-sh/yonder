/**
 * FB-11 · "Asia 2027 · Full draft" (seed/draft/SCHEMA.md §7). Reads the draft
 * files in `seed/draft/`, validates all of them (SCHEMA §8 plus the app's own
 * input limits), copies the owner's real trip with the app's Duplicate… logic
 * (`duplicateTripCore`) and applies the whole itinerary to the COPY through the
 * app's server functions, the same validators and handler bodies the UI
 * calls: nodes, day titles and starts, stays, items, flight blocks, legs
 * (reserved trains, taxis, cars), notes, links, planned expenses split between
 * Dennis and Audrey, to-dos with relative booking windows and the budgets.
 * Then it queues leg autofill (walks and Japan rail estimates), waits for it,
 * and prints a report. The real trip is only ever read.
 *
 *   N pnpm exec tsx scripts/draft/build-full-draft.ts --check   # validate + resolve, writes nothing
 *   N pnpm exec tsx scripts/draft/build-full-draft.ts           # (re)build asia-2027-full-draft
 *
 * A rebuild hard-deletes the previous draft (only a trip named like the draft
 * and created by the owner), edits made to it included.
 *
 * Flags: --check · --source <slug> (asia-2027) · --owner <email> · --dir <seed/draft>
 * · --no-autofill · --wait <seconds> (90; how long to wait for autofill) ·
 * --report <file> (.data/full-draft-report.md; "-" = stdout only).
 *
 * Environment: `.env`, but variables already set win, so
 * `set -a; . .data/agent-57.env; set +a` runs it against an isolated database.
 *
 * Server functions outside a request: `@tanstack/react-start` and
 * `@tanstack/react-start/server` resolve to the DB tests' stand-ins
 * (`src/test/start-mock.ts`, `start-server-mock.ts`), so
 * `createServerFn(...).validator(schema).handler(fn)` is a plain function that
 * runs the real validator and the real handler body with `context.user` = the
 * owner. Only the session middleware (cookie lookup, rate limits) is skipped.
 * Notes are Yjs documents that only the collab server edits, so they are
 * written like the sheet importer writes them (`markdownToYdoc`), inside the
 * app's `withTripTx`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { isKnownCurrency, toMinor } from "@/lib/engine/money";
import { addDays, localDateTimeToEpoch } from "@/lib/engine/time";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { HHmm, HttpUrl, IsoDate, LocalDT, Tz } from "@/lib/schemas/common";
import {
	EXPENSE_CATEGORY_VALUES,
	PlaceCategory,
	Priority,
} from "@/lib/schemas/enums";
import { FlightDetails, OtherKind, SegmentMode } from "@/lib/schemas/legs";
import { isProposed } from "@/lib/schemas/proposals";
import type { BundleTarget, LegTarget } from "@/lib/schemas/targets";
import type { AuthUser } from "@/server/auth.server";
import { loadDotEnv } from "../load-env";

// ===========================================================================
// Draft file shapes (SCHEMA.md §3–§6), strict: an unknown field is an error
// ===========================================================================

const Member = z.enum(["dennis", "audrey"]);
type Member = z.infer<typeof Member>;
const MEMBERS: readonly Member[] = ["dennis", "audrey"];
const Currency = z.string().regex(/^[A-Z]{3}$/, "expected ISO 4217");
const ExpenseCategory = z.enum(EXPENSE_CATEGORY_VALUES);
type ExpenseCategory = z.infer<typeof ExpenseCategory>;
const Confidence = z.enum(["high", "medium", "low"]);

const NodeSpec = z.strictObject({
	key: z.string().min(1),
	type: z.enum(["country", "region", "city", "area", "place"]),
	category: PlaceCategory.optional(),
	parent: z.string().min(1).optional(),
	name: z.string().trim().min(1).max(200).optional(),
	localName: z.string().max(200).optional(),
	lat: z.number().min(-90).max(90),
	lng: z.number().min(-180).max(180),
	tz: Tz.optional(),
	countryCode: z
		.string()
		.regex(/^[A-Z]{2}$/)
		.optional(),
	description: z.string().max(500).optional(),
	timeNeededMin: z.number().int().min(0).max(4320).optional(),
	address: z.string().max(500).optional(),
	website: HttpUrl.max(2000).optional(),
	openHours: z.string().max(1000).optional(),
	bookAhead: z.boolean().optional(),
	iata: z.string().length(3).optional(),
	confidence: Confidence.optional(),
	links: z
		.array(
			z.strictObject({
				url: HttpUrl.max(2000),
				title: z.string().max(2000).optional(),
			}),
		)
		.max(20)
		.optional(),
	priority: z
		.strictObject({ dennis: Priority.optional(), audrey: Priority.optional() })
		.optional(),
	note: z.string().max(10_000).optional(),
});
type NodeSpec = z.infer<typeof NodeSpec>;

const StaySpec = z.strictObject({
	node: z.string().min(1),
	checkIn: z.literal(true).optional(),
	nights: z.number().int().min(1).max(60).optional(),
	cost: z
		.strictObject({
			amount: z.number().positive(),
			currency: Currency,
			per: z.enum(["night", "total"]),
			note: z.string().max(2000).optional(),
		})
		.optional(),
	note: z.string().max(4000).optional(),
});
type StaySpec = z.infer<typeof StaySpec>;

const ItemCost = z.strictObject({
	amount: z.number().positive(),
	currency: Currency,
	per: z.enum(["person", "total"]),
	category: ExpenseCategory.optional(),
	note: z.string().max(2000).optional(),
});
const ItemKind = z.enum([
	"meal",
	"sight",
	"activity",
	"shopping",
	"nightlife",
	"transport",
	"lodging",
	"rest",
]);
const ItemSpec = z
	.strictObject({
		ref: z.string().min(1).optional(),
		node: z.string().min(1).nullable().optional(),
		title: z.string().trim().min(1).max(200).optional(),
		kind: ItemKind,
		durationMin: z.number().int().min(0).max(4320),
		pinnedStart: HHmm.optional(),
		fixedDate: z.literal(true).optional(),
		bookAhead: z.literal(true).optional(),
		who: z.array(Member).min(1).max(2).optional(),
		note: z.string().max(10_000).optional(),
		cost: ItemCost.optional(),
	})
	.refine((i) => i.node || i.title, {
		message: "an item needs a node or a title",
	});
type ItemSpec = z.infer<typeof ItemSpec>;

const Stop = z.strictObject({
	name: z.string().min(1).max(200),
	lat: z.number().min(-90).max(90).optional(),
	lng: z.number().min(-180).max(180).optional(),
});
const LegSpec = z.strictObject({
	ref: z.string().min(1).optional(),
	mode: z.enum(["transit", "walk", "other"]),
	otherKind: OtherKind.optional(),
	label: z.string().trim().min(1).max(80),
	durationMin: z.number().int().min(0).max(4320),
	fixed: z
		.strictObject({
			depart: LocalDT,
			arrive: LocalDT,
			fromTz: Tz.optional(),
			toTz: Tz.optional(),
			accessMin: z.number().int().min(0).max(180).optional(),
			egressMin: z.number().int().min(0).max(180).optional(),
		})
		.optional(),
	segments: z
		.array(
			z.strictObject({
				mode: SegmentMode,
				lineName: z.string().max(200).optional(),
				agency: z.string().max(200).optional(),
				headsign: z.string().max(200).optional(),
				from: Stop.optional(),
				to: Stop.optional(),
				durationMin: z.number().int().min(0).max(10_080),
			}),
		)
		.max(40)
		.optional(),
	booking: z
		.strictObject({
			trainNumber: z.string().max(40).optional(),
			class: z.string().max(40).optional(),
			car: z.string().max(20).optional(),
		})
		.optional(),
	cost: z
		.strictObject({
			amount: z.number().positive(),
			currency: Currency,
			per: z.enum(["person", "total"]),
			note: z.string().max(2000).optional(),
		})
		.optional(),
	bookAhead: z.literal(true).optional(),
	note: z.string().max(10_000).optional(),
});
type LegSpec = z.infer<typeof LegSpec>;

type Entry =
	| { t: "item"; item: ItemSpec }
	| { t: "leg"; leg: LegSpec }
	| { t: "flight"; flight: string };

const DaySpec = z.strictObject({
	date: IsoDate,
	half: z.enum(["before", "after"]).optional(),
	owner: z.literal(true).optional(),
	title: z.string().trim().min(1).max(200).optional(),
	startTime: HHmm.optional(),
	stay: z.unknown().optional(),
	dayNote: z.string().max(10_000).optional(),
	items: z.array(z.unknown()),
});

const Target = z.union([
	z.strictObject({ trip: z.literal(true) }),
	z.strictObject({ node: z.string().min(1) }),
	z.strictObject({ item: z.string().min(1) }),
	z.strictObject({ leg: z.string().min(1) }),
	z.strictObject({ flight: z.string().min(1) }),
	z.strictObject({ day: IsoDate }),
]);
type Target = z.infer<typeof Target>;

const ExpenseSpec = z
	.strictObject({
		title: z.string().trim().min(1).max(120),
		target: Target,
		category: ExpenseCategory,
		amount: z.number().positive().optional(),
		currency: Currency.optional(),
		points: z
			.strictObject({
				amount: z.number().int().positive().max(100_000_000),
				program: z.string().trim().min(1).max(60),
				source: z
					.strictObject({
						amount: z.number().int().positive().max(100_000_000),
						program: z.string().trim().min(1).max(60),
					})
					.optional(),
			})
			.optional(),
		cashValue: z
			.strictObject({ amount: z.number().positive(), currency: Currency })
			.optional(),
		expectedOn: IsoDate.optional(),
		split: z.array(Member).min(1).max(2).optional(),
		note: z.string().max(2000).optional(),
	})
	.refine((e) => e.amount !== undefined || e.points !== undefined, {
		message: "an expense needs an amount or points",
	})
	.refine((e) => (e.amount === undefined) === (e.currency === undefined), {
		message: "amount and currency go together",
	});
type ExpenseSpec = z.infer<typeof ExpenseSpec>;

const TodoSpec = z
	.strictObject({
		text: z.string().trim().min(1).max(500),
		target: Target,
		kind: z.enum(["opens", "due", "on"]),
		rule: z
			.strictObject({
				anchor: z.string().min(1),
				days: z.number().int().min(0).max(400).optional(),
				months: z.number().int().min(0).max(24).optional(),
				dayOfMonth: z.number().int().min(1).max(31).optional(),
				time: HHmm,
				tz: Tz,
			})
			.refine((r) => (r.days === undefined) !== (r.months === undefined), {
				message: "a rule has days OR months",
			})
			.refine((r) => r.dayOfMonth === undefined || r.months !== undefined, {
				message: "dayOfMonth needs months",
			})
			.optional(),
		due: z
			.strictObject({
				date: IsoDate,
				time: HHmm.optional(),
				tz: Tz.optional(),
			})
			.optional(),
		url: HttpUrl.max(2000).optional(),
		note: z.string().max(10_000).optional(),
		who: z.array(Member).min(1).max(2).optional(),
		replaces: z.string().min(1).optional(),
	})
	.refine((t) => !(t.rule && t.due), {
		message: "a to-do has a rule OR a due date",
	});
type TodoSpec = z.infer<typeof TodoSpec>;

const BudgetSpec = z.strictObject({
	scope: z.string().min(1),
	category: z.union([ExpenseCategory, z.literal("all")]),
	kind: z.enum(["per_day", "total"]),
	amountUSD: z.number().nonnegative(),
	note: z.string().optional(),
});
type BudgetSpec = z.infer<typeof BudgetSpec>;

const PARTS = ["japan", "korea", "vietnam", "taiwan"] as const;
type PartName = (typeof PARTS)[number];
/** The part's zone, for checks before the places are known. */
const PART_TZ: Record<PartName, string> = {
	japan: "Asia/Tokyo",
	korea: "Asia/Seoul",
	vietnam: "Asia/Ho_Chi_Minh",
	taiwan: "Asia/Taipei",
};

const DraftPart = z.strictObject({
	version: z.literal(1),
	part: z.enum(PARTS),
	nodes: z.array(z.unknown()).optional(),
	days: z.array(z.unknown()),
	expenses: z.array(z.unknown()).optional(),
	todos: z.array(z.unknown()).optional(),
	budgets: z.array(z.unknown()).optional(),
	notes: z.array(z.string()).optional(),
});

const FlightsFile = z.strictObject({
	version: z.literal(1),
	about: z.unknown().optional(),
	generatedAt: z.string().optional(),
	sources: z.unknown().optional(),
	airportNodes: z.array(z.unknown()),
	flights: z.array(z.unknown()),
	expenses: z.array(z.unknown()),
	todos: z.array(z.unknown()),
});
const FlightSpec = z.strictObject({
	key: z.string().min(1),
	date: IsoDate,
	label: z.string().min(1),
	status: z.enum(["planned", "booked"]),
	travellers: z.array(Member).min(1).max(2),
	segments: z.array(z.unknown()).min(1).max(4),
	note: z.string().max(10_000).optional(),
	uncertain: z.array(z.string()).optional(),
});
type Segment = FlightDetails & { note?: string };
type FlightSpec = Omit<z.infer<typeof FlightSpec>, "segments"> & {
	segments: Segment[];
};

const SleepKind = z.enum(["hotel", "ryokan", "train", "flight", "home"]);
const Allocation = z.looseObject({
	trip: z.looseObject({
		name: z.string().min(1).max(120),
		slug: z.string().regex(/^[a-z0-9-]{1,100}$/),
		start: IsoDate,
		end: IsoDate,
		homeCurrency: Currency,
		dayCapacityMin: z.number().int().optional(),
	}),
	parts: z.record(
		z.string(),
		z.looseObject({
			dates: z.tuple([IsoDate, IsoDate]),
			file: z.string().min(1),
		}),
	),
	days: z.array(
		z.looseObject({
			date: IsoDate,
			parts: z.array(z.enum(PARTS)).min(1),
			split: z
				.looseObject({
					before: z.enum(PARTS),
					after: z.enum(PARTS),
					marker: z.string(),
				})
				.nullable()
				.optional(),
			ownerItineraryDay: z.number().int().optional(),
			country: z.string().nullable().optional(),
			cities: z.array(z.string()).optional(),
			sleep: z.looseObject({
				kind: SleepKind,
				city: z.string().nullable(),
				node: z.string().nullable().optional(),
			}),
		}),
	),
	budgets: z.array(z.unknown()),
});
type Allocation = z.infer<typeof Allocation>;

// ===========================================================================
// Loading + pure validation
// ===========================================================================

type Issues = { errors: string[]; warnings: string[]; fixes: string[] };

type DayHalf = {
	part: PartName;
	half: "before" | "after" | null;
	owner: boolean;
	title?: string;
	startTime?: string;
	stay: StaySpec | null | undefined;
	hasStay: boolean;
	dayNote?: string;
	entries: Entry[];
};

type DayPlan = {
	date: string;
	owner: boolean;
	title?: string;
	startTime?: string;
	/** undefined = keep what the copy has (owner days only). */
	stay: StaySpec | null | undefined;
	dayNote?: string;
	entries: { entry: Entry; part: PartName }[];
	parts: PartName[];
	sleep: Allocation["days"][number]["sleep"];
};

type Draft = {
	dir: string;
	allocation: Allocation;
	flights: FlightSpec[];
	airportNodes: NodeSpec[];
	/** Declared nodes in creation order (airports first, parents before children). */
	nodes: { spec: NodeSpec; part: PartName | "flights" }[];
	days: DayPlan[];
	expenses: { spec: ExpenseSpec; part: PartName | "flights" }[];
	todos: { spec: TodoSpec; part: PartName | "flights" }[];
	budgets: { spec: BudgetSpec; part: PartName | "allocation" }[];
	notes: { part: PartName; note: string }[];
	uncertain: { flight: string; note: string }[];
	/** item/leg refs → where they are. */
	refs: Map<string, { kind: "item" | "leg"; date: string }>;
	/** `<flight>.dep|.arr` → the flight block key. */
	flightRefs: Map<string, string>;
	/** Segment flight numbers → block key. */
	segmentOf: Map<string, string>;
};

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function zodIssues(where: string, err: z.ZodError): string[] {
	return err.issues.map(
		(i) =>
			`${where}${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}`,
	);
}

function parseWith<S extends z.ZodType>(
	schema: S,
	value: unknown,
	where: string,
	issues: Issues,
): z.output<S> | null {
	const r = schema.safeParse(value);
	if (r.success) return r.data;
	issues.errors.push(...zodIssues(where, r.error));
	return null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Normalises one day entry. Known planner-output mismatches are fixed here
 * (and listed under "fixes" in the report) instead of in the builders' files.
 */
function parseEntry(raw: unknown, where: string, issues: Issues): Entry | null {
	if (!isObj(raw)) {
		issues.errors.push(`${where}: not an object`);
		return null;
	}
	if ("flight" in raw) {
		const keys = Object.keys(raw);
		if (keys.length !== 1 || typeof raw.flight !== "string") {
			issues.errors.push(`${where}: a flight marker is { "flight": "<key>" }`);
			return null;
		}
		return { t: "flight", flight: raw.flight };
	}
	if ("leg" in raw) {
		if (Object.keys(raw).length !== 1) {
			issues.errors.push(`${where}: a leg entry is { "leg": {…} } only`);
			return null;
		}
		const leg = parseWith(LegSpec, raw.leg, `${where}.leg`, issues);
		if (!leg) return null;
		// SCHEMA §3.4: reserved times live on transit details only. A timed
		// "other" leg (a sky tram, a boat with a timetable) becomes transit
		// with one segment, so its departure is kept.
		if (leg.mode === "other" && leg.fixed) {
			const segMode: z.infer<typeof SegmentMode> =
				leg.otherKind === "bus"
					? "bus"
					: leg.otherKind === "ferry"
						? "ferry"
						: "other";
			issues.fixes.push(
				`${where} "${leg.label}": mode other + fixed times → transit with one ${segMode} segment (only transit legs keep reserved times)`,
			);
			const { otherKind: _k, ...rest } = leg;
			return {
				t: "leg",
				leg: {
					...rest,
					mode: "transit",
					segments: leg.segments?.length
						? leg.segments
						: [{ mode: segMode, durationMin: leg.durationMin }],
				},
			};
		}
		if (leg.mode === "other" && !leg.otherKind) {
			issues.errors.push(`${where}: mode "other" needs otherKind`);
			return null;
		}
		if (leg.mode !== "other" && leg.otherKind)
			issues.warnings.push(
				`${where}: otherKind ignored on a ${leg.mode} leg (${leg.label})`,
			);
		if (leg.mode !== "transit" && (leg.segments || leg.booking))
			issues.warnings.push(
				`${where}: segments/booking only apply to transit legs (${leg.label})`,
			);
		return { t: "leg", leg };
	}
	const item = parseWith(ItemSpec, raw, where, issues);
	return item ? { t: "item", item } : null;
}

function loadDraft(dir: string): { draft: Draft; issues: Issues } {
	const issues: Issues = { errors: [], warnings: [], fixes: [] };
	const allocation = Allocation.parse(
		readJson(path.join(dir, "allocation.json")),
	);
	const flightsRaw = FlightsFile.parse(
		readJson(path.join(dir, "flights.json")),
	);

	const draft: Draft = {
		dir,
		allocation,
		flights: [],
		airportNodes: [],
		nodes: [],
		days: [],
		expenses: [],
		todos: [],
		budgets: [],
		notes: [],
		uncertain: [],
		refs: new Map(),
		flightRefs: new Map(),
		segmentOf: new Map(),
	};

	// ---- flights.json ------------------------------------------------------
	for (const [k, raw] of flightsRaw.airportNodes.entries()) {
		const n = parseWith(NodeSpec, raw, `flights.airportNodes[${k}]`, issues);
		if (n) {
			draft.airportNodes.push(n);
			draft.nodes.push({ spec: n, part: "flights" });
		}
	}
	for (const [k, raw] of flightsRaw.flights.entries()) {
		const where = `flights.flights[${k}]`;
		const f = parseWith(FlightSpec, raw, where, issues);
		if (!f) continue;
		const segments: Segment[] = [];
		for (const [s, seg] of f.segments.entries()) {
			if (!isObj(seg)) {
				issues.errors.push(`${where}.segments[${s}]: not an object`);
				continue;
			}
			const { note, ...rest } = seg;
			const parsed = parseWith(
				FlightDetails.strict(),
				rest,
				`${where}.segments[${s}]`,
				issues,
			);
			if (!parsed) continue;
			if (note !== undefined && typeof note !== "string")
				issues.errors.push(`${where}.segments[${s}].note: not a string`);
			segments.push({
				...parsed,
				...(typeof note === "string" ? { note } : {}),
			});
		}
		if (segments.length !== f.segments.length) continue;
		const first = segments[0] as Segment;
		if (first.flightNumber !== f.key)
			issues.errors.push(
				`${where}: key ${f.key} ≠ first segment's flight number ${first.flightNumber}`,
			);
		if ((first.depLocal ?? "").slice(0, 10) !== f.date)
			issues.errors.push(
				`${where}: date ${f.date} ≠ first departure ${first.depLocal}`,
			);
		for (const [s, seg] of segments.entries()) {
			// The draft's flights are fully timed (FB-18 times are optional elsewhere).
			const dep = localDateTimeToEpoch(seg.depLocal ?? "", seg.from.tz);
			const arr = localDateTimeToEpoch(seg.arrLocal ?? "", seg.to.tz);
			if (dep === null || arr === null || arr <= dep)
				issues.errors.push(
					`${where}.segments[${s}]: arrives before it departs (${seg.depLocal} ${seg.from.tz} → ${seg.arrLocal} ${seg.to.tz})`,
				);
			const prev = segments[s - 1];
			if (prev) {
				const prevArr = localDateTimeToEpoch(prev.arrLocal ?? "", prev.to.tz);
				if (prevArr !== null && dep !== null && dep < prevArr)
					issues.errors.push(
						`${where}.segments[${s}]: departs before segment ${s} lands`,
					);
				if (prev.to.iata !== seg.from.iata)
					issues.errors.push(
						`${where}.segments[${s}]: connects ${prev.to.iata} → ${seg.from.iata}`,
					);
			}
			const num = seg.flightNumber ?? `${f.key}#${s + 1}`;
			if (draft.segmentOf.has(num))
				issues.errors.push(`${where}: flight number ${num} used twice`);
			draft.segmentOf.set(num, f.key);
			draft.flightRefs.set(`${num}.dep`, f.key);
			draft.flightRefs.set(`${num}.arr`, f.key);
		}
		for (const u of f.uncertain ?? [])
			draft.uncertain.push({ flight: f.key, note: u });
		draft.flights.push({ ...f, segments });
	}
	for (const [k, raw] of flightsRaw.expenses.entries()) {
		const e = parseWith(ExpenseSpec, raw, `flights.expenses[${k}]`, issues);
		if (e) draft.expenses.push({ spec: e, part: "flights" });
	}
	for (const [k, raw] of flightsRaw.todos.entries()) {
		const t = parseWith(TodoSpec, raw, `flights.todos[${k}]`, issues);
		if (t) draft.todos.push({ spec: t, part: "flights" });
	}
	for (const [k, raw] of allocation.budgets.entries()) {
		const b = parseWith(BudgetSpec, raw, `allocation.budgets[${k}]`, issues);
		if (b) draft.budgets.push({ spec: b, part: "allocation" });
	}

	// ---- parts ----------------------------------------------------------------
	const halves = new Map<string, DayHalf[]>();
	for (const part of PARTS) {
		const meta = allocation.parts[part];
		if (!meta) {
			issues.errors.push(`allocation.parts.${part}: missing`);
			continue;
		}
		const file = path.join(dir, meta.file);
		const raw = parseWith(DraftPart, readJson(file), meta.file, issues);
		if (!raw) continue;
		if (raw.part !== part)
			issues.errors.push(`${meta.file}: part is "${raw.part}", not "${part}"`);
		for (const [k, n] of (raw.nodes ?? []).entries()) {
			const spec = parseWith(NodeSpec, n, `${meta.file}.nodes[${k}]`, issues);
			if (spec) draft.nodes.push({ spec, part });
		}
		const [from, to] = meta.dates;
		for (const [k, d] of raw.days.entries()) {
			const where = `${meta.file}.days[${k}]`;
			const day = parseWith(DaySpec, d, where, issues);
			if (!day) continue;
			if (day.date < from || day.date > to)
				issues.errors.push(
					`${where}: ${day.date} is outside ${part}'s dates ${from}…${to}`,
				);
			let stay: StaySpec | null | undefined;
			const hasStay = isObj(d) && "stay" in d;
			if (day.stay === null) stay = null;
			else if (day.stay !== undefined)
				stay =
					parseWith(StaySpec, day.stay, `${where}.stay`, issues) ?? undefined;
			const entries: Entry[] = [];
			for (const [i, e] of day.items.entries()) {
				const entry = parseEntry(e, `${where}.items[${i}]`, issues);
				if (entry) entries.push(entry);
			}
			const list = halves.get(day.date) ?? [];
			list.push({
				part,
				half: day.half ?? null,
				owner: day.owner === true,
				title: day.title,
				startTime: day.startTime,
				stay,
				hasStay,
				dayNote: day.dayNote,
				entries,
			});
			halves.set(day.date, list);
		}
		for (const [k, e] of (raw.expenses ?? []).entries()) {
			const spec = parseWith(
				ExpenseSpec,
				e,
				`${meta.file}.expenses[${k}]`,
				issues,
			);
			if (spec) draft.expenses.push({ spec, part });
		}
		for (const [k, t] of (raw.todos ?? []).entries()) {
			const spec = parseWith(TodoSpec, t, `${meta.file}.todos[${k}]`, issues);
			if (spec) draft.todos.push({ spec, part });
		}
		for (const [k, b] of (raw.budgets ?? []).entries()) {
			const spec = parseWith(
				BudgetSpec,
				b,
				`${meta.file}.budgets[${k}]`,
				issues,
			);
			if (spec) draft.budgets.push({ spec, part });
		}
		for (const note of raw.notes ?? []) draft.notes.push({ part, note });
	}

	// ---- days: every date once, halves merged -----------------------------------
	const dates = new Set<string>();
	for (const a of allocation.days) {
		if (dates.has(a.date))
			issues.errors.push(`allocation.days: ${a.date} twice`);
		dates.add(a.date);
		const list = halves.get(a.date) ?? [];
		halves.delete(a.date);
		const where = `day ${a.date}`;
		let before: DayHalf | undefined;
		let after: DayHalf | undefined;
		if (a.split) {
			before = list.find((h) => h.half === "before");
			after = list.find((h) => h.half === "after");
			if (list.length !== 2 || !before || !after)
				issues.errors.push(
					`${where}: a split day needs exactly one "before" and one "after" half (got ${list.map((h) => `${h.part}/${h.half ?? "whole"}`).join(", ") || "none"})`,
				);
			if (before && before.part !== a.split.before)
				issues.errors.push(
					`${where}: the "before" half is ${a.split.before}'s, not ${before.part}'s`,
				);
			if (after && after.part !== a.split.after)
				issues.errors.push(
					`${where}: the "after" half is ${a.split.after}'s, not ${after.part}'s`,
				);
		} else {
			if (list.length !== 1)
				issues.errors.push(
					`${where}: expected once, found ${list.length} times`,
				);
			before = list[0];
			if (before?.half)
				issues.errors.push(
					`${where}: "${before.half}" on a day that isn't split`,
				);
		}
		const halvesHere = [before, after].filter((h): h is DayHalf => !!h);
		if (!halvesHere.length) continue;
		for (const h of halvesHere)
			if (!a.parts.includes(h.part))
				issues.errors.push(`${where}: ${h.part} isn't allocated this day`);
		const owner = halvesHere.some((h) => h.owner);
		if (owner && a.ownerItineraryDay === undefined)
			issues.errors.push(`${where}: "owner" on a day that isn't an owner day`);
		if (!owner && a.ownerItineraryDay !== undefined)
			issues.warnings.push(
				`${where}: owner Itinerary day ${a.ownerItineraryDay} not marked "owner" — its items are added, not kept`,
			);
		// Entries: before + after, the shared flight marker once.
		const entries: { entry: Entry; part: PartName }[] = [];
		for (const h of halvesHere)
			for (const entry of h.entries) {
				const last = entries.at(-1)?.entry;
				if (
					entry.t === "flight" &&
					last?.t === "flight" &&
					last.flight === entry.flight
				)
					continue;
				entries.push({ entry, part: h.part });
			}
		// The stay: the "after" half's on a split day.
		const stayHalf = a.split ? after : before;
		let stay: StaySpec | null | undefined = stayHalf?.stay;
		if (stayHalf && !stayHalf.hasStay) stay = owner ? undefined : null;
		if (a.split && before?.stay)
			issues.warnings.push(
				`${where}: the "before" half's stay is ignored (the "after" half sets it)`,
			);
		const title = after?.title ?? before?.title;
		if (owner && (before?.title || before?.startTime))
			issues.warnings.push(
				`${where}: owner day title/start ignored (the imported ones stay)`,
			);
		if (title && title.length > 80)
			issues.warnings.push(`${where}: title longer than 80 characters`);
		const dayNote = halvesHere
			.map((h) => h.dayNote?.trim())
			.filter((s): s is string => !!s)
			.join("\n\n");
		if (dayNote.length > 2000)
			issues.warnings.push(
				`${where}: day note is ${dayNote.length} characters (SCHEMA says ≤ 2,000)`,
			);
		draft.days.push({
			date: a.date,
			owner,
			title: owner ? undefined : title,
			startTime: owner
				? undefined
				: (before?.startTime ?? after?.startTime ?? undefined),
			stay,
			dayNote: dayNote || undefined,
			entries,
			parts: halvesHere.map((h) => h.part),
			sleep: a.sleep,
		});
	}
	for (const date of halves.keys())
		issues.errors.push(`day ${date}: not in allocation.json`);
	const start = allocation.trip.start;
	const end = allocation.trip.end;
	for (let d = start; d <= end; d = addDays(d, 1))
		if (!dates.has(d)) issues.errors.push(`allocation.days: ${d} missing`);
	draft.days.sort((x, y) => (x.date < y.date ? -1 : 1));

	checkDays(draft, issues);
	return { draft, issues };
}

/** SCHEMA §8 checks that need no database: refs, markers, stays, legs, load. */
function checkDays(draft: Draft, issues: Issues): void {
	const capacity = draft.allocation.trip.dayCapacityMin ?? 750;
	// ---- refs (items + legs) -------------------------------------------------
	for (const day of draft.days)
		for (const { entry } of day.entries) {
			const ref =
				entry.t === "item"
					? entry.item.ref
					: entry.t === "leg"
						? entry.leg.ref
						: undefined;
			if (!ref) continue;
			if (draft.refs.has(ref) || draft.flightRefs.has(ref))
				issues.errors.push(`ref "${ref}" is used twice`);
			draft.refs.set(ref, {
				kind: entry.t === "item" ? "item" : "leg",
				date: day.date,
			});
		}

	// ---- flight markers ---------------------------------------------------------
	const byDate = new Map(draft.days.map((d) => [d.date, d]));
	const flightKeys = new Set(draft.flights.map((f) => f.key));
	for (const day of draft.days)
		for (const { entry } of day.entries)
			if (entry.t === "flight" && !flightKeys.has(entry.flight))
				issues.errors.push(
					`day ${day.date}: marker for unknown flight ${entry.flight}`,
				);
	for (const f of draft.flights) {
		const first = f.segments[0] as Segment;
		const last = f.segments.at(-1) as Segment;
		const depDate = (first.depLocal ?? first.depDate ?? "").slice(0, 10);
		const arrDate = (last.arrLocal ?? last.arrDate ?? "").slice(0, 10);
		const markerAt = (date: string) =>
			(byDate.get(date)?.entries ?? [])
				.map((e, i) => ({ e: e.entry, i }))
				.filter((x) => x.e.t === "flight" && x.e.flight === f.key)
				.map((x) => x.i);
		const dep = byDate.get(depDate);
		if (!dep || markerAt(depDate).length !== 1)
			issues.errors.push(
				`flight ${f.key}: needs one marker on ${depDate} (found ${markerAt(depDate).length})`,
			);
		if (arrDate !== depDate) {
			const at = markerAt(arrDate);
			if (at.length !== 1 || at[0] !== 0)
				issues.errors.push(
					`flight ${f.key}: the arrival day ${arrDate} must start with its marker`,
				);
			const n = dep?.entries.length ?? 0;
			const i = markerAt(depDate)[0];
			if (i !== undefined && i !== n - 1)
				issues.errors.push(
					`flight ${f.key}: an overnight flight's marker ends ${depDate}`,
				);
		}
		for (const day of draft.days)
			if (
				day.date !== depDate &&
				day.date !== arrDate &&
				markerAt(day.date).length
			)
				issues.errors.push(
					`flight ${f.key}: marker on ${day.date}, which is neither its departure nor its arrival day`,
				);
	}

	// ---- stays --------------------------------------------------------------------
	for (const [k, day] of draft.days.entries()) {
		const where = `day ${day.date}`;
		const kind = day.sleep.kind;
		const needs = kind === "hotel" || kind === "ryokan";
		if (day.stay === undefined) {
			if (!day.owner)
				issues.errors.push(`${where}: no stay (the allocation says ${kind})`);
			continue;
		}
		if (day.stay === null) {
			if (needs)
				issues.errors.push(
					`${where}: stay is null but the allocation sleeps in a ${kind} in ${day.sleep.city}`,
				);
			continue;
		}
		if (!needs)
			issues.errors.push(
				`${where}: a stay on a ${kind} night (the allocation has none)`,
			);
		const s = day.stay;
		const prev = draft.days[k - 1];
		const continues = !!prev?.stay && prev.stay.node === s.node && !s.checkIn;
		if (s.checkIn) {
			if (!s.nights) issues.errors.push(`${where}: a check-in needs "nights"`);
			for (let n = 1; n < (s.nights ?? 1); n++) {
				const next = draft.days[k + n];
				if (next?.stay?.node !== s.node)
					issues.errors.push(
						`${where}: ${s.nights} nights at ${s.node}, but ${next?.date ?? "the end"} has ${next?.stay?.node ?? "no stay"}`,
					);
			}
			const after = draft.days[k + (s.nights ?? 1)];
			if (after?.stay?.node === s.node && !after.stay.checkIn)
				issues.errors.push(
					`${where}: ${s.nights} nights at ${s.node}, but ${after.date} continues it`,
				);
		} else {
			if (!continues)
				issues.errors.push(
					`${where}: stay at ${s.node} without a check-in the night before`,
				);
			if (s.cost || s.nights)
				issues.errors.push(
					`${where}: cost/nights belong on the check-in night`,
				);
		}
		if (day.sleep.node && day.sleep.node !== s.node)
			issues.errors.push(
				`${where}: stay ${s.node} ≠ the allocation's ${day.sleep.node}`,
			);
		const city = day.sleep.city;
		if (city && s.node.split("|")[1] !== city)
			issues.errors.push(
				`${where}: stay ${s.node} is not in ${city} (the allocation's sleep city)`,
			);
	}

	// ---- items, legs, load -------------------------------------------------------
	const flat: { day: DayPlan; entry: Entry; part: PartName }[] = [];
	for (const day of draft.days)
		for (const e of day.entries)
			flat.push({ day, entry: e.entry, part: e.part });
	for (const day of draft.days) {
		let minutes = 0;
		for (const { entry } of day.entries) {
			if (entry.t !== "item") continue;
			minutes += entry.item.durationMin;
			if (entry.item.title && entry.item.title.length > 120)
				issues.warnings.push(
					`day ${day.date}: title longer than 120 characters: ${entry.item.title}`,
				);
		}
		if (!day.owner && minutes > capacity)
			issues.warnings.push(
				`day ${day.date}: ${minutes} min of items (> ${capacity})`,
			);
	}
	const located = (e: Entry) =>
		e.t === "flight" || (e.t === "item" && !!e.item.node);
	for (const [i, x] of flat.entries()) {
		if (x.entry.t !== "leg") continue;
		const leg = x.entry.leg;
		const where = `day ${x.day.date} leg "${leg.label}"`;
		let before: (typeof flat)[number] | undefined;
		for (let j = i - 1; j >= 0; j--) {
			const y = flat[j];
			if (y && located(y.entry)) {
				before = y;
				break;
			}
			if (y?.entry.t === "leg") {
				issues.errors.push(`${where}: two legs with no located item between`);
				break;
			}
		}
		let after: (typeof flat)[number] | undefined;
		for (let j = i + 1; j < flat.length; j++) {
			const y = flat[j];
			if (y && located(y.entry)) {
				after = y;
				break;
			}
			if (y?.entry.t === "leg") {
				issues.errors.push(`${where}: two legs with no located item between`);
				break;
			}
		}
		if (!before && !x.day.owner)
			issues.errors.push(`${where}: no located item before it`);
		if (!after) issues.errors.push(`${where}: no located item after it`);
		if (after && after.day.date !== x.day.date) {
			if (x.day.stay)
				issues.errors.push(
					`${where}: crosses the night into ${after.day.date}, so the day's stay must be null`,
				);
			if (addDays(x.day.date, 1) !== after.day.date)
				issues.errors.push(`${where}: its next stop is ${after.day.date}`);
		}
		if (leg.fixed) {
			const fromTz = leg.fixed.fromTz ?? PART_TZ[x.part];
			const toTz = leg.fixed.toTz ?? PART_TZ[after?.part ?? x.part];
			const dep = localDateTimeToEpoch(leg.fixed.depart, fromTz);
			const arr = localDateTimeToEpoch(leg.fixed.arrive, toTz);
			if (dep === null || arr === null || arr <= dep)
				issues.errors.push(`${where}: arrives before it departs`);
			if (leg.fixed.depart.slice(0, 10) !== x.day.date)
				issues.errors.push(
					`${where}: departs ${leg.fixed.depart}, not on its day`,
				);
			if (dep !== null && arr !== null) {
				const mins = Math.round((arr - dep) / 60_000);
				if (Math.abs(mins - leg.durationMin) > 30)
					issues.warnings.push(
						`${where}: durationMin ${leg.durationMin} vs fixed times ${mins} min (the app uses the times)`,
					);
			}
		}
		if (leg.mode === "transit" && !leg.segments?.length)
			issues.warnings.push(`${where}: transit leg without segments`);
	}

	// ---- to-do rules, targets --------------------------------------------------------
	const anchors = new Set([...draft.flightRefs.keys()]);
	for (const [ref, r] of draft.refs) if (r.kind === "item") anchors.add(ref);
	const check = (t: Target, where: string) => {
		if ("item" in t && draft.refs.get(t.item)?.kind !== "item")
			issues.errors.push(`${where}: unknown item ref "${t.item}"`);
		if ("leg" in t && draft.refs.get(t.leg)?.kind !== "leg")
			issues.errors.push(`${where}: unknown leg ref "${t.leg}"`);
		if ("flight" in t && !draft.segmentOf.has(t.flight))
			issues.errors.push(`${where}: unknown flight ${t.flight}`);
		if ("day" in t && !byDate.has(t.day))
			issues.errors.push(`${where}: unknown day ${t.day}`);
	};
	for (const { spec, part } of draft.todos) {
		const where = `${part} to-do "${spec.text}"`;
		check(spec.target, where);
		if (spec.rule && !anchors.has(spec.rule.anchor))
			issues.errors.push(`${where}: unknown anchor "${spec.rule.anchor}"`);
	}
	for (const { spec, part } of draft.expenses) {
		const where = `${part} expense "${spec.title}"`;
		check(spec.target, where);
		if (spec.currency && !isKnownCurrency(spec.currency))
			issues.errors.push(`${where}: unknown currency ${spec.currency}`);
	}
	// ---- budgets: category lines ≤ the scope's "all" line --------------------------
	const all = new Map<string, BudgetSpec>();
	for (const { spec } of draft.budgets)
		if (spec.category === "all") all.set(`${spec.scope}|${spec.kind}`, spec);
	const seen = new Set<string>();
	for (const { spec, part } of draft.budgets) {
		const slot = `${spec.scope}|${spec.category}`;
		if (seen.has(slot)) issues.errors.push(`${part} budget ${slot}: set twice`);
		seen.add(slot);
		const cap = all.get(`${spec.scope}|${spec.kind}`);
		if (cap && spec.category !== "all" && spec.amountUSD > cap.amountUSD)
			issues.warnings.push(
				`budget ${slot}: ${spec.amountUSD} > the scope's all-categories ${cap.amountUSD}`,
			);
	}
	const sumBy = new Map<string, number>();
	for (const { spec } of draft.budgets)
		if (spec.category !== "all") {
			const k = `${spec.scope}|${spec.kind}`;
			sumBy.set(k, (sumBy.get(k) ?? 0) + spec.amountUSD);
		}
	for (const [k, sum] of sumBy) {
		const cap = all.get(k);
		if (cap && sum > cap.amountUSD)
			issues.warnings.push(
				`budget ${k}: category lines add up to ${sum} > the all-categories ${cap.amountUSD}`,
			);
	}
}

// ===========================================================================
// Place keys (SCHEMA §2): names along the path, case/diacritic-insensitive
// ===========================================================================

export function norm(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/[’‘`´]/g, "'")
		.replace(/[‐-―]/g, "-")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}
const normKey = (key: string) => key.split("|").map(norm).join("|");

type TreeNode = Pick<
	GraphNode,
	"id" | "parentId" | "type" | "name" | "status" | "lat" | "lng" | "tz"
>;

/** The copy's (or the source's) place tree, plus the nodes the draft declares. */
class PlaceTree {
	private readonly byId = new Map<string, TreeNode>();
	private readonly kids = new Map<string | null, TreeNode[]>();
	/** normalised key → node id (declared or already resolved). */
	readonly declared = new Map<string, string>();

	constructor(nodes: readonly TreeNode[]) {
		for (const n of nodes) this.add(n);
	}

	add(n: TreeNode): void {
		this.byId.set(n.id, n);
		const list = this.kids.get(n.parentId) ?? [];
		list.push(n);
		this.kids.set(n.parentId, list);
	}

	node(id: string): TreeNode | undefined {
		return this.byId.get(id);
	}

	/** The node or an ancestor is dropped. */
	dropped(id: string): boolean {
		for (
			let n = this.byId.get(id);
			n;
			n = n.parentId ? this.byId.get(n.parentId) : undefined
		)
			if (n.status === "dropped") return true;
		return false;
	}

	within(id: string, ancestorId: string): boolean {
		for (
			let n = this.byId.get(id);
			n;
			n = n.parentId ? this.byId.get(n.parentId) : undefined
		)
			if (n.id === ancestorId) return true;
		return false;
	}

	private children(id: string | null): TreeNode[] {
		return this.kids.get(id) ?? [];
	}

	/** Descendants of `id` of one of `types` named `name`, shallowest first. */
	private find(id: string, types: readonly string[], name: string): TreeNode[] {
		const want = norm(name);
		const out: TreeNode[] = [];
		let level = this.children(id);
		while (level.length && !out.length) {
			for (const n of level)
				if (types.includes(n.type) && norm(n.name) === want) out.push(n);
			level = level.flatMap((n) => this.children(n.id));
		}
		return out;
	}

	/** Resolves a key to a node id; `warn` for a fallback match. */
	resolve(key: string): { id?: string; error?: string; warn?: string } {
		const hit = this.declared.get(normKey(key));
		if (hit) return { id: hit };
		const segs = key.split("|");
		if (
			segs.length < 1 ||
			segs.length > 4 ||
			segs.some((s, i) => !s && i !== 2)
		)
			return { error: `malformed key "${key}"` };
		const one = (list: TreeNode[], what: string) =>
			list.length === 1
				? { id: (list[0] as TreeNode).id }
				: list.length
					? { error: `"${key}": ${list.length} ${what} match` }
					: { error: `"${key}": no ${what}` };
		const countries = this.children(null).filter(
			(n) => n.type === "country" && norm(n.name) === norm(segs[0] as string),
		);
		const country = one(countries, `country "${segs[0]}"`);
		if (!country.id || segs.length === 1) return country;
		const city = one(
			this.find(country.id, ["city", "region"], segs[1] as string),
			`city/region "${segs[1]}"`,
		);
		if (!city.id || segs.length === 2) return city;
		const areaName = segs[2] as string;
		let area: { id?: string; error?: string } = {};
		if (areaName) {
			area = one(this.find(city.id, ["area"], areaName), `area "${areaName}"`);
			if (!area.id || segs.length === 3) return area;
		} else if (segs.length === 3) return { error: `malformed key "${key}"` };
		const placeName = segs[3] as string;
		if (area.id) {
			const under = this.find(area.id, ["place"], placeName);
			if (under.length) return one(under, `place "${placeName}"`);
			const anywhere = this.find(city.id, ["place"], placeName);
			if (anywhere.length === 1)
				return {
					id: (anywhere[0] as TreeNode).id,
					warn: `"${key}": found outside area "${areaName}"`,
				};
			return { error: `"${key}": no place "${placeName}" under ${areaName}` };
		}
		return one(
			this.find(city.id, ["place"], placeName),
			`place "${placeName}"`,
		);
	}

	/** The parent key a declared node hangs under (SCHEMA §2). */
	static parentKey(spec: NodeSpec): string | null {
		if (spec.parent) return spec.parent;
		const segs = spec.key.split("|");
		switch (spec.type) {
			case "country":
				return null;
			case "city":
			case "region":
				return segs.slice(0, 1).join("|");
			case "area":
				return segs.slice(0, 2).join("|");
			case "place":
				return segs[2]
					? segs.slice(0, 3).join("|")
					: segs.slice(0, 2).join("|");
		}
	}

	static expectedSegments(spec: NodeSpec): number {
		return { country: 1, region: 2, city: 2, area: 3, place: 4 }[spec.type];
	}
}

/**
 * Declares the draft's nodes into `tree` without writing (the check), and
 * returns every problem with keys, parents, stays and targets.
 */
function checkKeys(draft: Draft, tree: PlaceTree, issues: Issues): void {
	let virtual = 0;
	const seen = new Set<string>();
	for (const { spec, part } of draft.nodes) {
		const where = `${part} node "${spec.key}"`;
		const nk = normKey(spec.key);
		if (seen.has(nk)) {
			issues.errors.push(`${where}: declared twice`);
			continue;
		}
		seen.add(nk);
		if (spec.key.split("|").length !== PlaceTree.expectedSegments(spec))
			issues.errors.push(
				`${where}: a ${spec.type} key has ${PlaceTree.expectedSegments(spec)} segments`,
			);
		if (spec.type === "place" && !spec.category)
			issues.warnings.push(`${where}: a place without a category`);
		const existing = tree.resolve(spec.key);
		if (existing.id && !existing.warn) {
			issues.warnings.push(
				`${where}: already in the trip — reused, not created`,
			);
			tree.declared.set(nk, existing.id);
			continue;
		}
		const pk = PlaceTree.parentKey(spec);
		let parentId: string | null = null;
		if (pk) {
			const p = tree.resolve(pk);
			if (!p.id) {
				issues.errors.push(`${where}: parent ${p.error}`);
				continue;
			}
			parentId = p.id;
		}
		const id = `decl:${++virtual}`;
		tree.add({
			id,
			parentId,
			type: spec.type,
			name: spec.name ?? (spec.key.split("|").at(-1) as string),
			status: "active",
			lat: spec.lat,
			lng: spec.lng,
			tz: spec.tz ?? null,
		});
		tree.declared.set(nk, id);
	}
	const need = (key: string, where: string, schedule: boolean) => {
		const r = tree.resolve(key);
		if (!r.id) issues.errors.push(`${where}: ${r.error}`);
		else {
			if (r.warn) issues.warnings.push(`${where}: ${r.warn}`);
			tree.declared.set(normKey(key), r.id);
			if (schedule && tree.dropped(r.id))
				issues.errors.push(`${where}: "${key}" is dropped in the trip`);
		}
		return r.id;
	};
	for (const day of draft.days) {
		for (const { entry } of day.entries)
			if (entry.t === "item" && entry.item.node)
				need(
					entry.item.node,
					`day ${day.date} item "${entry.item.title ?? entry.item.node}"`,
					true,
				);
		if (day.stay) {
			const id = need(day.stay.node, `day ${day.date} stay`, true);
			const n = id ? tree.node(id) : undefined;
			if (n && n.type !== "place")
				issues.errors.push(
					`day ${day.date} stay: ${day.stay.node} is a ${n.type}, not a place`,
				);
			const city = day.sleep.city;
			const country = day.stay.node.split("|")[0];
			if (id && city && country) {
				const c = tree.resolve(`${country}|${city}`);
				if (c.id && !tree.within(id, c.id))
					issues.errors.push(
						`day ${day.date} stay: ${day.stay.node} is not inside ${city}`,
					);
			}
		}
	}
	for (const { spec, part } of [...draft.todos, ...draft.expenses]) {
		const t = spec.target;
		if ("node" in t)
			need(
				t.node,
				`${part} ${"text" in spec ? `to-do "${spec.text}"` : `expense "${spec.title}"`}`,
				false,
			);
	}
	for (const { spec, part } of draft.budgets)
		if (spec.scope !== "trip") {
			const id = need(spec.scope, `${part} budget ${spec.scope}`, false);
			const n = id ? tree.node(id) : undefined;
			if (n && n.type === "place")
				issues.warnings.push(
					`${part} budget ${spec.scope}: a budget on a place`,
				);
		}
	for (const { spec, part } of draft.nodes)
		if (
			spec.type === "place" &&
			spec.category === "lodging" &&
			part !== "flights"
		) {
			const used = draft.days.some(
				(d) => d.stay && normKey(d.stay.node) === normKey(spec.key),
			);
			if (!used)
				issues.warnings.push(`${part} hotel "${spec.key}" is never a stay`);
		}
}

// ===========================================================================
// The app's modules (loaded after the react-start stand-ins are registered)
// ===========================================================================

function registerStartStandIns(root: string): void {
	const mock = pathToFileURL(path.join(root, "src/test/start-mock.ts")).href;
	const serverMock = pathToFileURL(
		path.join(root, "src/test/start-server-mock.ts"),
	).href;
	const hooks = `
export async function resolve(specifier, context, next) {
	if (specifier === "@tanstack/react-start") return { url: ${JSON.stringify(mock)}, shortCircuit: true };
	if (specifier === "@tanstack/react-start/server") return { url: ${JSON.stringify(serverMock)}, shortCircuit: true };
	return next(specifier, context);
}`;
	register(`data:text/javascript,${encodeURIComponent(hooks)}`);
}

async function loadApp() {
	const [
		dbMod,
		schema,
		orm,
		access,
		graph,
		gi,
		sched,
		moneyScope,
		dup,
		tripDelete,
		nodesFns,
		itemsFns,
		daysFns,
		legsFns,
		transitFns,
		listsFns,
		moneyFns,
		mediaFns,
		tripsFns,
		sweep,
		jobs,
		outbox,
		tx,
		ydoc,
		redis,
		errors,
		sheetMedia,
		sheetWrite,
	] = await Promise.all([
		import("@/db/db.server"),
		import("@/db/schema"),
		import("drizzle-orm"),
		import("@/server/authz/access.server"),
		import("@/server/graph.server"),
		import("@/lib/engine/graph-index"),
		import("@/lib/engine/schedule"),
		import("@/lib/engine/money-scope"),
		import("@/features/home/server/duplicate.server"),
		import("@/server/trip-delete.server"),
		import("@/functions/nodes.functions"),
		import("@/functions/items.functions"),
		import("@/functions/days.functions"),
		import("@/functions/legs.functions"),
		import("@/features/transit/transit.functions"),
		import("@/features/lists/lists.functions"),
		import("@/features/money/money.functions"),
		import("@/features/media/media.functions"),
		import("@/functions/trips.functions"),
		import("@/server/autofill-sweep.server"),
		import("@/server/live/jobs.server"),
		import("@/server/live/outbox.server"),
		import("@/server/tx.server"),
		import("@/lib/notes/ydoc.server"),
		import("@/server/live/redis.server"),
		import("@/server/authz/errors"),
		import("../sheet/lib/media"),
		import("../sheet/lib/write"),
	]);
	return {
		...dbMod,
		schema,
		orm,
		getTripAccess: access.getTripAccess,
		loadGraphForServer: graph.loadGraphForServer,
		indexGraph: gi.indexGraph,
		computeSchedule: sched.computeSchedule,
		daysTouching: moneyScope.daysTouching,
		duplicateTripCore: dup.duplicateTripCore,
		hardDeleteTrip: tripDelete.hardDeleteTrip,
		fns: {
			...nodesFns,
			...itemsFns,
			...daysFns,
			...legsFns,
			...transitFns,
			...listsFns,
			...moneyFns,
			...mediaFns,
			...tripsFns,
		},
		autofillSweep: sweep.autofillSweep,
		enqueue: jobs.enqueue,
		closeQueues: jobs.closeQueues,
		autofillDedupeId: outbox.autofillDedupeId,
		withTripTx: tx.withTripTx,
		markdownToYdoc: ydoc.markdownToYdoc,
		closeRedis: redis.closeRedis,
		errorCode: errors.errorCode,
		deleteTripObjects: sheetMedia.deleteTripObjects,
		noteDocName: sheetWrite.noteDocName,
	};
}
type App = Awaited<ReturnType<typeof loadApp>>;

// ===========================================================================
// The build
// ===========================================================================

type Args = {
	check: boolean;
	source: string;
	owner: string;
	dir: string;
	autofill: boolean;
	waitSec: number;
	report: string | null;
};

function parseCli(argv: string[]): Args {
	const { values } = parseArgs({
		args: argv,
		options: {
			check: { type: "boolean", default: false },
			source: { type: "string", default: "asia-2027" },
			owner: { type: "string", default: "dennis@dennispham.me" },
			dir: { type: "string", default: "seed/draft" },
			"no-autofill": { type: "boolean", default: false },
			wait: { type: "string", default: "90" },
			report: { type: "string", default: ".data/full-draft-report.md" },
			help: { type: "boolean", default: false },
		},
		strict: true,
	});
	if (values.help) {
		console.log(
			"usage: tsx scripts/draft/build-full-draft.ts [--check] [--source asia-2027] [--owner email] [--dir seed/draft] [--no-autofill] [--wait 90] [--report file|-]",
		);
		process.exit(0);
	}
	const wait = Number(values.wait);
	return {
		check: values.check,
		source: values.source,
		owner: values.owner.trim().toLowerCase(),
		dir: values.dir,
		autofill: !values["no-autofill"],
		waitSec: Number.isFinite(wait) && wait >= 0 ? wait : 90,
		report: values.report === "-" ? null : values.report,
	};
}

type Counts = Record<string, number>;
const bump = (c: Counts, k: string, n = 1) => {
	c[k] = (c[k] ?? 0) + n;
};

const DEFAULT_CATEGORY: Record<z.infer<typeof ItemKind>, ExpenseCategory> = {
	meal: "food_drink",
	shopping: "shopping",
	transport: "transport",
	lodging: "lodging",
	sight: "activities",
	activity: "activities",
	nightlife: "activities",
	rest: "activities",
};

type Built = {
	tripId: string;
	slug: string;
	replacedTripId: string | null;
	counts: Counts;
	warnings: string[];
	additions: string[];
	planned: Map<string, number>;
	flightItems: Map<string, string>;
	autofillJobs: number | null;
	sourceVersion: { before: number; after: number };
};

class Builder {
	readonly counts: Counts = {};
	readonly warnings: string[] = [];
	/** What the importer added on its own (reported). */
	readonly additions: string[] = [];
	/** Planned amounts by currency (major units), for the report. */
	readonly planned = new Map<string, number>();
	readonly itemRefs = new Map<string, string>();
	readonly legRefs = new Map<string, string>();
	/** `<flight>.dep|.arr` → item id. */
	readonly flightItems = new Map<string, string>();
	/** segment flight number → leg id. */
	readonly flightLegs = new Map<string, string>();
	readonly blocks = new Map<string, { itemIds: string[]; legIds: string[] }>();
	readonly memberIds = new Map<Member, string>();
	readonly dayIds = new Map<string, string>();
	tree: PlaceTree = new PlaceTree([]);

	constructor(
		readonly app: App,
		readonly user: AuthUser,
		readonly tripId: string,
		readonly draft: Draft,
	) {}

	// ---- plumbing -----------------------------------------------------------
	async call<T>(fn: unknown, data: unknown, what: string): Promise<T> {
		try {
			const r = await (
				fn as (o: {
					data: unknown;
					context: { user: AuthUser };
				}) => Promise<unknown>
			)({ data, context: { user: this.user } });
			if (isProposed(r)) throw new Error("became a suggestion, not an edit");
			return r as T;
		} catch (e) {
			const code = this.app.errorCode(e);
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`${what}: ${code ? `${code} ` : ""}${msg}`);
		}
	}

	async graph(): Promise<{ graph: TripGraph; ix: GraphIndex }> {
		const graph = await this.app.loadGraphForServer(
			this.app.getDb(),
			this.tripId,
		);
		if (!graph) throw new Error("the draft trip vanished");
		return { graph, ix: this.app.indexGraph(graph) };
	}

	resolve(key: string, where: string): string {
		const r = this.tree.resolve(key);
		if (!r.id) throw new Error(`${where}: ${r.error}`);
		this.tree.declared.set(normKey(key), r.id);
		return r.id;
	}

	members(who?: readonly Member[]): string[] {
		return (who ?? MEMBERS).map((m) => {
			const id = this.memberIds.get(m);
			if (!id) throw new Error(`no member for ${m}`);
			return id;
		});
	}

	addPlanned(currency: string, amount: number): void {
		this.planned.set(currency, (this.planned.get(currency) ?? 0) + amount);
	}

	/** Appends Markdown to a shared note (a Yjs document), like the sheet importer writes it. */
	async appendNote(target: BundleTarget, markdown: string): Promise<void> {
		const md = markdown.trim();
		if (!md) return;
		const { schema, orm } = this.app;
		const t = target;
		const name = this.app.noteDocName(
			this.tripId,
			t.kind === "trip"
				? { kind: "root" }
				: t.kind === "node"
					? { kind: "node", nodeId: t.nodeId }
					: t.kind === "leg"
						? { kind: "leg", legId: t.legId }
						: t.kind === "item"
							? { kind: "item", itemId: t.itemId }
							: { kind: "day", dayId: t.dayId },
		);
		if (!name.startsWith(`trip/${this.tripId}/`))
			throw new Error("appendNote: not the draft trip");
		await this.app.withTripTx(this.tripId, async (tx, out) => {
			const [row] = await tx
				.select({ markdown: schema.yjsDocuments.markdown })
				.from(schema.yjsDocuments)
				.where(orm.eq(schema.yjsDocuments.name, name));
			const full = row?.markdown?.trim()
				? `${row.markdown.trim()}\n\n${md}`
				: md;
			const snap = this.app.markdownToYdoc(full);
			const values = {
				state: snap.state,
				json: snap.json,
				markdown: snap.markdown,
				plainText: snap.plainText,
				updatedBy: this.user.id,
				updatedAt: new Date(),
			};
			if (row)
				await tx
					.update(schema.yjsDocuments)
					.set(values)
					.where(orm.eq(schema.yjsDocuments.name, name));
			else
				await tx.insert(schema.yjsDocuments).values({
					name,
					tripId: this.tripId,
					nodeId: t.kind === "node" ? t.nodeId : null,
					legId: t.kind === "leg" ? t.legId : null,
					itemId: t.kind === "item" ? t.itemId : null,
					dayId: t.kind === "day" ? t.dayId : null,
					...values,
				});
			out.emit({ keys: ["notes", "counts"] });
		});
		bump(this.counts, "notes");
	}

	target(t: Target, where: string): BundleTarget {
		if ("trip" in t) return { kind: "trip" };
		if ("node" in t)
			return { kind: "node", nodeId: this.resolve(t.node, where) };
		if ("item" in t) {
			const itemId = this.itemRefs.get(t.item);
			if (!itemId) throw new Error(`${where}: item ref ${t.item} not created`);
			return { kind: "item", itemId };
		}
		if ("leg" in t) {
			const legId = this.legRefs.get(t.leg);
			if (!legId) throw new Error(`${where}: leg ref ${t.leg} not created`);
			return { kind: "leg", legId };
		}
		if ("flight" in t) {
			const legId = this.flightLegs.get(t.flight);
			if (!legId) throw new Error(`${where}: flight ${t.flight} not created`);
			return { kind: "leg", legId };
		}
		const dayId = this.dayIds.get(t.day);
		if (!dayId) throw new Error(`${where}: no day ${t.day}`);
		return { kind: "day", dayId };
	}

	// ---- steps ---------------------------------------------------------------
	async setup(): Promise<void> {
		const { graph } = await this.graph();
		this.tree = new PlaceTree(graph.nodes);
		for (const d of graph.days) this.dayIds.set(d.date, d.id);
		const owner = graph.members.find(
			(m) => m.userId === this.user.id && m.status === "active",
		);
		const audrey = graph.members.find(
			(m) => m.status === "placeholder" && norm(m.name).startsWith("audrey"),
		);
		if (!owner) throw new Error("the owner isn't a member of the copy");
		if (!audrey) throw new Error("Audrey (placeholder) wasn't copied");
		this.memberIds.set("dennis", owner.id);
		this.memberIds.set("audrey", audrey.id);
		for (const d of this.draft.days)
			if (!this.dayIds.has(d.date))
				throw new Error(`the copy has no day ${d.date}`);
	}

	/** Draft to-dos that were done in the real trip stay done in the copy. */
	async mirrorDone(sourceId: string): Promise<void> {
		const { orm } = this.app;
		const db = this.app.getDb();
		const res = await db.execute(orm.sql`
			select c.id::text as id, s.status
			  from list_items s
			  join list_items c on c.trip_id = ${this.tripId} and c.list = s.list and c.text = s.text
			   and c.position = s.position and c.deleted_at is null and c.status = 'open'
			   and (c.node_id is null) = (s.node_id is null) and (c.item_id is null) = (s.item_id is null)
			   and (c.leg_id is null) = (s.leg_id is null) and (c.day_id is null) = (s.day_id is null)
			 where s.trip_id = ${sourceId} and s.deleted_at is null and s.status <> 'open'
			   and not s.is_private`);
		for (const r of res.rows as { id: string; status: "done" | "skipped" }[]) {
			await this.call(
				this.app.fns.setListItemStatus,
				{ id: r.id, status: r.status },
				"list.status",
			);
			bump(this.counts, "todos kept done");
		}
	}

	async nodes(): Promise<void> {
		for (const { spec, part } of this.draft.nodes) {
			const where = `${part} node "${spec.key}"`;
			const nk = normKey(spec.key);
			const existing = this.tree.resolve(spec.key);
			if (existing.id && !existing.warn) {
				this.tree.declared.set(nk, existing.id);
				bump(this.counts, "nodes reused");
				continue;
			}
			const pk = PlaceTree.parentKey(spec);
			const parentId = pk ? this.resolve(pk, `${where} parent`) : null;
			const details: Record<string, unknown> = {};
			if (spec.website) details.website = spec.website;
			if (spec.openHours) details.openHoursText = spec.openHours;
			if (spec.bookAhead) details.bookAhead = true;
			if (spec.iata) details.iata = spec.iata;
			if (spec.confidence) details.geocodeConfidence = spec.confidence;
			const name = spec.name ?? (spec.key.split("|").at(-1) as string);
			const r = await this.call<{ nodeId: string }>(
				this.app.fns.createNode,
				{
					tripId: this.tripId,
					parentId,
					type: spec.type,
					...(spec.type === "place" && spec.category
						? { category: spec.category }
						: {}),
					name,
					...(spec.localName ? { localName: spec.localName } : {}),
					...(spec.description ? { description: spec.description } : {}),
					lat: spec.lat,
					lng: spec.lng,
					...(spec.address ? { address: spec.address } : {}),
					...(spec.countryCode ? { countryCode: spec.countryCode } : {}),
					...(spec.timeNeededMin !== undefined
						? { timeNeededMin: spec.timeNeededMin }
						: {}),
					...(Object.keys(details).length ? { details } : {}),
				},
				where,
			);
			this.tree.add({
				id: r.nodeId,
				parentId,
				type: spec.type,
				name,
				status: "active",
				lat: spec.lat,
				lng: spec.lng,
				tz: spec.tz ?? null,
			});
			this.tree.declared.set(nk, r.nodeId);
			bump(this.counts, `nodes created (${spec.type})`);
			if (spec.note)
				await this.appendNote({ kind: "node", nodeId: r.nodeId }, spec.note);
			for (const link of spec.links ?? []) {
				await this.call(
					this.app.fns.addLink,
					{
						tripId: this.tripId,
						target: { kind: "node", nodeId: r.nodeId },
						url: link.url,
						...(link.title ? { caption: link.title } : {}),
					},
					`${where} link`,
				);
				bump(this.counts, "links");
			}
			for (const m of MEMBERS) {
				const p = spec.priority?.[m];
				if (!p) continue;
				await this.call(
					this.app.fns.setNodePriority,
					{ nodeId: r.nodeId, memberId: this.members([m])[0], priority: p },
					`${where} priority`,
				);
				bump(this.counts, "ratings");
			}
		}
	}

	async daysAndStays(): Promise<void> {
		for (const day of this.draft.days) {
			const dayId = this.dayIds.get(day.date) as string;
			if (day.title || day.startTime) {
				await this.call(
					this.app.fns.updateDay,
					{
						dayId,
						...(day.title ? { title: day.title } : {}),
						...(day.startTime ? { startTime: day.startTime } : {}),
					},
					`day ${day.date}`,
				);
				bump(this.counts, "days titled");
			}
		}
		const days = this.draft.days;
		for (const [k, day] of days.entries()) {
			const dayId = this.dayIds.get(day.date) as string;
			if (day.stay === undefined) continue;
			if (day.stay === null) {
				await this.call(
					this.app.fns.setDayStay,
					{ fromDayId: dayId, nodeId: null },
					`day ${day.date} stay`,
				);
				continue;
			}
			if (!day.stay.checkIn) continue;
			const nights = day.stay.nights ?? 1;
			const last = days[k + nights - 1] ?? day;
			const nodeId = this.resolve(day.stay.node, `day ${day.date} stay`);
			await this.call(
				this.app.fns.setDayStay,
				{
					fromDayId: dayId,
					toDayId: this.dayIds.get(last.date),
					nodeId,
				},
				`day ${day.date} stay`,
			);
			bump(this.counts, "stays (blocks)");
			bump(this.counts, "stay nights", nights);
		}
	}

	/**
	 * Items and flight blocks, day by day in trip order. Legs only record their
	 * neighbours here and are written once every item exists (night trains
	 * reach into the next day).
	 */
	async items(pendingLegs: PendingLeg[]): Promise<ItemExtra[]> {
		const extras: ItemExtra[] = [];
		const waiting: PendingLeg[] = [];
		const created = (itemId: string) => {
			for (const l of waiting.splice(0)) l.nextItemId = itemId;
		};
		for (const day of this.draft.days) {
			const dayId = this.dayIds.get(day.date) as string;
			let cursor: string | undefined;
			if (day.owner) {
				const { ix } = await this.graph();
				cursor = ix.itemsByDay.get(dayId)?.at(-1)?.id;
			}
			for (const { entry } of day.entries) {
				if (entry.t === "flight") {
					const block = await this.flightBlock(entry.flight, dayId, cursor);
					const { ix } = await this.graph();
					const here = block.itemIds.filter(
						(id) => ix.item(id)?.dayId === dayId,
					);
					const first = here[0];
					if (first) created(first);
					if (!day.owner) cursor = here.at(-1) ?? cursor;
					continue;
				}
				if (entry.t === "leg") {
					const leg: PendingLeg = {
						spec: entry.leg,
						date: day.date,
						prevItemId: cursor,
						nextItemId: undefined,
					};
					pendingLegs.push(leg);
					waiting.push(leg);
					continue;
				}
				const it = entry.item;
				const where = `day ${day.date} item "${it.title ?? it.node}"`;
				const nodeId = it.node ? this.resolve(it.node, where) : undefined;
				const r = await this.call<{ itemId: string }>(
					this.app.fns.createItem,
					{
						tripId: this.tripId,
						dayId,
						...(nodeId ? { nodeId } : {}),
						...(it.title ? { title: it.title } : {}),
						...(it.note ? { note: it.note } : {}),
						durationMin: it.durationMin,
						...(it.pinnedStart ? { pinnedStart: it.pinnedStart } : {}),
						...(cursor ? { afterItemId: cursor } : {}),
					},
					where,
				);
				cursor = r.itemId;
				created(r.itemId);
				if (it.ref) this.itemRefs.set(it.ref, r.itemId);
				bump(this.counts, "items");
				extras.push({ spec: it, itemId: r.itemId, nodeId, date: day.date });
			}
			if (day.dayNote)
				await this.appendNote({ kind: "day", dayId }, day.dayNote);
		}
		if (waiting.length)
			throw new Error(
				`legs with nothing after them: ${waiting.map((l) => l.spec.label).join(", ")}`,
			);
		return extras;
	}

	async flightBlock(
		key: string,
		dayId: string,
		cursor: string | undefined,
	): Promise<{ itemIds: string[]; legIds: string[] }> {
		const have = this.blocks.get(key);
		if (have) return have;
		const f = this.draft.flights.find((x) => x.key === key);
		if (!f) throw new Error(`unknown flight ${key}`);
		const segments = f.segments.map(({ note: _n, ...s }) => s);
		const r = await this.call<{ itemIds: string[]; legIds: string[] }>(
			this.app.fns.createFlightWithAirports,
			{
				tripId: this.tripId,
				segments,
				...(cursor ? { afterItemId: cursor } : { dayId }),
			},
			`flight ${key}`,
		);
		this.blocks.set(key, r);
		bump(this.counts, "flight blocks");
		bump(this.counts, "flight legs", r.legIds.length);
		for (const [k, seg] of f.segments.entries()) {
			const num = seg.flightNumber ?? `${key}#${k + 1}`;
			const from = r.itemIds[k] as string;
			const to = r.itemIds[k + 1] as string;
			this.flightItems.set(`${num}.dep`, from);
			this.flightItems.set(`${num}.arr`, to);
			this.flightLegs.set(num, r.legIds[k] as string);
			const legId = r.legIds[k] as string;
			await this.call(
				this.app.fns.setLegAssignees,
				{ legId, memberIds: this.members(f.travellers) },
				`flight ${num} travellers`,
			);
			const note = [
				k === 0
					? `**${f.label}**${f.status === "planned" ? " · planned, not booked" : ""}`
					: "",
				seg.note ?? "",
				k === 0 ? (f.note ?? "") : "",
			]
				.filter(Boolean)
				.join("\n\n");
			if (note) await this.appendNote({ kind: "leg", legId }, note);
		}
		return r;
	}

	/** Legs: the pair around each leg entry, then the mode, route, times and note. */
	async legs(pending: PendingLeg[]): Promise<void> {
		const { ix } = await this.graph();
		for (const l of pending) {
			const where = `day ${l.date} leg "${l.spec.label}"`;
			const from = l.prevItemId
				? ix.item(l.prevItemId)?.nodeId
					? ix.item(l.prevItemId)
					: ix.prevLocated(l.prevItemId)
				: l.nextItemId
					? ix.prevLocated(l.nextItemId)
					: null;
			const next = l.nextItemId ? ix.item(l.nextItemId) : undefined;
			const to = next?.nodeId ? next : next ? ix.nextLocated(next.id) : null;
			if (!from || !to)
				throw new Error(`${where}: no located item on both sides`);
			if (!ix.isPair(from.id, to.id))
				throw new Error(
					`${where}: ${from.title ?? ix.node(from.nodeId)?.name} → ${to.title ?? ix.node(to.nodeId)?.name} are not consecutive stops`,
				);
			const target: LegTarget = {
				kind: "pair",
				fromItemId: from.id,
				toItemId: to.id,
			};
			const spec = l.spec;
			let legId: string;
			if (spec.mode === "transit") {
				const segments = (spec.segments ?? []).map((s) => ({
					...s,
					...(s.from ? { from: s.from } : {}),
				}));
				const fare =
					spec.cost?.per === "person"
						? { amount: spec.cost.amount, currency: spec.cost.currency }
						: undefined;
				const r = await this.call<{ leg: { id: string } }>(
					this.app.fns.saveCustomRoute,
					{
						target,
						route: {
							id: "draft",
							source: "manual",
							label: spec.label,
							durationMin: spec.durationMin,
							segments,
							...(fare ? { fare } : {}),
						},
					},
					where,
				);
				legId = r.leg.id;
				if (spec.fixed || spec.booking) {
					const fromTz = spec.fixed?.fromTz ?? ix.tzOf(from.nodeId);
					const toTz = spec.fixed?.toTz ?? ix.tzOf(to.nodeId);
					await this.call(
						this.app.fns.saveTransitDetails,
						{
							target,
							...(spec.fixed
								? {
										fixed: {
											departLocal: spec.fixed.depart,
											arriveLocal: spec.fixed.arrive,
											fromTz,
											toTz,
											accessMin: spec.fixed.accessMin ?? 10,
											egressMin: spec.fixed.egressMin ?? 0,
										},
									}
								: {}),
							...(spec.booking
								? { booking: { ...spec.booking, seats: [] } }
								: {}),
						},
						`${where} times`,
					);
					if (spec.fixed) bump(this.counts, "timed legs (reserved)");
				}
			} else {
				const r = await this.call<{ legId: string }>(
					this.app.fns.setLeg,
					{
						target,
						patch: {
							mode: spec.mode,
							durationMin: spec.durationMin,
							source: "manual",
							isEdited: true,
							details:
								spec.mode === "walk"
									? { kind: "walk" }
									: {
											kind: "other",
											otherKind: spec.otherKind ?? "other",
											label: spec.label,
										},
						},
					},
					where,
				);
				legId = r.legId;
			}
			bump(this.counts, `legs (${spec.mode})`);
			l.legId = legId;
			if (spec.ref) this.legRefs.set(spec.ref, legId);
			if (spec.note) await this.appendNote({ kind: "leg", legId }, spec.note);
		}
	}

	/** fixedDate, assignees, node book-ahead flags (after the items exist). */
	async itemExtras(extras: ItemExtra[]): Promise<void> {
		for (const x of extras) {
			const where = `day ${x.date} item "${x.spec.title ?? x.spec.node}"`;
			if (x.spec.fixedDate) {
				await this.call(
					this.app.fns.updateItem,
					{ itemId: x.itemId, patch: { fixedDate: true } },
					`${where} fixed date`,
				);
				bump(this.counts, "items booked for their date");
			}
			if (x.spec.who && x.spec.who.length < MEMBERS.length) {
				await this.call(
					this.app.fns.setItemAssignees,
					{ itemId: x.itemId, memberIds: this.members(x.spec.who) },
					`${where} assignees`,
				);
				bump(this.counts, "items for one person");
			}
			if (x.spec.bookAhead && x.nodeId) {
				const { ix } = await this.graph();
				const details = ix.node(x.nodeId)?.details as
					| { bookAhead?: boolean }
					| undefined;
				if (!details?.bookAhead)
					await this.call(
						this.app.fns.updateNode,
						{ nodeId: x.nodeId, patch: { details: { bookAhead: true } } },
						`${where} book ahead`,
					);
			}
		}
	}

	async expense(
		data: {
			target: BundleTarget;
			title: string;
			category: ExpenseCategory;
			amount?: number;
			currency?: string;
			points?: ExpenseSpec["points"];
			cashValue?: ExpenseSpec["cashValue"];
			expectedOn?: string;
			split?: readonly Member[];
			note?: string;
		},
		where: string,
	): Promise<void> {
		const title =
			data.title.length > 120 ? `${data.title.slice(0, 119)}…` : data.title;
		await this.call(
			this.app.fns.createExpense,
			{
				tripId: this.tripId,
				target: data.target,
				title,
				category: data.category,
				...(data.amount !== undefined && data.currency
					? {
							amountMinor: toMinor(data.amount, data.currency),
							currency: data.currency,
						}
					: {}),
				...(data.points
					? {
							points: {
								program: data.points.program,
								points: data.points.amount,
								...(data.points.source
									? {
											sourceProgram: data.points.source.program,
											sourcePoints: data.points.source.amount,
										}
									: {}),
								...(data.cashValue
									? {
											cashValueMinor: toMinor(
												data.cashValue.amount,
												data.cashValue.currency,
											),
											cashValueCurrency: data.cashValue.currency,
										}
									: {}),
							},
						}
					: {}),
				...(data.expectedOn ? { expectedOn: data.expectedOn } : {}),
				split: {
					mode: "equal",
					shares: this.members(data.split).map((memberId) => ({ memberId })),
				},
				...(data.note ? { note: data.note.slice(0, 2000) } : {}),
			},
			where,
		);
		bump(this.counts, `expenses (${data.category})`);
		if (data.amount !== undefined && data.currency)
			this.addPlanned(data.currency, data.amount);
		if (data.points)
			bump(this.counts, `points: ${data.points.program}`, data.points.amount);
	}

	async money(extras: ItemExtra[], pending: PendingLeg[]): Promise<void> {
		// Stays: one lodging expense per check-in block.
		for (const day of this.draft.days) {
			const s = day.stay;
			if (!s?.checkIn || !s.cost) continue;
			const nodeId = this.resolve(s.node, `day ${day.date} stay`);
			const nights = s.nights ?? 1;
			const name = this.tree.node(nodeId)?.name ?? s.node.split("|").at(-1);
			const amount =
				s.cost.per === "night" ? s.cost.amount * nights : s.cost.amount;
			await this.expense(
				{
					target: { kind: "node", nodeId },
					title: `${name} · ${nights} night${nights === 1 ? "" : "s"}`,
					category: "lodging",
					amount,
					currency: s.cost.currency,
					note: [
						`${day.date} → ${addDays(day.date, nights)} (check-out).`,
						s.cost.per === "night"
							? `${s.cost.amount.toLocaleString("en-US")} ${s.cost.currency}/night × ${nights} for the room (both).`
							: "",
						s.cost.note ?? "",
					]
						.filter(Boolean)
						.join(" "),
				},
				`day ${day.date} stay cost`,
			);
		}
		// Items.
		for (const x of extras) {
			const c = x.spec.cost;
			if (!c) continue;
			const people = x.spec.who ?? MEMBERS;
			const amount = c.per === "person" ? c.amount * people.length : c.amount;
			const title =
				x.spec.title ??
				(x.nodeId ? this.tree.node(x.nodeId)?.name : undefined) ??
				"Planned cost";
			await this.expense(
				{
					target: { kind: "item", itemId: x.itemId },
					title,
					category: c.category ?? DEFAULT_CATEGORY[x.spec.kind],
					amount,
					currency: c.currency,
					split: people,
					note: [
						c.per === "person"
							? `${c.amount.toLocaleString("en-US")} ${c.currency} per person × ${people.length}.`
							: "",
						c.note ?? "",
					]
						.filter(Boolean)
						.join(" "),
				},
				`day ${x.date} item cost "${title}"`,
			);
		}
		// Legs.
		for (const l of pending) {
			const c = l.spec.cost;
			if (!c || !l.legId) continue;
			const amount = c.per === "person" ? c.amount * MEMBERS.length : c.amount;
			await this.expense(
				{
					target: { kind: "leg", legId: l.legId },
					title: l.spec.label,
					category: "transport",
					amount,
					currency: c.currency,
					note: [
						c.per === "person"
							? `${c.amount.toLocaleString("en-US")} ${c.currency} per person × ${MEMBERS.length}.`
							: "",
						c.note ?? "",
					]
						.filter(Boolean)
						.join(" "),
				},
				`day ${l.date} leg cost "${l.spec.label}"`,
			);
		}
		// Explicit ones (parts + flights).
		for (const { spec, part } of this.draft.expenses) {
			const where = `${part} expense "${spec.title}"`;
			await this.expense(
				{
					target: this.target(spec.target, where),
					title: spec.title,
					category: spec.category,
					amount: spec.amount,
					currency: spec.currency,
					points: spec.points,
					cashValue: spec.cashValue,
					expectedOn: spec.expectedOn,
					split: spec.split,
					note: spec.note,
				},
				where,
			);
		}
	}

	async todos(extras: ItemExtra[], pending: PendingLeg[]): Promise<void> {
		// Book-ahead flags without a to-do of their own.
		const covered = new Set<string>();
		for (const { spec } of this.draft.todos) {
			const t = spec.target;
			if ("item" in t) covered.add(`item:${t.item}`);
			if ("leg" in t) covered.add(`leg:${t.leg}`);
			if ("node" in t) covered.add(`node:${normKey(t.node)}`);
		}
		const { ix } = await this.graph();
		const openBookAhead = (target: BundleTarget) =>
			this.app
				.getDb()
				.execute(
					this.app.orm
						.sql`select 1 from list_items where trip_id = ${this.tripId} and list = 'todo'
					   and text = 'Book ahead' and deleted_at is null
					   and ${target.kind === "item" ? this.app.orm.sql`item_id = ${target.itemId}` : target.kind === "leg" ? this.app.orm.sql`leg_id = ${target.legId}` : this.app.orm.sql`false`}`,
				)
				.then((r) => r.rows.length > 0);
		for (const x of extras) {
			if (!x.spec.bookAhead) continue;
			if (x.spec.ref && covered.has(`item:${x.spec.ref}`)) continue;
			if (x.spec.node && covered.has(`node:${normKey(x.spec.node)}`)) continue;
			const target: BundleTarget = { kind: "item", itemId: x.itemId };
			if (await openBookAhead(target)) continue;
			await this.call(
				this.app.fns.createListItem,
				{ tripId: this.tripId, target, list: "todo", text: "Book ahead" },
				`day ${x.date} book ahead`,
			);
			bump(this.counts, "to-dos: book ahead");
		}
		for (const l of pending) {
			if (!l.spec.bookAhead || !l.legId) continue;
			if (l.spec.ref && covered.has(`leg:${l.spec.ref}`)) continue;
			const target: BundleTarget = { kind: "leg", legId: l.legId };
			if (await openBookAhead(target)) continue;
			await this.call(
				this.app.fns.createListItem,
				{ tripId: this.tripId, target, list: "todo", text: "Book ahead" },
				`day ${l.date} leg book ahead`,
			);
			bump(this.counts, "to-dos: book ahead");
		}
		// The planned to-dos.
		const { orm } = this.app;
		for (const { spec, part } of this.draft.todos) {
			const where = `${part} to-do "${spec.text}"`;
			const target = this.target(spec.target, where);
			const due: Record<string, unknown> = { dueKind: spec.kind };
			if (spec.rule) {
				const r = spec.rule;
				const itemId =
					this.itemRefs.get(r.anchor) ?? this.flightItems.get(r.anchor);
				if (!itemId)
					throw new Error(`${where}: anchor ${r.anchor} not created`);
				due.dueRule =
					r.months !== undefined
						? {
								kind: "months",
								itemId,
								months: r.months,
								...(r.dayOfMonth ? { dayOfMonth: r.dayOfMonth } : {}),
								time: r.time,
								tz: r.tz,
							}
						: { kind: "days", itemId, days: r.days, time: r.time, tz: r.tz };
			} else if (spec.due) {
				due.dueDate = spec.due.date;
				if (spec.due.time) {
					due.dueTime = spec.due.time;
					due.dueTz = spec.due.tz ?? ix.defaultTz;
				}
			}
			const assigneeIds = spec.who ? this.members(spec.who) : undefined;
			if (spec.replaces) {
				const found = await this.app.getDb().execute(orm.sql`
					select id::text as id, node_id::text as "nodeId", item_id::text as "itemId",
					       leg_id::text as "legId", day_id::text as "dayId"
					  from list_items
					 where trip_id = ${this.tripId} and list = 'todo' and deleted_at is null
					   and text = ${spec.replaces}
					 order by position limit 2`);
				const rows = found.rows as {
					id: string;
					nodeId: string | null;
					itemId: string | null;
					legId: string | null;
					dayId: string | null;
				}[];
				const row = rows[0];
				if (rows.length > 1)
					this.warnings.push(
						`${where}: "${spec.replaces}" matches ${rows.length} to-dos — the first is updated`,
					);
				if (row) {
					await this.call(
						this.app.fns.updateListItem,
						{
							id: row.id,
							patch: {
								text: spec.text,
								note: spec.note ?? null,
								url: spec.url ?? null,
								...due,
								...(spec.rule
									? {}
									: spec.due
										? {}
										: { dueDate: null, dueTime: null, dueTz: null }),
								...(assigneeIds ? { assigneeIds } : {}),
							},
						},
						`${where} (replacing "${spec.replaces}")`,
					);
					const same =
						(target.kind === "trip" &&
							!row.nodeId &&
							!row.itemId &&
							!row.legId &&
							!row.dayId) ||
						(target.kind === "node" && row.nodeId === target.nodeId) ||
						(target.kind === "item" && row.itemId === target.itemId) ||
						(target.kind === "leg" && row.legId === target.legId) ||
						(target.kind === "day" && row.dayId === target.dayId);
					if (!same)
						await this.call(
							this.app.fns.moveListItem,
							{ id: row.id, target },
							`${where} move`,
						);
					bump(this.counts, "to-dos updated (replaces)");
					continue;
				}
				this.warnings.push(
					`${where}: no to-do "${spec.replaces}" to replace — added instead`,
				);
			}
			await this.call(
				this.app.fns.createListItem,
				{
					tripId: this.tripId,
					target,
					list: "todo",
					text: spec.text,
					...(spec.note ? { note: spec.note } : {}),
					...(spec.url ? { url: spec.url } : {}),
					...due,
					...(assigneeIds ? { assigneeIds } : {}),
				},
				where,
			);
			bump(
				this.counts,
				spec.rule
					? "to-dos (relative window)"
					: spec.due
						? "to-dos (dated)"
						: "to-dos (undated)",
			);
		}
	}

	async budgets(): Promise<void> {
		for (const { spec, part } of this.draft.budgets) {
			const where = `${part} budget ${spec.scope}/${spec.category}`;
			await this.call(
				this.app.fns.setBudgetLine,
				{
					tripId: this.tripId,
					nodeId:
						spec.scope === "trip" ? null : this.resolve(spec.scope, where),
					category: spec.category === "all" ? null : spec.category,
					memberId: null,
					amountMinor: toMinor(spec.amountUSD, "USD"),
					kind: spec.kind,
				},
				where,
			);
			bump(this.counts, "budget lines");
		}
		await this.tripTotal();
	}

	/**
	 * The trip root's "All costs" line. Without one, the budget engine derives
	 * the root's total from the root's CATEGORY lines only (money-budget.ts:
	 * "derived from this scope's categories, else from the nearest budgeted
	 * descendants"), so a lone trip-wide shopping line would read "All costs
	 * $2.5K" above "Lodging $3.3K" rolled up from the countries. The root total
	 * is the countries' all-cost lines (per day × the days that touch each
	 * country, counted like the app) plus the root's own category lines.
	 */
	async tripTotal(): Promise<void> {
		const specs = this.draft.budgets.map((b) => b.spec);
		if (specs.some((s) => s.scope === "trip" && s.category === "all")) return;
		const rootCats = specs.filter((s) => s.scope === "trip");
		const { ix } = await this.graph();
		let total = 0;
		const parts: string[] = [];
		for (const s of specs) {
			if (s.scope === "trip" || s.category !== "all") continue;
			const nodeId = this.resolve(s.scope, `budget ${s.scope}`);
			if (ix.node(nodeId)?.parentId !== null) continue; // countries only
			const days = s.kind === "per_day" ? this.app.daysTouching(ix, nodeId) : 1;
			total += s.amountUSD * days;
			parts.push(
				`${s.scope} ${s.amountUSD}${s.kind === "per_day" ? `×${days}d` : ""}`,
			);
		}
		if (!parts.length || !rootCats.length) return;
		for (const s of rootCats) {
			const days = s.kind === "per_day" ? ix.days.length : 1;
			total += s.amountUSD * days;
			parts.push(
				`trip ${s.category} ${s.amountUSD}${s.kind === "per_day" ? `×${days}d` : ""}`,
			);
		}
		await this.call(
			this.app.fns.setBudgetLine,
			{
				tripId: this.tripId,
				nodeId: null,
				category: null,
				memberId: null,
				amountMinor: toMinor(total, "USD"),
				kind: "total",
			},
			"trip budget total",
		);
		bump(this.counts, "budget lines");
		this.additions.push(
			`Added the trip's All-costs budget: US$${total.toLocaleString("en-US")} per person (${parts.join(" + ")}), so the trip view doesn't derive it from the shopping line alone`,
		);
	}

	async setAutofill(on: boolean): Promise<void> {
		await this.call(
			this.app.fns.updateTrip,
			{ tripId: this.tripId, settings: { autofillLegs: on } },
			`autofill ${on ? "on" : "off"}`,
		);
	}

	/** SPEC §10.9: every unset walk/transit pair (the app's sweep) + the stay legs. */
	async queueAutofill(): Promise<number> {
		const { graph } = await this.graph();
		let n = await this.app.autofillSweep(graph);
		for (const [i, d] of graph.days.entries()) {
			const targets: LegTarget[] = [];
			if (d.nightNodeId)
				targets.push({ kind: "stay", dayId: d.id, end: "end" });
			const prev = graph.days[i - 1];
			if (prev?.nightNodeId)
				targets.push({ kind: "stay", dayId: d.id, end: "start" });
			for (const target of targets) {
				await this.app.enqueue(
					"autofill",
					"autofill",
					{ tripId: this.tripId, target },
					{ dedupeId: this.app.autofillDedupeId(target) },
				);
				n++;
			}
		}
		return n;
	}

	/** Polls until the unset legs stop changing (or `sec` pass). */
	async waitForAutofill(sec: number): Promise<number> {
		const t0 = Date.now();
		let last = -1;
		let stableSince = Date.now();
		for (;;) {
			const { ix } = await this.graph();
			const sched = this.app.computeSchedule(ix);
			const unset = Object.values(sched.days).reduce(
				(t, d) => t + d.unsetLegs,
				0,
			);
			if (unset !== last) {
				last = unset;
				stableSince = Date.now();
			}
			if (unset === 0 || Date.now() - stableSince > 20_000) return unset;
			if (Date.now() - t0 > sec * 1000) return unset;
			await new Promise((r) => setTimeout(r, 3000));
		}
	}
}

type PendingLeg = {
	spec: LegSpec;
	date: string;
	prevItemId: string | undefined;
	nextItemId: string | undefined;
	legId?: string;
};
type ItemExtra = {
	spec: ItemSpec;
	itemId: string;
	nodeId: string | undefined;
	date: string;
};

// ===========================================================================
// Report
// ===========================================================================

function fmtMin(m: number): string {
	const h = Math.floor(m / 60);
	const mm = Math.round(m % 60);
	return h ? `${h}h${String(mm).padStart(2, "0")}` : `${mm}m`;
}

function renderReport(o: {
	args: Args;
	draft: Draft;
	issues: Issues;
	built: Built | null;
	schedule: string[];
	durationMs: number;
}): string {
	const { draft, issues, built } = o;
	const L: string[] = [];
	const t = draft.allocation.trip;
	L.push(`# ${t.name} — build report`, "");
	L.push(
		built
			? `Built \`/t/${built.slug}\` (trip ${built.tripId}) from \`${o.args.source}\` for ${o.args.owner}${built.replacedTripId ? `, replacing ${built.replacedTripId}` : ""} in ${(o.durationMs / 1000).toFixed(0)} s.`
			: `Check only (nothing written): ${draft.days.length} days, ${draft.flights.length} flights.`,
	);
	if (built)
		L.push(
			`Source trip \`${o.args.source}\` version ${built.sourceVersion.before} → ${built.sourceVersion.after}${built.sourceVersion.before === built.sourceVersion.after ? " (untouched)" : " — CHANGED, investigate"}.`,
		);
	L.push("");
	L.push(`## Validation`, "");
	L.push(`- errors: ${issues.errors.length}`);
	for (const e of issues.errors) L.push(`  - ${e}`);
	L.push(`- input fixes applied by the importer: ${issues.fixes.length}`);
	for (const f of issues.fixes) L.push(`  - ${f}`);
	L.push(
		`- warnings: ${issues.warnings.length + (built?.warnings.length ?? 0)}`,
	);
	for (const w of [...issues.warnings, ...(built?.warnings ?? [])])
		L.push(`  - ${w}`);
	L.push("");
	if (built) {
		L.push("## Written", "");
		for (const [k, v] of Object.entries(built.counts).sort())
			L.push(`- ${k}: ${v.toLocaleString("en-US")}`);
		L.push(
			`- autofill jobs queued: ${built.autofillJobs ?? "none (--no-autofill)"}`,
		);
		for (const a of built.additions) L.push(`- ${a}`);
		L.push("");
		L.push("Planned costs entered (major units, before conversion):", "");
		for (const [c, v] of [...built.planned].sort())
			L.push(`- ${c} ${v.toLocaleString("en-US")}`);
		L.push("");
	}
	if (o.schedule.length) {
		L.push("## Days (after autofill)", "");
		L.push(...o.schedule, "");
	}
	L.push("## Flights: uncertain", "");
	for (const u of draft.uncertain) L.push(`- **${u.flight}** ${u.note}`);
	L.push("");
	L.push("## Planner notes", "");
	for (const n of draft.notes) L.push(`- (${n.part}) ${n.note}`);
	const budgetNotes = draft.budgets.filter((b) => b.spec.note);
	if (budgetNotes.length) {
		L.push("", "## Budget notes", "");
		for (const b of budgetNotes)
			L.push(`- ${b.spec.scope}/${b.spec.category}: ${b.spec.note}`);
	}
	return `${L.join("\n")}\n`;
}

function scheduleTable(app: App, ix: GraphIndex): string[] {
	const sched = app.computeSchedule(ix);
	const out = [
		"| Day | Date | Title | Stops | Activities | Travel | Ends | Unset legs | Issues | Night |",
		"|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const d of ix.days) {
		const s = sched.days[d.id];
		if (!s) continue;
		const items = ix.itemsByDay.get(d.id) ?? [];
		const end = new Intl.DateTimeFormat("en-GB", {
			timeZone: s.tz,
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).format(s.end);
		const issues: string[] = [];
		if (s.conflicts)
			issues.push(`${s.conflicts} conflict${s.conflicts > 1 ? "s" : ""}`);
		if (s.overCapacityMin > 0)
			issues.push(`over by ${fmtMin(s.overCapacityMin)}`);
		for (const it of items) {
			const si = sched.items[it.id];
			if (si?.late)
				issues.push(
					`late ${si.late.minutes}m: ${it.title ?? ix.node(it.nodeId)?.name}`,
				);
		}
		for (const [k, l] of Object.entries(sched.legs))
			if (l.late && items.some((i) => k.startsWith(i.id)))
				issues.push(`${l.late.label} ${l.late.minutes}m late`);
		const night = d.nightNodeId ? (ix.node(d.nightNodeId)?.name ?? "?") : "—";
		out.push(
			`| ${ix.dayNumber(d.id)} | ${d.date} | ${(d.title ?? "").replace(/\|/g, "/")} | ${items.length} | ${fmtMin(s.activitiesMin)} | ${fmtMin(s.travelMin)} | ${end}${localDate(s.end, s.tz) !== d.date ? " (+1)" : ""} | ${s.unsetLegs} | ${issues.join("; ").replace(/\|/g, "/") || "—"} | ${night} |`,
		);
	}
	return out;
}

function localDate(at: Date, tz: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(at);
}

// ===========================================================================
// Main
// ===========================================================================

async function main(): Promise<void> {
	const t0 = Date.now();
	const args = parseCli(process.argv.slice(2));
	const root = process.cwd();
	loadDotEnv(path.join(root, ".env"));
	const { draft, issues } = loadDraft(path.resolve(root, args.dir));

	registerStartStandIns(root);
	const app = await loadApp();
	const db = app.getDb();
	const { schema, orm } = app;
	const dbName = new URL(
		process.env.DATABASE_URL ?? "postgres://x/unknown",
	).pathname.slice(1);
	console.log(
		`[draft] database ${dbName}, ${args.check ? "check only" : "build"}`,
	);

	let built: Built | null = null;
	let schedule: string[] = [];
	try {
		// ---- 1. the owner and the real trip (read only) ----------------------
		const [owner] = await db
			.select()
			.from(schema.user)
			.where(orm.eq(schema.user.email, args.owner));
		if (!owner) throw new Error(`no user ${args.owner}`);
		const user = owner as unknown as AuthUser;
		const [source] = await db
			.select({
				id: schema.trips.id,
				version: schema.trips.version,
				name: schema.trips.name,
			})
			.from(schema.trips)
			.where(
				orm.and(
					orm.eq(schema.trips.slug, args.source),
					orm.isNull(schema.trips.deletedAt),
				),
			);
		if (!source) throw new Error(`no trip "${args.source}"`);
		const access = await app.getTripAccess(source.id, user);
		if (access?.role !== "owner")
			throw new Error(`${args.owner} doesn't own "${args.source}"`);
		const slug = draft.allocation.trip.slug;
		if (slug === args.source)
			throw new Error("the draft slug is the real trip's");
		const sourceGraph = await app.loadGraphForServer(db, source.id);
		if (!sourceGraph) throw new Error("can't read the real trip");

		// ---- 2. keys against the real trip's tree ------------------------------
		checkKeys(draft, new PlaceTree(sourceGraph.nodes), issues);
		const sourceTodos = await db.execute(orm.sql`
			select text from list_items where trip_id = ${source.id} and list = 'todo' and deleted_at is null`);
		const texts = new Set(
			(sourceTodos.rows as { text: string }[]).map((r) => r.text),
		);
		for (const { spec, part } of draft.todos)
			if (spec.replaces && !texts.has(spec.replaces))
				issues.warnings.push(
					`${part} to-do "${spec.text}": replaces "${spec.replaces}", which the real trip doesn't have`,
				);
		const needDays = draft.days.map((d) => d.date);
		const haveDays = new Set(sourceGraph.days.map((d) => d.date));
		for (const d of needDays)
			if (!haveDays.has(d)) issues.errors.push(`the real trip has no day ${d}`);
		if (issues.errors.length) {
			console.error(`[draft] ${issues.errors.length} validation errors:`);
			for (const e of issues.errors) console.error(`  - ${e}`);
			throw new Error("validation failed — nothing written");
		}
		if (args.check) return;

		// ---- 3. replace an earlier draft (never the real trip) ------------------
		const [old] = await db
			.select({
				id: schema.trips.id,
				name: schema.trips.name,
				createdBy: schema.trips.createdBy,
			})
			.from(schema.trips)
			.where(
				orm.and(
					orm.eq(schema.trips.slug, slug),
					orm.isNull(schema.trips.deletedAt),
				),
			);
		let replacedTripId: string | null = null;
		if (old) {
			if (old.id === source.id)
				throw new Error("refusing: that is the real trip");
			if (old.name !== draft.allocation.trip.name || old.createdBy !== user.id)
				throw new Error(
					`refusing to replace "${slug}": it is "${old.name}", not a draft made for ${args.owner}`,
				);
			await db.transaction((tx) => app.hardDeleteTrip(tx, old.id));
			replacedTripId = old.id;
			const n = await app.deleteTripObjects(old.id).catch(() => 0);
			console.log(
				`[draft] removed the previous draft ${old.id}${n ? ` (${n} objects)` : ""}`,
			);
		}

		// ---- 4. the copy: the app's Duplicate… (everything included) -------------
		const { tripId, slug: gotSlug } = await db.transaction((tx) =>
			app.duplicateTripCore(tx, {
				srcId: source.id,
				userId: user.id,
				srcMemberId: access.memberId,
				name: draft.allocation.trip.name,
				startDate: sourceGraph.trip.startDate ?? draft.allocation.trip.start,
				include: {
					notes: true,
					lists: true,
					media: true,
					budgets: true,
					placeholders: true,
				},
			}),
		);
		if (tripId === source.id) throw new Error("the copy is the real trip?!");
		if (gotSlug !== slug)
			throw new Error(
				`the copy got the slug "${gotSlug}", expected "${slug}" — is another trip holding it?`,
			);
		console.log(`[draft] copied ${args.source} → ${gotSlug} (${tripId})`);

		// ---- 5. the itinerary, through the app's server functions --------------
		const b = new Builder(app, user, tripId, draft);
		await b.setup();
		await b.setAutofill(false);
		await b.mirrorDone(source.id);
		console.log("[draft] nodes…");
		await b.nodes();
		console.log("[draft] days + stays…");
		await b.daysAndStays();
		console.log("[draft] items + flights…");
		const pending: PendingLeg[] = [];
		const extras = await b.items(pending);
		console.log("[draft] legs…");
		await b.legs(pending);
		await b.itemExtras(extras);
		console.log("[draft] money…");
		await b.money(extras, pending);
		console.log("[draft] to-dos + budgets…");
		await b.todos(extras, pending);
		await b.budgets();
		await b.setAutofill(true);
		let autofillJobs: number | null = null;
		if (args.autofill) {
			autofillJobs = await b.queueAutofill();
			console.log(
				`[draft] queued ${autofillJobs} autofill jobs; waiting up to ${args.waitSec}s…`,
			);
			const left = await b.waitForAutofill(args.waitSec);
			console.log(`[draft] unset legs left: ${left}`);
		}
		const { ix } = await b.graph();
		schedule = scheduleTable(app, ix);
		const [after] = await db
			.select({ version: schema.trips.version })
			.from(schema.trips)
			.where(orm.eq(schema.trips.id, source.id));
		built = {
			tripId,
			slug: gotSlug,
			replacedTripId,
			counts: b.counts,
			warnings: b.warnings,
			additions: b.additions,
			planned: b.planned,
			flightItems: b.flightItems,
			autofillJobs,
			sourceVersion: { before: source.version, after: after?.version ?? -1 },
		};
	} finally {
		const report = renderReport({
			args,
			draft,
			issues,
			built,
			schedule,
			durationMs: Date.now() - t0,
		});
		console.log(report);
		if (args.report) {
			mkdirSync(path.dirname(path.resolve(root, args.report)), {
				recursive: true,
			});
			writeFileSync(path.resolve(root, args.report), report);
			console.log(`[draft] report: ${args.report}`);
		}
		await app.closeQueues().catch(() => undefined);
		await app.closeRedis().catch(() => undefined);
		await app.closeDb().catch(() => undefined);
	}
}

main().catch((e: unknown) => {
	console.error("[draft]", e instanceof Error ? e.message : e);
	process.exitCode = 1;
});

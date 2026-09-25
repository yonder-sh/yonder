/**
 * Workspace URL state (SPEC §12.1): the scope is the URL path
 * (`/t/<trip>/japan/tokyo`); everything else is a search param, so every view
 * is a deep link and Back zooms out (DESIGN §1.5).
 *
 * Invalid values never throw: each field `.catch(undefined)`s, so a stale or
 * hand-edited URL degrades to the default instead of an error page.
 */
import { z } from "zod";
import type { DayRange, Lens } from "@/lib/engine/types";
import type { LegTarget } from "@/lib/schemas/targets";
import { FILTER_PARAM_RE } from "./filter";

export type { BundleTarget, LegTarget } from "@/lib/schemas/targets";

const ID = "[0-9a-f-]{36}";

/**
 * `overview` (docs/OVERVIEW.md) is the trip-level landing page; `money` (E5)
 * is never rendered for guests and is read-only for viewers (EXTENSIONS §1.4).
 */
export const TABS = [
	"overview",
	"plan",
	"places",
	"media",
	"lists",
	"notes",
	"money",
] as const;
export type Tab = (typeof TABS)[number];

/**
 * The Places tab's views (docs/PLACES.md §1: `pv`), which also name its step
 * (rate → review → schedule, owner 2026-09-25): table, board and map are Review,
 * rate is Rate, schedule is Schedule. Absent = the tab picks the step.
 */
export const PLACES_VIEWS = [
	"table",
	"board",
	"map",
	"rate",
	"schedule",
] as const;
export type PlacesView = (typeof PLACES_VIEWS)[number];
/** Group by (`pg`); absent = city. */
export const PLACES_GROUP_PARAM = [
	"country",
	"region",
	"city",
	"area",
	"status",
	"none",
] as const;
/** Sort (`ps`); absent = priority. */
export const PLACES_SORT_PARAM = ["priority", "name", "trip"] as const;
/** Status filter (`pst`); absent = all (everything but dropped). */
export const PLACES_STATUS_PARAM = [
	"shortlist",
	"idea",
	"scheduled",
	"dropped",
] as const;
/** The Rate feed's order (`po`); absent = mixed. */
export const FEED_ORDER_PARAM = ["mixed", "city", "random"] as const;

/**
 * The inspector's tabs (FB-21b: `itab` in the URL, so links and Follow open
 * on the same one). Overview is the default and never written.
 */
export const INSPECTOR_TABS = [
	"overview",
	"media",
	"lists",
	"notes",
	"money",
] as const;
export type InspectorTabParam = (typeof INSPECTOR_TABS)[number];

export const LENS_VALUES = [
	"country",
	"region",
	"city",
	"area",
	"place",
] as const satisfies readonly Lens[];

export const DaysParam = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?$/);

export const SEL_RE = new RegExp(
	`^(root|n\\.${ID}|i\\.${ID}|l\\.${ID}\\.${ID}|e\\.${ID}\\.${ID}|d\\.${ID}|s\\.${ID}\\.(start|end)|p\\.${ID})$`,
);

export const WorkspaceSearch = z.object({
	lens: z.enum(LENS_VALUES).optional().catch(undefined),
	/** Absent = `defaultTab()`: the Overview at a bare trip root, else the Plan. */
	tab: z.enum(TABS).optional().catch(undefined),
	/**
	 * docs/OVERVIEW.md: "today" for the Overview (`YYYY-MM-DD`), so demos and
	 * e2e can see it before, during and after the trip. Nothing else reads it.
	 */
	asOf: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional()
		.catch(undefined),
	/** One day or an inclusive range. */
	days: DaysParam.optional().catch(undefined),
	sel: z.string().regex(SEL_RE).optional().catch(undefined),
	/** The inspector's tab (FB-21b); absent = Overview. Reset with each new `sel`. */
	itab: z
		.enum(["media", "lists", "notes", "money"])
		.optional()
		.catch(undefined),
	/** Rollup "Only <scope>". */
	only: z.literal(1).optional().catch(undefined),
	list: z.enum(["todo", "shopping"]).optional().catch(undefined),
	/** Media filter; `documents` = PDFs (ADDENDUM §9). */
	mf: z
		.enum(["photos", "videos", "social", "guides", "documents"])
		.optional()
		.catch(undefined),
	/** Person filter (a memberId). */
	who: z.uuid().optional().catch(undefined),
	/** The shared place filter (ADDENDUM §10); see `filter.ts` for the format. */
	f: z.string().regex(FILTER_PARAM_RE).optional().catch(undefined),
	// ---- the Places tab (docs/PLACES.md §1); shared by every view -----------
	pv: z.enum(PLACES_VIEWS).optional().catch(undefined),
	pg: z.enum(PLACES_GROUP_PARAM).optional().catch(undefined),
	ps: z.enum(PLACES_SORT_PARAM).optional().catch(undefined),
	pst: z.enum(PLACES_STATUS_PARAM).optional().catch(undefined),
	/** "Talk about it": only Split places. */
	talk: z.literal(1).optional().catch(undefined),
	po: z.enum(FEED_ORDER_PARAM).optional().catch(undefined),
});
export type WorkspaceSearch = z.infer<typeof WorkspaceSearch>;

// ---------------------------------------------------------------------------
// tab
// ---------------------------------------------------------------------------

/**
 * The Plan's (and the map's) own view state. A trip-root link that carries
 * any of it (an inbox `?sel=`, a day link, a lens) opens the Plan as it always
 * did; only a bare trip link lands on the Overview.
 */
const PLAN_VIEW_KEYS = ["sel", "days", "lens", "f"] as const;

/** The tab a URL without `tab` shows: the Overview at a bare trip root, else the Plan. */
export function defaultTab(
	scopeId: string | null,
	search: WorkspaceSearch,
): Tab {
	if (scopeId) return "plan";
	return PLAN_VIEW_KEYS.some((k) => search[k] !== undefined)
		? "plan"
		: "overview";
}

/** The tab a URL shows. */
export function tabOf(scopeId: string | null, search: WorkspaceSearch): Tab {
	return search.tab ?? defaultTab(scopeId, search);
}

/** The `tab` param that shows `tab` at `scopeId` with the rest of `search` (undefined = its default). */
export function tabParam(
	scopeId: string | null,
	tab: Tab,
	search: WorkspaceSearch,
): Tab | undefined {
	return tab === defaultTab(scopeId, { ...search, tab: undefined })
		? undefined
		: tab;
}

// ---------------------------------------------------------------------------
// sel
// ---------------------------------------------------------------------------

export type Sel =
	| { kind: "node"; id: string }
	| { kind: "item"; id: string }
	| { kind: "leg"; target: LegTarget }
	| { kind: "edge"; from: string; to: string }
	| { kind: "day"; id: string }
	/** E7: a proposal (`p.<id>`, ProposalOverview). */
	| { kind: "proposal"; id: string }
	| { kind: "root" };

/**
 * `sel` encoding: `n.<nodeId>`, `i.<itemId>`, `l.<from>.<to>` (a pair, stable
 * whether or not the leg row exists; also overnight connectors), `e.<fromRep>.<toRep>`
 * (an aggregated edge), `d.<dayId>`, `s.<dayId>.start|end` (a stay leg),
 * `p.<proposalId>` (E7), `root`.
 */
export function parseSel(raw: string | null | undefined): Sel | null {
	if (!raw || !SEL_RE.test(raw)) return null;
	if (raw === "root") return { kind: "root" };
	const [k, a = "", b = ""] = raw.split(".");
	switch (k) {
		case "n":
			return { kind: "node", id: a };
		case "i":
			return { kind: "item", id: a };
		case "d":
			return { kind: "day", id: a };
		case "p":
			return { kind: "proposal", id: a };
		case "e":
			return { kind: "edge", from: a, to: b };
		case "l":
			return {
				kind: "leg",
				target: { kind: "pair", fromItemId: a, toItemId: b },
			};
		case "s":
			return {
				kind: "leg",
				target: { kind: "stay", dayId: a, end: b as "start" | "end" },
			};
		default:
			return null;
	}
}

export function serializeSel(sel: Sel | null | undefined): string | undefined {
	if (!sel) return undefined;
	switch (sel.kind) {
		case "root":
			return "root";
		case "node":
			return `n.${sel.id}`;
		case "item":
			return `i.${sel.id}`;
		case "day":
			return `d.${sel.id}`;
		case "proposal":
			return `p.${sel.id}`;
		case "edge":
			return `e.${sel.from}.${sel.to}`;
		case "leg":
			return sel.target.kind === "pair"
				? `l.${sel.target.fromItemId}.${sel.target.toItemId}`
				: `s.${sel.target.dayId}.${sel.target.end}`;
	}
}

export function sameSel(a: Sel | null, b: Sel | null): boolean {
	return serializeSel(a) === serializeSel(b);
}

// ---------------------------------------------------------------------------
// days
// ---------------------------------------------------------------------------

/** `2027-10-05` or `2027-10-05..2027-10-07` → an ordered inclusive range. */
export function parseDays(raw: string | null | undefined): DayRange | null {
	if (!raw || !DaysParam.safeParse(raw).success) return null;
	const [from = "", to = from] = raw.split("..");
	return from <= to ? { from, to } : { from: to, to: from };
}

export function serializeDays(
	range: DayRange | null | undefined,
): string | undefined {
	if (!range) return undefined;
	return range.from === range.to ? range.from : `${range.from}..${range.to}`;
}

/** Shift-click / long-press: grow the range to include `date`. */
export function extendRange(range: DayRange | null, date: string): DayRange {
	if (!range) return { from: date, to: date };
	return {
		from: date < range.from ? date : range.from,
		to: date > range.to ? date : range.to,
	};
}

// ---------------------------------------------------------------------------
// scope path
// ---------------------------------------------------------------------------

/** The splat (`japan/tokyo`) → slug segments. Empty = the trip root. */
export function splitScopePath(splat: string | null | undefined): string[] {
	if (!splat) return [];
	return splat
		.split("/")
		.map((s) => {
			try {
				return decodeURIComponent(s);
			} catch {
				return s;
			}
		})
		.filter(Boolean);
}

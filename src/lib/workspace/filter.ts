/**
 * The shared place filter (ADDENDUM §10 "Filters"): one filter for the map,
 * Ideas and Outline, kept in the URL as `?f=`. F owns the format; WP-Outline
 * and WP-Map apply it (`matchesFilter` is theirs to write on top of this).
 *
 * Format: `;`-separated tokens, each optional, in any order:
 *   `g:sight,food_drink`  category groups (PLACE_GROUPS keys; none = all)
 *   `p:want`              minimum priority (inclusive; PRIORITY_VALUES)
 *   `by:max` | `by:<id>`  whose rating `p` reads: the max of all members
 *                         (default) or one member
 *   `u:me` | `u:<id>`     unrated by me / by that member
 *   `ns`                  not scheduled (no live item on a day)
 * Unknown or malformed tokens are dropped, never an error (like the rest of
 * WorkspaceSearch).
 */
import { PLACE_GROUPS, type PlaceGroup } from "@/lib/domain/taxonomy";
import { PRIORITY_VALUES, type Priority } from "@/lib/schemas/enums";

export type WorkspaceFilter = {
	groups: PlaceGroup[];
	minPriority: Priority | null;
	/** `max` = the highest rating of any member (the owner's ranking rule). */
	priorityOf: "max" | string;
	unratedBy: "me" | string | null;
	notScheduled: boolean;
};

export const EMPTY_FILTER: WorkspaceFilter = {
	groups: [],
	minPriority: null,
	priorityOf: "max",
	unratedBy: null,
	notScheduled: false,
};

/** What the URL param may contain (the schema in `search.ts` uses it). */
export const FILTER_PARAM_RE = /^[a-z0-9_:;,.-]{0,400}$/;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isGroup(v: string): v is PlaceGroup {
	return Object.hasOwn(PLACE_GROUPS, v);
}
function isPriority(v: string): v is Priority {
	return (PRIORITY_VALUES as readonly string[]).includes(v);
}

export function parseFilter(raw: string | null | undefined): WorkspaceFilter {
	const f: WorkspaceFilter = { ...EMPTY_FILTER, groups: [] };
	if (!raw || !FILTER_PARAM_RE.test(raw)) return f;
	for (const token of raw.split(";")) {
		const [key, value = ""] = token.split(":", 2) as [string, string?];
		switch (key) {
			case "g":
				for (const g of value.split(","))
					if (isGroup(g) && !f.groups.includes(g)) f.groups.push(g);
				break;
			case "p":
				if (isPriority(value)) f.minPriority = value;
				break;
			case "by":
				if (value === "max" || UUID_RE.test(value)) f.priorityOf = value;
				break;
			case "u":
				if (value === "me" || UUID_RE.test(value)) f.unratedBy = value;
				break;
			case "ns":
				f.notScheduled = true;
				break;
		}
	}
	// Canonical order, so parse ∘ serialize is the identity.
	const order = Object.keys(PLACE_GROUPS);
	f.groups.sort((a, b) => order.indexOf(a) - order.indexOf(b));
	return f;
}

/** The canonical param; `undefined` for an empty filter (keeps URLs clean). */
export function serializeFilter(
	f: WorkspaceFilter | null | undefined,
): string | undefined {
	if (!f) return undefined;
	const out: string[] = [];
	const groups = (Object.keys(PLACE_GROUPS) as PlaceGroup[]).filter((g) =>
		f.groups.includes(g),
	);
	if (groups.length) out.push(`g:${groups.join(",")}`);
	if (f.minPriority) {
		out.push(`p:${f.minPriority}`);
		if (f.priorityOf !== "max") out.push(`by:${f.priorityOf}`);
	}
	if (f.unratedBy) out.push(`u:${f.unratedBy}`);
	if (f.notScheduled) out.push("ns");
	return out.length ? out.join(";") : undefined;
}

export function isEmptyFilter(f: WorkspaceFilter): boolean {
	return serializeFilter(f) === undefined;
}

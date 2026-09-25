/**
 * The one inbox (ADDENDUM §10), pure helpers for `InboxBell`: grouping by
 * kind, where a row goes (a workspace URL), and the short relative time.
 *
 * `InboxItem.link` comes from the server; it is re-validated here like any URL
 * state (`sel` must match `SEL_RE`, `tab`/`list` their enums), so a malformed
 * link degrades to "open the trip" instead of navigating somewhere odd.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import { formatMoney } from "@/lib/engine/money";
import type { InboxItem, InboxLink } from "@/lib/schemas/inbox";
import { cleanSearch } from "@/lib/workspace/nav";
import {
	parseSel,
	type Sel,
	TABS,
	type WorkspaceSearch,
} from "@/lib/workspace/search";

export type InboxGroupKey = "mentions" | "suggestions" | "todos" | "money";

export const INBOX_GROUP_LABEL: Record<InboxGroupKey, string> = {
	mentions: "Mentions",
	suggestions: "Suggestions",
	todos: "To-dos",
	money: "Money",
};

const GROUP_OF: Record<InboxItem["kind"], InboxGroupKey> = {
	mention: "mentions",
	review: "suggestions",
	proposal_result: "suggestions",
	due: "todos",
	balance_changed: "money",
	budget_notice: "money",
};

const GROUP_ORDER: InboxGroupKey[] = [
	"suggestions",
	"mentions",
	"todos",
	"money",
];

export type InboxGroup = { key: InboxGroupKey; items: InboxItem[] };

/** Groups in a fixed order (actionable first), each newest first; empty groups dropped. */
export function groupInbox(items: readonly InboxItem[]): InboxGroup[] {
	const by = new Map<InboxGroupKey, InboxItem[]>();
	for (const i of items) {
		const k = GROUP_OF[i.kind];
		const list = by.get(k) ?? [];
		list.push(i);
		by.set(k, list);
	}
	return GROUP_ORDER.flatMap((key) => {
		const list = by.get(key);
		if (!list?.length) return [];
		list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
		return [{ key, items: list }];
	});
}

/** The workspace search a link opens (validated; unknown values dropped). */
export function inboxSearch(link: InboxLink): WorkspaceSearch {
	const sel = parseSel(link.sel);
	const tab =
		link.tab && (TABS as readonly string[]).includes(link.tab)
			? link.tab
			: undefined;
	const list =
		link.list === "todo" || link.list === "shopping" ? link.list : undefined;
	return cleanSearch({
		sel: sel ? link.sel : undefined,
		tab: tab === "plan" ? undefined : tab,
		list,
	});
}

/** The node a selection lives in (to decide whether the current scope can stay). */
function nodeOfSel(ix: GraphIndex, sel: Sel | null): string | null {
	if (!sel) return null;
	switch (sel.kind) {
		case "node":
			return sel.id;
		case "item":
			return ix.item(sel.id)?.nodeId ?? null;
		default:
			return null;
	}
}

/**
 * Keep the current scope when the linked entity is inside it (so opening a
 * mention in Tokyo doesn't throw you back to the trip root); else the root.
 */
export function keepScope(
	ix: GraphIndex,
	scopeId: string | null,
	link: InboxLink,
): boolean {
	if (!scopeId) return true;
	const n = nodeOfSel(ix, parseSel(link.sel));
	return !!n && ix.isWithin(n, scopeId);
}

/** "just now", "5m ago", "2h ago", "3d ago", then "12 Sep". */
export function timeAgo(iso: string, now: number): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "";
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.round(h / 24);
	if (d < 7) return `${d}d ago`;
	// Older: the calendar date in the viewer's zone ("12 Sep").
	return new Date(t).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
	});
}

/** Signed money in minor units, for the caller's own balance notices ("+$6.20"). */
export function formatDelta(minor: number, currency: string): string {
	let body: string;
	try {
		body = formatMoney(Math.abs(minor), currency);
	} catch {
		body = `${Math.abs(minor)} ${currency}`;
	}
	return `${minor < 0 ? "−" : "+"}${body}`;
}

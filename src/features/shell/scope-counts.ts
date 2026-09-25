/**
 * Tab counts (DESIGN §4.3 "Media 42 · Lists 17", §4.4 inspector tabs), summed
 * over exactly the bundle targets the tabs show (SPEC §8.4): the counts per
 * target become one synthetic entry each and go through the same `rollup()`
 * the Media, Lists and Notes tabs use. So nodes in the subtree, items whose
 * effective node is inside, pair legs touching the scope, stay legs of its
 * days, the days themselves, the trip root at the root, the day range, the
 * "Only Tokyo" switch and dropped places all count exactly as they display.
 *
 * Private rows and `members`-only media are already left out of `counts` by F
 * (`getTripCounts`), so nothing here can leak them.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import { type RollupEntryRef, rollup } from "@/lib/engine/rollup";
import type {
	Counts,
	DayRange,
	Lens,
	TripCounts,
	WorkspaceModel,
} from "@/lib/engine/types";
import type { BundleTarget } from "@/lib/schemas/targets";
import type { Workspace } from "@/lib/workspace/use-workspace";

export type TabCounts = { media: number; lists: number; notes: boolean };

const ZERO: TabCounts = { media: 0, lists: 0, notes: false };

type Entry = RollupEntryRef & { c: Counts };

function add(out: TabCounts, x: Counts | undefined): void {
	if (!x) return;
	out.media += x.media + x.links + x.docs;
	out.lists += x.todoOpen + x.shopOpen;
	out.notes ||= x.hasNote;
}

/** One entry per target that has counts. */
export function countEntries(c: TripCounts): Entry[] {
	const out: Entry[] = [{ c: c.root }];
	for (const [nodeId, x] of Object.entries(c.byNode))
		out.push({ nodeId, c: x });
	for (const [itemId, x] of Object.entries(c.byItem))
		out.push({ itemId, c: x });
	for (const [legId, x] of Object.entries(c.byLeg)) out.push({ legId, c: x });
	for (const [dayId, x] of Object.entries(c.byDay)) out.push({ dayId, c: x });
	return out;
}

/** Sums the counts of every target a rollup of `opts` shows. */
export function rollupCounts(
	ix: GraphIndex,
	counts: TripCounts | undefined,
	opts: {
		scopeId: string | null;
		lens: Lens;
		includeDescendants: boolean;
		dayRange: DayRange | null;
		model?: WorkspaceModel;
	},
): TabCounts {
	if (!counts) return { ...ZERO };
	const out: TabCounts = { ...ZERO };
	const groups = rollup(ix, opts, countEntries(counts));
	for (const g of groups)
		for (const s of g.subgroups) for (const e of s.entries) add(out, e.c);
	return out;
}

/** The centre tab bar's counts for the current scope, days and Only switch. */
export function scopeCounts(
	ws: Pick<
		Workspace,
		"counts" | "ix" | "scope" | "only" | "lens" | "days" | "model"
	>,
): TabCounts {
	return rollupCounts(ws.ix, ws.counts, {
		scopeId: ws.scope?.id ?? null,
		lens: ws.lens,
		includeDescendants: !ws.only,
		dayRange: ws.days,
		model: ws.model,
	});
}

/** One target's own counts (the inspector's leg, item, day or "This visit only"). */
export function targetCounts(
	counts: TripCounts | undefined,
	t: BundleTarget,
): TabCounts {
	const out: TabCounts = { ...ZERO };
	if (!counts) return out;
	switch (t.kind) {
		case "trip":
			add(out, counts.root);
			break;
		case "node":
			add(out, counts.byNode[t.nodeId]);
			break;
		case "item":
			add(out, counts.byItem[t.itemId]);
			break;
		case "leg":
			add(out, counts.byLeg[t.legId]);
			break;
		case "day":
			add(out, counts.byDay[t.dayId]);
			break;
	}
	return out;
}

/**
 * The rollup (SPEC §8.4) flattened for the gallery: groups of tiles, each
 * tile with its source line in rollups ("Shibuya › Shibuya Sky", "This visit ·
 * Day 4 · 11:42", "Transit · Osaka → Seoul"). Pure; receipts never roll up.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import { type RollupOptions, rollup } from "@/lib/engine/rollup";
import type { ScheduleResult } from "@/lib/engine/types";
import { attachmentTargetColumns } from "@/lib/schemas/targets";
import { dayHeading } from "./labels";
import type { MediaDto } from "./types";

type Entry = {
	nodeId: string | null;
	legId: string | null;
	itemId: string | null;
	dayId: string | null;
	item: MediaDto;
};

export type Tile = { item: MediaDto; source: string | null };
export type Group = { key: string; header: HeaderSpec | null; tiles: Tile[] };
export type HeaderSpec =
	| { kind: "rep"; repId: string | null; count: number }
	| { kind: "text"; text: string; count: number };

function timeOf(schedule: ScheduleResult, itemId: string): string | null {
	const s = schedule.items[itemId];
	if (!s) return null;
	try {
		return new Intl.DateTimeFormat("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZone: s.tz,
		}).format(s.start);
	} catch {
		return null;
	}
}

/** The rollup, flattened to groups of tiles with their source lines. */
export function buildGroups(
	ix: GraphIndex,
	schedule: ScheduleResult,
	items: readonly MediaDto[],
	opts: RollupOptions,
	scopeId: string | null,
): Group[] {
	const entries: Entry[] = items
		.filter((i) => i.target.kind !== "expense")
		.map((item) => {
			const c = attachmentTargetColumns(item.target);
			return {
				nodeId: c.nodeId,
				legId: c.legId,
				itemId: c.itemId,
				dayId: c.dayId,
				item,
			};
		});
	const groups = rollup(ix, opts, entries);
	return groups.map((g) => {
		const tiles: Tile[] = [];
		for (const s of g.subgroups) {
			let source: string | null = null;
			if (s.kind === "node" && s.nodeId && s.nodeId !== g.repId) {
				const names = s.caption
					.map((id) => ix.node(id)?.name)
					.filter((n): n is string => !!n);
				source = names.length ? names.join(" › ") : null;
			} else if (s.kind === "visit" && s.itemId) {
				const day = s.dayId ? ix.dayNumber(s.dayId) : 0;
				const t = timeOf(schedule, s.itemId);
				source = ["This visit", day ? `Day ${day}` : null, t]
					.filter(Boolean)
					.join(" · ");
			} else if (s.kind === "transit") {
				const a = ix.node(s.fromRepId)?.name;
				const b = ix.node(s.toRepId)?.name;
				source = a && b ? `Transit · ${a} → ${b}` : "Transit";
			} else if (s.kind === "unlinked") {
				source = "Unlinked transit";
			}
			for (const e of s.entries) tiles.push({ item: e.item, source });
		}
		const header: HeaderSpec =
			g.kind === "day"
				? { kind: "text", text: dayHeading(ix, g.dayId), count: g.count }
				: g.kind === "unlinked"
					? { kind: "text", text: "Unlinked transit", count: g.count }
					: g.kind === "scope"
						? {
								kind: "text",
								text: scopeId
									? (ix.node(scopeId)?.name ?? "Here")
									: ix.trip.name || "The trip",
								count: g.count,
							}
						: { kind: "rep", repId: g.repId, count: g.count };
		return { key: g.key, header, tiles };
	});
}

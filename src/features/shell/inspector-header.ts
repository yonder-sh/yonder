/**
 * DESIGN §4.4 inspector header variants: title + chip per selection kind.
 */

import { describeProposal } from "@/features/suggest/describe-proposal";
import { baseIndexOf } from "@/features/suggest/use-base-index";
import {
	formatDateRange,
	formatDayDate,
	formatDuration,
	formatTime,
} from "@/lib/format";
import type { Workspace } from "@/lib/workspace/use-workspace";

export type InspectorHeader = {
	title: string;
	chip: string | null;
	/** Day titles use Parkinsans (our words, DESIGN §2.6). */
	display?: boolean;
};

export function inspectorHeader(ws: Workspace): InspectorHeader {
	const { sel, ix, graph, schedule } = ws;
	const nameOfItem = (id: string | null | undefined) => {
		const it = ix.item(id);
		if (!it) return "?";
		return it.title ?? ix.node(it.nodeId)?.name ?? "Untitled";
	};
	if (!sel || sel.kind === "root") {
		return {
			title: graph.trip.name,
			chip: graph.trip.startDate
				? formatDateRange(graph.trip.startDate, graph.trip.endDate, {
						year: true,
					})
				: "No dates yet",
		};
	}
	switch (sel.kind) {
		case "node": {
			const n = ix.node(sel.id);
			return { title: n?.name ?? "Unknown place", chip: n ? n.type : null };
		}
		case "item": {
			const it = ix.item(sel.id);
			const s = schedule.items[sel.id];
			const day = it?.dayId ? ix.day(it.dayId) : undefined;
			const chip =
				day && s
					? `Day ${ix.dayNumber(day.id)} · ${formatTime(s.start, s.tz)}–${formatTime(s.end, s.tz)}`
					: it
						? `Unscheduled · ${formatDuration(it.durationMin)}`
						: null;
			return { title: nameOfItem(sel.id), chip };
		}
		case "leg": {
			const t = sel.target;
			if (t.kind === "pair") {
				const kind = ix.boundaryKind(t.fromItemId, t.toItemId);
				return {
					title: `${nameOfItem(t.fromItemId)} → ${nameOfItem(t.toItemId)}`,
					chip: kind === "overnight" ? "Overnight" : null,
				};
			}
			const plan =
				t.end === "start" ? ix.morningStay(t.dayId) : ix.eveningStay(t.dayId);
			const stay = ix.node(ix.day(t.dayId)?.nightNodeId ?? null);
			return {
				title: plan
					? `${stay?.name ?? "Stay"} · ${t.end === "start" ? "morning" : "evening"}`
					: "Stay leg",
				chip: t.end === "start" ? "Morning" : "Evening",
			};
		}
		case "edge": {
			const edge = ws.model.edges.find(
				(e) => e.fromRepId === sel.from && e.toRepId === sel.to,
			);
			return {
				title: `${ix.node(sel.from)?.name ?? "?"} → ${ix.node(sel.to)?.name ?? "?"}`,
				chip: edge
					? `${edge.count} ${edge.count === 1 ? "leg" : "legs"}`
					: null,
			};
		}
		case "day": {
			const d = ix.day(sel.id);
			return {
				title: d ? formatDayDate(d.date) : "Unknown day",
				chip: d
					? `Day ${ix.dayNumber(d.id)}${d.title ? ` · ${d.title}` : ""}`
					: null,
				display: true,
			};
		}
		case "proposal": {
			const p = ws.proposals.list.find((x) => x.id === sel.id);
			// WP-Suggest M9: read against the server graph (`ws.ix` already has
			// the suggestions applied while they're shown). The overview under
			// the header names the author.
			const title = p
				? describeProposal(p, baseIndexOf(graph, ix)) || p.summary
				: "Suggestion";
			return { title, chip: "Suggestion" };
		}
	}
}

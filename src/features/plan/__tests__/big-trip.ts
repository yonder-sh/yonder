/**
 * A synthetic trip the size of Asia 2027 (QA PERF-01/05: 125 places, 35
 * days): eight stops a day across Tokyo, Kyoto, Osaka and Seoul, meals as
 * blocks, a pinned stop every other day, a nightly stay, legs between every
 * stop (walk and transit, a few left unset), notes, assignees and counts on
 * every card. Built on the demo scenario builder, so the ids and shapes match
 * the real graph.
 */

import type { Counts, TripCounts } from "@/lib/engine/types";
import { scenario } from "@/lib/fixtures/demo";

const AREAS = [
	"shibuya",
	"harajuku",
	"asakusa",
	"kappabashi",
	"kyoto",
	"osaka",
	"seoul",
	"taipei",
] as const;
const CATS = [
	"shopping",
	"restaurant",
	"temple_shrine",
	"museum",
	"viewpoint",
	"nature",
] as const;

export function bigTrip(days = 35, perDay = 8) {
	const places = Array.from({ length: 125 }, (_, i) => ({
		key: `p${i}`,
		parent: AREAS[i % AREAS.length] as string,
		type: "place" as const,
		name: `Place ${i + 1}`,
		at: [35 + (i % 10) * 0.01, 139 + (i % 7) * 0.01] as [number, number],
		category: CATS[i % CATS.length] as (typeof CATS)[number],
	}));
	let p = 0;
	const dayList = Array.from({ length: days }, (_, d) => ({
		k: `d${d + 1}`,
		night: `p${(d * 3) % 125}`,
		items: Array.from({ length: perDay }, (_, j) => {
			if (j === 3) return { k: `d${d}i${j}`, title: "Lunch", min: 60 };
			const node = `p${p++ % 125}`;
			return {
				k: `d${d}i${j}`,
				node,
				min: 45 + ((d + j) % 4) * 15,
				...(j === 5 && d % 2 === 0 ? { pin: "15:30" } : {}),
			};
		}),
	}));
	// Legs join consecutive located stops (Lunch is a block; travel skips it).
	const legs = dayList.flatMap((d, di) => {
		const located = d.items.filter((it) => "node" in it);
		return located.slice(1).map((it, j) => ({
			from: located[j]?.k as string,
			to: it.k,
			mode:
				(di + j) % 5 === 0
					? null
					: (di + j) % 3 === 0
						? ("transit" as const)
						: ("walk" as const),
			min: 5 + ((di + j) % 6) * 5,
		}));
	});
	const s = scenario({
		nodes: places,
		days: dayList,
		unscheduled: Array.from({ length: 8 }, (_, i) => ({
			k: `u${i}`,
			node: `p${(i * 11) % 125}`,
		})),
		legs,
	});
	const members = s.graph.members.map((m) => m.id);
	s.graph.items = s.graph.items.map((it, i) => ({
		...it,
		note: i % 3 === 0 ? `Remember **item ${i}** — tickets at the gate.` : null,
		assigneeIds: i % 4 === 0 ? members : [],
	}));
	const full: Counts = {
		media: 2,
		links: 1,
		docs: 1,
		todoOpen: 1,
		todo: 2,
		shopOpen: 1,
		shop: 1,
		hasNote: true,
	};
	const counts: TripCounts = {
		root: full,
		byNode: Object.fromEntries(s.graph.nodes.map((n) => [n.id, full])),
		byItem: Object.fromEntries(s.graph.items.map((i) => [i.id, full])),
		byLeg: {},
		byDay: {},
	};
	return { ...s, counts };
}

/**
 * "Where things stand" (standing.ts): each line's words and done state, the
 * first open line as what's next, people whose ratings are left out, and
 * trips with no dates.
 */
import { describe, expect, it } from "vitest";
import { isRateable } from "@/features/places/lib/rate";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import type { GraphMember, Priority, TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N, scenario } from "@/lib/fixtures/demo";
import {
	citiesDetail,
	joinNames,
	ratingDetail,
	whereThingsStand,
} from "./standing";

const ME = DEMO_MEMBERS.dennis;
const AUDREY = DEMO_MEMBERS.audrey;
const MAYA = "00000000-0000-7000-8000-0000000000a1";

const maya: GraphMember = {
	id: MAYA,
	userId: "user-maya",
	status: "active",
	role: "editor",
	name: "Maya Tester",
	firstName: "Maya",
	color: 2,
};

function stand(graph: TripGraph, bar = 3) {
	const ix = indexGraph(graph);
	return whereThingsStand({
		ix,
		schedule: computeSchedule(ix),
		members: graph.members,
		me: ME,
		bar,
	});
}

/** Rates the first `n` rateable places `p` for `memberId`. */
function rate(
	graph: TripGraph,
	memberId: string,
	n: number,
	p: Priority = "want",
): TripGraph {
	let k = 0;
	return {
		...graph,
		nodes: graph.nodes.map((node) =>
			isRateable(node) && k++ < n
				? { ...node, priorities: { ...node.priorities, [memberId]: p } }
				: node,
		),
	};
}

const rateable = demoGraph.nodes.filter((n) => isRateable(n)).length;
const line = (s: ReturnType<typeof stand>, key: string) =>
	s.lines.find((l) => l.key === key);

describe("whereThingsStand", () => {
	it("the demo trip: places added, nobody rated yet, rating is next", () => {
		const s = stand(demoGraph);
		expect(line(s, "places")).toMatchObject({
			detail: `${rateable} places added`,
			done: true,
		});
		expect(line(s, "rating")).toMatchObject({
			label: "Rating",
			detail: "You and Audrey haven't started.",
			done: false,
		});
		expect(s.next).toBe("rating");
		expect(s.myLeft).toBe(rateable);
		expect(s.lines.map((l) => l.key)).toEqual([
			"places",
			"rating",
			"cities",
			"days",
			"hotels",
		]);
	});

	it("names who is done, who is partway and who hasn't started", () => {
		const g = rate(
			rate(
				{ ...demoGraph, members: [...demoGraph.members, maya] },
				ME,
				rateable,
			),
			MAYA,
			2,
		);
		expect(line(stand(g), "rating")?.detail).toBe(
			`You're done. Maya has ${rateable - 2} left. Audrey hasn't started.`,
		);
		const all = rate(rate(g, AUDREY, rateable), MAYA, rateable);
		expect(line(stand(all), "rating")).toMatchObject({
			detail: "everyone is done",
			done: true,
		});
		expect(stand(all).next).not.toBe("rating");
	});

	it("leaves out people whose ratings aren't counted", () => {
		const g = rate(
			{
				...demoGraph,
				members: demoGraph.members.map((m) =>
					m.id === AUDREY ? { ...m, ratingsCounted: false } : m,
				),
			},
			ME,
			rateable,
		);
		const s = stand(g);
		expect(s.people.map((p) => p.member.id)).toEqual([ME]);
		expect(line(s, "rating")).toMatchObject({
			detail: "you're done",
			done: true,
		});
	});

	it("city days, favourites with a day, and nights without a hotel", () => {
		const { graph } = scenario({
			days: [
				{ night: "tokyo", items: [{ k: "sky", node: "shibuyaSky" }] },
				{ night: "tokyo", items: [] },
				{ night: "kyoto", items: [{ k: "kiyomizu", node: "kiyomizu" }] },
				{ items: [] },
			],
		});
		// Both rate Shibuya Sky and Senso-ji Must; Kiyomizu-dera is on a day
		// (a place on a day counts, like the Places tab's "shortlisted").
		const must = { [ME]: "must", [AUDREY]: "must" } as const;
		const g: TripGraph = {
			...graph,
			nodes: graph.nodes.map((n) =>
				n.id === N.shibuyaSky || n.id === N.sensoji
					? { ...n, priorities: must }
					: n,
			),
		};
		const s = stand(g);
		expect(line(s, "cities")).toMatchObject({
			detail: "Tokyo 2 days · Kyoto 2",
			done: true,
		});
		expect(line(s, "days")).toMatchObject({
			detail: "2 of 3 favourites have a day",
			done: false,
		});
		// Every night is only a town: all three need a hotel.
		expect(line(s, "hotels")).toMatchObject({
			detail: "3 nights still need one",
			done: false,
		});
	});

	it("no city nights yet: not decided; no dates: pick them first", () => {
		const { graph } = scenario({ days: [{ items: [] }, { items: [] }] });
		expect(line(stand(graph), "cities")).toMatchObject({
			detail: "not decided yet",
			done: false,
		});
		const noDays: TripGraph = { ...graph, days: [], items: [] };
		const s = stand(noDays);
		for (const key of ["cities", "days", "hotels"])
			expect(line(s, key)?.detail).toBe("Pick your dates first");
	});

	it("an empty trip starts with adding places", () => {
		const s = stand({ ...demoGraph, nodes: [], items: [], days: [] });
		expect(line(s, "places")).toMatchObject({
			detail: "No places added yet",
			done: false,
		});
		expect(line(s, "rating")?.detail).toBe("nothing to rate yet");
		expect(s.next).toBe("places");
	});
});

describe("the words", () => {
	it("joins names", () => {
		expect(joinNames(["You"])).toBe("You");
		expect(joinNames(["You", "Maya"])).toBe("You and Maya");
		expect(joinNames(["Dennis", "Audrey", "Sam"])).toBe(
			"Dennis, Audrey and Sam",
		);
	});

	it("two people done, two not started", () => {
		const p = (id: string, name: string, rated: number, left: number) => ({
			member: { ...maya, id, name, firstName: name },
			rated,
			left,
		});
		expect(
			ratingDetail(
				[
					p("d", "Dennis", 4, 0),
					p("a", "Audrey", 4, 0),
					p("me", "Me", 0, 4),
					p("m", "Maya", 0, 4),
				],
				"me",
				4,
			),
		).toBe("Dennis and Audrey are done. You and Maya haven't started.");
		expect(
			ratingDetail([p("me", "Me", 1, 3), p("m", "Maya", 2, 2)], "me", 4),
		).toBe("You have 3 left, Maya 2.");
	});

	it("cities in trip order, three at most", () => {
		const rows = [
			{ name: "Kyoto", dayIds: ["c", "d"] },
			{ name: "Tokyo", dayIds: ["a", "b"] },
			{ name: "Osaka", dayIds: ["e"] },
			{ name: "Nara", dayIds: [] },
			{ name: "Seoul", dayIds: ["f"] },
		];
		const at = (id: string) => "abcdef".indexOf(id) + 1;
		expect(citiesDetail(rows.slice(0, 3), at)).toBe(
			"Tokyo 2 days · Kyoto 2 · Osaka 1",
		);
		expect(citiesDetail(rows, at)).toBe("Tokyo 2 days · Kyoto 2 · Osaka 1 · …");
	});
});

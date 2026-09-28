/**
 * "Mark decided" (owner, 2026-09-28): a mark at a place, a city, a country
 * or the trip covers the places inside that were added before it; later
 * finds still ask. Decide's header reads the scope's own mark, or the one
 * above it.
 */
import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { demoGraph, N } from "@/lib/fixtures/demo";
import {
	addedSince,
	coveredBy,
	decidedIds,
	decidedMarkOf,
	hasMarks,
	isDecided,
	marksOver,
	scopeDecision,
	whereName,
} from "../lib/decided";

const T0 = "2026-09-01T10:00:00.000Z";
const T1 = "2026-09-10T10:00:00.000Z";
const T2 = "2026-09-20T10:00:00.000Z";
const T3 = "2026-09-25T10:00:00.000Z";
const NISHIKI = "00000000-0000-7000-8000-00000000fa01";

/** The demo trip, every node added at T0, plus Nishiki Market (Kyoto) added at `nishikiAt`. */
function trip(
	marks: Record<string, string> = {},
	opts: { trip?: string; nishikiAt?: string } = {},
): TripGraph {
	const nishiki: GraphNode = {
		...(demoGraph.nodes.find((n) => n.id === N.kiyomizu) as GraphNode),
		id: NISHIKI,
		name: "Nishiki Market",
		slug: "nishiki-market",
		position: "a0999",
		createdAt: opts.nishikiAt ?? T2,
	};
	return {
		...demoGraph,
		trip: {
			...demoGraph.trip,
			decidedAt: opts.trip ?? null,
			decidedBy: opts.trip ? "user-1" : null,
		},
		nodes: [...demoGraph.nodes, nishiki].map((n) => ({
			...n,
			createdAt: n.createdAt ?? T0,
			decidedAt: marks[n.id] ?? null,
			decidedBy: marks[n.id] ? "user-1" : null,
		})),
	};
}

const node = (g: TripGraph, id: string) =>
	g.nodes.find((n) => n.id === id) as GraphNode;

describe("which places a mark settles", () => {
	it("nothing is decided until someone marks it", () => {
		const g = trip();
		const ix = indexGraph(g);
		expect(hasMarks(ix)).toBe(false);
		expect(isDecided(ix, node(g, N.kiyomizu as string))).toBe(false);
		expect(decidedIds(ix, g.nodes).size).toBe(0);
	});

	it("reaches down from a city to the places added before the mark", () => {
		const g = trip({ [N.kyoto as string]: T3 });
		const ix = indexGraph(g);
		expect(decidedMarkOf(ix, node(g, N.kiyomizu as string))).toMatchObject({
			scopeId: N.kyoto,
			name: "Kyoto",
			at: T3,
			by: "user-1",
		});
		// Nishiki came at T2, before the T3 mark: decided too.
		expect(isDecided(ix, node(g, NISHIKI))).toBe(true);
		// Tokyo isn't inside Kyoto.
		expect(isDecided(ix, node(g, N.sensoji as string))).toBe(false);
	});

	it("a place added after the mark still asks", () => {
		const g = trip({ [N.kyoto as string]: T1 });
		const ix = indexGraph(g);
		expect(isDecided(ix, node(g, N.kiyomizu as string))).toBe(true);
		expect(isDecided(ix, node(g, NISHIKI))).toBe(false);
		expect([...decidedIds(ix, g.nodes)]).not.toContain(NISHIKI);
	});

	it("reaches down from a country, and from the whole trip", () => {
		const japan = trip({ [N.japan as string]: T3 });
		const ix = indexGraph(japan);
		expect(decidedMarkOf(ix, node(japan, N.sensoji as string))?.name).toBe(
			"Japan",
		);
		expect(isDecided(ix, node(japan, N.icn as string))).toBe(false);

		const whole = trip({}, { trip: T1 });
		const wix = indexGraph(whole);
		expect(hasMarks(wix)).toBe(true);
		expect(decidedMarkOf(wix, node(whole, N.icn as string))).toMatchObject({
			scopeId: null,
			name: "the trip",
		});
		expect(isDecided(wix, node(whole, NISHIKI))).toBe(false);
	});

	it("the nearest mark made after the place was added wins", () => {
		// Japan at T1, Kyoto at T3; Nishiki (T2) is settled by Kyoto only.
		const g = trip({ [N.japan as string]: T1, [N.kyoto as string]: T3 });
		const ix = indexGraph(g);
		expect(marksOver(ix, NISHIKI).map((m) => m.name)).toEqual([
			"Kyoto",
			"Japan",
		]);
		expect(decidedMarkOf(ix, node(g, NISHIKI))?.name).toBe("Kyoto");
		expect(decidedMarkOf(ix, node(g, N.kiyomizu as string))?.name).toBe(
			"Kyoto",
		);
		// Senso-ji (T0) is under Japan's mark.
		expect(decidedMarkOf(ix, node(g, N.sensoji as string))?.name).toBe("Japan");
	});

	it("a place can be marked itself", () => {
		const g = trip({ [NISHIKI]: T3 });
		const ix = indexGraph(g);
		expect(decidedMarkOf(ix, node(g, NISHIKI))?.scopeId).toBe(NISHIKI);
		expect(isDecided(ix, node(g, N.kiyomizu as string))).toBe(false);
	});

	it("a place without a known creation time counts as older", () => {
		expect(coveredBy({ at: T1 }, undefined)).toBe(true);
		expect(coveredBy({ at: T1 }, T0)).toBe(true);
		expect(coveredBy({ at: T1 }, T2)).toBe(false);
		expect(coveredBy({ at: T1 }, T1)).toBe(false);
	});
});

describe("Decide's header for a scope", () => {
	it("offers the mark, named for the scope", () => {
		const ix = indexGraph(trip());
		const kyoto = ix.node(N.kyoto) as GraphNode;
		expect(scopeDecision(ix, kyoto)).toEqual({
			kind: "open",
			label: "Mark Kyoto decided",
		});
		expect(scopeDecision(ix, null)).toEqual({
			kind: "open",
			label: "Mark the trip decided",
		});
		expect(whereName(null)).toBe("the trip");
	});

	it("a marked scope is decided; inside it, decided with it", () => {
		const ix = indexGraph(trip({ [N.japan as string]: T3 }));
		const japan = ix.node(N.japan) as GraphNode;
		const kyoto = ix.node(N.kyoto) as GraphNode;
		expect(scopeDecision(ix, japan)).toMatchObject({
			kind: "decided",
			mark: { scopeId: N.japan, at: T3 },
			remark: "Mark them decided",
		});
		// Places added since re-mark the one mark, Japan's.
		expect(scopeDecision(ix, kyoto)).toMatchObject({
			kind: "inherited",
			label: "Decided with Japan",
			mark: { scopeId: N.japan },
			remark: "Mark Japan's new places decided",
		});
		// Outside Japan, nothing changes.
		expect(scopeDecision(ix, ix.node(N.seoul) as GraphNode).kind).toBe("open");
	});

	it("its own mark wins over one above; the trip's mark reads 'with the trip'", () => {
		const both = indexGraph(
			trip({ [N.japan as string]: T1, [N.kyoto as string]: T3 }),
		);
		expect(scopeDecision(both, both.node(N.kyoto) as GraphNode).kind).toBe(
			"decided",
		);
		const whole = indexGraph(trip({}, { trip: T1 }));
		expect(scopeDecision(whole, null).kind).toBe("decided");
		expect(
			scopeDecision(whole, whole.node(N.tokyo) as GraphNode),
		).toMatchObject({
			kind: "inherited",
			label: "Decided with the trip",
			remark: "Mark the trip's new places decided",
		});
	});

	it("counts the places added since the mark, not the dropped ones", () => {
		expect(
			addedSince([
				{ status: "idea", decided: false },
				{ status: "shortlist", decided: false },
				{ status: "dropped", decided: false },
				{ status: "idea", decided: true },
			]),
		).toBe(2);
		expect(addedSince([])).toBe(0);
	});

	it("re-marking moves the stamp: the places added before now are covered", () => {
		const before = trip({ [N.kyoto as string]: T1 });
		expect(isDecided(indexGraph(before), node(before, NISHIKI))).toBe(false);
		const after = trip({ [N.kyoto as string]: T3 });
		expect(isDecided(indexGraph(after), node(after, NISHIKI))).toBe(true);
	});
});

import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N } from "@/lib/fixtures/demo";
import { EMPTY_FILTER, parseFilter } from "./filter";
import {
	describeFilter,
	groupOf,
	isActiveFilter,
	matchesFilter,
	ratingOf,
	visibleUnderFilter,
} from "./filter-match";

const { dennis: D, audrey: A } = DEMO_MEMBERS;

/** The demo graph with ratings (Audrey is a placeholder in the real import). */
function rated(): TripGraph {
	const ratings: Record<string, GraphNode["priorities"]> = {
		[N.hands as string]: { [D]: "want", [A]: "must" },
		[N.loft as string]: { [D]: "meh" },
		[N.tpe as string]: { [A]: "sure_why_not" },
		[N.kyoto as string]: { [D]: "must" },
	};
	return {
		...demoGraph,
		nodes: demoGraph.nodes.map((n) =>
			ratings[n.id]
				? { ...n, priorities: ratings[n.id] as GraphNode["priorities"] }
				: n,
		),
	};
}

const node = (g: TripGraph, id: string | undefined) =>
	g.nodes.find((n) => n.id === id) as GraphNode;

describe("matchesFilter (ADDENDUM §10 shared filter)", () => {
	const g = rated();
	const ix = indexGraph(g);
	const ctx = { meMemberId: D, scheduled: ix.scheduledNodeIds };

	it("category groups match places only", () => {
		const f = parseFilter("g:shopping");
		expect(groupOf(node(g, N.hands))).toBe("shopping");
		expect(matchesFilter(node(g, N.hands), f, ctx)).toBe(true);
		expect(matchesFilter(node(g, N.shibuyaSky), f, ctx)).toBe(false);
		expect(matchesFilter(node(g, N.tokyo), f, ctx)).toBe(false);
	});

	it("minimum priority reads the max of all members by default", () => {
		const f = parseFilter("p:really_want");
		expect(ratingOf(node(g, N.hands), "max")).toBe("must");
		expect(matchesFilter(node(g, N.hands), f, ctx)).toBe(true);
		expect(matchesFilter(node(g, N.loft), f, ctx)).toBe(false);
		// Unrated never passes a floor ("absent, not 0").
		expect(matchesFilter(node(g, N.itoya), parseFilter("p:nah"), ctx)).toBe(
			false,
		);
	});

	it("minimum priority by one member reads only their rating", () => {
		const f = parseFilter(`p:really_want;by:${D}`);
		expect(matchesFilter(node(g, N.hands), f, ctx)).toBe(false);
		expect(matchesFilter(node(g, N.kyoto), f, ctx)).toBe(true);
	});

	it("unrated by me / by a member", () => {
		expect(matchesFilter(node(g, N.hands), parseFilter("u:me"), ctx)).toBe(
			false,
		);
		expect(matchesFilter(node(g, N.tpe), parseFilter("u:me"), ctx)).toBe(true);
		expect(matchesFilter(node(g, N.loft), parseFilter(`u:${A}`), ctx)).toBe(
			true,
		);
		expect(matchesFilter(node(g, N.hands), parseFilter(`u:${A}`), ctx)).toBe(
			false,
		);
	});

	it("`u:me` means nothing for a link guest (no member id)", () => {
		const guest = { ...ctx, meMemberId: null };
		expect(isActiveFilter(parseFilter("u:me"), null)).toBe(false);
		expect(matchesFilter(node(g, N.hands), parseFilter("u:me"), guest)).toBe(
			true,
		);
	});

	it("not scheduled drops places (and cities) on the plan", () => {
		const f = parseFilter("ns");
		expect(matchesFilter(node(g, N.hands), f, ctx)).toBe(false);
		expect(matchesFilter(node(g, N.tpe), f, ctx)).toBe(true);
		expect(matchesFilter(node(g, N.tokyo), f, ctx)).toBe(false);
	});

	it("criteria combine with AND", () => {
		const f = parseFilter("g:shopping;p:want");
		expect(matchesFilter(node(g, N.hands), f, ctx)).toBe(true);
		expect(matchesFilter(node(g, N.loft), f, ctx)).toBe(false);
	});

	it("the visible set is the matches plus their ancestors; inactive is null", () => {
		expect(visibleUnderFilter(ix, EMPTY_FILTER, ctx)).toBeNull();
		const v = visibleUnderFilter(ix, parseFilter("g:shopping"), ctx);
		expect(v?.matched.has(N.hands as string)).toBe(true);
		expect(v?.visible.has(N.shibuya as string)).toBe(true);
		expect(v?.visible.has(N.japan as string)).toBe(true);
		expect(v?.visible.has(N.kyoto as string)).toBe(false);
	});

	it("describes itself in one quiet line", () => {
		expect(
			describeFilter(EMPTY_FILTER, { meMemberId: D, members: g.members }),
		).toBeNull();
		const text = describeFilter(parseFilter("g:shopping,bar;p:want;u:me;ns"), {
			meMemberId: D,
			members: g.members,
		});
		expect(text).toBe(
			"Bar, Shopping · Want or higher · Unrated by me · Not scheduled",
		);
	});
});

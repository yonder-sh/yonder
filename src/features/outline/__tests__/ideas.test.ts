import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import type { TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N, scenario } from "@/lib/fixtures/demo";
import { EMPTY_FILTER, parseFilter } from "@/lib/workspace/filter";
import { ghostNodes, originsByParent } from "../ghosts";
import { ideasFor, sortIdeas } from "../ideas";

const { dennis: D, audrey: A } = DEMO_MEMBERS;

function graphWithIdeas(): TripGraph {
	const extra = ["Omoide Yokocho", "Golden Gai", "Ameyoko"].map((name, i) => ({
		...(demoGraph.nodes.find(
			(n) => n.id === N.itoya,
		) as TripGraph["nodes"][number]),
		id: `00000000-0000-7000-8000-00000000f00${i}`,
		name,
		slug: name.toLowerCase().replace(/\s+/g, "-"),
		position: `z${i}`,
		priorities: {},
	}));
	const [omoide, goldenGai, ameyoko] = extra as [
		(typeof extra)[number],
		(typeof extra)[number],
		(typeof extra)[number],
	];
	omoide.priorities = { [D]: "want", [A]: "want" };
	goldenGai.priorities = { [D]: "must" };
	ameyoko.priorities = { [A]: "want" };
	return { ...demoGraph, nodes: [...demoGraph.nodes, ...extra] };
}

describe("Ideas (DESIGN §4.2, SPEC §7.3)", () => {
	const g = graphWithIdeas();
	const ix = indexGraph(g);
	const ctx = { meMemberId: D, scheduled: ix.scheduledNodeIds };

	it("lists unscheduled live places in the scope, by max then sum then name", () => {
		const { ideas, total } = ideasFor({
			ix,
			scopeId: N.tokyo as string,
			filter: EMPTY_FILTER,
			ctx,
			sort: "priority",
		});
		expect(total).toBe(3);
		expect(ideas.map((e) => e.node.name)).toEqual([
			"Golden Gai", // must
			"Omoide Yokocho", // want + want
			"Ameyoko", // want
		]);
	});

	it("the root scope includes every unscheduled place (airports too)", () => {
		const { ideas } = ideasFor({
			ix,
			scopeId: null,
			filter: EMPTY_FILTER,
			ctx,
			sort: "name",
		});
		expect(ideas.map((e) => e.node.name)).toContain("Taoyuan (TPE)");
		expect(ideas.map((e) => e.node.name)).not.toContain("Hands Shibuya");
	});

	it("applies the shared filter", () => {
		const { ideas, total } = ideasFor({
			ix,
			scopeId: N.tokyo as string,
			filter: parseFilter("u:me"),
			ctx,
			sort: "priority",
		});
		expect(total).toBe(3);
		expect(ideas.map((e) => e.node.name)).toEqual(["Ameyoko"]);
	});

	it("sorts by name and by most recently added (UUIDv7 ids)", () => {
		const list = ideasFor({
			ix,
			scopeId: N.tokyo as string,
			filter: EMPTY_FILTER,
			ctx,
			sort: "name",
		}).ideas;
		expect(list.map((e) => e.node.name)).toEqual([
			"Ameyoko",
			"Golden Gai",
			"Omoide Yokocho",
		]);
		expect(sortIdeas(list, "recent").map((e) => e.node.name)).toEqual([
			"Ameyoko",
			"Golden Gai",
			"Omoide Yokocho",
		]);
	});

	it("proposed places (E7) sort in as ghosts", () => {
		const ghosts = ghostNodes(ix, scenario.proposals);
		expect(ghosts.map((x) => x.node.name)).toEqual(["Nishiki Market"]);
		const { ideas } = ideasFor({
			ix,
			scopeId: N.kyoto as string,
			filter: EMPTY_FILTER,
			ctx,
			sort: "priority",
			ghosts,
		});
		expect(ideas).toHaveLength(1);
		expect(ideas[0]?.proposalId).toBeTruthy();
	});
});

describe("E7 marks for the Outline", () => {
	it("a ghost disappears once the node is really in the graph", () => {
		const ix = indexGraph(demoGraph);
		const ghosts = ghostNodes(ix, scenario.proposals);
		const created = ghosts[0]?.node;
		expect(created).toBeDefined();
		const withIt = indexGraph({
			...demoGraph,
			nodes: [
				...demoGraph.nodes,
				{
					...(created as NonNullable<typeof created>),
					slug: "nishiki",
					position: "z",
				},
			],
		});
		expect(ghostNodes(withIt, scenario.proposals)).toEqual([]);
	});

	it("closed proposals make no ghosts", () => {
		const ix = indexGraph(demoGraph);
		const closed = scenario.proposals.map((p) => ({
			...p,
			status: "accepted" as const,
		}));
		expect(ghostNodes(ix, closed)).toEqual([]);
	});

	it("groups from:node marks by their old parent", () => {
		const mark = {
			proposalId: "p",
			op: "node.move" as const,
			kind: "move" as const,
			author: { userId: null, memberId: null, name: "Maya", color: 2 },
		};
		const m = originsByParent(
			new Map([
				[`from:node:${N.tokyo}` as const, [mark]],
				[`node:${N.itoya}` as const, [mark]],
			]),
		);
		expect([...m.keys()]).toEqual([N.tokyo]);
	});
});

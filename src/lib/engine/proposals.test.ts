import { describe, expect, it } from "vitest";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { demo, demoGraph, N, scenario } from "./__fixtures__/demo";
import { indexGraph } from "./graph-index";
import { applyProposals, keyBetween, markKeyOf, markKindOf } from "./proposals";

/** A minimal open proposal for the reducer tests. */
function prop(
	n: number,
	p: Pick<ProposalDto, "op" | "entityKind" | "entityId" | "payload"> &
		Partial<ProposalDto>,
): ProposalDto {
	const at = new Date(Date.UTC(2026, 8, 22, 10, n)).toISOString();
	return {
		id: `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`,
		tripId: demoGraph.trip.id,
		createdIds: [],
		requires: [],
		summary: "s",
		message: null,
		status: "open",
		author: {
			userId: "u-sue",
			memberId: null,
			name: "Sue",
			color: 1,
			isGuest: false,
		},
		fields: [],
		before: {},
		reviewedBy: null,
		reviewedAt: null,
		reviewNote: null,
		lastError: null,
		dependants: [],
		createdAt: at,
		updatedAt: at,
		...p,
	};
}

describe("applyProposals (EXTENSIONS §3.6)", () => {
	const open = scenario.proposals;

	it("never mutates the input; nothing to simulate returns the same graph", () => {
		const before = JSON.stringify(demoGraph);
		const { graph } = applyProposals(demoGraph, open);
		expect(graph).not.toBe(demoGraph);
		expect(JSON.stringify(demoGraph)).toBe(before);
		const markOnly = open.filter((p) => p.op === "trip.shift");
		expect(applyProposals(demoGraph, markOnly).graph).toBe(demoGraph);
		expect(applyProposals(demoGraph, []).graph).toBe(demoGraph);
	});

	it("marks creates, moves, deletes and trip ops on their entity", () => {
		const { marks } = applyProposals(demoGraph, open);
		const itoya = marks.get(`item:${demo.I.itoya}`);
		expect(itoya?.[0]).toMatchObject({
			kind: "move",
			author: { name: "Maya" },
		});
		expect(marks.get(`item:${demo.I.sky}`)?.[0]?.kind).toBe("delete");
		expect(marks.get("trip")?.[0]?.op).toBe("trip.shift");
		const created = open.find((p) => p.op === "node.create");
		expect(marks.get(`node:${created?.entityId}`)?.[0]?.kind).toBe("create");
	});

	it("leaves an origin mark at the old container of a move", () => {
		const { marks } = applyProposals(demoGraph, open);
		const from = marks.get(`from:day:${demo.D.d2}`) ?? [];
		expect(from.some((m) => m.origin?.toLabel === "Day 1")).toBe(true);
	});

	it("the oldest proposal on a field applies; later ones are stacked", () => {
		const { marks } = applyProposals(demoGraph, open);
		const knives = marks.get(`item:${demo.I.knives}`) ?? [];
		expect(knives).toHaveLength(2);
		expect(knives[0]?.stacked).toBeUndefined();
		expect(knives[0]?.author.name).toBe("Maya");
		expect(knives[1]?.stacked).toBe(true);
		expect(knives[1]?.author.name).toBe("Audrey");
		// A stacked move leaves no origin row of its own.
		const origins = (marks.get(`from:day:${demo.D.d2}`) ?? []).filter(
			(m) => m.author.name === "Audrey",
		);
		expect(origins).toEqual([]);
	});

	it("ignores closed proposals and records conflicts", () => {
		const closed = open.map((p) => ({ ...p, status: "accepted" as const }));
		expect(applyProposals(demoGraph, closed).marks.size).toBe(0);
		const [first, ...rest] = open;
		if (!first) throw new Error("fixture");
		const conflicted = [
			{ ...first, lastError: { reason: "gone" as const, message: "gone" } },
			...rest,
		];
		const r = applyProposals(demoGraph, conflicted);
		expect(r.conflicts.get(first.id)?.reason).toBe("gone");
		expect(r.marks.get(markKeyOf(first))?.[0]?.conflict).toBe("gone");
	});

	it("simulates a create under its parent, a move to another day, and keeps a deleted row", () => {
		const { graph } = applyProposals(demoGraph, open);
		const ix = indexGraph(graph);
		const created = open.find((p) => p.op === "node.create");
		const ghost = ix.node(created?.entityId);
		expect(ghost?.name).toBe("Nishiki Market");
		expect(ghost?.parentId).toBe(N.kyoto);
		// Itoya's move (proposal 2) applies; the knives' oldest move (Maya → Day 4) applies,
		// Audrey's stacked one (→ Day 1) doesn't.
		expect(ix.item(demo.I.itoya)?.dayId).toBe(demo.D.d1);
		expect(ix.item(demo.I.knives)?.dayId).toBe(demo.D.d4);
		// A delete keeps the row (it's only marked).
		expect(ix.item(demo.I.sky)).toBeDefined();
	});

	it("skips conflicted proposals", () => {
		const move = open.find((p) => p.op === "item.move");
		if (!move) throw new Error("fixture");
		const r = applyProposals(demoGraph, [
			{ ...move, lastError: { reason: "changed", message: "x" } },
		]);
		expect(r.graph).toBe(demoGraph);
		expect(r.marks.get(markKeyOf(move))?.[0]?.conflict).toBe("changed");
	});

	it("chains a place and an item on it; a create then a move of the same ghost", () => {
		const nodeId = "00000000-0000-4000-8000-00000000a001";
		const itemId = "00000000-0000-4000-8000-00000000a002";
		const r = applyProposals(demoGraph, [
			prop(1, {
				op: "node.create",
				entityKind: "node",
				entityId: nodeId,
				createdIds: [nodeId],
				payload: {
					tripId: demoGraph.trip.id,
					id: nodeId,
					parentId: N.tokyo ?? null,
					type: "place",
					category: "restaurant",
					name: "Ramen Spot",
				},
			}),
			prop(2, {
				op: "item.create",
				entityKind: "item",
				entityId: itemId,
				createdIds: [itemId],
				requires: [],
				payload: {
					tripId: demoGraph.trip.id,
					id: itemId,
					dayId: demo.D.d2 ?? null,
					nodeId,
					afterItemId: demo.I.sensoji ?? "",
				},
			}),
			prop(3, {
				op: "item.move",
				entityKind: "item",
				entityId: itemId,
				fields: ["dayId", "position"],
				payload: { itemId, dayId: demo.D.d3 ?? null },
			}),
		]);
		const ix = indexGraph(r.graph);
		expect(ix.node(nodeId)?.parentId).toBe(N.tokyo);
		expect(ix.item(itemId)).toMatchObject({ nodeId, dayId: demo.D.d3 });
		expect(r.marks.get(`item:${itemId}`)?.map((m) => m.kind)).toEqual([
			"create",
			"move",
		]);
	});

	it("inserts a create after its anchor and patches updates", () => {
		const itemId = "00000000-0000-4000-8000-00000000b001";
		const r = applyProposals(demoGraph, [
			prop(1, {
				op: "item.create",
				entityKind: "item",
				entityId: itemId,
				payload: {
					tripId: demoGraph.trip.id,
					id: itemId,
					dayId: demo.D.d1 ?? null,
					title: "Coffee",
					afterItemId: demo.I.hands ?? "",
				},
			}),
			prop(2, {
				op: "item.update",
				entityKind: "item",
				entityId: demo.I.loft ?? null,
				fields: ["durationMin"],
				payload: { itemId: demo.I.loft ?? "", patch: { durationMin: 90 } },
			}),
		]);
		const day1 = r.graph.items
			.filter((i) => i.dayId === demo.D.d1)
			.sort((a, b) =>
				a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
			)
			.map((i) => i.id);
		expect(day1.indexOf(itemId)).toBe(day1.indexOf(demo.I.hands ?? "") + 1);
		expect(r.graph.items.find((i) => i.id === demo.I.loft)?.durationMin).toBe(
			90,
		);
		// An unknown / mark-only op changes nothing.
		const markOnly = applyProposals(demoGraph, [
			prop(3, {
				op: "list.status",
				entityKind: "list",
				entityId: "00000000-0000-4000-8000-00000000c001",
				payload: { id: "00000000-0000-4000-8000-00000000c001", status: "done" },
			}),
		]);
		expect(markOnly.graph).toBe(demoGraph);
		expect(markOnly.marks.size).toBe(1);
	});

	it("keyBetween orders strictly between its bounds", () => {
		const cases: [string | null, string | null][] = [
			[null, null],
			["a0", null],
			[null, "a0"],
			["a0", "a1"],
			["a0", "a0V"],
			["a0", "a00"],
		];
		for (const [a, b] of cases) {
			const k = keyBetween(a, b);
			if (a !== null) expect(k > a).toBe(true);
			if (b !== null) expect(k < b).toBe(true);
		}
	});

	it("classifies ops by verb", () => {
		expect(markKindOf("item.create")).toBe("create");
		expect(markKindOf("attachment.link")).toBe("create");
		expect(markKindOf("node.move")).toBe("move");
		expect(markKindOf("list.delete")).toBe("delete");
		expect(markKindOf("flight.save")).toBe("update");
		expect(markKindOf("trip.shift")).toBe("other");
	});
});

describe("applyProposals: checkpoint amendments", () => {
	it("a move out of the top level leaves a `from:node:root` origin row", () => {
		const japan = N.japan as string;
		const korea = demoGraph.nodes.find(
			(n) => n.parentId === null && n.id !== japan,
		)?.id as string;
		const { marks } = applyProposals(demoGraph, [
			prop(1, {
				op: "node.move",
				entityKind: "node",
				entityId: japan,
				payload: { nodeId: japan, parentId: korea },
			}),
		]);
		expect(marks.get("from:node:root")?.[0]?.origin).toMatchObject({
			entity: `node:${japan}`,
		});
	});

	it("note additions hang on `note:<target>`, never on the trip", () => {
		const { marks } = applyProposals(demoGraph, [
			prop(2, {
				op: "note.append",
				entityKind: "note",
				entityId: "node:x",
				payload: { markdown: "hi" },
			}),
		]);
		expect(marks.get("trip")).toBeUndefined();
		expect(marks.get("note:node:x")?.[0]?.op).toBe("note.append");
	});

	it("node.update merges details and a null deletes the key; items get fixedDate", () => {
		const tokyo = N.tokyo as string;
		const item = demoGraph.items[0]?.id as string;
		const { graph } = applyProposals(
			{
				...demoGraph,
				nodes: demoGraph.nodes.map((n) =>
					n.id === tokyo
						? { ...n, details: { plannedDays: 4, website: "https://x.test/" } }
						: n,
				),
			},
			[
				prop(3, {
					op: "node.update",
					entityKind: "node",
					entityId: tokyo,
					payload: { nodeId: tokyo, patch: { details: { plannedDays: null } } },
				}),
				prop(4, {
					op: "item.update",
					entityKind: "item",
					entityId: item,
					payload: { itemId: item, patch: { fixedDate: true } },
				}),
			],
		);
		expect(graph.nodes.find((n) => n.id === tokyo)?.details).toEqual({
			website: "https://x.test/",
		});
		expect(graph.items.find((i) => i.id === item)?.fixedDate).toBe(true);
	});
});

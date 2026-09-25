/**
 * describeProposal and the pure helpers behind the suggestion UI, on the demo
 * fixture and its `scenario.proposals` (a create, a move, a delete, a
 * trip.shift, a guest flight.save and two stacked moves of one item).
 */
import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { demo, demoGraph, N, scenario } from "@/lib/fixtures/demo";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { describeProposal } from "../describe-proposal";
import {
	addDays,
	batches,
	conflictLine,
	dateChangeOf,
	entityLive,
	fieldRows,
	forceable,
	formatValue,
	imperative,
	reviewerFirstNames,
	reviewersLine,
	scopeOf,
	selFor,
	timeAgo,
} from "../proposal-view";

const ix = indexGraph(demoGraph);
const P = scenario.proposals;
const byOp = (op: string, n = 0) => {
	const p = P.filter((x) => x.op === op)[n];
	if (!p) throw new Error(`no ${op}`);
	return p;
};
const with_ = (p: ProposalDto, over: Partial<ProposalDto>): ProposalDto => ({
	...p,
	...over,
});

describe("describeProposal", () => {
	it("names things by their current names, in the imperative", () => {
		expect(describeProposal(byOp("node.create"), ix)).toBe(
			"Add Nishiki Market to Kyoto",
		);
		expect(describeProposal(byOp("item.move"), ix)).toBe(
			"Move Itoya Ginza to Day 1",
		);
		expect(describeProposal(byOp("item.delete"), ix)).toBe(
			"Remove Shibuya Sky from the plan",
		);
		expect(describeProposal(byOp("trip.shift"), ix)).toBe(
			"Shift the trip +1 day (4–8 Oct 2027)",
		);
		expect(describeProposal(byOp("flight.save"), ix)).toBe(
			"Change flight KE724",
		);
		expect(describeProposal(byOp("item.move", 1), ix)).toBe(
			"Move Kama-asa (knives) to Day 4",
		);
		expect(describeProposal(byOp("item.move", 2), ix)).toBe(
			"Move Kama-asa (knives) to Day 1",
		);
	});

	it("follows renames: the live name wins over the summary", () => {
		const g = {
			...demoGraph,
			nodes: demoGraph.nodes.map((n) =>
				n.id === N.itoya ? { ...n, name: "Itoya G.Itoya" } : n,
			),
		};
		expect(describeProposal(byOp("item.move"), indexGraph(g))).toBe(
			"Move Itoya G.Itoya to Day 1",
		);
	});

	it("falls back to the summary when the entity is gone or the op is unknown", () => {
		const gone = with_(byOp("item.move"), {
			entityId: "00000000-0000-7000-8000-00000000dead",
		});
		expect(describeProposal(gone, ix)).toBe("Move Itoya Ginza to Day 1");
		const list = with_(byOp("item.move"), {
			op: "list.create",
			entityKind: "list",
			entityId: null,
			summary: "added a to-do “Book Ghibli”",
			payload: {},
		});
		expect(describeProposal(list, ix)).toBe("Add a to-do “Book Ghibli”");
	});

	it("reads patches, assignees, stays, dates and legs", () => {
		const base = byOp("item.move");
		const itoya = demo.I.itoya ?? "";
		const cases: [Partial<ProposalDto>, string][] = [
			[
				{
					op: "item.update",
					payload: { itemId: itoya, patch: { durationMin: 90 } },
				},
				"Change Itoya Ginza to 1h 30m",
			],
			[
				{
					op: "item.update",
					payload: { itemId: itoya, patch: { pinnedStart: "10:30" } },
				},
				"Start Itoya Ginza at 10:30",
			],
			[
				{
					op: "item.update",
					payload: { itemId: itoya, patch: { pinnedStart: null } },
				},
				"Unpin the time of Itoya Ginza",
			],
			[
				{ op: "item.move", payload: { itemId: itoya, dayId: null } },
				"Move Itoya Ginza to Unscheduled",
			],
			[
				{ op: "item.move", payload: { itemId: itoya, dayId: demo.D.d2 ?? "" } },
				"Reorder Itoya Ginza on Day 2",
			],
			[
				{
					op: "day.stay",
					entityKind: "day",
					entityId: demo.D.d1 ?? null,
					payload: {
						fromDayId: demo.D.d1 ?? "",
						toDayId: demo.D.d2 ?? "",
						nodeId: N.ryokan ?? "",
					},
				},
				"Stay at Kawaguchiko Ryokan on the nights of Day 1–2",
			],
			[
				{
					op: "trip.dates",
					entityKind: "trip",
					entityId: null,
					payload: {
						tripId: demoGraph.trip.id,
						startDate: "2027-10-02",
						endDate: "2027-11-07",
					},
				},
				"Change the trip dates to 2 Oct – 7 Nov 2027",
			],
			[
				{
					op: "leg.set",
					entityKind: "leg",
					entityId: null,
					payload: {
						target: {
							kind: "pair",
							fromItemId: demo.I.hands ?? "",
							toItemId: demo.I.loft ?? "",
						},
						patch: { mode: "walk", durationMin: 4 },
					},
				},
				"Walk: Hands Shibuya → Shibuya Loft · 4m",
			],
			[
				{
					op: "node.update",
					entityKind: "node",
					entityId: N.itoya ?? null,
					payload: { nodeId: N.itoya ?? "", patch: { name: "Itoya" } },
				},
				"Rename Itoya Ginza to Itoya",
			],
			[
				{
					op: "node.priority",
					entityKind: "node",
					entityId: N.itoya ?? null,
					payload: {
						nodeId: N.itoya ?? "",
						memberId: demoGraph.me.memberId ?? "",
						priority: "must",
					},
				},
				"Rate Itoya Ginza: Must",
			],
		];
		for (const [over, text] of cases)
			expect(describeProposal(with_(base, over), ix)).toBe(text);
	});

	it("describes a note addition by where it goes", () => {
		const p = with_(byOp("item.move"), {
			op: "note.append",
			entityKind: "note",
			entityId: N.shibuyaSky ?? null,
			payload: {
				tripId: demoGraph.trip.id,
				target: { kind: "node", nodeId: N.shibuyaSky ?? "" },
				markdown: "- go at sunset",
			},
		});
		expect(describeProposal(p, ix)).toBe("Add to the notes of Shibuya Sky");
	});
});

describe("proposal-view helpers", () => {
	it("imperative() turns summaries into the same voice", () => {
		expect(imperative("moved Itoya to Day 4")).toBe("Move Itoya to Day 4");
		expect(imperative("shifted the trip")).toBe("Shift the trip");
		expect(imperative("something odd")).toBe("Something odd");
		expect(imperative("")).toBe("Change something");
	});

	it("batches by author × 10-minute runs, oldest first", () => {
		const bs = batches(P);
		// Maya 1–4 and 6 (1 min apart), the guest at 5, Audrey at 7.
		expect(bs.map((b) => [b.author.name, b.proposals.length])).toEqual([
			["Maya", 5],
			["Guest Wren", 1],
			["Audrey", 1],
		]);
		const later = with_(byOp("item.delete"), {
			id: "00000000-0000-7000-8000-00000000beef",
			createdAt: "2026-09-22T11:30:00.000Z",
		});
		expect(batches([...P, later]).length).toBe(4);
	});

	it("a create isn't live and Shows its proposal; a move Shows its item", () => {
		expect(entityLive(byOp("node.create"), ix)).toBe(false);
		expect(selFor(byOp("node.create"), ix)).toEqual({
			kind: "proposal",
			id: byOp("node.create").id,
		});
		expect(selFor(byOp("item.move"), ix)).toEqual({
			kind: "item",
			id: demo.I.itoya,
		});
		expect(selFor(byOp("flight.save"), ix)).toEqual({
			kind: "leg",
			target: { kind: "pair", fromItemId: demo.I.kix, toItemId: demo.I.icn },
		});
	});

	it("scopeOf gives the crumb path and the day", () => {
		const s = scopeOf(byOp("item.move"), ix);
		expect(s.nodeIds).toEqual([N.japan, N.tokyo]);
		expect(s.day).toBe("Day 2 · Mon 4 Oct");
		expect(scopeOf(byOp("node.create"), ix).nodeIds).toEqual([
			N.japan,
			N.kyoto,
		]);
	});

	it("fieldRows: before from the DTO, else the live value; after from the payload", () => {
		expect(fieldRows(byOp("item.move"), ix)).toEqual([
			{
				field: "dayId",
				label: "Day",
				before: "Day 2 · Mon 4 Oct",
				after: "Day 1 · Sun 3 Oct",
			},
		]);
		const shift = fieldRows(byOp("trip.shift"), ix);
		expect(shift.map((r) => [r.label, r.before, r.after])).toEqual([
			["Trip starts", "Sun 3 Oct 2027", "Mon 4 Oct 2027"],
			["Trip ends", "Thu 7 Oct 2027", "Fri 8 Oct 2027"],
		]);
		const withBefore = with_(byOp("item.move"), {
			before: { dayId: demo.D.d3 ?? "" },
		});
		expect(fieldRows(withBefore, ix)[0]?.before).toBe("Day 3 · Tue 5 Oct");
		const create = fieldRows(byOp("node.create"), ix);
		expect(create.map((r) => [r.label, r.after])).toEqual([
			["Name", "Nishiki Market"],
			["Type", "Place"],
			["Inside", "Kyoto"],
		]);
	});

	it("formatValue shows taxonomy labels, not raw enum values (COLLAB-7)", () => {
		const create = with_(byOp("node.create"), {
			payload: {
				...byOp("node.create").payload,
				type: "place",
				category: "temple_shrine",
			},
		});
		const rows = fieldRows(create, ix).map((r) => [r.label, r.after]);
		expect(rows).toContainEqual(["Type", "Place"]);
		expect(rows).toContainEqual(["Category", "Temple / Shrine"]);
		expect(formatValue("type", "area", ix)).toBe("Area");
		expect(formatValue("category", "food_drink", ix)).toBe("Food & Drink");
		// Unknown values degrade to readable text instead of snake_case.
		expect(formatValue("category", "night_life", ix)).toBe("Night life");
		expect(formatValue("status", "dropped", ix)).toBe("Dropped");
		expect(formatValue("mode", "transit", ix)).toBe("Transit");
		expect(formatValue("category", null, ix)).toBe("—");
	});

	it("dateChangeOf reads trip.* payloads only", () => {
		expect(dateChangeOf(byOp("trip.shift"))).toEqual({ deltaDays: 1 });
		expect(dateChangeOf(byOp("item.move"))).toBeNull();
		expect(addDays("2027-10-31", 1)).toBe("2027-11-01");
	});

	it("conflict wording and forceability", () => {
		const p = byOp("item.move");
		expect(conflictLine(p, { reason: "gone", message: "" }, ix)).toBe(
			"Itoya Ginza was deleted since.",
		);
		expect(
			conflictLine(
				p,
				{ reason: "changed", message: "Itoya was moved to Day 5 since" },
				ix,
			),
		).toBe("Itoya was moved to Day 5 since.");
		expect(forceable({ reason: "changed", message: "" })).toBe(true);
		expect(forceable({ reason: "gone", message: "" })).toBe(false);
		expect(forceable(null)).toBe(false);
	});

	it("names the reviewers a suggester's changes go to", () => {
		const g = {
			...demoGraph,
			me: { ...demoGraph.me, userId: "user-maya", role: "suggester" as const },
			members: [
				...demoGraph.members,
				{
					id: "m-kai",
					userId: "user-kai",
					status: "active" as const,
					role: "editor" as const,
					name: "Kai Tan",
					color: 4,
				},
			],
		};
		expect(reviewerFirstNames(g)).toEqual(["Dennis", "Kai"]);
		expect(reviewersLine(reviewerFirstNames(g))).toBe(
			"Your changes go to Dennis and Kai for review.",
		);
		expect(reviewersLine([])).toBe(
			"Your changes go to the trip's editors for review.",
		);
	});

	it("timeAgo is short", () => {
		const now = Date.parse("2026-09-22T12:00:00.000Z");
		expect(timeAgo("2026-09-22T11:59:30.000Z", now)).toBe("just now");
		expect(timeAgo("2026-09-22T11:55:00.000Z", now)).toBe("5 min ago");
		expect(timeAgo("2026-09-22T09:00:00.000Z", now)).toBe("3 h ago");
		expect(timeAgo("2026-09-19T12:00:00.000Z", now)).toBe("3 d ago");
	});
});

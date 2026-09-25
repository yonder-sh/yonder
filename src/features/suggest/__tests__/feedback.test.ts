/** Author feedback toasts: only my suggestions, only open → accepted/rejected by someone else. */
import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { demoGraph, scenario } from "@/lib/fixtures/demo";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { feedbackFor } from "../use-author-feedback";

const me = "user-maya";
const graph = {
	...demoGraph,
	me: { ...demoGraph.me, userId: me, role: "suggester" as const },
};
const ix = indexGraph(graph);
const base = scenario.proposals[1] as ProposalDto; // Maya moves Itoya to Day 1
const mine: ProposalDto = { ...base, author: { ...base.author, userId: me } };
const seenOpen = new Map([[mine.id, "open" as const]]);

describe("feedbackFor", () => {
	it("an accept by the owner", () => {
		const list = [
			{ ...mine, status: "accepted" as const, reviewedBy: "user-dennis" },
		];
		expect(feedbackFor(seenOpen, list, graph, ix)).toEqual([
			{
				id: mine.id,
				text: "Dennis accepted your suggestion",
				description: "Move Itoya Ginza to Day 1",
			},
		]);
	});

	it("a reject carries the note", () => {
		const list = [
			{
				...mine,
				status: "rejected" as const,
				reviewedBy: "user-dennis",
				reviewNote: "too far that day",
			},
		];
		expect(feedbackFor(seenOpen, list, graph, ix)[0]?.text).toBe(
			"Dennis rejected your suggestion: “too far that day”",
		);
	});

	it("nothing for others' suggestions, withdrawals, unseen or already-closed ones", () => {
		const other = {
			...base,
			author: { ...base.author, userId: "user-audrey" },
			status: "accepted" as const,
		};
		expect(
			feedbackFor(new Map([[base.id, "open"]]), [other], graph, ix),
		).toEqual([]);
		expect(
			feedbackFor(
				seenOpen,
				[{ ...mine, status: "withdrawn" as const }],
				graph,
				ix,
			),
		).toEqual([]);
		expect(
			feedbackFor(
				new Map(),
				[{ ...mine, status: "accepted" as const }],
				graph,
				ix,
			),
		).toEqual([]);
		expect(
			feedbackFor(
				new Map([[mine.id, "accepted"]]),
				[{ ...mine, status: "accepted" as const }],
				graph,
				ix,
			),
		).toEqual([]);
	});
});

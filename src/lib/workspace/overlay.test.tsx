/**
 * EXTENSIONS §3.6 in the workspace: `ix`, `model` and `schedule` come from
 * the proposal overlay while suggestions are shown (reviewers and proposers
 * only); `graph` stays the server's; viewers never see ghosts.
 */
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demo, demoGraph, scenario } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";

const ghostId = scenario.proposals.find((p) => p.op === "node.create")
	?.entityId as string;

describe("the overlay in the workspace model", () => {
	it("reviewers see ghosts in ix and the schedule; graph stays the server's", () => {
		const { ws } = renderWithWorkspace(<div />, {
			proposals: scenario.proposals,
		});
		expect(ws().ix.node(ghostId)?.name).toBe("Nishiki Market");
		expect(ws().graph.nodes.some((n) => n.id === ghostId)).toBe(false);
		expect(ws().ix.item(demo.I.itoya)?.dayId).toBe(demo.D.d1);
		expect(ws().proposals.count).toBe(scenario.proposals.length);
		act(() => ws().proposals.setShow(false));
		expect(ws().ix.node(ghostId)).toBeUndefined();
		expect(ws().ix.item(demo.I.itoya)?.dayId).toBe(demo.D.d2);
		expect(ws().proposals.marks.size).toBe(0);
	});

	it("viewers get no overlay, no marks and no list", () => {
		const viewer = {
			...demoGraph,
			me: { ...demoGraph.me, role: "viewer" as const },
		};
		const { ws } = renderWithWorkspace(<div />, {
			graph: viewer,
			proposals: scenario.proposals,
		});
		expect(ws().ix.node(ghostId)).toBeUndefined();
		expect(ws().proposals.list).toEqual([]);
		expect(ws().proposals.marks.size).toBe(0);
	});
});

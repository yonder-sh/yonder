/** One Yonder D08: Decide sorts the places into Shortlist, Disagreements and Not going. */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { decideColumn } from "../PlacesDecide";
import { PlacesTab } from "../PlacesTab";
import { PLACES_TAB_TESTID as T } from "../testids";

const calls = vi.hoisted(() => ({ setDecided: [] as unknown[] }));
vi.mock("@/functions/nodes.functions", () => ({
	setDecided: async (opts: { data: unknown }) => {
		calls.setDecided.push(opts.data);
		return { decidedAt: null };
	},
	setNodePriority: async () => ({ ok: true }),
	updateNode: async () => ({ ok: true }),
	createNodePath: async () => ({ ok: true }),
	moveNode: async () => ({ ok: true }),
}));

const row = (r: Partial<{ status: string; split: boolean }>) =>
	({ status: "idea", split: false, ...r }) as Parameters<
		typeof decideColumn
	>[0];

describe("Decide (D08)", () => {
	it("puts a split rating under Disagreements before the shortlist, and dropped ones out", () => {
		expect(
			decideColumn({ ...row({ status: "idea", split: true }), decided: true }),
		).toBeNull();
		expect(
			decideColumn({
				...row({ status: "shortlist", split: true }),
				decided: true,
			}),
		).toBe("shortlist");
		expect(decideColumn(row({ status: "shortlist" }))).toBe("shortlist");
		expect(decideColumn(row({ status: "scheduled" }))).toBe("shortlist");
		expect(decideColumn(row({ status: "shortlist", split: true }))).toBe(
			"talk",
		);
		expect(decideColumn(row({ status: "dropped", split: true }))).toBe("out");
		expect(decideColumn(row({ status: "idea" }))).toBeNull();
	});

	it("shows its three columns from ?pv=decide", () => {
		renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places", pv: "decide" },
		});
		const view = screen.getByTestId(T.decide);
		expect(
			within(view)
				.getAllByTestId(T.decideColumn)
				.map((c) => c.dataset.column),
		).toEqual(["shortlist", "talk", "out"]);
		expect(screen.getByTestId(T.steps)).toHaveAttribute("data-step", "decide");
	});

	it("says who the rest are waiting on", () => {
		const graph = structuredClone(demoGraph);
		const other = graph.members.find((m) => m.id !== graph.me.memberId);
		if (!other) throw new Error("fixture: one member");
		for (const n of graph.nodes) {
			const { [other.id]: _, ...rest } = n.priorities;
			n.priorities = rest;
		}
		renderWithWorkspace(<PlacesTab />, {
			graph,
			search: { tab: "places", pv: "decide" },
		});
		const name = other.firstName ?? other.name.split(/\s+/)[0];
		expect(
			screen
				.getAllByTestId(T.decideWaiting)
				.some((w) =>
					new RegExp(`\\d+ more (is|are) waiting on ${name}'s rating`).test(
						w.textContent ?? "",
					),
				),
		).toBe(true);
	});
});

/** The demo trip with marks (ISO) on nodes, by id. */
function marked(marks: Record<string, string>): TripGraph {
	const g = structuredClone(demoGraph);
	g.nodes = g.nodes.map((n) =>
		marks[n.id]
			? { ...n, decidedAt: marks[n.id], decidedBy: "user-dennis" }
			: n,
	);
	return g;
}

describe("Mark decided (D08)", () => {
	beforeEach(() => {
		calls.setDecided.length = 0;
	});

	it("marks the Where picker's scope: Kyoto, or the trip at the root", async () => {
		renderWithWorkspace(<PlacesTab />, {
			splat: "japan/kyoto",
			search: { tab: "places", pv: "decide" },
		});
		const mark = screen.getByTestId(T.decideMark);
		expect(mark).toHaveTextContent("Mark Kyoto decided");
		expect(mark).toBeEnabled();
		fireEvent.click(mark);
		await waitFor(() =>
			expect(calls.setDecided).toEqual([
				{ tripId: demoGraph.trip.id, nodeId: N.kyoto, decided: true },
			]),
		);
	});

	it("reads 'Mark the trip decided' at the root", () => {
		renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places", pv: "decide" },
		});
		expect(screen.getByTestId(T.decideMark)).toHaveTextContent(
			"Mark the trip decided",
		);
	});

	it("is for editors only: a suggester sees it disabled", () => {
		const graph = structuredClone(demoGraph);
		graph.me = { ...graph.me, role: "suggester" };
		renderWithWorkspace(<PlacesTab />, {
			graph,
			splat: "japan/kyoto",
			search: { tab: "places", pv: "decide" },
		});
		expect(screen.getByTestId(T.decideMark)).toBeDisabled();
	});

	it("a decided scope says so, with Undo", async () => {
		renderWithWorkspace(<PlacesTab />, {
			graph: marked({ [N.kyoto as string]: "2030-01-01T00:00:00.000Z" }),
			splat: "japan/kyoto",
			search: { tab: "places", pv: "decide" },
		});
		expect(screen.queryByTestId(T.decideMark)).toBeNull();
		const line = screen.getByTestId(T.decideDecided);
		expect(line).toHaveTextContent(/^Decided·Undo$/);
		expect(line).toHaveAttribute("title", "Marked decided by Dennis");
		fireEvent.click(within(line).getByTestId(T.decideUndo));
		await waitFor(() =>
			expect(calls.setDecided).toEqual([
				{ tripId: demoGraph.trip.id, nodeId: N.kyoto, decided: false },
			]),
		);
	});

	it("says how many were added since the mark (they still ask)", () => {
		const graph = marked({ [N.kyoto as string]: "2026-09-10T00:00:00.000Z" });
		graph.nodes = graph.nodes.map((n) =>
			n.id === N.kiyomizu ? { ...n, createdAt: "2026-09-20T00:00:00.000Z" } : n,
		);
		renderWithWorkspace(<PlacesTab />, {
			graph,
			splat: "japan/kyoto",
			search: { tab: "places", pv: "decide" },
		});
		expect(screen.getByTestId(T.decideDecided)).toHaveTextContent(
			"Decided· 1 added since·Undo",
		);
	});

	it("inside a decided scope: 'Decided with Japan', which goes there", () => {
		const { ws } = renderWithWorkspace(<PlacesTab />, {
			graph: marked({ [N.japan as string]: "2030-01-01T00:00:00.000Z" }),
			splat: "japan/kyoto",
			search: { tab: "places", pv: "decide" },
		});
		expect(screen.queryByTestId(T.decideMark)).toBeNull();
		const withJapan = screen.getByTestId(T.decideDecidedWith);
		expect(withJapan).toHaveTextContent("Decided with Japan");
		fireEvent.click(withJapan);
		expect(ws().scope?.id).toBe(N.japan);
		expect(ws().search.pv).toBe("decide");
		expect(screen.getByTestId(T.decideDecided)).toBeInTheDocument();
	});

	it("a decided split place leaves Disagreements for a quiet note", () => {
		const graph = marked({ [N.kyoto as string]: "2030-01-01T00:00:00.000Z" });
		const split = {
			[DEMO_MEMBERS.dennis]: "must",
			[DEMO_MEMBERS.audrey]: "nah",
		} as const;
		graph.nodes = graph.nodes.map((n) =>
			n.id === N.kiyomizu || n.id === N.sensoji
				? { ...n, priorities: { ...split } }
				: n,
		);
		renderWithWorkspace(<PlacesTab />, {
			graph,
			search: { tab: "places", pv: "decide" },
		});
		const talk = screen
			.getAllByTestId(T.decideColumn)
			.find((c) => c.dataset.column === "talk") as HTMLElement;
		const names = within(talk)
			.queryAllByTestId(T.decideCard)
			.map((c) => c.dataset.place);
		expect(names).toContain(N.sensoji);
		expect(names).not.toContain(N.kiyomizu);
		expect(within(talk).getByTestId(T.decideSettled)).toHaveTextContent(
			"Split, but decided: Kiyomizu-dera",
		);
		// The step's count: one to talk through, not two.
		const decide = screen
			.getAllByTestId(T.step)
			.find((b) => b.dataset.step === "decide");
		expect(decide).toHaveTextContent("1 to talk");
	});
});

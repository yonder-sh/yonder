/**
 * NodeOverview and the days table on the demo fixture (no server): the place
 * and coarse variants render their facts, and the rating buttons behave.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { DaysPerCityTable } from "../DaysPerCityTable";
import { NodeOverview } from "../NodeOverview";
import { PLACES_TESTID } from "../testids";

const rated: TripGraph = {
	...demoGraph,
	nodes: demoGraph.nodes.map((n) =>
		n.id === N.itoya
			? {
					...n,
					description: "Twelve floors of stationery.",
					priorities: {
						[DEMO_MEMBERS.dennis]: "really_want",
						[DEMO_MEMBERS.audrey]: "must",
					},
					ratingComments: { [DEMO_MEMBERS.audrey]: "Pens for Mom" },
					details: { ...n.details, openHoursText: "10:00–20:00 daily" },
				}
			: n,
	),
};

describe("NodeOverview", () => {
	it("a place shows its description, each member's rating and comment, and where it's scheduled", () => {
		renderWithWorkspace(<NodeOverview nodeId={N.itoya as string} />, {
			graph: rated,
		});
		const o = screen.getByTestId(TESTID.nodeOverview);
		expect(o).toHaveAttribute("data-type", "place");
		expect(
			within(o).getByText("Twelve floors of stationery."),
		).toBeInTheDocument();
		const rows = within(o).getAllByTestId(PLACES_TESTID.priorityRow);
		expect(rows.map((r) => r.getAttribute("data-member"))).toEqual([
			DEMO_MEMBERS.dennis,
			DEMO_MEMBERS.audrey,
		]);
		expect(rows[0]).toHaveTextContent("Really want");
		expect(rows[1]).toHaveTextContent("Must");
		expect(rows[1]).toHaveTextContent("Pens for Mom");
		expect(
			within(o).getAllByTestId(PLACES_TESTID.occurrence)[0],
		).toHaveTextContent("Day 2");
		// WP-Insights' week grid (stub or real) is mounted for the place.
		expect(within(o).getByTestId(TESTID.hoursTable)).toHaveAttribute(
			"data-nodeid",
			N.itoya as string,
		);
		expect(within(o).getByTestId(PLACES_TESTID.openInMaps)).toHaveAttribute(
			"href",
			expect.stringContaining("google.com/maps"),
		);
	});

	it("a city shows its visits, planned days and children, and Zoom in", () => {
		const { ws } = renderWithWorkspace(
			<NodeOverview nodeId={N.tokyo as string} />,
			{
				splat: "japan",
			},
		);
		const o = screen.getByTestId(TESTID.nodeOverview);
		expect(within(o).getByTestId(PLACES_TESTID.visits)).toHaveTextContent(
			"3–4 Oct",
		);
		expect(within(o).getByTestId(PLACES_TESTID.visits)).toHaveTextContent(
			"7 stops",
		);
		expect(within(o).getByTestId(PLACES_TESTID.children)).toHaveTextContent(
			"Asakusa",
		);
		expect(o).toHaveTextContent("7 places");
		expect(o).not.toHaveTextContent("0 ideas");
		expect(within(o).getByTestId(PLACES_TESTID.plannedDays)).toHaveTextContent(
			"planned · 2 scheduled",
		);
		fireEvent.click(within(o).getByTestId(PLACES_TESTID.zoomIn));
		expect(ws().scope?.id).toBe(N.tokyo);
	});

	it("a node that's gone says so", () => {
		renderWithWorkspace(
			<NodeOverview nodeId="00000000-0000-7000-8000-00000000dead" />,
		);
		expect(screen.getByText("This place was removed.")).toBeInTheDocument();
	});
});

describe("DaysPerCityTable", () => {
	it("lists the cities by country with planned and scheduled days", () => {
		const g: TripGraph = {
			...demoGraph,
			nodes: demoGraph.nodes.map((n) =>
				n.id === N.tokyo
					? { ...n, details: { ...n.details, plannedDays: 3 } }
					: n,
			),
		};
		renderWithWorkspace(<DaysPerCityTable />, { graph: g });
		const table = screen.getByTestId(PLACES_TESTID.daysTable);
		const tokyo = within(table)
			.getAllByTestId(PLACES_TESTID.daysRow)
			.find((r) => r.getAttribute("data-node") === N.tokyo);
		expect(
			within(tokyo as HTMLElement).getByTestId(PLACES_TESTID.daysInput),
		).toHaveValue("3");
		expect(tokyo).toHaveTextContent("2");
		// 5 trip days, 3 planned.
		expect(screen.getByTestId(PLACES_TESTID.daysUnallocated)).toHaveTextContent(
			"Unallocated 2 days",
		);
	});
});

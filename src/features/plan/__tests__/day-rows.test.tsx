/** The Plan's list of days: every day keeps its header, visits are labels, empty days one line. */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demoGraph } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { titleBesideCity } from "../DayHeader";
import { PlanTab } from "../PlanTab";
import { PLAN_TESTID } from "../testids";

/** The demo with its second day emptied (its stops off the day). */
function withEmptyDay() {
	const graph = structuredClone(demoGraph);
	const day = graph.days[1];
	if (!day) throw new Error("the demo's second day");
	for (const it of graph.items) if (it.dayId === day.id) it.dayId = null;
	return { graph, day };
}

describe("the Plan's days", () => {
	it("shows every day with its own header under its visit's label at a coarse lens", () => {
		const { graph, day } = withEmptyDay();
		renderWithWorkspace(<PlanTab />, {
			graph,
			search: { tab: "plan", lens: "country" },
		});
		const sections = screen.getAllByTestId(PLAN_TESTID.daySection);
		expect(new Set(sections.map((s) => s.dataset.dayId)).size).toBe(
			graph.days.length,
		);
		const planned = new Set(
			graph.items.flatMap((i) => (i.dayId ? [i.dayId] : [])),
		);
		const headers = screen
			.getAllByTestId(PLAN_TESTID.dayHeader)
			.map((h) => h.dataset.dayId);
		for (const id of planned) expect(headers).toContain(id);
		// The visits are labels, never folds.
		expect(screen.getAllByTestId(PLAN_TESTID.band).length).toBeGreaterThan(0);
		expect(screen.queryByRole("button", { name: /^Collapse / })).toBeNull();
		expect(screen.queryByRole("button", { name: "Collapse all" })).toBeNull();
		// The empty day: one line, no header.
		const line = screen
			.getAllByTestId(PLAN_TESTID.dayEmpty)
			.find((l) => l.dataset.dayId === day.id) as HTMLElement;
		expect(line.textContent).toMatch(/Nothing planned/);
		expect(
			within(line).getByRole("button", { name: "Add to this day" }),
		).toBeTruthy();
		expect(headers).not.toContain(day.id);
	});

	it("the empty day's date selects it, and its full header shows", () => {
		const { graph, day } = withEmptyDay();
		const { ws } = renderWithWorkspace(<PlanTab />, {
			graph,
			search: { tab: "plan", lens: "country" },
		});
		const line = screen
			.getAllByTestId(PLAN_TESTID.dayEmpty)
			.find((l) => l.dataset.dayId === day.id) as HTMLElement;
		fireEvent.click(within(line).getByRole("button", { name: /, Day 2$/ }));
		expect(ws().sel).toEqual({ kind: "day", id: day.id });
		expect(
			screen
				.getAllByTestId(PLAN_TESTID.dayHeader)
				.some((h) => h.dataset.dayId === day.id),
		).toBe(true);
	});

	it("a day in view keeps its full header even when empty", () => {
		const { graph, day } = withEmptyDay();
		renderWithWorkspace(<PlanTab />, {
			graph,
			search: { tab: "plan", lens: "place", days: day.date },
		});
		expect(screen.queryAllByTestId(PLAN_TESTID.dayEmpty)).toHaveLength(0);
		expect(screen.getByText("A free day.")).toBeTruthy();
	});

	it("a day in two countries is drawn once per visit, each with its own anchor", () => {
		renderWithWorkspace(<PlanTab />, {
			search: { tab: "plan", lens: "country" },
		});
		const anchors = screen
			.getAllByTestId(PLAN_TESTID.daySection)
			.map((s) => s.dataset.cursorAnchor ?? "");
		expect(anchors.every((a) => a.startsWith("day:"))).toBe(true);
		expect(new Set(anchors).size).toBe(anchors.length);
	});
});

describe("titleBesideCity", () => {
	it("drops a leading city next to the city, and nothing else", () => {
		expect(titleBesideCity("Tokyo · Nakano + Shinjuku", "Tokyo")).toBe(
			"Nakano + Shinjuku",
		);
		expect(titleBesideCity("Mt. Fuji → Nagoya", "Mt. Fuji")).toBe(
			"Mt. Fuji → Nagoya",
		);
		expect(titleBesideCity("Knives and pens", "Tokyo")).toBe("Knives and pens");
		expect(titleBesideCity(null, "Tokyo")).toBeNull();
	});
});

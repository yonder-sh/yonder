/**
 * The F1u skeleton wiring, on the demo fixture: the functional stubs render
 * real data and drive navigation through `useWorkspace().nav`.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Outline } from "@/features/outline/Outline";
import { PlanTab } from "@/features/plan/PlanTab";
import { N } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { InspectorBody } from "./InspectorBody";

describe("workspace stubs on the fixture", () => {
	it("PlanTab lists the scope's items with times from the schedule", () => {
		renderWithWorkspace(<PlanTab />, { splat: "japan/tokyo" });
		const items = screen.getAllByTestId(TESTID.timelineItem);
		expect(items.length).toBeGreaterThan(3);
		const hands = items.find((el) => el.textContent?.includes("Hands Shibuya"));
		expect(
			hands && within(hands).getByTestId(TESTID.itemStart).textContent,
		).toBe("09:00");
	});

	it("clicking an Outline row selects it; double-click zooms in", () => {
		const { ws } = renderWithWorkspace(<Outline />);
		fireEvent.click(screen.getByText("Tokyo"));
		expect(ws().sel).toEqual({ kind: "node", id: N.tokyo });
		fireEvent.doubleClick(screen.getByText("Tokyo"));
		expect(ws().scope?.id).toBe(N.tokyo);
		expect(ws().sel).toBeNull();
	});

	it("the inspector dispatches on sel", () => {
		renderWithWorkspace(<InspectorBody />, {
			splat: "japan",
			search: { sel: `n.${N.tokyo}` },
		});
		expect(screen.getByTestId(TESTID.nodeOverview)).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Tokyo" })).toBeInTheDocument();
	});
});

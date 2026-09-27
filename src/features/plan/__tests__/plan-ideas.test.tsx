/**
 * The Plan's "Ideas in …" (One Yonder, D03): the Outline's Ideas bin under the
 * days, for the city the first day in view stays in, each idea with + to add
 * it to that day.
 */
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IdeasBin } from "@/features/outline/IdeasBin";
import { OUTLINE_TESTID } from "@/features/outline/testids";
import { indexGraph } from "@/lib/engine/graph-index";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { planIdeasScope } from "../PlanTab";
import { PLAN_TESTID } from "../testids";

const ix = indexGraph(demoGraph);

describe("the Plan's ideas", () => {
	it("follow where the first day in view stays (its city, else its region), else the scope", () => {
		// The ryokan is in Kawaguchiko, in the Mt. Fuji region (no city there).
		const stay = ix.days.find((d) => d.nightNodeId === N.ryokan);
		expect(stay).toBeTruthy();
		const range = { from: stay?.date as string, to: stay?.date as string };
		expect(planIdeasScope(ix, range, N.japan ?? null)).toBe(N.mtFuji);
		expect(planIdeasScope(ix, null, N.tokyo ?? null)).toBe(N.tokyo);
	});

	it("say where they are and offer + on each", () => {
		renderWithWorkspace(<IdeasBin plan scopeId={N.kyoto ?? null} />, {
			splat: "japan",
		});
		const block = screen.getByTestId(PLAN_TESTID.ideas);
		expect(block).toHaveTextContent("Ideas in Kyoto");
		const rows = within(block).queryAllByTestId(OUTLINE_TESTID.ideaRow);
		expect(within(block).queryAllByTestId(OUTLINE_TESTID.ideaAdd)).toHaveLength(
			rows.filter((r) => !r.hasAttribute("data-ghost")).length,
		);
	});
});

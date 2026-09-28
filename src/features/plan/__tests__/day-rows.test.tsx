/** One Yonder D02: without a day in view the Plan lists its days as rows. */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demoGraph } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { titleBesideCity } from "../DayHeader";
import { PlanTab } from "../PlanTab";
import { PLAN_TESTID } from "../testids";

describe("the Plan's days (D02)", () => {
	it("lists every day as a row at a coarse lens; a row opens its day", () => {
		const { ws } = renderWithWorkspace(<PlanTab />, {
			search: { tab: "plan", lens: "country" },
		});
		const rows = screen.getAllByTestId(PLAN_TESTID.dayRow);
		// Every day, once per country it's in (a flight day is in two).
		expect(new Set(rows.map((r) => r.dataset.dayId)).size).toBe(
			demoGraph.days.length,
		);
		expect(screen.queryAllByTestId(PLAN_TESTID.dayHeader)).toHaveLength(0);
		expect(screen.getByTestId(PLAN_TESTID.planMeta).textContent).toMatch(
			new RegExp(`^${demoGraph.days.length} days · `),
		);
		const first = rows[0] as HTMLElement;
		fireEvent.click(
			within(first).getByRole("button", { name: /open the day/ }),
		);
		const date = demoGraph.days[0]?.date as string;
		expect(ws().days).toEqual({ from: date, to: date });
	});

	it("the place lens keeps the timelines", () => {
		renderWithWorkspace(<PlanTab />, { search: { lens: "place" } });
		expect(screen.queryAllByTestId(PLAN_TESTID.dayRow)).toHaveLength(0);
		expect(screen.getAllByTestId(PLAN_TESTID.dayHeader).length).toBeGreaterThan(
			0,
		);
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

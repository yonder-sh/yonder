/** One Yonder D04: Fill a day lists the day's ideas with + and "On <day>". */
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demoGraph } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { FillDay } from "../FillDay";
import { PLAN_TESTID } from "../testids";

describe("Fill a day (D04)", () => {
	it("lists the places where the day sleeps: those on it say so, the others have +", () => {
		const day = demoGraph.days[1];
		if (!day) throw new Error("fixture: no day 2");
		renderWithWorkspace(<FillDay />, {
			search: { tab: "plan", days: day.date, fill: 1 },
		});
		const view = screen.getByTestId(PLAN_TESTID.fillDay);
		expect(view).toHaveTextContent(/^Ideas in /);
		const ideas = within(view).queryAllByTestId(PLAN_TESTID.fillIdea);
		for (const idea of ideas) {
			const on = within(idea).queryByText(/^On /);
			const add = within(idea).queryByTestId(PLAN_TESTID.fillAdd);
			// One or the other: already on the day, or one click to add.
			expect(!!on !== !!add).toBe(true);
		}
		expect(
			within(view).getByRole("button", { name: /Show map/ }),
		).toBeInTheDocument();
	});
});

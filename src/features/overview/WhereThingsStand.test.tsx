/**
 * "Where things stand" on screen: the five lines, the first open one
 * highlighted with its action, lines that open where they get done, Remind
 * on the rating line, and a read-only list for viewers.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { STANDING_TESTID as S } from "./testids-standing";
import { useStanding } from "./use-standing";
import { WhereThingsStand } from "./WhereThingsStand";

vi.mock("@/features/places/rating.functions", () => ({
	getRateReminders: async () => ({ recent: [], mine: null }),
	remindToRate: async () => ({ at: new Date().toISOString() }),
	setRatingsCounted: async () => ({ ok: true }),
	dismissRateReminder: async () => ({ ok: true }),
}));

function Checklist() {
	return <WhereThingsStand standing={useStanding()} />;
}

const withMaya: TripGraph = {
	...demoGraph,
	members: [
		...demoGraph.members,
		{
			id: "00000000-0000-7000-8000-0000000000a1",
			userId: "user-maya",
			status: "active",
			role: "editor",
			name: "Maya Chen",
			firstName: "Maya",
			color: 2,
		},
	],
};

const lineOf = (key: string) =>
	screen
		.getAllByTestId(S.line)
		.find((l) => l.dataset.key === key) as HTMLElement;

describe("WhereThingsStand", () => {
	it("five lines; rating is next with Rate N places, which opens the Rate step", async () => {
		const user = userEvent.setup();
		const r = renderWithWorkspace(<Checklist />, {
			graph: withMaya,
			mode: "live",
		});
		expect(screen.getAllByTestId(S.line).map((l) => l.dataset.key)).toEqual([
			"places",
			"rating",
			"cities",
			"days",
			"hotels",
		]);
		expect(lineOf("places")).toHaveAttribute("data-done", "true");
		expect(lineOf("rating")).toHaveAttribute("data-next", "true");
		expect(lineOf("rating")).toHaveTextContent(
			"Rating: You, Audrey and Maya haven't started.",
		);
		// Remind Maya (an account), not Audrey (no account) and not you.
		const reminds = within(lineOf("rating")).getAllByTestId("rating-remind");
		expect(reminds.map((b) => b.textContent)).toEqual(["Remind Maya"]);
		const action = within(lineOf("rating")).getByTestId(S.action);
		expect(action).toHaveTextContent(/^Rate \d+ places$/);
		await user.click(action);
		expect(r.ws().tab).toBe("places");
		expect(r.ws().search.pv).toBe("rate");
		// Other lines open where they get done.
		await user.click(
			within(lineOf("hotels")).getAllByRole("button")[0] as HTMLElement,
		);
		expect(r.ws().tab).toBe("plan");
	});

	it("viewers read it: no action, no Remind", () => {
		renderWithWorkspace(<Checklist />, {
			graph: {
				...withMaya,
				me: { ...withMaya.me, role: "viewer" },
				members: withMaya.members.map((m) =>
					m.id === DEMO_MEMBERS.dennis ? { ...m, role: "viewer" as const } : m,
				),
			},
			mode: "live",
		});
		expect(screen.queryByTestId(S.action)).toBeNull();
		expect(screen.queryByTestId("rating-remind")).toBeNull();
		expect(lineOf("rating")).toHaveTextContent(
			"Rating: Audrey and Maya haven't started.",
		);
	});
});

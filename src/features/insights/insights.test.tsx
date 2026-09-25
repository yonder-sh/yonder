import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { demoProposals } from "@/lib/engine/__fixtures__/demo";
import { dateChangeImpact } from "@/lib/engine/date-impact";
import { effectiveHours } from "@/lib/engine/hours";
import type { TripGraph } from "@/lib/engine/types";
import { demo, demoGraph } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { DateImpactList } from "./DateImpactList";
import { DayHoursBadge } from "./DayHoursBadge";
import { DaySun } from "./DaySun";
import { HoursChip } from "./HoursChip";
import { HoursTable } from "./HoursTable";
import { INSIGHTS_TESTID } from "./testids";
import { WhatIfChip } from "./WhatIfChip";

/** The demo graph with Itoya (Mon 4 Oct) closed on Mondays. */
function graph(role: "owner" | "viewer" = "owner"): TripGraph {
	const g = structuredClone(demoGraph);
	const itoya = g.nodes.find((n) => n.id === demo.N.itoya);
	if (itoya) itoya.details = { openHoursText: "10:00–20:00; closed Mon" };
	g.me.role = role;
	return g;
}

afterEach(() => useUi.getState().resetUi());

describe("HoursChip + DayHoursBadge", () => {
	it("shows an amber chip and the day badge; a tap explains and offers the fixes", () => {
		renderWithWorkspace(
			<>
				<HoursChip itemId={demo.I.itoya ?? ""} />
				<DayHoursBadge dayId={demo.D.d2 ?? ""} />
				<HoursChip itemId={demo.I.hands ?? ""} />
			</>,
			{ graph: graph() },
		);
		const chips = screen.getAllByTestId(TESTID.hoursChip);
		expect(chips).toHaveLength(1);
		expect(chips[0]).toHaveTextContent("Closed Mon");
		expect(chips[0]).toHaveAttribute("data-severity", "warn");
		expect(screen.getByTestId(TESTID.dayHoursBadge)).toHaveTextContent(
			"Itoya Ginza closed Mon",
		);
		fireEvent.click(chips[0] as HTMLElement);
		const pop = screen.getByTestId(INSIGHTS_TESTID.hoursPopover);
		expect(
			within(pop).getByText("Itoya Ginza is closed on Mondays."),
		).toBeTruthy();
		const fixes = within(pop).getAllByTestId(INSIGHTS_TESTID.hoursFix);
		expect(fixes.map((f) => f.textContent)).toEqual([
			"Move to Sun 3 Oct",
			"Unschedule",
		]);
		expect(fixes[0]).not.toBeDisabled();
	});

	it("keeps the chips for a viewer but shows no fix and no edit (HRS-08)", () => {
		renderWithWorkspace(<HoursChip itemId={demo.I.itoya ?? ""} />, {
			graph: graph("viewer"),
		});
		fireEvent.click(screen.getByTestId(TESTID.hoursChip));
		const pop = screen.getByTestId(INSIGHTS_TESTID.hoursPopover);
		expect(
			within(pop).getByText("Itoya Ginza is closed on Mondays."),
		).toBeTruthy();
		expect(within(pop).queryAllByTestId(INSIGHTS_TESTID.hoursFix)).toEqual([]);
		expect(
			within(pop).queryByTestId(INSIGHTS_TESTID.hoursEditHours),
		).toBeNull();
	});

	it("an offline editor still sees the fixes and edit, disabled", () => {
		renderWithWorkspace(<HoursChip itemId={demo.I.itoya ?? ""} />, {
			graph: graph(),
			connection: "offline",
		});
		fireEvent.click(screen.getByTestId(TESTID.hoursChip));
		const pop = screen.getByTestId(INSIGHTS_TESTID.hoursPopover);
		const fixes = within(pop).getAllByTestId(INSIGHTS_TESTID.hoursFix);
		expect(fixes.length).toBeGreaterThan(0);
		for (const b of fixes) expect(b).toBeDisabled();
		expect(
			within(pop).getByTestId(INSIGHTS_TESTID.hoursEditHours),
		).toBeDisabled();
	});
});

describe("HoursTable", () => {
	it("a viewer sees the week and the source but no Edit or Confirm (HRS-08, COLLAB-5)", () => {
		renderWithWorkspace(<HoursTable nodeId={demo.N.itoya ?? ""} />, {
			graph: graph("viewer"),
		});
		const table = screen.getByTestId(TESTID.hoursTable);
		expect(table).toHaveAttribute("data-source", "sheet");
		expect(
			within(table).getAllByTestId(INSIGHTS_TESTID.hoursTableRow),
		).toHaveLength(7);
		expect(
			within(table).getByTestId(INSIGHTS_TESTID.hoursSource),
		).toHaveTextContent("closed Mon");
		expect(
			within(table).queryByTestId(INSIGHTS_TESTID.hoursTableEdit),
		).toBeNull();
		expect(
			within(table).queryByTestId(INSIGHTS_TESTID.hoursTableConfirm),
		).toBeNull();
	});

	it("a viewer gets no Add hours on a place without hours", () => {
		renderWithWorkspace(<HoursTable nodeId={demo.N.hands ?? ""} />, {
			graph: graph("viewer"),
		});
		const table = screen.getByTestId(TESTID.hoursTable);
		expect(table).toHaveTextContent("Hours unknown.");
		expect(
			within(table).queryByTestId(INSIGHTS_TESTID.hoursTableAdd),
		).toBeNull();
	});

	it("an editor gets Edit and Confirm; offline they stay, disabled", () => {
		const { unmount } = renderWithWorkspace(
			<HoursTable nodeId={demo.N.itoya ?? ""} />,
			{ graph: graph() },
		);
		expect(
			screen.getByTestId(INSIGHTS_TESTID.hoursTableEdit),
		).not.toBeDisabled();
		expect(
			screen.getByTestId(INSIGHTS_TESTID.hoursTableConfirm),
		).not.toBeDisabled();
		unmount();
		renderWithWorkspace(<HoursTable nodeId={demo.N.itoya ?? ""} />, {
			graph: graph(),
			connection: "offline",
		});
		expect(screen.getByTestId(INSIGHTS_TESTID.hoursTableEdit)).toBeDisabled();
		expect(
			screen.getByTestId(INSIGHTS_TESTID.hoursTableConfirm),
		).toBeDisabled();
	});

	it("shows an open hours suggestion above the week, and opens it", () => {
		const base = demoProposals[1];
		if (!base) throw new Error("no demo proposal");
		const suggestion = {
			...base,
			id: "00000000-0000-7000-8000-00000000abcd",
			op: "node.hours" as const,
			entityKind: "node" as const,
			entityId: demo.N.itoya ?? null,
			summary: "updated hours of Itoya Ginza",
			fields: ["details.openingHours"],
			payload: {
				nodeId: demo.N.itoya ?? "",
				hours: {
					source: "manual",
					periods: [1, 2, 3, 4, 5, 6].map((day) => ({
						day,
						open: "10:00",
						close: "20:00",
					})),
					updatedAt: "2026-09-20T00:00:00.000Z",
				},
			},
		};
		const { ws } = renderWithWorkspace(
			<HoursTable nodeId={demo.N.itoya ?? ""} />,
			{ graph: graph(), proposals: [suggestion] },
		);
		const block = screen.getByTestId(INSIGHTS_TESTID.hoursSuggested);
		expect(block).toHaveTextContent("suggests");
		expect(block).toHaveTextContent("Review");
		const button = within(block).getByRole("button");
		expect(button.getAttribute("aria-description")).toMatch(
			/: Mon–Sat 10:00–20:00 · Closed Sun$/,
		);
		fireEvent.click(button);
		expect(ws().sel).toEqual({ kind: "proposal", id: suggestion.id });
		// The week grid still shows what's stored (the sheet's hours).
		expect(screen.getByTestId(TESTID.hoursTable)).toHaveAttribute(
			"data-source",
			"sheet",
		);
	});
});

describe("HoursTable suggestion preview (COLLAB-R2-08)", () => {
	it("a suggestion that only closes one date names that date, not the unchanged week", () => {
		const base = demoProposals[1];
		if (!base) throw new Error("no demo proposal");
		const g = graph();
		const itoya = g.nodes.find((n) => n.id === demo.N.itoya);
		if (!itoya) throw new Error("no itoya");
		const stored = {
			source: "manual" as const,
			periods: [],
			closedDays: [0],
			updatedAt: "2026-09-01T00:00:00.000Z",
		};
		itoya.details = { openingHours: stored };
		const suggestion = {
			...base,
			id: "00000000-0000-7000-8000-00000000abce",
			op: "node.hours" as const,
			entityKind: "node" as const,
			entityId: demo.N.itoya ?? null,
			summary: "updated hours of Itoya Ginza",
			fields: ["details.openingHours"],
			payload: {
				nodeId: demo.N.itoya ?? "",
				hours: {
					...stored,
					exceptions: [{ date: "2027-10-05", closed: true }],
					updatedAt: "2026-09-20T00:00:00.000Z",
				},
			},
		};
		renderWithWorkspace(<HoursTable nodeId={demo.N.itoya ?? ""} />, {
			graph: g,
			proposals: [suggestion],
		});
		const block = screen.getByTestId(INSIGHTS_TESTID.hoursSuggested);
		expect(
			within(block).getByTestId(INSIGHTS_TESTID.hoursSuggestedChange),
		).toHaveTextContent("Closed Tue 5 Oct 2027");
		// The unchanged "Sun Closed" week isn't repeated as if it were the change.
		expect(block).not.toHaveTextContent("Sun");
		expect(
			within(block).getByRole("button").getAttribute("aria-description"),
		).toMatch(/: Closed Tue 5 Oct 2027$/);
	});
});

describe("DaySun", () => {
	it("reads the day's place and shows sunrise–sunset, or only the sunset when compact", () => {
		const { rerender } = renderWithWorkspace(
			<DaySun dayId={demo.D.d1 ?? ""} />,
			{ graph: graph() },
		);
		expect(screen.getByTestId(TESTID.daySun)).toHaveTextContent(
			/Tokyo05:3\d–17:2\d$/,
		);
		rerender(<DaySun dayId={demo.D.d1 ?? ""} compact />);
		expect(screen.getByTestId(TESTID.daySun)).toHaveTextContent(
			/Sunset 17:2\d$/,
		);
	});
});

describe("WhatIfChip", () => {
	it("shows the draft, reopens the dialog and discards it", () => {
		renderWithWorkspace(<WhatIfChip />, { graph: graph() });
		expect(screen.queryByTestId(TESTID.whatIfChip)).toBeNull();
		act(() => useUi.getState().setDateDraft({ deltaDays: -2 }));
		expect(screen.getByTestId(TESTID.whatIfChip)).toHaveTextContent(
			"What-if −2 days",
		);
		fireEvent.click(screen.getByTestId(INSIGHTS_TESTID.whatIfReview));
		expect(useUi.getState().shiftOpen).toBe(true);
		fireEvent.click(screen.getByTestId(INSIGHTS_TESTID.whatIfClear));
		expect(useUi.getState().dateDraft).toBeNull();
		expect(screen.queryByTestId(TESTID.whatIfChip)).toBeNull();
	});
});

describe("DateImpactList", () => {
	it("renders the sections with counts; a closure row selects its item", () => {
		const g = graph();
		const itoya = g.nodes.find((n) => n.id === demo.N.itoya);
		if (itoya) itoya.details = { openHoursText: "10:00–20:00; closed Tue" };
		const impact = dateChangeImpact(
			g,
			{ deltaDays: 1 },
			{
				hoursOf: (id) => {
					const n = g.nodes.find((x) => x.id === id);
					return n ? effectiveHours(n, g.trip.settings) : null;
				},
				holidays: [],
				today: "2026-09-23",
			},
		);
		let marked = "";
		const { ws } = renderWithWorkspace(
			<DateImpactList impact={impact} onMarkBooked={(id) => (marked = id)} />,
			{
				graph: g,
			},
		);
		const sections = screen
			.getAllByTestId(INSIGHTS_TESTID.impactSection)
			.map((s) => s.getAttribute("data-section"));
		expect(sections).toEqual(["timed", "closures", "stays"]);
		const closures = screen.getAllByTestId(
			INSIGHTS_TESTID.impactSection,
		)[1] as HTMLElement;
		expect(closures).toHaveTextContent("Itoya Ginza");
		expect(closures).toHaveTextContent("Closed Tue");
		fireEvent.click(within(closures).getAllByRole("button")[0] as HTMLElement);
		expect(ws().sel).toEqual({ kind: "item", id: demo.I.itoya });
		fireEvent.click(screen.getByTestId(INSIGHTS_TESTID.markBooked));
		expect(marked).toBe(demo.I.sky);
	});

	it("says so when nothing moves", () => {
		const g = graph();
		const empty = dateChangeImpact(
			g,
			{ deltaDays: 0 },
			{ hoursOf: () => null, holidays: [], today: "2026-09-23" },
		);
		renderWithWorkspace(<DateImpactList impact={empty} />, { graph: g });
		expect(screen.getByTestId(TESTID.dateImpactList)).toHaveTextContent(
			"Nothing booked or timed moves",
		);
	});
});

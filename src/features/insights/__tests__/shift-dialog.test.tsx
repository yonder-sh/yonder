/**
 * ShiftTripDialog's `expectedVersion` (EXTENSIONS §5, QA SHIFT-03, COLLAB-3):
 * it is the version the user reviewed, so someone else's edit that refreshes
 * the graph under the open dialog still ends in CONFLICT and a re-review. The
 * user's own "Mark booked" is not a concurrent change.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TripGraph } from "@/lib/engine/types";
import { AppError } from "@/lib/errors";
import { demo, demoGraph } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import {
	type RenderWorkspaceOptions,
	renderWithWorkspace,
} from "@/test/render-workspace";
import { ShiftTripDialog } from "../ShiftTripDialog";
import { INSIGHTS_TESTID as T } from "../testids";

const fns = vi.hoisted(() => ({
	shiftTripDates: vi.fn(),
	previewTripDates: vi.fn(),
	updateItem: vi.fn(),
}));
vi.mock("@/functions/trips.functions", () => ({
	shiftTripDates: fns.shiftTripDates,
	previewTripDates: fns.previewTripDates,
}));
vi.mock("@/functions/items.functions", () => ({
	updateItem: fns.updateItem,
}));

/** The demo graph at `version`, with Hands pinned at 09:30 (a Timed — check row). */
function graphAt(version: number, patch?: (g: TripGraph) => void): TripGraph {
	const g = structuredClone(demoGraph);
	g.trip.version = version;
	const hands = g.items.find((i) => i.id === demo.I.hands);
	if (hands) hands.pinnedStart = "09:30";
	patch?.(g);
	return g;
}

/** Renders the dialog open; `live(g)` swaps in a newer graph like a live refresh does. */
function openDialog(graph: TripGraph) {
	const opts: RenderWorkspaceOptions = { graph };
	const r = renderWithWorkspace(<ShiftTripDialog />, opts);
	act(() => useUi.getState().openShiftTrip(true));
	const live = (g: TripGraph) => {
		opts.graph = g;
		r.rerender(<ShiftTripDialog />);
	};
	return { ...r, live };
}

const sentVersion = (call: number) =>
	(
		fns.shiftTripDates.mock.calls[call]?.[0] as
			| { data: { expectedVersion?: number } }
			| undefined
	)?.data.expectedVersion;

beforeEach(() => {
	for (const f of Object.values(fns)) f.mockReset();
	fns.previewTripDates.mockResolvedValue({
		removedDays: [],
		affectedItems: [],
	});
});
afterEach(() => useUi.getState().resetUi());

describe("ShiftTripDialog expectedVersion", () => {
	it("someone else's edit, heard live while the dialog is open, still refuses the shift until it's reviewed again (SHIFT-03)", async () => {
		const { live } = openDialog(graphAt(10));
		fireEvent.click(screen.getByTestId(T.shiftPlus));
		expect(screen.getByTestId(T.shiftApply)).toHaveTextContent(
			"Shift by +1 day",
		);

		// Audrey renames Lunch; the live event refreshes this tab's graph.
		live(
			graphAt(11, (g) => {
				const lunch = g.items.find((i) => i.title === "Lunch");
				if (lunch) lunch.title = "Lunch!";
			}),
		);
		fns.shiftTripDates.mockRejectedValueOnce(
			new AppError(
				"CONFLICT",
				"The trip changed while you were looking — review again.",
			),
		);
		fireEvent.click(screen.getByTestId(T.shiftApply));
		expect(await screen.findByTestId(T.shiftConflict)).toBeVisible();
		// It sent the version the user reviewed, not the live one.
		expect(sentVersion(0)).toBe(10);
		expect(screen.getByTestId(TESTID.shiftTripDialog)).toBeVisible();
		expect(useUi.getState().dateDraft).toEqual({ deltaDays: 1 });

		// The notice was the re-review: the next click applies against the new version.
		fns.shiftTripDates.mockResolvedValueOnce({ version: 12 });
		fireEvent.click(screen.getByTestId(T.shiftApply));
		await waitFor(() => expect(fns.shiftTripDates).toHaveBeenCalledTimes(2));
		expect(sentVersion(1)).toBe(11);
		await waitFor(() => expect(useUi.getState().dateDraft).toBeNull());
	});

	it("stepping the delta after a live change is a fresh review (no conflict)", async () => {
		const { live } = openDialog(graphAt(20));
		fireEvent.click(screen.getByTestId(T.shiftPlus));
		live(graphAt(21));
		fireEvent.click(screen.getByTestId(T.shiftPlus));
		fns.shiftTripDates.mockResolvedValueOnce({ version: 22 });
		fireEvent.click(screen.getByTestId(T.shiftApply));
		await waitFor(() => expect(fns.shiftTripDates).toHaveBeenCalledTimes(1));
		expect(sentVersion(0)).toBe(21);
		expect(fns.shiftTripDates.mock.calls[0]?.[0]).toMatchObject({
			data: { deltaDays: 2 },
		});
	});

	it("the user's own Mark booked is not a concurrent change (SHIFT-05 then apply)", async () => {
		const { live } = openDialog(graphAt(30));
		fireEvent.click(screen.getByTestId(T.shiftPlus));
		fns.updateItem.mockResolvedValueOnce({
			updatedAt: "2026-09-23T00:00:00.000Z",
			detachedLegIds: [],
		});
		const mark = screen
			.getAllByTestId(T.markBooked)
			.find((b) =>
				b
					.closest(`[data-testid=${T.impactRow}]`)
					?.textContent?.includes("Hands"),
			);
		if (!mark) throw new Error("no Mark booked on Hands");
		fireEvent.click(mark);
		await waitFor(() => expect(fns.updateItem).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(screen.getByTestId(T.shiftApply)).not.toBeDisabled(),
		);
		// Its own edit comes back in the refetched graph as the next version.
		live(
			graphAt(31, (g) => {
				const hands = g.items.find((i) => i.id === demo.I.hands);
				if (hands) hands.fixedDate = true;
			}),
		);
		fns.shiftTripDates.mockResolvedValueOnce({ version: 32 });
		fireEvent.click(screen.getByTestId(T.shiftApply));
		await waitFor(() => expect(fns.shiftTripDates).toHaveBeenCalledTimes(1));
		expect(sentVersion(0)).toBe(31);
		expect(screen.queryByTestId(T.shiftConflict)).toBeNull();
	});
});

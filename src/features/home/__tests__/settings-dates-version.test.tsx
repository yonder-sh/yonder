/**
 * Trip settings → Dates sends `expectedVersion` = the version its preview was
 * computed at (QA NOTE-VERSION-CONFLICT): the graph's version lags behind
 * changes that don't refetch the graph (a note, a to-do), and sending it
 * refused a date change nothing had touched. A real CONFLICT re-reviews: the
 * preview refetches and the next click sends its version.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TripGraph } from "@/lib/engine/types";
import { AppError } from "@/lib/errors";
import { demoGraph } from "@/lib/fixtures/demo";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { TripSettingsDialog } from "../TripSettingsDialog";
import { HOME_TESTID } from "../testids";

const fns = vi.hoisted(() => ({
	previewTripDates: vi.fn(),
	setTripDates: vi.fn(),
	updateTrip: vi.fn(),
	deleteTrip: vi.fn(),
}));
vi.mock("@/functions/trips.functions", () => fns);
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => vi.fn(),
}));
// Only the dates row is under test: the rest of the dialog stays quiet.
vi.mock("@/features/insights/HolidaysEditor", () => ({
	HolidaysEditor: () => null,
}));
vi.mock("@/features/money/queries", () => ({
	tripMoneyQuery: (tripId: string) => ({
		queryKey: ["trip", tripId, "money"],
		queryFn: async () => ({ expenses: [] }),
	}),
}));
vi.mock("../sharing.functions", () => ({ leaveTrip: vi.fn() }));
vi.mock("../DuplicateTripDialog", () => ({ DuplicateTripDialog: () => null }));
// The calendar popover is not what this tests: one click picks a new range.
vi.mock("../date-fields", () => ({
	DateRangeField: ({
		testId,
		onChange,
	}: {
		testId?: string;
		onChange: (from: string | null, to: string | null) => void;
	}) => (
		<button
			type="button"
			data-testid={testId}
			onClick={() => onChange("2031-01-01", "2031-01-09")}
		>
			dates
		</button>
	),
}));

const graphAt = (version: number): TripGraph => {
	const g = structuredClone(demoGraph);
	g.trip.version = version;
	return g;
};

const preview = (version: number) => ({
	removedDays: [],
	affectedItems: [],
	version,
});

const sentVersion = (call: number) =>
	(
		fns.setTripDates.mock.calls[call]?.[0] as
			| { data: { expectedVersion?: number } }
			| undefined
	)?.data.expectedVersion;

function open(graph: TripGraph) {
	renderWithWorkspace(<TripSettingsDialog />, { graph, mode: "live" });
	act(() => useUi.getState().setSettingsOpen(true));
	fireEvent.click(screen.getByTestId(HOME_TESTID.settingsDates));
}

beforeEach(() => {
	for (const f of Object.values(fns)) f.mockReset();
});
afterEach(() => useUi.getState().resetUi());

describe("Trip settings → Change dates expectedVersion", () => {
	it("sends the preview's version, not a graph that missed a note or to-do (QA NOTE-VERSION-CONFLICT)", async () => {
		// The graph was loaded at 10; notes and to-dos since then never refetched it.
		fns.previewTripDates.mockResolvedValue(preview(12));
		fns.setTripDates.mockResolvedValue({ ok: true, version: 13 });
		open(graphAt(10));
		const apply = screen.getByTestId(HOME_TESTID.datesConfirm);
		await waitFor(() => expect(apply).not.toBeDisabled());
		fireEvent.click(apply);
		await waitFor(() => expect(fns.setTripDates).toHaveBeenCalledTimes(1));
		expect(sentVersion(0)).toBe(12);
	});

	it("a CONFLICT re-reviews: the preview refetches and the next click sends its version", async () => {
		fns.previewTripDates
			.mockResolvedValueOnce(preview(12))
			.mockResolvedValue(preview(14));
		fns.setTripDates
			.mockRejectedValueOnce(
				new AppError(
					"CONFLICT",
					"The trip changed while you were looking — review again.",
				),
			)
			.mockResolvedValue({ ok: true, version: 15 });
		open(graphAt(10));
		const apply = screen.getByTestId(HOME_TESTID.datesConfirm);
		await waitFor(() => expect(apply).not.toBeDisabled());
		fireEvent.click(apply);
		await waitFor(() => expect(fns.previewTripDates).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(apply).not.toBeDisabled());
		fireEvent.click(apply);
		await waitFor(() => expect(fns.setTripDates).toHaveBeenCalledTimes(2));
		expect(sentVersion(0)).toBe(12);
		expect(sentVersion(1)).toBe(14);
	});
});

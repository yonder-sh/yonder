/**
 * One dialog anatomy (One Yonder, phase 4): a form dialog's footer is
 * "Cancel" (ghost) and then its primary action, last on the right. Cancel
 * closes without saving.
 */
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { NewTripDialog } from "../NewTripDialog";
import { TripSettingsDialog } from "../TripSettingsDialog";

const fns = vi.hoisted(() => ({
	createTrip: vi.fn(),
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
vi.mock("@/features/money/queries", () => ({
	tripMoneyQuery: (tripId: string) => ({
		queryKey: ["trip", tripId, "money"],
		queryFn: async () => ({ expenses: [] }),
	}),
}));
vi.mock("../sharing.functions", () => ({ leaveTrip: vi.fn() }));
vi.mock("../DuplicateTripDialog", () => ({ DuplicateTripDialog: () => null }));

afterEach(() => useUi.getState().resetUi());

/** The footer's buttons, in order. */
function footer(dialog: HTMLElement): (string | undefined)[] {
	const el = dialog.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
	if (!el) throw new Error("no footer");
	return within(el)
		.getAllByRole("button")
		.map((b) => b.textContent?.trim());
}

describe("dialog anatomy: Cancel, then the primary action last", () => {
	it("New trip: Cancel closes without creating a trip", async () => {
		renderWithWorkspace(<NewTripDialog />);
		fireEvent.click(screen.getByTestId(TESTID.newTripButton));
		const dialog = screen.getByTestId(TESTID.newTripDialog);
		expect(footer(dialog)).toEqual(["Cancel", "Create trip"]);
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByTestId(TESTID.newTripDialog)).toBeNull(),
		);
		expect(fns.createTrip).not.toHaveBeenCalled();
	});

	it("Trip settings: Cancel closes without saving", () => {
		renderWithWorkspace(<TripSettingsDialog />, { mode: "live" });
		act(() => useUi.getState().setSettingsOpen(true));
		const dialog = screen.getByTestId(TESTID.tripSettingsDialog);
		expect(footer(dialog)).toEqual(["Cancel", "Save"]);
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(useUi.getState().settingsOpen).toBe(false);
		expect(fns.updateTrip).not.toHaveBeenCalled();
	});
});

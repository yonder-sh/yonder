/**
 * QA EMPTY-01/02: a new trip opens on its Plan, whose own card asks "What do
 * you want to see?"; no palette opens over that same question.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { NewTripDialog } from "../NewTripDialog";

const fns = vi.hoisted(() => ({
	createTrip: vi.fn(async () => ({ tripId: "t-new", slug: "japan-k7m2qxw9" })),
	navigate: vi.fn(async () => {}),
}));
vi.mock("@/functions/trips.functions", () => ({ createTrip: fns.createTrip }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => fns.navigate,
}));

afterEach(() => useUi.getState().resetUi());

describe("New trip", () => {
	it("goes to the new trip's Plan without opening the palette", async () => {
		renderWithWorkspace(<NewTripDialog />);
		fireEvent.click(screen.getByTestId(TESTID.newTripButton));
		fireEvent.change(screen.getByTestId(TESTID.newTripName), {
			target: { value: "Japan" },
		});
		fireEvent.click(screen.getByTestId(TESTID.newTripSubmit));
		await waitFor(() =>
			expect(fns.navigate).toHaveBeenCalledWith({
				to: "/t/$trip",
				params: { trip: "japan-k7m2qxw9" },
				search: { tab: "plan" },
			}),
		);
		expect(useUi.getState().addPlace).toBeNull();
	});
});

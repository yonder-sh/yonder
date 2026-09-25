/**
 * NEW-V52-01: a holiday filled in in Trip settings is never lost. Before, the
 * dialog's own "Save" wrote the other settings and closed the dialog, and the
 * new holiday (saved only by the small "Save holidays" button) was dropped
 * without a word. Now the dialog holds the holiday draft: Save writes it with
 * the rest, a half-filled one keeps the dialog open with the reason, and a
 * change to the trip from elsewhere doesn't wipe it (or a name being typed).
 */
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TripGraph } from "@/lib/engine/types";
import { demoGraph } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { INSIGHTS_TESTID as T } from "../../insights/testids";
import { TripSettingsDialog } from "../TripSettingsDialog";
import { HOME_TESTID } from "../testids";

const fns = vi.hoisted(() => ({
	previewTripDates: vi.fn(),
	setTripDates: vi.fn(),
	updateTrip: vi.fn(),
	deleteTrip: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/functions/trips.functions", () => fns);
vi.mock("sonner", async (orig) => {
	const real = await orig<typeof import("sonner")>();
	const toast = Object.assign((...a: unknown[]) => a, real.toast, {
		error: toasts.error,
		success: vi.fn(),
	});
	return { ...real, toast };
});
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
// The holiday's calendar popover isn't what's tested: one click picks 4 Oct.
vi.mock("@/features/insights/ui", async (orig) => ({
	...(await orig<typeof import("@/features/insights/ui")>()),
	DateField: ({
		label,
		value,
		onChange,
	}: {
		label: string;
		value: string;
		onChange: (iso: string) => void;
	}) => (
		<button
			type="button"
			aria-label={label}
			onClick={() => onChange("2027-10-04")}
		>
			{value || "Pick a date"}
		</button>
	),
}));

const graph = (): TripGraph => {
	const g = structuredClone(demoGraph);
	g.trip.settings = { ...g.trip.settings, holidays: [] };
	return g;
};

function open(g: TripGraph = graph()) {
	const opts = { graph: g, mode: "live" as const };
	const r = renderWithWorkspace(<TripSettingsDialog />, opts);
	act(() => useUi.getState().setSettingsOpen(true));
	const dialog = screen.getByTestId(TESTID.tripSettingsDialog);
	const editor = within(dialog).getByTestId(TESTID.holidaysEditor);
	return { ...r, opts, dialog, editor };
}

function fillHoliday(editor: HTMLElement, name: string | null) {
	fireEvent.click(within(editor).getByTestId(T.holidayAdd));
	const row = within(editor).getAllByTestId(T.holidayRow).at(-1) as HTMLElement;
	fireEvent.click(within(row).getByLabelText("Holiday date"));
	if (name !== null)
		fireEvent.change(within(row).getByLabelText("Holiday name"), {
			target: { value: name },
		});
}

beforeEach(() => {
	for (const f of Object.values(fns)) f.mockReset();
	toasts.error.mockReset();
	fns.updateTrip.mockResolvedValue({ slug: demoGraph.trip.slug });
});
afterEach(() => useUi.getState().resetUi());

describe("Trip settings: a new holiday is never lost (NEW-V52-01)", () => {
	it("the dialog's Save writes a filled-in holiday with the other settings", async () => {
		const { dialog, editor } = open();
		fillHoliday(editor, "Sports Day");
		fireEvent.click(within(dialog).getByTestId(HOME_TESTID.settingsSave));
		await waitFor(() => expect(fns.updateTrip).toHaveBeenCalledTimes(1));
		const sent = fns.updateTrip.mock.calls[0]?.[0] as {
			data: { settings: Record<string, unknown> };
		};
		expect(sent.data.settings.holidays).toEqual([
			{ date: "2027-10-04", name: "Sports Day" },
		]);
		// …together with the plan settings, in one write.
		expect(sent.data.settings).toHaveProperty("defaultDayStart");
		await waitFor(() => expect(useUi.getState().settingsOpen).toBe(false));
	});

	it("without holiday edits, Save leaves the holidays alone", async () => {
		const { dialog } = open();
		fireEvent.click(within(dialog).getByTestId(HOME_TESTID.settingsSave));
		await waitFor(() => expect(fns.updateTrip).toHaveBeenCalledTimes(1));
		const sent = fns.updateTrip.mock.calls[0]?.[0] as {
			data: { settings: Record<string, unknown> };
		};
		expect(sent.data.settings).not.toHaveProperty("holidays");
	});

	it("a half-filled holiday keeps the dialog open and says why", async () => {
		const { dialog, editor } = open();
		fillHoliday(editor, null);
		fireEvent.click(within(dialog).getByTestId(HOME_TESTID.settingsSave));
		await waitFor(() =>
			expect(toasts.error).toHaveBeenCalledWith(
				"Public holidays: Each holiday needs a name.",
			),
		);
		expect(fns.updateTrip).not.toHaveBeenCalled();
		expect(useUi.getState().settingsOpen).toBe(true);
		expect(within(editor).getAllByTestId(T.holidayRow)).toHaveLength(1);
	});

	it("a change to the trip from elsewhere keeps the draft and what's being typed", async () => {
		const r = open();
		fillHoliday(r.editor, "Sports Day");
		const name = within(r.dialog).getByTestId(HOME_TESTID.settingsName);
		fireEvent.change(name, { target: { value: "Asia 2027 (v2)" } });
		// Someone else saves the trip: a new graph with a new updatedAt.
		const next = graph();
		next.trip.updatedAt = "2031-01-01T00:00:00.000Z";
		next.trip.version += 1;
		r.opts.graph = next;
		r.rerender(<TripSettingsDialog />);
		const editor = screen.getByTestId(TESTID.holidaysEditor);
		expect(within(editor).getAllByTestId(T.holidayRow)).toHaveLength(1);
		expect(within(editor).getByLabelText("Holiday name")).toHaveValue(
			"Sports Day",
		);
		expect(screen.getByTestId(HOME_TESTID.settingsName)).toHaveValue(
			"Asia 2027 (v2)",
		);
	});

	it("'Save holidays' still saves just the holidays and keeps the dialog", async () => {
		const { editor } = open();
		fillHoliday(editor, "Sports Day");
		fireEvent.click(within(editor).getByTestId(T.holidaySave));
		await waitFor(() => expect(fns.updateTrip).toHaveBeenCalledTimes(1));
		const sent = fns.updateTrip.mock.calls[0]?.[0] as {
			data: { settings: Record<string, unknown> };
		};
		expect(sent.data.settings).toEqual({
			holidays: [{ date: "2027-10-04", name: "Sports Day" }],
		});
		expect(useUi.getState().settingsOpen).toBe(true);
	});
});

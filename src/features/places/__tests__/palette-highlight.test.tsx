/**
 * The ⌘K palette's highlight and its way to the rate screen:
 *
 * - VIS3-01: typing "Tokyo Tower" first offers only the actions, so cmdk
 *   highlights "Drop a pin…"; the OpenStreetMap results arrive ~300 ms later
 *   ABOVE it. The first result must take the highlight (the footer says
 *   "↵ open"), unless the user already moved it with the keys.
 * - FB-05: "rate" (and an empty palette) offers "Rate places in <scope>",
 *   which opens `/t/<trip>/rate?in=<scope>`.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { AddPlaceDialog } from "../AddPlaceDialog";
import { PLACES_TESTID } from "../testids";

const calls = vi.hoisted(() => ({
	search: [] as string[],
	navigate: [] as unknown[],
}));

vi.mock("../places.functions", () => ({
	// What Photon finds for anything: two places, after the debounce.
	searchPlaces: async (opts: { data: { q: string } }) => {
		calls.search.push(opts.data.q);
		return {
			provider: "photon",
			results: [
				{
					ref: "W1",
					title: `${opts.data.q}, Shibakōen`,
					subtitle: "Minato, Tokyo, Japan",
					types: ["attraction"],
				},
				{
					ref: "W2",
					title: `${opts.data.q} Station`,
					subtitle: "Tokyo, Japan",
					types: ["station"],
				},
			],
		};
	},
	reverseGeocode: async () => {
		throw new Error("no reverse geocode here");
	},
	getPlacePreview: async () => new Promise(() => {}),
	resolveSharedLink: async () => ({ preview: null }),
}));
vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	useNavigate: () => (opts: unknown) => {
		calls.navigate.push(opts);
	},
}));
vi.mock("../ui/mini-map", () => ({ MiniMap: () => null }));

beforeEach(() => {
	calls.search.length = 0;
	calls.navigate.length = 0;
});
afterEach(() => {
	act(() => useUi.getState().openAddPlace(null));
});

const highlighted = () =>
	screen
		.getAllByRole("option")
		.find((o) => o.getAttribute("aria-selected") === "true");

function open(splat = "") {
	useUi.getState().openAddPlace({ mode: "search" });
	return renderWithWorkspace(<AddPlaceDialog />, { mode: "live", splat });
}

describe("the highlight when results arrive (VIS3-01)", () => {
	it("the first result takes it from 'Drop a pin…', and Enter opens that result", async () => {
		open();
		const input = screen.getByTestId(PLACES_TESTID.paletteInput);
		fireEvent.change(input, { target: { value: "Tokyo Tower" } });
		// Before the search answers, the actions are all there is.
		await waitFor(() => expect(highlighted()).toBeDefined());
		expect(screen.queryAllByTestId(PLACES_TESTID.paletteResult)).toEqual([]);
		expect(highlighted()).toHaveTextContent("Drop a pin…");
		// The results arrive above it: the first one is highlighted now.
		await waitFor(() =>
			expect(screen.getAllByTestId(PLACES_TESTID.paletteResult)).toHaveLength(
				2,
			),
		);
		await waitFor(() =>
			expect(highlighted()).toHaveTextContent("Tokyo Tower, Shibakōen"),
		);
		// The input points assistive tech at the same option.
		const active = input.getAttribute("aria-activedescendant");
		expect(active).toBe(highlighted()?.id);
		// ↵ opens the result (its preview), not the pin dropper.
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() =>
			expect(
				screen.getAllByTestId(PLACES_TESTID.paletteResult)[0],
			).toHaveAttribute("data-selected-preview", "true"),
		);
		expect(
			screen.queryByText("Move the map until the pin sits on the spot."),
		).toBeNull();
	});

	it("a highlight the user moved stays put when results arrive", async () => {
		open();
		const input = screen.getByTestId(PLACES_TESTID.paletteInput);
		fireEvent.change(input, { target: { value: "Tokyo Tower" } });
		await waitFor(() => expect(highlighted()).toHaveTextContent("Drop a pin…"));
		// ↓ to "Add “Tokyo Tower” as a new …" before the search answers.
		fireEvent.keyDown(input, { key: "ArrowDown" });
		await waitFor(() => expect(highlighted()).toHaveTextContent(/^Add “/));
		await waitFor(() =>
			expect(screen.getAllByTestId(PLACES_TESTID.paletteResult)).toHaveLength(
				2,
			),
		);
		expect(highlighted()).toHaveTextContent(/^Add “/);
		// New text: the first option again.
		fireEvent.change(input, { target: { value: "Tokyo Towers" } });
		await waitFor(() =>
			expect(highlighted()).toHaveTextContent("Tokyo Towers, Shibakōen"),
		);
	});
});

describe("Rate places from ⌘K (FB-05)", () => {
	it("'rate' offers the Rate feed for the scope, first; Enter opens it", async () => {
		const { navigations } = open("japan/tokyo");
		const input = screen.getByTestId(PLACES_TESTID.paletteInput);
		fireEvent.change(input, { target: { value: "rate" } });
		const item = await screen.findByTestId(PLACES_TESTID.paletteRate);
		expect(item).toHaveTextContent(/^Rate places in Tokyo/);
		expect(item).toHaveTextContent(/\d+ (unrated|places?)$/);
		// First even after the place search answers.
		await waitFor(() =>
			expect(screen.getAllByTestId(PLACES_TESTID.paletteResult)).toHaveLength(
				2,
			),
		);
		await waitFor(() => expect(highlighted()).toBe(item));
		fireEvent.keyDown(input, { key: "Enter" });
		// docs/PLACES.md §1b: the Places tab's Rate view at the scope.
		expect(navigations.at(-1)).toMatchObject({
			splat: "japan/tokyo",
			search: { tab: "places", pv: "rate" },
		});
		expect(calls.navigate).toEqual([]);
	});

	it("an empty palette lists it with the actions; other words don't", async () => {
		open();
		const item = await screen.findByTestId(PLACES_TESTID.paletteRate);
		expect(item).toHaveTextContent(/^Rate places/);
		expect(item).not.toHaveTextContent(" in ");
		fireEvent.change(screen.getByTestId(PLACES_TESTID.paletteInput), {
			target: { value: "Senso" },
		});
		await waitFor(() =>
			expect(screen.queryByTestId(PLACES_TESTID.paletteRate)).toBeNull(),
		);
	});
});

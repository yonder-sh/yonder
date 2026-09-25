/**
 * The palette's results map: a numbered pin per result with a location (the
 * list shows the same numbers), the highlighted result's pin marked, and a
 * pin opens that result's preview; back returns to the map. MapLibre needs
 * WebGL2, so the map is a stand-in that renders its props.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoGraph } from "@/lib/fixtures/demo";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { AddPlaceDialog } from "../AddPlaceDialog";
import type { PlacePreview } from "../lib/providers";
import { PLACES_TESTID } from "../testids";
import type { ResultPin } from "../ui/results-map";

vi.mock("../places.functions", () => ({
	searchPlaces: async () => ({
		provider: "photon",
		results: [
			{
				ref: "N1",
				title: "Ichiran Shibuya",
				subtitle: "Shibuya, Tokyo",
				types: ["restaurant"],
				lat: 35.661,
				lng: 139.701,
			},
			{
				ref: "N2",
				title: "Ichiran (no location)",
				subtitle: "Tokyo",
				types: ["restaurant"],
			},
			{
				ref: "N3",
				title: "Ichiran Shinjuku",
				subtitle: "Shinjuku, Tokyo",
				types: ["restaurant"],
				lat: 35.692,
				lng: 139.701,
			},
		],
	}),
	getPlacePreview: async (): Promise<PlacePreview> => ({
		provider: "photon",
		ref: "N3",
		osmRef: "N3",
		name: "Ichiran Shinjuku",
		category: "restaurant",
		address: "Shinjuku, Tokyo, Japan",
		lat: 35.692,
		lng: 139.701,
		countryCode: "JP",
		photos: [],
		level: "place",
		filing: { existing: [], create: [] },
	}),
	reverseGeocode: async () => {
		throw new Error("no reverse geocoding here");
	},
	resolveSharedLink: async () => ({ preview: null }),
}));
vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	useNavigate: () => () => undefined,
}));
vi.mock("../ui/mini-map", () => ({ MiniMap: () => null }));
vi.mock("../ui/results-map", () => ({
	ResultsMap: (p: {
		pins: ResultPin[];
		active: string | null;
		onPick: (ref: string) => void;
	}) => (
		<div data-testid="results-map" data-active={p.active ?? ""}>
			{p.pins.map((pin) => (
				<button key={pin.ref} type="button" onClick={() => p.onPick(pin.ref)}>
					{`Pin ${pin.n} ${pin.title}`}
				</button>
			))}
		</div>
	),
}));

afterEach(() => {
	act(() => useUi.getState().openAddPlace(null));
});

async function search() {
	useUi.getState().openAddPlace({ mode: "search" });
	renderWithWorkspace(<AddPlaceDialog />, { graph: demoGraph, mode: "live" });
	fireEvent.change(screen.getByTestId(PLACES_TESTID.paletteInput), {
		target: { value: "ichiran" },
	});
	await waitFor(() =>
		expect(screen.getAllByTestId(PLACES_TESTID.paletteResult)).toHaveLength(3),
	);
}

describe("the results map", () => {
	it("pins every result with a location, numbered as in the list", async () => {
		await search();
		const map = screen.getByTestId("results-map");
		expect(
			[...map.querySelectorAll("button")].map((b) => b.textContent),
		).toEqual(["Pin 1 Ichiran Shibuya", "Pin 3 Ichiran Shinjuku"]);
		const rows = screen.getAllByTestId(PLACES_TESTID.paletteResult);
		expect(rows[0]?.textContent).toMatch(/1$/);
		expect(rows[1]?.textContent).not.toMatch(/\d$/);
		expect(rows[2]?.textContent).toMatch(/3$/);
	});

	it("marks the highlighted result's pin, following the keys", async () => {
		await search();
		const map = () => screen.getByTestId("results-map");
		await waitFor(() => expect(map()).toHaveAttribute("data-active", "N1"));
		const input = screen.getByTestId(PLACES_TESTID.paletteInput);
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "ArrowDown" });
		await waitFor(() => expect(map()).toHaveAttribute("data-active", "N3"));
	});

	it("opens a pin's result, and back returns to the map", async () => {
		await search();
		fireEvent.click(
			screen.getByRole("button", { name: "Pin 3 Ichiran Shinjuku" }),
		);
		await waitFor(() => expect(screen.queryByTestId("results-map")).toBeNull());
		expect(
			await screen.findByRole("heading", { name: "Ichiran Shinjuku" }),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Back to results/ }));
		expect(screen.getByTestId("results-map")).toBeInTheDocument();
	});

	it("switches between the list and the map on a phone", async () => {
		await search();
		const list = screen.getByRole("button", { name: "List" });
		const map = screen.getByRole("button", { name: "Map" });
		expect(list).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(map);
		expect(map).toHaveAttribute("aria-pressed", "true");
		expect(list).toHaveAttribute("aria-pressed", "false");
	});
});

/**
 * New-user walkthrough fixes: "golden gai" on a Japan trip ranks Shinjuku
 * before Ghent, a save that would add Belgium to the trip asks first, and
 * "Where next?" talks about the next city, offering no "new country" for one.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { N } from "@/lib/fixtures/demo";
import { type AddPlaceRequest, useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { AddPlaceDialog } from "../AddPlaceDialog";
import type { PlacePreview, PlaceSearchResult } from "../lib/providers";
import { PLACES_TESTID } from "../testids";

const calls = vi.hoisted(() => ({
	paths: [] as { chain: unknown[] }[],
	results: [] as PlaceSearchResult[],
	preview: {} as Partial<PlacePreview>,
	toasts: [] as string[],
}));

vi.mock("../places.functions", () => ({
	searchPlaces: async () => ({ provider: "photon", results: calls.results }),
	getPlacePreview: async (): Promise<PlacePreview> => ({
		provider: "photon",
		ref: "N1",
		name: "Golden Gai",
		lat: 51.05,
		lng: 3.72,
		countryCode: "BE",
		photos: [],
		level: "place",
		category: "bar",
		filing: {
			existing: [],
			create: [
				{ type: "country", name: "Belgium" },
				{ type: "city", name: "Ghent" },
			],
		},
		...calls.preview,
	}),
	reverseGeocode: async () => {
		throw new Error("no geocoding here");
	},
	resolveSharedLink: async () => ({ preview: null }),
}));
vi.mock("@/functions/nodes.functions", () => ({
	createNodePath: async (opts: { data: { chain: unknown[] } }) => {
		calls.paths.push({ chain: opts.data.chain });
		return { ok: true };
	},
	updateNode: async () => ({ ok: true }),
	setNodePriority: async () => ({ ok: true }),
	moveNode: async () => ({ ok: true }),
}));
vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	useNavigate: () => () => undefined,
}));
vi.mock("../ui/mini-map", () => ({ MiniMap: () => null }));
vi.mock("../ui/results-map", () => ({ ResultsMap: () => null }));
vi.mock("sonner", async (orig) => {
	const say = (m: string) => {
		calls.toasts.push(m);
	};
	return {
		...(await orig<typeof import("sonner")>()),
		toast: Object.assign(say, { error: say, success: say }),
	};
});

const GHENT: PlaceSearchResult = {
	ref: "N1",
	title: "Golden Gai",
	subtitle: "Ham, Ghent, Belgium",
	types: ["osm:amenity=bar"],
	countryCode: "BE",
};
const SHINJUKU: PlaceSearchResult = {
	ref: "N2",
	title: "Golden Gai",
	subtitle: "Kabukicho, Shinjuku, Tokyo, Japan",
	types: ["osm:amenity=bar"],
	countryCode: "JP",
};
const KYOTO: PlaceSearchResult = {
	ref: "R3",
	title: "Kyoto",
	subtitle: "Kyoto Prefecture, Japan",
	types: ["osm:place=city", "photon:city"],
	countryCode: "JP",
};

beforeEach(() => {
	calls.paths.length = 0;
	calls.results = [GHENT, SHINJUKU];
	calls.preview = {};
	calls.toasts.length = 0;
});
afterEach(() => {
	act(() => useUi.getState().openAddPlace(null));
});

const input = () => screen.getByTestId(PLACES_TESTID.paletteInput);
const type = (value: string) =>
	fireEvent.change(input(), { target: { value } });

function open(request: AddPlaceRequest = { mode: "search" }) {
	useUi.getState().openAddPlace(request);
	return renderWithWorkspace(<AddPlaceDialog />, {
		mode: "live",
		splat: "japan/tokyo",
	});
}

describe("search results", () => {
	it("rank the trip's countries first", async () => {
		open();
		type("golden gai");
		await waitFor(() =>
			expect(screen.getAllByTestId(PLACES_TESTID.paletteResult)).toHaveLength(
				2,
			),
		);
		const [first, second] = screen.getAllByTestId(PLACES_TESTID.paletteResult);
		expect(first).toHaveTextContent("Shinjuku");
		expect(second).toHaveTextContent("Ghent");
	});
});

describe("a save that adds a country", () => {
	it("says so and asks before saving", async () => {
		calls.results = [GHENT];
		open();
		type("golden gai");
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.paletteResult));
		expect(
			await screen.findByTestId(PLACES_TESTID.newCountry),
		).toHaveTextContent("This is in Belgium, not on your trip yet.");
		fireEvent.click(screen.getByTestId(PLACES_TESTID.saveToIdeas));
		const confirm = await screen.findByTestId(PLACES_TESTID.newCountryConfirm);
		expect(confirm).toHaveTextContent("Add Belgium too");
		expect(calls.paths).toEqual([]);

		// Not now goes back; nothing saved.
		fireEvent.click(screen.getByRole("button", { name: "Not now" }));
		expect(screen.queryByTestId(PLACES_TESTID.newCountryConfirm)).toBeNull();
		expect(calls.paths).toEqual([]);

		fireEvent.click(screen.getByTestId(PLACES_TESTID.saveToIdeas));
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.newCountryConfirm));
		await waitFor(() => expect(calls.paths).toHaveLength(1));
		expect(calls.paths[0]?.chain).toEqual([
			expect.objectContaining({ type: "country", name: "Belgium" }),
			{ type: "city", name: "Ghent" },
			expect.objectContaining({ type: "place", name: "Golden Gai" }),
		]);
	});

	it("saves at once when the place is in the trip's countries", async () => {
		calls.results = [SHINJUKU];
		calls.preview = {
			ref: "N2",
			countryCode: "JP",
			lat: 35.694,
			lng: 139.704,
			filing: { existing: [N.japan, N.tokyo] as string[], create: [] },
		};
		open();
		type("golden gai");
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.paletteResult));
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.saveToIdeas));
		await waitFor(() => expect(calls.paths).toHaveLength(1));
		expect(screen.queryByTestId(PLACES_TESTID.newCountry)).toBeNull();
	});
});

describe("Where next?", () => {
	it("asks for the next city", async () => {
		open({ mode: "first", next: true });
		expect(
			await screen.findByText("Type a city to go to next."),
		).toBeInTheDocument();
	});

	it("offers no new country for a city it found", async () => {
		calls.results = [KYOTO];
		open({ mode: "first", next: true });
		type("Kyoto");
		await screen.findByTestId(PLACES_TESTID.paletteResult);
		expect(
			screen.queryByRole("option", { name: /as a new country/ }),
		).toBeNull();
	});

	it("still offers one for a name it didn't find as a city", async () => {
		calls.results = [KYOTO];
		open({ mode: "first", next: true });
		type("Narnia");
		expect(
			await screen.findByRole("option", {
				name: /Add “Narnia” as a new country/,
			}),
		).toBeInTheDocument();
	});
});

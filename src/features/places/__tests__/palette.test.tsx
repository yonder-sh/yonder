/**
 * The ⌘K palette against QA HIER-12 and HIER-10 (PLAN-R2-01/02/10):
 *
 * - Set location: pasting "lat, lng" over the node's name search drops the
 *   stale worldwide hits, so "Use this location" is the first, chosen option
 *   and Enter uses the pasted spot (not "Yoro Kuro Bar", Ningbo).
 * - The pin keeps the node's identity: no OSM ref from the nearest bar.
 * - The search for an unlocated place looks around its parent.
 * - "Shinjuku" also lists the named leg "Fuji Excursion (Shinjuku → …)".
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphLeg, GraphNode, TripGraph } from "@/lib/engine/types";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { AddPlaceDialog } from "../AddPlaceDialog";
import type { PlacePreview } from "../lib/providers";
import { PLACES_TESTID } from "../testids";

const calls = vi.hoisted(() => ({
	search: [] as { q: string; bias?: { lat: number; lng: number } }[],
	updateNode: [] as unknown[],
}));

vi.mock("../places.functions", () => ({
	searchPlaces: async (opts: {
		data: { q: string; bias?: { lat: number; lng: number } };
	}) => {
		calls.search.push(opts.data);
		// What Photon finds for "Bar Kuro" worldwide.
		return {
			provider: "photon",
			results: [
				{
					ref: "N9105271323",
					title: "Yoro Kuro Bar",
					subtitle: "Ningbo, China",
					types: ["bar"],
				},
				{
					ref: "N1",
					title: "Kuro Sushi & Bar",
					subtitle: "Vancouver, Canada",
					types: ["restaurant"],
				},
			],
		};
	},
	reverseGeocode: async (opts: {
		data: { lat: number; lng: number };
	}): Promise<PlacePreview> => ({
		provider: "photon",
		ref: "N14144934501",
		osmRef: "N14144934501",
		name: "Blue Dragon",
		category: "bar",
		address: "Akarui Hanazono Third Street, Kabukicho, Shinjuku, Tokyo, Japan",
		lat: opts.data.lat,
		lng: opts.data.lng,
		countryCode: "JP",
		photos: [],
		level: "place",
		filing: { existing: [], create: [] },
	}),
	getPlacePreview: async () => {
		throw new Error("a search result was opened");
	},
	resolveSharedLink: async () => ({ preview: null }),
}));
vi.mock("@/functions/nodes.functions", () => ({
	updateNode: async (opts: { data: unknown }) => {
		calls.updateNode.push(opts.data);
		return { ok: true };
	},
	createNodePath: async () => ({ ok: true }),
	setNodePriority: async () => ({ ok: true }),
	moveNode: async () => ({ ok: true }),
}));
vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	useNavigate: () => () => undefined,
}));
// MapLibre needs WebGL2, which happy-dom doesn't have.
vi.mock("../ui/mini-map", () => ({ MiniMap: () => null }));

const KURO = "00000000-0000-7000-8000-00000000bb01";
const GAI = "00000000-0000-7000-8000-00000000bb02";
const shibuya = demoGraph.nodes.find((n) => n.id === N.shibuya) as GraphNode;
const fujiLeg = demoGraph.legs.find((l) => l.mode === "transit") as GraphLeg;
// Golden Gai › Bar Kuro in Shibuya, neither located; the demo's transit leg
// named like the sheet's Fuji Excursion.
const graph: TripGraph = {
	...demoGraph,
	nodes: [
		...demoGraph.nodes,
		{
			...shibuya,
			id: GAI,
			parentId: N.shibuya as string,
			name: "Golden Gai",
			slug: "golden-gai",
			lat: null,
			lng: null,
			position: "z0",
		},
		{
			...shibuya,
			id: KURO,
			parentId: GAI,
			type: "place",
			category: "bar",
			name: "Bar Kuro",
			slug: "bar-kuro",
			lat: null,
			lng: null,
			address: null,
			position: "z1",
		},
	],
	legs: demoGraph.legs.map((l) =>
		l.id === fujiLeg.id
			? {
					...l,
					details: {
						kind: "transit",
						route: {
							id: "sheet",
							label: "Fuji Excursion (Shinjuku → Kawaguchiko)",
							source: "manual",
							durationMin: 120,
							walkMin: 0,
							transfers: 0,
							segments: [],
						},
						chosenId: "sheet",
					},
				}
			: l,
	),
};

beforeEach(() => {
	calls.search.length = 0;
	calls.updateNode.length = 0;
});
afterEach(() => {
	act(() => useUi.getState().openAddPlace(null));
});

const options = () =>
	screen.getAllByRole("option").map((o) => ({
		text: o.textContent ?? "",
		coords: o.getAttribute("data-testid") === PLACES_TESTID.coordsResult,
		selected: o.getAttribute("aria-selected") === "true",
	}));

describe("Set location (HIER-12)", () => {
	it("pasted coordinates replace the stale search, and Enter uses them", async () => {
		useUi.getState().openAddPlace({ mode: "locate", nodeId: KURO });
		renderWithWorkspace(<AddPlaceDialog />, { graph, mode: "live" });
		// The dialog searches the node's name, around its parent (Shibuya).
		await waitFor(() =>
			expect(screen.getAllByTestId(PLACES_TESTID.paletteResult)).toHaveLength(
				2,
			),
		);
		expect(calls.search[0]).toMatchObject({
			q: "Bar Kuro",
			bias: { lat: shibuya.lat, lng: shibuya.lng },
		});

		const input = screen.getByTestId(PLACES_TESTID.paletteInput);
		fireEvent.change(input, { target: { value: "35.6941, 139.7045" } });
		await waitFor(() =>
			expect(options().find((o) => o.selected)?.coords).toBe(true),
		);
		expect(screen.queryAllByTestId(PLACES_TESTID.paletteResult)).toEqual([]);
		expect(options()[0]?.text).toMatch(
			/Use this location35\.69410, 139\.70450/,
		);
		// Still none after the debounce (no new search, no stale results back).
		await new Promise((r) => setTimeout(r, 400));
		expect(screen.queryAllByTestId(PLACES_TESTID.paletteResult)).toEqual([]);
		expect(calls.search).toHaveLength(1);

		// ↵ chooses the pasted spot; the preview is Bar Kuro, not Blue Dragon.
		fireEvent.keyDown(input, { key: "Enter" });
		const address = await screen.findByTestId(PLACES_TESTID.pinAddress);
		expect(address).toHaveTextContent(
			"Nearest address on the map: Akarui Hanazono",
		);
		const preview = screen.getByTestId(PLACES_TESTID.previewCard);
		expect(preview).toHaveTextContent("Bar Kuro");
		expect(preview).not.toHaveTextContent("Blue Dragon");

		fireEvent.click(screen.getByTestId(PLACES_TESTID.useLocation));
		await waitFor(() => expect(calls.updateNode).toHaveLength(1));
		// The spot and the address; never Blue Dragon's OSM ref (PLAN-R2-02).
		expect(calls.updateNode[0]).toEqual({
			nodeId: KURO,
			patch: {
				lat: 35.6941,
				lng: 139.7045,
				address:
					"Akarui Hanazono Third Street, Kabukicho, Shinjuku, Tokyo, Japan",
			},
		});
	});

	it("out-of-range coordinates show the error, not stale results", async () => {
		useUi.getState().openAddPlace({ mode: "locate", nodeId: KURO });
		renderWithWorkspace(<AddPlaceDialog />, { graph, mode: "live" });
		await waitFor(() =>
			expect(
				screen.getAllByTestId(PLACES_TESTID.paletteResult).length,
			).toBeGreaterThan(0),
		);
		fireEvent.change(screen.getByTestId(PLACES_TESTID.paletteInput), {
			target: { value: "135, 500" },
		});
		expect(screen.getByTestId(PLACES_TESTID.coordsError)).toHaveTextContent(
			/out of range/,
		);
		expect(screen.queryAllByTestId(PLACES_TESTID.paletteResult)).toEqual([]);
		expect(screen.queryByTestId(PLACES_TESTID.coordsResult)).toBeNull();
	});
});

describe("In this trip: legs (HIER-10)", () => {
	it("'Shinjuku' lists the Fuji Excursion leg, labelled as a leg", async () => {
		useUi.getState().openAddPlace({ mode: "search" });
		const { ws } = renderWithWorkspace(<AddPlaceDialog />, { graph });
		fireEvent.change(screen.getByTestId(PLACES_TESTID.paletteInput), {
			target: { value: "Shinjuku" },
		});
		const leg = await screen.findByTestId(PLACES_TESTID.paletteTripLeg);
		expect(leg).toHaveTextContent("Fuji Excursion (Shinjuku → Kawaguchiko)");
		expect(leg).toHaveTextContent(/Leg · Day \d+/);
		fireEvent.click(leg);
		expect(ws().sel).toEqual({
			kind: "leg",
			target: {
				kind: "pair",
				fromItemId: fujiLeg.fromItemId,
				toItemId: fujiLeg.toItemId,
			},
		});
	});
});

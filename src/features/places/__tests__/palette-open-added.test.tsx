/**
 * A place saved to Ideas from Places › Review opens there, in its details;
 * elsewhere the dialog closes with a "Show" toast as before.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { AddPlaceDialog } from "../AddPlaceDialog";
import type { PlacePreview } from "../lib/providers";
import { PLACES_TESTID } from "../testids";

const calls = vi.hoisted(() => ({ ids: [] as string[][] }));

vi.mock("../places.functions", () => ({
	searchPlaces: async () => ({
		provider: "photon",
		results: [
			{ ref: "N1", title: "Ichiran", subtitle: "Tokyo, Japan", types: [] },
		],
	}),
	getPlacePreview: async (): Promise<PlacePreview> => ({
		provider: "photon",
		ref: "N1",
		osmRef: "N1",
		name: "Ichiran",
		category: "restaurant",
		address: "Shibuya, Tokyo, Japan",
		lat: 35.66,
		lng: 139.7,
		countryCode: "JP",
		photos: [],
		level: "place",
		filing: { existing: [N.shibuya as string], create: [] },
	}),
	reverseGeocode: async () => {
		throw new Error("no pin in this test");
	},
	resolveSharedLink: async () => ({ preview: null }),
}));
vi.mock("@/functions/nodes.functions", () => ({
	createNodePath: async (opts: { data: { ids: string[] } }) => {
		calls.ids.push(opts.data.ids);
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
// MapLibre needs WebGL2, which happy-dom doesn't have.
vi.mock("../ui/mini-map", () => ({ MiniMap: () => null }));
vi.mock("../ui/results-map", () => ({ ResultsMap: () => null }));

beforeEach(() => {
	calls.ids.length = 0;
});
afterEach(() => {
	act(() => useUi.getState().openAddPlace(null));
});

async function saveIchiran(search: Record<string, unknown>) {
	useUi.getState().openAddPlace({ mode: "search" });
	const r = renderWithWorkspace(<AddPlaceDialog />, {
		graph: demoGraph,
		mode: "live",
		search,
	});
	fireEvent.change(screen.getByTestId(PLACES_TESTID.paletteInput), {
		target: { value: "Ichiran" },
	});
	fireEvent.click(await screen.findByTestId(PLACES_TESTID.paletteResult));
	fireEvent.click(await screen.findByTestId(PLACES_TESTID.saveToIdeas));
	await waitFor(() => expect(calls.ids).toHaveLength(1));
	return r;
}

describe("saving a place to Ideas", () => {
	it("opens it on Places › Review", async () => {
		const { ws } = await saveIchiran({ tab: "places", pv: "table" });
		const leafId = calls.ids[0]?.at(-1);
		await waitFor(() => expect(ws().sel).toEqual({ kind: "node", id: leafId }));
		expect(useUi.getState().addPlace).toBeNull();
	});

	it("leaves the selection alone elsewhere", async () => {
		const { ws } = await saveIchiran({ tab: "places", pv: "rate" });
		await waitFor(() => expect(useUi.getState().addPlace).toBeNull());
		expect(ws().sel).toBeNull();
	});
});

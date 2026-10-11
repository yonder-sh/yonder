/**
 * Adding a few in a row: a save keeps the palette open, cleared and focused,
 * with "Added Ichiran" and Done. Done on Places › Review opens the last one in
 * its details; a scheduled one makes the next go after it.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demo, demoGraph, N } from "@/lib/fixtures/demo";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { AddPlaceDialog } from "../AddPlaceDialog";
import type { PlacePreview } from "../lib/providers";
import { PLACES_TESTID } from "../testids";

const calls = vi.hoisted(() => ({
	ids: [] as string[][],
	items: [] as { id: string; dayId: string | null; afterItemId?: string }[],
}));

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
vi.mock("@/functions/items.functions", async (orig) => ({
	...(await orig<typeof import("@/functions/items.functions")>()),
	createItem: async (opts: { data: (typeof calls.items)[number] }) => {
		calls.items.push(opts.data);
		return { ok: true };
	},
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
	calls.items.length = 0;
});
afterEach(() => {
	act(() => useUi.getState().openAddPlace(null));
});

function pickIchiran() {
	fireEvent.change(screen.getByTestId(PLACES_TESTID.paletteInput), {
		target: { value: "Ichiran" },
	});
	return screen.findByTestId(PLACES_TESTID.paletteResult).then((r) => {
		fireEvent.click(r);
	});
}

async function saveIchiran(search: Record<string, unknown>) {
	useUi.getState().openAddPlace({ mode: "search" });
	const r = renderWithWorkspace(<AddPlaceDialog />, {
		graph: demoGraph,
		mode: "live",
		search,
	});
	await pickIchiran();
	fireEvent.click(await screen.findByTestId(PLACES_TESTID.saveToIdeas));
	await waitFor(() => expect(calls.ids).toHaveLength(1));
	return r;
}

describe("saving a place to Ideas", () => {
	it("keeps the palette open, cleared and focused, saying what it added", async () => {
		await saveIchiran({ tab: "places", pv: "rate" });
		expect(
			await screen.findByTestId(PLACES_TESTID.paletteAdded),
		).toHaveTextContent("Added Ichiran");
		const input = screen.getByTestId(PLACES_TESTID.paletteInput);
		expect(input).toHaveValue("");
		await waitFor(() => expect(input).toHaveFocus());
		expect(screen.queryByTestId(PLACES_TESTID.previewCard)).toBeNull();
		expect(useUi.getState().addPlace).not.toBeNull();
	});

	it("Done on Places › Review opens the last one added", async () => {
		const { ws } = await saveIchiran({ tab: "places", pv: "table" });
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.paletteDone));
		const leafId = calls.ids[0]?.at(-1);
		await waitFor(() => expect(ws().sel).toEqual({ kind: "node", id: leafId }));
		expect(useUi.getState().addPlace).toBeNull();
	});

	it("Done elsewhere just closes", async () => {
		const { ws } = await saveIchiran({ tab: "places", pv: "rate" });
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.paletteDone));
		await waitFor(() => expect(useUi.getState().addPlace).toBeNull());
		expect(ws().sel).toBeNull();
	});
});

describe("scheduling a few in a row", () => {
	it("puts the next one after the last", async () => {
		const dayId = demo.D.d2;
		useUi.getState().openAddPlace({ mode: "schedule", dayId });
		renderWithWorkspace(<AddPlaceDialog />, { graph: demoGraph, mode: "live" });
		await pickIchiran();
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.schedule));
		await waitFor(() => expect(calls.items).toHaveLength(1));
		expect(calls.items[0]?.dayId).toBe(dayId);
		expect(
			await screen.findByTestId(PLACES_TESTID.paletteAdded),
		).toHaveTextContent("Added Ichiran");
		expect(useUi.getState().addPlace).toEqual({
			mode: "schedule",
			dayId,
			afterItemId: calls.items[0]?.id,
		});
	});
});

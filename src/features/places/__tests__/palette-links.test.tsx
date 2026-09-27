/**
 * ⌘K with a pasted link (owner, 2026-09-27): a reel or a guide is never a
 * place name ("Add 'https://…' as a new country"). It goes onto the open
 * place, or to the share page, which asks: a new idea, or an existing place?
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { AddPlaceDialog } from "../AddPlaceDialog";
import { PLACES_TESTID } from "../testids";

const calls = vi.hoisted(() => ({
	links: [] as unknown[],
	navigate: [] as unknown[],
}));

vi.mock("../places.functions", () => ({
	searchPlaces: async () => ({ provider: "photon", results: [] }),
	reverseGeocode: async () => {
		throw new Error("no geocoding here");
	},
	getPlacePreview: async () => {
		throw new Error("no preview here");
	},
	resolveSharedLink: async () => ({ preview: null }),
}));
vi.mock("@/features/media/media.functions", async (orig) => ({
	...(await orig<typeof import("@/features/media/media.functions")>()),
	addLink: async (opts: { data: unknown }) => {
		calls.links.push(opts.data);
		return { ok: true, value: null };
	},
}));
vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	useNavigate: () => (to: unknown) => {
		calls.navigate.push(to);
	},
}));
vi.mock("../ui/mini-map", () => ({ MiniMap: () => null }));

const REEL = "https://www.tiktok.com/@cafes/video/7430912345678901234";

beforeEach(() => {
	calls.links.length = 0;
	calls.navigate.length = 0;
});
afterEach(() => {
	act(() => useUi.getState().openAddPlace(null));
});

const paste = (value: string) =>
	fireEvent.change(screen.getByTestId(PLACES_TESTID.paletteInput), {
		target: { value },
	});

describe("a pasted link in ⌘K", () => {
	it("offers to save the link, never to add it as a new country", async () => {
		useUi.getState().openAddPlace({ mode: "search" });
		renderWithWorkspace(<AddPlaceDialog />);
		paste(REEL);
		const save = await screen.findByTestId(PLACES_TESTID.saveLink);
		expect(screen.queryByText(/as a new/)).toBeNull();
		expect(screen.queryByTestId(PLACES_TESTID.addLinkTo)).toBeNull();
		fireEvent.click(save);
		expect(calls.navigate).toEqual([{ to: "/share", search: { url: REEL } }]);
	});

	it("adds it to the open place in one step", async () => {
		useUi.getState().openAddPlace({ mode: "search" });
		const name = demoGraph.nodes.find((n) => n.id === N.shibuya)?.name;
		renderWithWorkspace(<AddPlaceDialog />, {
			search: { sel: `n.${N.shibuya}` } as never,
		});
		paste(REEL);
		const add = await screen.findByTestId(PLACES_TESTID.addLinkTo);
		expect(add).toHaveTextContent(`Add this link to ${name}`);
		fireEvent.click(add);
		await waitFor(() =>
			expect(calls.links).toEqual([
				{
					tripId: demoGraph.trip.id,
					target: { kind: "node", nodeId: N.shibuya },
					url: REEL,
				},
			]),
		);
	});
});

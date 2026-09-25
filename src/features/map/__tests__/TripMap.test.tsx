/**
 * `TripMap` without WebGL2 (happy-dom): the SVG fallback draws the same pins as
 * the real map, pins select and zoom in, and the empty scope says so.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demo, N } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import TripMap from "../TripMap";
import { MAP_TESTID } from "../testids";

function pinNamed(re: RegExp): HTMLElement {
	const pin = screen
		.getAllByTestId(TESTID.pin)
		.find((el) => re.test(el.getAttribute("aria-label") ?? ""));
	if (!pin) throw new Error(`no pin ${re}`);
	return pin;
}

describe("TripMap (no WebGL2)", () => {
	it("falls back to the SVG map with one button per pin", async () => {
		renderWithWorkspace(<TripMap variant="desktop" />, {
			splat: "japan/tokyo",
			search: { lens: "place" },
		});
		await screen.findByTestId(MAP_TESTID.fallback);
		const region = within(screen.getByTestId(TESTID.tripMap)).getByRole(
			"region",
			{ name: "Map of Tokyo" },
		);
		expect(region).toBeTruthy();
		const pins = screen.getAllByTestId(TESTID.pin);
		expect(pins.length).toBeGreaterThanOrEqual(7);
		expect(pinNamed(/^1\. Hands Shibuya/)).toBeTruthy();
	});

	it("selects a pin on click and zooms into it on double-click", async () => {
		const { ws } = renderWithWorkspace(<TripMap variant="desktop" />, {
			splat: "japan",
			search: { lens: "city" },
		});
		await screen.findByTestId(MAP_TESTID.fallback);
		const tokyo = pinNamed(/^\d+\. Tokyo/);
		fireEvent.click(tokyo);
		await waitFor(() =>
			expect(ws().sel).toEqual({ kind: "node", id: N.tokyo }),
		);
		fireEvent.doubleClick(tokyo);
		await waitFor(() => expect(ws().scope?.id).toBe(N.tokyo));
	});

	it("offers an ordered Stops list as the map's text alternative (A11Y-03)", async () => {
		const { ws } = renderWithWorkspace(<TripMap variant="desktop" />, {
			splat: "japan/tokyo",
			search: { lens: "place", days: "2027-10-03" },
		});
		await screen.findByTestId(MAP_TESTID.fallback);
		const region = within(screen.getByTestId(TESTID.tripMap)).getByRole(
			"region",
			{ name: "Map of Tokyo" },
		);
		const list = within(region).getByRole("list", { name: "Stops" });
		const stops = within(list).getAllByRole("listitem");
		expect(stops.length).toBeGreaterThanOrEqual(4);
		const hands = within(list).getByRole("button", {
			name: "Pin 1, Hands Shibuya, 09:00",
		});
		fireEvent.click(hands);
		await waitFor(() =>
			expect(ws().sel).toEqual({ kind: "node", id: N.hands }),
		);
		// Edges are reachable too: the walk to Loft selects its leg.
		fireEvent.click(
			within(list).getByRole("button", { name: "Walk · 3m to Shibuya Loft" }),
		);
		await waitFor(() =>
			expect(ws().sel).toEqual({
				kind: "leg",
				target: {
					kind: "pair",
					fromItemId: demo.I.hands,
					toItemId: demo.I.loft,
				},
			}),
		);
	});

	it("applies the shared filter from the URL", async () => {
		renderWithWorkspace(<TripMap variant="desktop" />, {
			splat: "japan/tokyo",
			search: { lens: "place", f: "g:shopping" },
		});
		await screen.findByTestId(MAP_TESTID.fallback);
		const meiji = pinNamed(/Meiji Jingu/);
		expect(Number(meiji.style.opacity)).toBeLessThan(0.5);
		const hands = pinNamed(/Hands Shibuya/);
		expect(Number(hands.style.opacity)).toBe(1);
	});
});

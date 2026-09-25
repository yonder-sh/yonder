/**
 * QA MOB-07: on a phone the map controls are 44px tap targets (`is-touch`,
 * sized in map.css; the e2e run measures them on a Pixel 7). FB-04: the layer
 * menu switches the map style.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EMPTY_FILTER } from "@/lib/workspace/filter";
import { Legend, MapControls, type MapControlsProps } from "../MapControls";
import { LINES } from "../palette";
import { MAP_TESTID } from "../testids";

const props = (variant: MapControlsProps["variant"]): MapControlsProps => ({
	variant,
	palette: LINES.light,
	style: {},
	mapStyle: "light",
	setMapStyle: () => {},
	onFit: () => {},
	onZoom: () => {},
	show: { ideas: true, dropped: false, stays: true },
	setShow: () => {},
	dayMode: "only",
	setDayMode: () => {},
	daysActive: false,
	filter: EMPTY_FILTER,
	setFilter: () => {},
	members: [],
	meMemberId: null,
});

describe("MapControls", () => {
	it("uses the touch size on a phone, the compact one on desktop", () => {
		const { unmount } = render(
			<TooltipProvider>
				<MapControls {...props("mobile")} />
			</TooltipProvider>,
		);
		const phone = screen.getByTestId(MAP_TESTID.controls);
		expect(phone.classList.contains("is-touch")).toBe(true);
		for (const name of [
			"Fit to the scope",
			"Map layers and legend",
			"Filter places",
		])
			expect(screen.getByRole("button", { name })).toBeTruthy();
		// No zoom buttons on touch (pinch).
		expect(screen.queryByTestId(MAP_TESTID.zoomIn)).toBeNull();
		unmount();
		render(
			<TooltipProvider>
				<MapControls {...props("desktop")} />
			</TooltipProvider>,
		);
		expect(
			screen.getByTestId(MAP_TESTID.controls).classList.contains("is-touch"),
		).toBe(false);
	});
});

describe("Legend (ADDENDUM §10: dashes only for estimates and proposals)", () => {
	it("shows known legs solid or dotted, and only estimates/proposals dashed", () => {
		render(<Legend palette={LINES.light} />);
		const kindOf = (label: string) =>
			screen
				.getByText(label)
				.parentElement?.querySelector("svg")
				?.getAttribute("data-line");
		expect(kindOf("Flight")).toBe("double");
		expect(kindOf("Taxi, car, ferry…")).toBe("solid");
		expect(kindOf("Transit")).toBe("solid");
		expect(kindOf("Walk")).toBe("dotted");
		expect(kindOf("To your stay")).toBe("dotted");
		expect(kindOf("Overnight")).toBe("dotted");
		expect(kindOf("Estimate (rail network, no timetable)")).toBe("dashed");
		expect(kindOf("No travel set yet")).toBe("dashed");
		expect(kindOf("Suggested")).toBe("dashed");
		// The flight sample has no dash pattern at all.
		const flight = screen
			.getByText("Flight")
			.parentElement?.querySelector("svg");
		for (const l of flight?.querySelectorAll("line") ?? [])
			expect(l.getAttribute("stroke-dasharray")).toBeNull();
	});
});

describe("Map popovers (VIS2-03: axe aria-dialog-name)", () => {
	it("names the layers-and-legend and filter dialogs", async () => {
		render(
			<TooltipProvider>
				<MapControls {...props("desktop")} />
			</TooltipProvider>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Map layers and legend" }),
		);
		const menu = await screen.findByTestId(MAP_TESTID.layerMenu);
		expect(menu.getAttribute("role")).toBe("dialog");
		expect(menu.getAttribute("aria-label")).toBe("Map layers and legend");
		fireEvent.keyDown(menu, { key: "Escape" });
		fireEvent.click(screen.getByRole("button", { name: "Filter places" }));
		const filter = await screen.findByTestId(MAP_TESTID.filterMenu);
		expect(filter.getAttribute("aria-label")).toBe("Filter places");
	});
});

describe("Map style in the layer menu (FB-04)", () => {
	it("shows the current style and saves another one", async () => {
		const setMapStyle = vi.fn();
		render(
			<TooltipProvider>
				<MapControls
					{...props("desktop")}
					mapStyle="dark"
					setMapStyle={setMapStyle}
				/>
			</TooltipProvider>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Map layers and legend" }),
		);
		const group = await screen.findByTestId(MAP_TESTID.mapStyle);
		expect(group.getAttribute("aria-label")).toBe("Map style");
		const dark = screen.getByTestId(`${MAP_TESTID.mapStyle}-dark`);
		expect(dark.getAttribute("data-state")).toBe("on");
		expect(
			screen
				.getByTestId(`${MAP_TESTID.mapStyle}-light`)
				.getAttribute("data-state"),
		).toBe("off");
		fireEvent.click(screen.getByTestId(`${MAP_TESTID.mapStyle}-satellite`));
		expect(setMapStyle).toHaveBeenCalledWith("satellite");
		// Clicking the chosen one again doesn't unset it (a single toggle group).
		setMapStyle.mockClear();
		fireEvent.click(dark);
		expect(setMapStyle).not.toHaveBeenCalled();
	});
});

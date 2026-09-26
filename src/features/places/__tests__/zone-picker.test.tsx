/**
 * The place overview's controls are named (VIS-08, axe `button-name`), and an
 * editor can override a node's time zone or go back to the location's
 * (QA TZ-08) through `updateNode({ patch: { tz } })`.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorBody } from "@/features/shell/InspectorBody";
import type { TripGraph } from "@/lib/engine/types";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { NodeOverview } from "../NodeOverview";
import { PLACES_TAB_TESTID } from "../tab/testids";
import { PLACES_TESTID } from "../testids";
import { offsetLabel, timeZoneNames, tripOffsetLabel } from "../ui/zone-picker";

const calls = vi.hoisted(() => ({ updateNode: [] as unknown[] }));
vi.mock("@/functions/nodes.functions", () => ({
	setNodePriority: async () => ({ ok: true }),
	updateNode: async (opts: { data: unknown }) => {
		calls.updateNode.push(opts.data);
		return { updatedAt: new Date().toISOString(), slug: "x" };
	},
	createNodePath: async () => ({ ok: true }),
	moveNode: async () => ({ ok: true }),
}));

beforeEach(() => {
	calls.updateNode.length = 0;
});

describe("NodeOverview controls", () => {
	it("VIS-08: the Category and Time needed selects have accessible names", () => {
		// Category in the place's header, Time needed in its About.
		renderWithWorkspace(<InspectorBody />, {
			search: { sel: `n.${N.itoya}` },
		});
		expect(
			screen.getByRole("combobox", { name: "Category" }),
		).toBeInTheDocument();
		// The time is a button named by its value, titled for what it sets.
		expect(
			within(screen.getByTestId(TESTID.nodeOverview)).getByTestId(
				PLACES_TAB_TESTID.timeCell,
			),
		).toHaveAttribute("title");
	});

	it("TZ-08: an editor overrides the zone, and can go back to Automatic", async () => {
		// The server wrote Itoya's zone from its coordinates.
		const graph: TripGraph = {
			...demoGraph,
			nodes: demoGraph.nodes.map((n) =>
				n.id === N.itoya ? { ...n, tz: "Asia/Tokyo" } : n,
			),
		};
		renderWithWorkspace(<NodeOverview nodeId={N.itoya as string} />, {
			graph,
		});
		const trigger = screen.getByTestId(PLACES_TESTID.tzPicker);
		expect(trigger).toHaveAccessibleName(/^Time zone: Asia\/Tokyo/);
		expect(trigger).toBeEnabled();
		fireEvent.click(trigger);
		fireEvent.click(
			await screen.findByRole("option", { name: /Asia\/Seoul|Asia Seoul/ }),
		);
		await vi.waitFor(() =>
			expect(calls.updateNode).toEqual([
				{ nodeId: N.itoya, patch: { tz: "Asia/Seoul" } },
			]),
		);
		fireEvent.click(screen.getByTestId(PLACES_TESTID.tzPicker));
		fireEvent.click(await screen.findByRole("option", { name: /^Automatic/ }));
		await vi.waitFor(() =>
			expect(calls.updateNode.at(-1)).toEqual({
				nodeId: N.itoya,
				patch: { tz: null },
			}),
		);
	});

	it("lists the runtime's zones with their offsets", () => {
		const zones = timeZoneNames();
		expect(zones).toContain("Asia/Tokyo");
		expect(zones).toContain("UTC");
		const at = Date.UTC(2027, 9, 7);
		expect(offsetLabel("Asia/Tokyo", at)).toBe("GMT+9");
		expect(offsetLabel("Not/AZone", at)).toBe("");
	});

	// FB-20: offsets for the trip's dates, both when a zone changes in it.
	it("shows the trip's offsets, both when the clocks change during it", () => {
		// Asia 2027: Oct 2 – Nov 7, 2027; New York leaves EDT on Sun Nov 7.
		expect(
			tripOffsetLabel("America/New_York", "2027-10-02", "2027-11-07"),
		).toBe("GMT-4 → GMT-5 from Nov 7");
		expect(tripOffsetLabel("Asia/Tokyo", "2027-10-02", "2027-11-07")).toBe(
			"GMT+9",
		);
		// A December trip is on EST throughout, whatever today is.
		expect(
			tripOffsetLabel("America/New_York", "2026-12-12", "2026-12-20"),
		).toBe("GMT-5");
		// Southern hemisphere: Sydney starts DST on Sun Oct 3, 2027.
		expect(
			tripOffsetLabel("Australia/Sydney", "2027-10-02", "2027-11-07"),
		).toBe("GMT+10 → GMT+11 from Oct 3");
	});
});

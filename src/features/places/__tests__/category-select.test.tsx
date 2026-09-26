/**
 * A place's category changes where the Places tab shows it: the table's
 * Category cell (without opening the place) and the details panel.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorBody } from "@/features/shell/InspectorBody";
import { N } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { PlacesTab } from "../tab/PlacesTab";
import { PLACES_TAB_TESTID as T } from "../tab/testids";

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

/** Radix opens a select on pointer down, then the option takes a click. */
async function pick(trigger: HTMLElement, name: RegExp) {
	fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
	fireEvent.click(await screen.findByRole("option", { name }));
}

describe("the category in the Places tab", () => {
	it("changes in the table's cell, without opening the place", async () => {
		const { ws } = renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places", pv: "table" },
		});
		const row = screen
			.getAllByTestId(T.row)
			.find((r) => r.getAttribute("data-row-id") === N.sensoji) as HTMLElement;
		const cell = within(row).getByRole("combobox", { name: "Category" });
		await pick(cell, /^Museum$/);
		await vi.waitFor(() =>
			expect(calls.updateNode).toEqual([
				{ nodeId: N.sensoji, patch: { category: "museum" } },
			]),
		);
		expect(ws().sel).toBeNull();
	});

	it("changes in the place's panel", async () => {
		// The panel the shell shows beside the map (the tab docks the same one when wide).
		renderWithWorkspace(<InspectorBody onClose={() => {}} />, {
			search: { tab: "places", pv: "table", sel: `n.${N.sensoji}` },
		});
		await pick(
			await screen.findByRole("combobox", { name: "Category" }),
			/^Museum$/,
		);
		await vi.waitFor(() =>
			expect(calls.updateNode.at(-1)).toMatchObject({
				nodeId: N.sensoji,
				patch: { category: expect.any(String) },
			}),
		);
	});
});

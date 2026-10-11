/**
 * Trash's grid: days left on each tile, the storage note, Select → Restore
 * (only what can come back; Undo puts it back) and Delete N (asks first);
 * the wording helpers.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daysLeft, daysLeftLabel, restoreLabel } from "../lib";
import { TrashGrid } from "../TrashPage";
import { TRASH_TESTID as T } from "../testids";
import type { TrashItem } from "../types";

const calls = vi.hoisted(() => ({
	restored: [] as unknown[],
	retrashed: [] as unknown[],
	deleted: [] as unknown[],
	undo: null as null | (() => void),
}));

vi.mock("../trash.functions", () => ({
	listTrashItems: async () => [],
	restoreTrashItems: async (o: { data: { ids: string[] } }) => {
		calls.restored.push(o.data);
		return o.data.ids.map((id) => ({ id, to: "here", trashedAt: 1 }));
	},
	retrashItems: async (o: { data: unknown }) => {
		calls.retrashed.push(o.data);
		return { ok: true };
	},
	deleteTrashItems: async (o: { data: { ids: string[] } }) => {
		calls.deleted.push(o.data);
		return { count: o.data.ids.length };
	},
	emptyTrashItems: async () => ({ count: 0 }),
}));
vi.mock("@/functions/storage.functions", () => ({
	getStorageUsage: async () => ({ usedBytes: 2048, quotaBytes: 4096 }),
}));
vi.mock("sonner", () => ({
	toast: Object.assign(
		(_t: string, o?: { action?: { onClick: () => void } }) => {
			calls.undo = o?.action?.onClick ?? null;
		},
		{ success: () => {}, error: () => {} },
	),
}));

afterEach(cleanup);

const DAY = 86_400_000;
const item = (id: string, o: Partial<TrashItem> = {}): TrashItem => ({
	id,
	kind: "photo",
	name: null,
	from: "Japan 2027 · Fushimi Inari",
	sizeBytes: 1024,
	count: 1,
	thumb: null,
	thumbhash: null,
	trashedAt: Date.now() - 2 * DAY,
	restoreTo: "here",
	restoreName: null,
	...o,
});

function renderGrid(items: TrashItem[]) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TrashGrid items={items} pending={false} />
		</QueryClientProvider>,
	);
}

describe("wording", () => {
	it("days left and where Restore puts it", () => {
		const now = Date.now();
		expect(daysLeft(now - 2 * DAY, now)).toBe(28);
		expect(daysLeftLabel(now - 29.5 * DAY, now)).toBe("1 day left");
		expect(daysLeftLabel(now - 31 * DAY, now)).toBe("Deleted today");
		expect(restoreLabel({ restoreTo: "place", restoreName: "Kyoto" })).toBe(
			"To Kyoto",
		);
		expect(restoreLabel({ restoreTo: null, restoreName: null })).toMatch(
			/Can't be restored/,
		);
	});
});

describe("the grid", () => {
	it("shows days left and that Trash counts; Select restores what can come back, with Undo", async () => {
		renderGrid([
			item("a:1"),
			item("a:2", {
				kind: "pdf",
				restoreTo: null,
				trashedAt: Date.now() - 28 * DAY,
			}),
		]);
		const tiles = screen.getAllByTestId(T.tile);
		expect(
			tiles.map((t) => within(t).getByTestId(T.daysLeft).textContent),
		).toEqual(["28d", "2d"]);
		expect(screen.getByTestId(T.note).textContent).toMatch(
			/count toward your storage/,
		);
		await waitFor(() =>
			expect(screen.getByTestId(T.note).textContent).toMatch(
				/2 KB in Trash · 2 KB of 4 KB used/,
			),
		);
		fireEvent.click(screen.getByTestId(T.select));
		for (const t of screen.getAllByTestId(T.tile)) fireEvent.click(t);
		expect(screen.getByTestId(T.restoreSelected).textContent).toBe("Restore 1");
		fireEvent.click(screen.getByTestId(T.restoreSelected));
		await waitFor(() => expect(calls.restored).toEqual([{ ids: ["a:1"] }]));
		await waitFor(() => expect(calls.undo).not.toBeNull());
		calls.undo?.();
		await waitFor(() =>
			expect(calls.retrashed).toEqual([
				{ items: [{ id: "a:1", trashedAt: 1 }] },
			]),
		);
	});

	it("Delete N asks first", async () => {
		renderGrid([item("a:1"), item("s:2")]);
		fireEvent.click(screen.getByTestId(T.select));
		for (const t of screen.getAllByTestId(T.tile)) fireEvent.click(t);
		fireEvent.click(screen.getByTestId(T.deleteSelected));
		const confirm = await screen.findByTestId(T.confirm);
		expect(calls.deleted).toEqual([]);
		fireEvent.click(
			within(confirm).getByRole("button", { name: "Delete forever" }),
		);
		await waitFor(() =>
			expect(calls.deleted).toEqual([{ ids: ["a:1", "s:2"] }]),
		);
	});
});

/**
 * Today's data hooks: Done is written into the graph at once (even while
 * suggesting: it's never a proposal) and rolled back on failure; the driver's
 * address comes from the graph, else one lookup that is kept on the place.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
	done: [] as Record<string, unknown>[],
	lookups: [] as Record<string, unknown>[],
	fail: false,
	address: "東京都中野区中野5丁目52-15" as string | null,
	release: null as null | (() => void),
}));

vi.mock("@/functions/items.functions", async (orig) => ({
	...(await orig<typeof import("@/functions/items.functions")>()),
	setItemDone: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
		server.done.push(data);
		await new Promise<void>((r) => {
			server.release = r;
		});
		if (server.fail) throw new Error("boom");
		return { doneAt: data.done ? "2027-10-05T08:10:00.000Z" : null };
	}),
}));
vi.mock("@/features/places/places.functions", async (orig) => ({
	...(await orig<typeof import("@/features/places/places.functions")>()),
	getLocalAddress: vi.fn(
		async ({ data }: { data: Record<string, unknown> }) => {
			server.lookups.push(data);
			if (server.fail) throw new Error("offline");
			return { localAddress: server.address };
		},
	),
}));

import type { TripGraph } from "@/lib/engine/types";
import { demo, N } from "@/lib/fixtures/demo";
import { tripKeys } from "@/lib/query/keys";
import { useUi } from "@/lib/workspace/ui-store";
import { useLocalAddress, useSetItemDone } from "../mutations";

const TRIP = demo.graph.trip.id;
const ITEM = demo.graph.items[0]?.id as string;

function setup() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	qc.setQueryData(tripKeys.graph(TRIP), demo.graph);
	// Keep the graph as written (no refetch in these tests).
	qc.setQueryDefaults(tripKeys.graph(TRIP), { staleTime: Infinity });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	const graph = () => qc.getQueryData<TripGraph>(tripKeys.graph(TRIP));
	return { qc, wrapper, graph };
}

afterEach(() => {
	server.done = [];
	server.lookups = [];
	server.fail = false;
	server.address = "東京都中野区中野5丁目52-15";
	server.release = null;
	useUi.setState({ suggesting: false });
});

describe("useSetItemDone", () => {
	it("marks the stop Done in the graph at once, even while suggesting", async () => {
		useUi.setState({ suggesting: true });
		const { wrapper, graph } = setup();
		const { result } = renderHook(() => useSetItemDone(TRIP), { wrapper });
		act(() =>
			result.current.mutate({ itemId: ITEM, done: true, by: "user-dennis" }),
		);
		await waitFor(() => expect(server.done).toHaveLength(1));
		const item = graph()?.items.find((i) => i.id === ITEM);
		expect(item?.doneBy).toBe("user-dennis");
		expect(Date.parse(item?.doneAt as string)).toBeGreaterThan(0);
		expect(server.done[0]).toEqual({ tripId: TRIP, itemId: ITEM, done: true });
		await act(async () => server.release?.());
	});

	it("Undo clears it; the Undo of an Undo sends the earlier stamp and who", async () => {
		const { wrapper, graph } = setup();
		const { result } = renderHook(() => useSetItemDone(TRIP), { wrapper });
		act(() =>
			result.current.mutate({ itemId: ITEM, done: false, by: "user-dennis" }),
		);
		await waitFor(() => expect(server.done).toHaveLength(1));
		expect(graph()?.items.find((i) => i.id === ITEM)?.doneAt).toBeNull();
		await act(async () => server.release?.());
		const at = "2027-10-05T07:50:00.000Z";
		act(() =>
			result.current.mutate({
				itemId: ITEM,
				done: true,
				by: "user-audrey",
				at,
			}),
		);
		await waitFor(() => expect(server.done).toHaveLength(2));
		expect(server.done[1]).toEqual({
			tripId: TRIP,
			itemId: ITEM,
			done: true,
			at,
			by: "user-audrey",
		});
		expect(graph()?.items.find((i) => i.id === ITEM)).toMatchObject({
			doneAt: at,
			doneBy: "user-audrey",
		});
		await act(async () => server.release?.());
	});

	it("rolls back when the server refuses", async () => {
		server.fail = true;
		const { wrapper, graph } = setup();
		const { result } = renderHook(() => useSetItemDone(TRIP), { wrapper });
		act(() =>
			result.current.mutate({ itemId: ITEM, done: true, by: "user-dennis" }),
		);
		await waitFor(() => expect(server.done).toHaveLength(1));
		expect(graph()?.items.find((i) => i.id === ITEM)?.doneAt).toBeTruthy();
		await act(async () => server.release?.());
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(
			graph()?.items.find((i) => i.id === ITEM)?.doneAt ?? null,
		).toBeNull();
	});
});

describe("useLocalAddress", () => {
	const node = { id: N.itoya as string, lat: 35.67, localAddress: null };

	it("looks it up once and keeps it on the place in the graph", async () => {
		const { wrapper, graph } = setup();
		const { result } = renderHook(() => useLocalAddress(TRIP, node), {
			wrapper,
		});
		await waitFor(() =>
			expect(result.current.localAddress).toBe("東京都中野区中野5丁目52-15"),
		);
		expect(server.lookups).toEqual([{ tripId: TRIP, nodeId: N.itoya }]);
		expect(graph()?.nodes.find((n) => n.id === N.itoya)?.localAddress).toBe(
			"東京都中野区中野5丁目52-15",
		);
	});

	it("uses the place's own address without asking; nothing to ask without coordinates", () => {
		const { wrapper } = setup();
		const { result } = renderHook(
			() =>
				useLocalAddress(TRIP, {
					...node,
					localAddress: "東京都中央区銀座2丁目7-15",
				}),
			{ wrapper },
		);
		expect(result.current.localAddress).toBe("東京都中央区銀座2丁目7-15");
		renderHook(() => useLocalAddress(TRIP, { ...node, lat: null }), {
			wrapper,
		});
		expect(server.lookups).toEqual([]);
	});

	it("is null, never an error, when the lookup fails", async () => {
		server.fail = true;
		const { wrapper } = setup();
		const { result } = renderHook(() => useLocalAddress(TRIP, node), {
			wrapper,
		});
		await waitFor(() => expect(server.lookups).toHaveLength(1));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.localAddress).toBeNull();
	});
});

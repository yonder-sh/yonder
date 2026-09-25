import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meKeys, tripKeys } from "@/lib/query/keys";
import type { CollabClient } from "./collab-client";
import type { ChannelMessage } from "./protocol";
import { TripLiveController } from "./trip-live";

const T = "0192f5a0-0000-7000-8000-000000000001";
const M = "0192f5a0-0000-7000-8000-0000000000aa";

function setup(baseVersion: number | null = 5) {
	const queryClient = new QueryClient();
	const spy = vi.spyOn(queryClient, "invalidateQueries");
	const onFlash = vi.fn();
	const onJob = vi.fn();
	const c = new TripLiveController({} as CollabClient, T, {
		queryClient,
		baseVersion,
		tabId: "me",
		onFlash,
		onJob,
		coalesceMs: 0,
	});
	const invalidated = () => spy.mock.calls.map((call) => call[0]?.queryKey);
	return { c, spy, invalidated, onFlash, onJob };
}

const inv = (
	version: number,
	extra: Partial<Extract<ChannelMessage, { type: "invalidate" }>> = {},
): ChannelMessage => ({
	type: "invalidate",
	tripId: T,
	version,
	keys: ["graph"],
	...extra,
});
const hello = (
	version: number | null,
	memberId: string | null = M,
): ChannelMessage => ({
	type: "hello",
	tripId: T,
	version,
	you: {
		userId: "u",
		memberId,
		role: "editor",
		guest: false,
		color: 1,
		name: "Ada",
	},
});

describe("TripLiveController", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("invalidates the named keys and flashes hints", () => {
		const { c, invalidated, onFlash } = setup();
		const actor = { userId: "u2", name: "Bob", color: 2 };
		c.handleMessage(
			inv(6, {
				keys: ["graph", "lists"],
				hints: [{ kind: "item", id: M }],
				actor,
			}),
		);
		vi.runAllTimers();
		expect(invalidated()).toEqual([
			tripKeys.graph(T),
			tripKeys.legs(T),
			tripKeys.lists(T),
			meKeys.deadlines,
			meKeys.inbox,
		]);
		expect(onFlash).toHaveBeenCalledWith({ kind: "item", id: M }, actor);
		expect(c.getSnapshot().version).toBe(6);
	});

	it("skips its own tab's events but still tracks the version", () => {
		const { c, spy } = setup();
		c.handleMessage(inv(6, { by: "me" }));
		vi.runAllTimers();
		expect(spy).not.toHaveBeenCalled();
		expect(c.getSnapshot().version).toBe(6);
	});

	it("refetches everything when a version was skipped", () => {
		const { c, invalidated } = setup(5);
		c.handleMessage(inv(7, { keys: ["media"] }));
		vi.runAllTimers();
		expect(invalidated()).toEqual([
			tripKeys.trip(T),
			meKeys.deadlines,
			meKeys.inbox,
		]);
	});

	it("does a full refetch on a skipped version even for its own tab's event", () => {
		const { c, invalidated } = setup(5);
		c.handleMessage(inv(7, { by: "me" }));
		vi.runAllTimers();
		expect(invalidated()).toContainEqual(tripKeys.trip(T));
	});

	it("hello: refetches only when the server version differs from what the tab has", () => {
		const same = setup(5);
		same.c.handleMessage(hello(5));
		vi.runAllTimers();
		expect(same.spy).not.toHaveBeenCalled();
		expect(same.c.getSnapshot().you?.memberId).toBe(M);

		const behind = setup(5);
		behind.c.handleMessage(hello(9));
		vi.runAllTimers();
		expect(behind.invalidated()).toContainEqual(tripKeys.trip(T));
		expect(behind.c.getSnapshot().version).toBe(9);

		const unknown = setup(null);
		unknown.c.handleMessage(hello(3));
		vi.runAllTimers();
		expect(unknown.invalidated()).toContainEqual(tripKeys.trip(T));
	});

	it("resync and access refetch everything; mentions only for me; jobs go to onJob", () => {
		const { c, invalidated, onJob } = setup();
		c.handleMessage({ type: "resync", tripId: T });
		vi.runAllTimers();
		expect(invalidated()).toContainEqual(tripKeys.trip(T));

		const m = setup();
		m.c.handleMessage(hello(5));
		m.c.handleMessage({
			type: "mention",
			tripId: T,
			memberIds: ["0192f5a0-0000-7000-8000-0000000000bb"],
		});
		vi.runAllTimers();
		expect(m.invalidated()).not.toContainEqual(meKeys.mentions);
		m.c.handleMessage({ type: "mention", tripId: T, memberIds: [M] });
		vi.runAllTimers();
		expect(m.invalidated()).toContainEqual(meKeys.mentions);
		expect(m.invalidated()).toContainEqual(meKeys.inbox);

		const job = {
			type: "job",
			tripId: T,
			kind: "autofill",
			remaining: 3,
			total: 10,
		} as const;
		c.handleMessage(job);
		expect(onJob).toHaveBeenCalledWith(job);
	});

	it("merges a burst into one invalidation per key", () => {
		const { c, spy } = setup();
		for (let v = 6; v < 16; v++) c.handleMessage(inv(v, { keys: ["media"] }));
		vi.runAllTimers();
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

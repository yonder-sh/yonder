import { describe, expect, it } from "vitest";
import {
	bufferItem,
	EVENT_WINDOW_MS,
	MemoryCoalesceStore,
	REMINDER_WINDOW_MS,
	takeItems,
} from "./coalesce";
import { buildPayload } from "./payload";
import type { PushItem } from "./types";

const TRIP = { id: "trip-1", name: "Asia 2027", slug: "asia-2027" };

const suggestion = (n: number, actor = "Maya"): PushItem => ({
	key: `review.p${n}`,
	at: 1_000 + n,
	actor,
	headline: `${actor} suggested a change`,
	body: `change ${n}`,
	url: `/t/asia-2027?sel=p.${n}`,
	meta: { label: `change ${n}` },
});

describe("coalescing", () => {
	it("the first event opens a ~2 min window; the rest ride along into one notification", async () => {
		const store = new MemoryCoalesceStore();
		const target = {
			userId: "u-dennis",
			tripId: TRIP.id,
			group: "review" as const,
		};
		const scheduled: number[] = [];
		for (let i = 1; i <= 5; i++)
			await bufferItem(store, target, suggestion(i), async (ms) =>
				scheduled.push(ms),
			);
		expect(scheduled).toEqual([EVENT_WINDOW_MS]);
		expect(EVENT_WINDOW_MS).toBe(120_000);

		const items = await takeItems(store, target);
		expect(items).toHaveLength(5);
		const p = buildPayload("review", items, TRIP);
		expect(p?.title).toBe("Asia 2027 · Maya made 5 suggestions");
		expect(p?.body).toBe("change 5, change 4, change 3 and 2 more");

		// The window is closed: the next event opens a new one.
		expect(await takeItems(store, target)).toEqual([]);
		await bufferItem(store, target, suggestion(6), async (ms) =>
			scheduled.push(ms),
		);
		expect(scheduled).toHaveLength(2);
	});

	it("keeps people, trips and groups apart", async () => {
		const store = new MemoryCoalesceStore();
		const opened: string[] = [];
		const add = (userId: string, tripId: string, group: "review" | "mention") =>
			bufferItem(store, { userId, tripId, group }, suggestion(1), async () =>
				opened.push(`${userId}/${tripId}/${group}`),
			);
		await add("u-a", "t1", "review");
		await add("u-b", "t1", "review");
		await add("u-a", "t2", "review");
		await add("u-a", "t1", "mention");
		await add("u-a", "t1", "review");
		expect(opened).toEqual([
			"u-a/t1/review",
			"u-b/t1/review",
			"u-a/t2/review",
			"u-a/t1/mention",
		]);
	});

	it("reminders only merge when due together (short window)", async () => {
		const store = new MemoryCoalesceStore();
		const windows: number[] = [];
		await bufferItem(
			store,
			{ userId: "u", tripId: "t", group: "booking" },
			suggestion(1),
			async (ms) => windows.push(ms),
		);
		expect(windows).toEqual([REMINDER_WINDOW_MS]);
	});

	it("one entry per key (the newest), oldest first; junk dropped", async () => {
		const store = new MemoryCoalesceStore();
		const target = { userId: "u", tripId: "t", group: "changes" as const };
		const noop = async () => {};
		await bufferItem(store, target, { ...suggestion(2), at: 50 }, noop);
		await bufferItem(store, target, { ...suggestion(1), at: 10 }, noop);
		await bufferItem(
			store,
			target,
			{ ...suggestion(1), at: 90, body: "newer" },
			noop,
		);
		await store.append("u|t|changes", "not json", 1);
		await store.append("u|t|changes", JSON.stringify({ key: 1 }), 1);
		const items = await takeItems(store, target);
		expect(items.map((i) => [i.key, i.at, i.body])).toEqual([
			["review.p2", 50, "change 2"],
			["review.p1", 90, "newer"],
		]);
	});
});

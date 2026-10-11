import { afterEach, describe, expect, it, vi } from "vitest";

// Redis is down: BullMQ's add waits in its offline queue and never settles.
vi.mock("bullmq", () => ({
	Queue: class {
		on() {}
		add() {
			return new Promise(() => {});
		}
	},
}));
vi.mock("./redis.server", () => ({
	key: (...p: string[]) => p.join(":"),
	redis: () => ({}),
	redisForBull: () => ({}),
}));

const { ENQUEUE_TIMEOUT_MS, enqueue } = await import("./jobs.server");

afterEach(() => vi.useRealTimers());

describe("enqueue", () => {
	it("gives up after a short wait when Redis doesn't answer", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const p = enqueue("autofill", "test.ping", {
			tripId: "01900000-0000-7000-8000-000000000001",
		});
		await vi.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS);
		await expect(p).resolves.toBeNull();
	});
});

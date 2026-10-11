import { describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({
	get: vi.fn(),
	set: vi.fn(),
}));
vi.mock("@/server/cache.server", () => ({
	cacheGet: cache.get,
	cacheSet: cache.set,
}));

const { linkMeta } = await import("../server/preview.server");

const stub = async (url: string) => ({
	status: 200,
	headers: {},
	finalUrl: url,
	contentType: "application/json",
	body: Buffer.from(
		JSON.stringify({ title: "Fresh title", author_name: "Rail Fan" }),
	),
});

describe("linkMeta and the cache", () => {
	it("a Refresh fetches again and stores the new answer", async () => {
		cache.get.mockResolvedValue({ ok: false, title: null });
		const url = "https://youtu.be/abcdefghijk";
		expect(await linkMeta(url, stub)).toMatchObject({ ok: false });
		const fresh = await linkMeta(url, stub, { fresh: true });
		expect(fresh).toMatchObject({ ok: true, title: "Fresh title" });
		expect(cache.set).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ title: "Fresh title" }),
			expect.any(Number),
		);
	});
});

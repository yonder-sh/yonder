import { describe, expect, it } from "vitest";
import { authErrorKind, settled } from "./auth-errors";

describe("settled", () => {
	it("turns a dropped connection into a network error instead of throwing", async () => {
		const r = await settled<{ data: null; error: null }>(
			Promise.reject(new TypeError("Failed to fetch")),
		);
		expect(r.data).toBeNull();
		expect(authErrorKind(r.error as { status: number })).toBe("network");
	});

	it("passes an answer through", async () => {
		const ok = { data: { ok: true }, error: null };
		expect(await settled(Promise.resolve(ok))).toBe(ok);
	});
});

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
	authorizeConnection,
	betterAuthSessionLookup,
	CollabAuthError,
	type SessionApi,
} from "./auth";

const failing: SessionApi = {
	api: {
		getSession: async () => {
			throw new Error("redis down");
		},
	},
};

describe("session lookup", () => {
	it("a lookup error throws, so it never reads as signed out", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const lookup = betterAuthSessionLookup(failing);
		await expect(lookup(new Headers())).rejects.toThrow("redis down");
		const refused = await authorizeConnection(
			{ pool: {} as pg.Pool, lookupSession: lookup },
			{
				doc: { tripId: "t", target: { kind: "channel" } } as never,
				requestHeaders: new Headers(),
				token: "cookie",
			},
		).catch((e: unknown) => e);
		// Not CollabAuthError(unauthorized): onAuthenticate answers `unavailable`.
		expect(refused).not.toBeInstanceOf(CollabAuthError);
	});

	it("no session is null", async () => {
		const lookup = betterAuthSessionLookup({
			api: { getSession: async () => null },
		});
		expect(await lookup(new Headers())).toBeNull();
	});
});

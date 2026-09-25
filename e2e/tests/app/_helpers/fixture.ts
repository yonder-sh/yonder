/**
 * Each spec clones its own trip (SPEC §18.5): `POST /api/test/fixture` makes a
 * fresh copy of the demo trip owned by the caller, under a random slug, with
 * fresh share tokens. Never use the seeded `demo` trip directly.
 */
import type { APIRequestContext } from "@playwright/test";
import { APP_URL, assertNotMainStack } from "./env";

export type FixtureClone = {
	tripId: string;
	slug: string;
	shareTokens: { editor: string; viewer: string };
	ids: {
		items: Record<string, string>;
		days: Record<string, string>;
		nodes: Record<string, string>;
		legs: Record<string, string>;
	};
	members: { owner: string; maya: string | null; audrey: string };
	/** With `{ proposals: true }`: Maya's seeded suggestions. */
	proposals?: { ids: string[]; skipped: { op: string; reason: string }[] };
};

export type FixtureOptions = {
	/** Maya's role in the clone (default editor). */
	mayaRole?: "editor" | "suggester" | "viewer";
	/** Seed the demo's suggestions by Maya through the real propose path. */
	proposals?: boolean;
};

export async function cloneFixtureTrip(
	request: APIRequestContext,
	opts: FixtureOptions = {},
): Promise<FixtureClone> {
	assertNotMainStack();
	const res = await request.post("/api/test/fixture", {
		headers: { Origin: APP_URL },
		...(Object.keys(opts).length ? { data: opts } : {}),
	});
	if (res.status() === 404) throw new Error("POST /api/test/fixture is off: run the app with ENABLE_TEST_ROUTES=1");
	if (res.status() === 403) throw new Error(`POST /api/test/fixture refused: ${await res.text()}`);
	if (!res.ok()) throw new Error(`fixture ${res.status()}: ${await res.text()}`);
	return (await res.json()) as FixtureClone;
}

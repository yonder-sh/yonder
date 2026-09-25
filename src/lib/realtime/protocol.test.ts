import { describe, expect, it } from "vitest";
import {
	channelDocName,
	hintsFor,
	noteDocName,
	parseChannelMessage,
	parseDocName,
	parseTripEvent,
} from "./protocol";

const T = "0192f5a0-0000-7000-8000-000000000001";
const N = "0192f5a0-0000-7000-8000-0000000000aa";

describe("parseDocName", () => {
	it("parses the channel and every note kind", () => {
		expect(parseDocName(`trip/${T}`)).toEqual({
			kind: "channel",
			name: `trip/${T}`,
			tripId: T,
		});
		expect(parseDocName(`trip/${T}/root`)).toMatchObject({
			kind: "note",
			tripId: T,
			target: { kind: "root" },
		});
		for (const kind of ["node", "leg", "item", "day"] as const) {
			expect(parseDocName(`trip/${T}/${kind}/${N}`)).toMatchObject({
				kind: "note",
				tripId: T,
				target: { kind, id: N },
			});
		}
	});

	it.each([
		"",
		"trip/",
		`trip/${T}/`,
		`trip/${T.toUpperCase()}`,
		`trip/${T}/root/x`,
		`trip/${T}/node/${N}/x`,
		`trip/${T}/nodes/${N}`,
		`trip/${T}/../${N}`,
		`trip:${T}:live`,
		` trip/${T}`,
		`trip/${T}\n`,
		`trip/not-a-uuid-at-all-but-36-chars-long!!`,
		`trip/${T}/node/${N.slice(0, -1)}`,
	])("rejects %j", (name) => {
		expect(parseDocName(name)).toBeNull();
	});

	it("parses a member's private note (ADDENDUM §7.2)", () => {
		const U = "abcDEF123_-xyzABCdef4567890abcd";
		expect(parseDocName(`trip/${T}/node/${N}/u/${U}`)).toMatchObject({
			kind: "note",
			target: { kind: "node", id: N },
			ownerUserId: U,
		});
		expect(parseDocName(`trip/${T}/root/u/${U}`)).toMatchObject({
			target: { kind: "root" },
			ownerUserId: U,
		});
		expect(parseDocName(`trip/${T}/node/${N}`)).toMatchObject({
			ownerUserId: null,
		});
		expect(noteDocName(T, { kind: "item", itemId: N }, U)).toBe(
			`trip/${T}/item/${N}/u/${U}`,
		);
		for (const bad of [
			`trip/${T}/u/${U}`,
			`trip/${T}/node/${N}/u/`,
			`trip/${T}/node/${N}/u/a b`,
			`trip/${T}/node/${N}/u/${"x".repeat(65)}`,
		])
			expect(parseDocName(bad)).toBeNull();
	});

	it("rejects non-strings", () => {
		expect(parseDocName(undefined)).toBeNull();
		expect(parseDocName(42)).toBeNull();
	});

	it("builds names the parser accepts", () => {
		expect(parseDocName(channelDocName(T))?.kind).toBe("channel");
		expect(noteDocName(T, { kind: "trip" })).toBe(`trip/${T}/root`);
		expect(noteDocName(T, { kind: "leg", legId: N })).toBe(
			`trip/${T}/leg/${N}`,
		);
		expect(
			parseDocName(noteDocName(T, { kind: "day", dayId: N })),
		).toMatchObject({
			target: { kind: "day", id: N },
		});
	});
});

describe("channel messages", () => {
	it("accepts a valid invalidate and strips unknown fields", () => {
		const m = parseChannelMessage(
			JSON.stringify({
				type: "invalidate",
				tripId: T,
				version: 3,
				keys: ["graph"],
				evil: "<script>",
			}),
		);
		expect(m).toEqual({
			type: "invalidate",
			tripId: T,
			version: 3,
			keys: ["graph"],
		});
	});

	it.each([
		"not json",
		JSON.stringify({ type: "invalidate", tripId: T, version: 1, keys: [] }),
		JSON.stringify({
			type: "invalidate",
			tripId: T,
			version: 1,
			keys: ["nope"],
		}),
		JSON.stringify({
			type: "invalidate",
			tripId: "x",
			version: 1,
			keys: ["graph"],
		}),
		JSON.stringify({
			type: "invalidate",
			tripId: T,
			version: -1,
			keys: ["graph"],
		}),
		JSON.stringify({ type: "explode", tripId: T }),
	])("rejects %s", (raw) => {
		expect(parseChannelMessage(raw)).toBeNull();
	});

	it("never lets a hello travel as a trip event", () => {
		const hello = JSON.stringify({
			type: "hello",
			tripId: T,
			version: 1,
			you: {
				userId: "u",
				memberId: null,
				role: "viewer",
				guest: true,
				color: 0,
				name: "G",
			},
		});
		expect(parseChannelMessage(hello)?.type).toBe("hello");
		expect(parseTripEvent(hello)).toBeNull();
	});
});

describe("hintsFor", () => {
	it("makes hints only for flashable entities, capped at 40", () => {
		const ids = Array.from({ length: 50 }, () => N);
		expect(hintsFor("item", ids)).toHaveLength(40);
		expect(hintsFor("attachment", [N])).toBeUndefined();
		expect(hintsFor("node", ["not-a-uuid"])).toEqual([]);
	});
});

/**
 * The relay's delivery rules without Redis or sockets (`Relay.handle`): an
 * `invalidate` with `userIds` (a private note's store, ADDENDUM §7.2; QA
 * NOTE-VERSION-CONFLICT) reaches only those users' channel connections, so
 * nobody else learns that someone typed in a private note.
 */
import type { Hocuspocus } from "@hocuspocus/server";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { channelDocName, type TripEvent } from "@/lib/realtime/protocol";
import { startRelay } from "./relay";

const TRIP = "0192f5a0-0000-7000-8000-000000000001";
const PATTERN = "rtest:trip:*";

type FakeConn = { context?: { userId: string }; got: string[] };

function setup() {
	const conns: FakeConn[] = [
		{ context: { userId: "u-dev" }, got: [] },
		{ context: { userId: "u-dev" }, got: [] }, // his second tab
		{ context: { userId: "u-maya" }, got: [] },
		{ got: [] }, // not authenticated yet
	];
	const channel = {
		getConnections: () => conns,
		relayStateless(payload: string, filter?: (c: FakeConn) => boolean) {
			for (const c of conns) if (!filter || filter(c)) c.got.push(payload);
		},
	};
	const hocuspocus = {
		documents: new Map([[channelDocName(TRIP), channel]]),
	} as unknown as Hocuspocus;
	const sub = {
		status: "end",
		on() {},
		off() {},
		disconnect() {},
	} as unknown as Redis;
	const relay = startRelay({
		hocuspocus,
		sub,
		pattern: PATTERN,
		log: () => {},
	});
	const send = (e: TripEvent) =>
		relay.handle(`rtest:trip:${TRIP}`, JSON.stringify(e));
	const who = () =>
		conns.map((c) => `${c.context?.userId ?? "anon"}:${c.got.length}`);
	return { send, who };
}

describe("relay delivery", () => {
	it("a private note's invalidate reaches only its owner's connections", () => {
		const { send, who } = setup();
		send({
			type: "invalidate",
			tripId: TRIP,
			version: 4,
			keys: ["notes", "counts"],
			userIds: ["u-dev"],
		});
		expect(who()).toEqual(["u-dev:1", "u-dev:1", "u-maya:0", "anon:0"]);
	});

	it("an invalidate without userIds still reaches everyone on the channel", () => {
		const { send, who } = setup();
		send({ type: "invalidate", tripId: TRIP, version: 4, keys: ["notes"] });
		expect(who()).toEqual(["u-dev:1", "u-dev:1", "u-maya:1", "anon:1"]);
	});
});

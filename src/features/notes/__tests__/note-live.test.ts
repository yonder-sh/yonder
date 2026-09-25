/**
 * QA RT-12 (COLLAB-R2-04): a short realtime outage ("Reconnecting…") keeps
 * the live note on screen and writable, so the line just typed stays in view
 * and typing goes on (Yjs syncs it once on reconnect). Offline, a refused
 * document and a read-only answer still stop it.
 */
import { describe, expect, it } from "vitest";
import type { DocSnapshot } from "@/lib/realtime/collab-client";
import type { ConnectionState } from "@/lib/workspace/model-context";
import { type NoteHold, noteLiveState } from "../note-live";

const DOC = "note:trip-1:node:n-1";

type Snap = DocSnapshot & { canWrite: boolean };
const synced: Snap = {
	status: "authenticated",
	synced: true,
	readOnly: false,
	reason: null,
	canWrite: true,
};
/** What collab-client sets on every document when the socket drops. */
const dropped: Snap = {
	...synced,
	status: "connecting",
	synced: false,
	canWrite: false,
};
const reauthed: Snap = { ...synced, synced: false };

/** Runs a sequence of (snapshot, connection) renders, like NoteEditor does. */
function run(
	steps: [Snap, ConnectionState][],
	opts: { allowWrite?: boolean; docName?: string } = {},
) {
	let hold: NoteHold = null;
	return steps.map(([snap, connection]) => {
		const s = noteLiveState({
			docName: opts.docName ?? DOC,
			snap,
			connection,
			allowWrite: opts.allowWrite ?? true,
			hold,
		});
		hold = s.hold;
		return { live: s.live, writable: s.writable };
	});
}

describe("noteLiveState (QA RT-12)", () => {
	it("never shows or writes before the first sync", () => {
		expect(
			run([
				[{ ...dropped }, "connecting"],
				[{ ...reauthed }, "live"],
			]),
		).toEqual([
			{ live: false, writable: false },
			{ live: false, writable: false },
		]);
	});

	it("rides out a socket drop: visible and writable while reconnecting, until it syncs again", () => {
		expect(
			run([
				[synced, "live"],
				[dropped, "reconnecting"], // the collab server stops
				[dropped, "reconnecting"], // Dennis keeps typing
				[dropped, "live"], // the socket is back, the document re-authenticates
				[reauthed, "live"], // authenticated, sync in flight
				[synced, "live"], // synced once
			]),
		).toEqual([
			{ live: true, writable: true },
			{ live: true, writable: true },
			{ live: true, writable: true },
			{ live: true, writable: true },
			{ live: true, writable: true },
			{ live: true, writable: true },
		]);
	});

	it("offline (down > 10 s, or navigator offline) is read-only: the saved copy shows", () => {
		expect(
			run([
				[synced, "live"],
				[dropped, "reconnecting"],
				[dropped, "offline"],
				[dropped, "live"],
				[synced, "live"],
			]),
		).toEqual([
			{ live: true, writable: true },
			{ live: true, writable: true },
			{ live: false, writable: false },
			{ live: true, writable: true },
			{ live: true, writable: true },
		]);
	});

	it("a viewer keeps the read-only editor through a reconnect, never writable", () => {
		const ro: Snap = { ...synced, readOnly: true, canWrite: false };
		expect(
			run([
				[ro, "live"],
				[{ ...dropped, readOnly: true }, "reconnecting"],
				[ro, "live"],
			]),
		).toEqual([
			{ live: true, writable: false },
			{ live: true, writable: false },
			{ live: true, writable: false },
		]);
		// And nobody writes where the page says they may not.
		expect(
			run(
				[
					[synced, "live"],
					[dropped, "reconnecting"],
				],
				{ allowWrite: false },
			),
		).toEqual([
			{ live: true, writable: false },
			{ live: true, writable: false },
		]);
	});

	it("a restarting server closes the document before the socket: still no gap", () => {
		expect(
			run([
				[synced, "live"],
				[dropped, "live"], // the server closed the document; the socket is still open
				[dropped, "reconnecting"], // then the socket
				[reauthed, "live"],
				[synced, "live"],
			]),
		).toEqual([
			{ live: true, writable: true },
			{ live: true, writable: true },
			{ live: true, writable: true },
			{ live: true, writable: true },
			{ live: true, writable: true },
		]);
	});

	it("a downgrade (the document re-authenticates read-only) stops the typing", () => {
		expect(
			run([
				[synced, "live"],
				[dropped, "live"],
				[{ ...reauthed, readOnly: true, canWrite: false }, "live"],
				[{ ...synced, readOnly: true, canWrite: false }, "live"],
			]),
		).toEqual([
			{ live: true, writable: true },
			{ live: true, writable: true },
			{ live: true, writable: false },
			{ live: true, writable: false },
		]);
	});

	it("a refused document (removed member) drops the live editor", () => {
		const denied: Snap = {
			status: "denied",
			synced: false,
			readOnly: false,
			reason: "forbidden",
			canWrite: false,
		};
		expect(
			run([
				[synced, "live"],
				[dropped, "reconnecting"],
				[denied, "live"],
				[dropped, "live"],
			]),
		).toEqual([
			{ live: true, writable: true },
			{ live: true, writable: true },
			{ live: false, writable: false },
			{ live: false, writable: false },
		]);
	});

	it("a read-only answer after the outage stops the typing", () => {
		expect(
			run([
				[synced, "live"],
				[dropped, "reconnecting"],
				[{ ...reauthed, readOnly: true, canWrite: false }, "live"],
			]),
		).toEqual([
			{ live: true, writable: true },
			{ live: true, writable: true },
			{ live: true, writable: false },
		]);
	});

	it("the hold is per document: another note starts from scratch", () => {
		let hold: NoteHold = null;
		hold = noteLiveState({
			docName: DOC,
			snap: synced,
			connection: "live",
			allowWrite: true,
			hold,
		}).hold;
		const other = noteLiveState({
			docName: "note:trip-1:node:n-2",
			snap: dropped,
			connection: "reconnecting",
			allowWrite: true,
			hold,
		});
		expect(other).toMatchObject({ live: false, writable: false, hold: null });
	});
});

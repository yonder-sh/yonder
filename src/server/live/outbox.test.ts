import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { MAX_EVENT_BYTES, TripEvent } from "@/lib/realtime/protocol";
import {
	accessEvent,
	createWithTripTx,
	enqueueAutofill,
	type OutboxDeps,
	TxOutbox,
} from "./outbox.server";

const T = "0192f5a0-0000-7000-8000-000000000001";
const I = "0192f5a0-0000-7000-8000-0000000000aa";

function fakeDeps() {
	const published: TripEvent[] = [];
	const enqueued: unknown[][] = [];
	const deps: OutboxDeps = {
		publish: async (e) => {
			published.push(e);
		},
		enqueue: async (...args) => {
			enqueued.push(args);
		},
	};
	return { deps, published, enqueued };
}

describe("TxOutbox", () => {
	it("merges emits into one invalidate with the version, tab and actor", () => {
		const out = new TxOutbox(T, {
			by: "tab-1",
			actor: { userId: "u", name: "Ada", color: 2 },
		});
		out.version = 7;
		out
			.emit({ entity: "item", ids: [I] })
			.emit({ keys: ["counts"] })
			.emit({ entity: "item", ids: [I] });
		expect(out.events()).toEqual([
			{
				type: "invalidate",
				tripId: T,
				version: 7,
				keys: ["graph", "activity", "counts"],
				by: "tab-1",
				actor: { userId: "u", name: "Ada", color: 2 },
				hints: [{ kind: "item", id: I }],
			},
		]);
	});

	it("puts access first and adds sharing+graph; mentions carry no version", () => {
		const out = new TxOutbox(T);
		out.version = 2;
		out.access(["u1"]).access(["u2"]).mention([I]);
		const events = out.events();
		expect(events.map((e) => e.type)).toEqual([
			"access",
			"invalidate",
			"mention",
		]);
		expect(events[0]).toEqual({
			type: "access",
			tripId: T,
			version: 2,
			userIds: ["u1", "u2"],
		});
		expect(events[1]).toMatchObject({ keys: ["sharing", "graph"] });
		out.access(); // everyone
		expect(out.events()[0]).toEqual({ type: "access", tripId: T, version: 2 });
	});
});

describe("TxOutbox.notes (QA P1: a removed day's note documents)", () => {
	it("publishes valid `notes` events in small chunks, never as a `gone` a doc that moved", () => {
		const out = new TxOutbox(T);
		out.version = 3;
		const day = (n: number) =>
			`trip/${T}/day/0192f5a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
		const gone = Array.from({ length: 45 }, (_, i) => day(i));
		const moved = [{ from: `${day(1)}/u/u-dev`, to: `trip/${T}/root/u/u-dev` }];
		out.notes({ gone: [...gone, moved[0]?.from as string], moved });
		const events = out.events().filter((e) => e.type === "notes");
		expect(events).toHaveLength(3);
		for (const e of events) {
			expect(TripEvent.safeParse(e).success).toBe(true);
			expect(JSON.stringify(e).length).toBeLessThan(MAX_EVENT_BYTES);
		}
		const all = events.flatMap((e) => (e.type === "notes" ? e.gone : []));
		expect(all).toEqual(gone);
		expect(events[0]?.type === "notes" && events[0].moved).toEqual(moved);
	});
});

describe("createWithTripTx", () => {
	type FakeTx = { execute(q: SQL): Promise<unknown>; log: string[] };

	function fakeDb(version: number) {
		const log: string[] = [];
		const db = {
			log,
			async transaction<R>(fn: (tx: FakeTx) => Promise<R>): Promise<R> {
				log.push("begin");
				const tx: FakeTx = {
					log,
					execute: async (q: SQL) => {
						const text = q.queryChunks
							.map((c) =>
								typeof c === "object" && c && "value" in c
									? (c.value as string[]).join("")
									: "?",
							)
							.join("");
						log.push(
							text.includes("advisory")
								? "lock"
								: text.includes("update trips")
									? "bump"
									: "sql",
						);
						return { rows: [{ version }] };
					},
				};
				try {
					const r = await fn(tx);
					log.push("commit");
					return r;
				} catch (e) {
					log.push("rollback");
					throw e;
				}
			},
		};
		return db;
	}

	it("locks, bumps the version, and publishes/enqueues only after COMMIT", async () => {
		const db = fakeDb(42);
		const { deps, published, enqueued } = fakeDeps();
		const publish = vi.fn(deps.publish);
		const withTripTx = createWithTripTx(db, {
			publish: async (e) => {
				db.log.push("publish");
				await publish(e);
			},
			enqueue: async (...a) => {
				db.log.push("enqueue");
				await deps.enqueue(...a);
			},
		});
		const result = await withTripTx(T, async (_tx, out) => {
			expect(out.version).toBe(42);
			out.emit({ keys: ["media"] });
			out.job("media", "media.variants", { tripId: T, attachmentId: I });
			return "ok";
		});
		expect(result).toBe("ok");
		expect(db.log).toEqual([
			"begin",
			"lock",
			"bump",
			"commit",
			"publish",
			"enqueue",
		]);
		expect(published[0]).toMatchObject({
			type: "invalidate",
			version: 42,
			keys: ["media"],
		});
		expect(enqueued[0]?.slice(0, 2)).toEqual(["media", "media.variants"]);
	});

	it("publishes nothing when the transaction fails", async () => {
		const db = fakeDb(1);
		const { deps, published, enqueued } = fakeDeps();
		const withTripTx = createWithTripTx(db, deps);
		await expect(
			withTripTx(T, async (_tx, out) => {
				out.emit({ keys: ["graph"] }).job("links", "links.preview", {
					tripId: T,
					attachmentId: I,
					url: "https://example.com",
				});
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(published).toEqual([]);
		expect(enqueued).toEqual([]);
		expect(db.log.at(-1)).toBe("rollback");
	});

	it("bumpVersion: false (a note body) locks but keeps the version, and the event carries the current one (QA NOTE-VERSION-CONFLICT)", async () => {
		const db = fakeDb(9);
		const { deps, published } = fakeDeps();
		const withTripTx = createWithTripTx(db, deps);
		await withTripTx(
			T,
			async (_tx, out) => {
				expect(out.version).toBe(9);
				out.emit({ keys: ["notes", "counts"] });
			},
			{ bumpVersion: false },
		);
		expect(db.log).toEqual(["begin", "lock", "sql", "commit"]);
		expect(published).toEqual([
			{
				type: "invalidate",
				tripId: T,
				version: 9,
				keys: ["notes", "counts"],
			},
		]);
	});
});

describe("TxOutbox audience (a private note's owner, ADDENDUM §7.2)", () => {
	it("targets the invalidate at those users only; an empty audience publishes none", () => {
		const out = new TxOutbox(T, { audience: ["u-dev", "u-dev"] });
		out.version = 4;
		out.emit({ keys: ["notes", "counts"] });
		const [e] = out.events();
		expect(e).toEqual({
			type: "invalidate",
			tripId: T,
			version: 4,
			keys: ["notes", "counts"],
			userIds: ["u-dev"],
		});
		expect(TripEvent.safeParse(e).success).toBe(true);
		const nobody = new TxOutbox(T, { audience: [] });
		nobody.version = 4;
		nobody.emit({ keys: ["notes"] });
		expect(nobody.events()).toEqual([]);
	});
});

describe("enqueueAutofill", () => {
	it("adds one deduplicated job per target, unless autofill is off", async () => {
		const { deps, enqueued } = fakeDeps();
		const out = new TxOutbox(T);
		out.version = 1;
		const J = "0192f5a0-0000-7000-8000-0000000000bb";
		enqueueAutofill(out, [
			{ kind: "pair", fromItemId: I, toItemId: J },
			{ kind: "stay", dayId: J, end: "start" },
		]);
		enqueueAutofill(out, [{ kind: "pair", fromItemId: J, toItemId: I }], {
			enabled: false,
		});
		await out.flush(deps);
		expect(enqueued.map((e) => e[3])).toEqual([
			{ dedupeId: `autofill:${I}>${J}` },
			{ dedupeId: `autofill:stay:${J}:start` },
		]);
	});
});

describe("access events never exceed the publish limit", () => {
	/** A Better Auth user id: 32 url-safe characters. */
	const baId = (i: number) => `${String(i).padStart(6, "0")}${"x".repeat(26)}`;

	it.each([1, 100, 400, 460, 466, 500, 501, 2000])(
		"%i affected users → a publishable event",
		(n) => {
			const out = new TxOutbox(T);
			out.version = 9;
			out.access(Array.from({ length: n }, (_, i) => baId(i)));
			const [ev] = out.events();
			expect(ev?.type).toBe("access");
			expect(JSON.stringify(ev).length).toBeLessThanOrEqual(MAX_EVENT_BYTES);
			expect(TripEvent.safeParse(ev).success).toBe(true);
			if (ev?.type === "access" && ev.userIds)
				expect(ev.userIds).toHaveLength(n);
		},
	);

	it("falls back to everyone when the ids don't fit (466 × 32 chars > 16 KB)", () => {
		const ids = Array.from({ length: 466 }, (_, i) => baId(i));
		expect(accessEvent(T, 1, ids)).toEqual({
			type: "access",
			tripId: T,
			version: 1,
		});
		expect(accessEvent(T, 1, ids.slice(0, 10)).userIds).toHaveLength(10);
	});
});

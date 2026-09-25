/**
 * QA NOTE-VERSION-CONFLICT against real Postgres: typing in a note (the collab
 * store, `storeNoteState`) never makes a reviewed date change fail. A note body
 * isn't structured data (SPEC D10), so it leaves `trips.version` alone; its
 * `invalidate` carries the current version, and a private note's goes to its
 * owner only (ADDENDUM §7.2). Structured edits still refuse a stale review.
 *
 * The store runs with a capturing outbox (no Redis for the note events); the
 * date ops run through the real handlers (`src/test/start-mock.ts`). A
 * throwaway migrated database and REDIS_PREFIX are created and removed.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_nv_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-nvtest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { scratchUrl: scratch.toString() };
});

vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
vi.mock(
	"@tanstack/react-start/server",
	() => import("@/test/start-server-mock"),
);

import { closeDb, getDb, getPool, type Tx } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { user } from "@/db/schema";
import { getTripGraph } from "@/functions/graph.functions";
import { createItem } from "@/functions/items.functions";
import { previewTripDates, setTripDates } from "@/functions/trips.functions";
import { addDays } from "@/lib/engine/time";
import {
	NOTE_FRAGMENT,
	noteDocName,
	type TripEvent,
} from "@/lib/realtime/protocol";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { createWithTripTx } from "@/server/live/outbox.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import type { CollabContext } from "../auth";
import type { CollabDb } from "../db";
import { notesHooks } from "../notes-hooks";
import { storeNoteState } from "../persistence";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T = Record<string, unknown>>(
	fn: unknown,
	u: AuthUser,
	data: unknown,
) => (fn as Fn)({ data, context: { user: u } }) as Promise<T>;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return (
			errorCode(e) ??
			`unexpected: ${e instanceof Error ? e.message : String(e)}`
		);
	}
}

async function newUser(first: string, email: string): Promise<AuthUser> {
	const id = randomUUID();
	await getDb()
		.insert(user)
		.values({
			id,
			email,
			emailVerified: true,
			name: `${first} Test`,
			firstName: first,
			lastName: "Test",
		});
	const [row] = await getDb()
		.select()
		.from(user)
		.where(sql`${user.id} = ${id}`);
	return row as unknown as AuthUser;
}

const U = {} as Record<"dev" | "maya", AuthUser>;
/** Events the note stores published (their outbox never reaches Redis). */
const events: TripEvent[] = [];
let cdb: CollabDb;

async function tripVersion(tripId: string): Promise<number> {
	const r = await getDb().execute(
		sql`select version from trips where id = ${tripId}`,
	);
	return Number((r.rows[0] as { version: string }).version);
}

async function graphOf(tripId: string, as: AuthUser) {
	return call<Awaited<ReturnType<typeof getTripGraph>>>(getTripGraph, as, {
		tripId,
	});
}

/** One collab store of `text` in a note, as `as` typing it (the debounced save). */
async function typeNote(
	c: FixtureClone,
	as: AuthUser,
	opts: { private: boolean; text: string },
) {
	const name = noteDocName(
		c.tripId,
		{ kind: "trip" },
		opts.private ? as.id : undefined,
	);
	const document = new Y.Doc();
	document.transact(() => {
		const p = new Y.XmlElement("paragraph");
		p.insert(0, [new Y.XmlText(opts.text)]);
		document.getXmlFragment(NOTE_FRAGMENT).insert(0, [p]);
	});
	const isMaya = as.id === U.maya.id;
	const context: CollabContext = {
		userId: as.id,
		tripId: c.tripId,
		slug: c.slug,
		role: isMaya ? "editor" : "owner",
		memberId: isMaya ? c.members.maya : c.members.owner,
		guest: false,
		color: isMaya ? 1 : 0,
		name: as.name,
		docKind: "note",
	};
	await storeNoteState(
		{ db: cdb, hooks: notesHooks },
		{
			documentName: name,
			state: Y.encodeStateAsUpdate(document),
			document,
			context,
		},
	);
	const r = await getDb().execute(
		sql`select plain_text as text from yjs_documents where name = ${name}`,
	);
	// Stored (the demo's shared trip note already has text: it is kept too).
	expect((r.rows[0] as { text: string }).text).toContain(opts.text);
	return name;
}

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	U.dev = await newUser("Dev", "dev@example.com");
	// The demo fixture makes maya@example.com an editor of every clone.
	U.maya = await newUser("Maya", "maya@example.com");
	cdb = {
		pool: getPool(),
		db: getDb(),
		withTripTx: createWithTripTx<Tx>(getDb(), {
			publish: async (e) => {
				events.push(e);
				return 1;
			},
			enqueue: async () => {},
		}),
	};
});

afterAll(async () => {
	await closeQueues().catch(() => {});
	const r = redis();
	let cursor = "0";
	do {
		const [next, keys] = await r.scan(
			cursor,
			"MATCH",
			`${redisPrefix()}:*`,
			"COUNT",
			500,
		);
		cursor = next;
		if (keys.length) await r.unlink(...keys);
	} while (cursor !== "0");
	await closeRedis();
	await closeDb();
	await dropDatabase(testEnv.scratchUrl);
});

describe("typing in a note never refuses a reviewed date change (QA NOTE-VERSION-CONFLICT)", () => {
	it("Maya's shared note, then Dev's private note: both date changes apply first time", async () => {
		const c = await cloneDemoTrip(getDb(), U.dev.id);
		expect(c.members.maya).not.toBeNull();
		const g0 = await graphOf(c.tripId, U.dev);
		const start = g0.trip.startDate as string;
		const end = g0.trip.endDate as string;
		const v0 = g0.trip.version;
		events.length = 0;

		// Maya types in the shared trip note; Dev's graph stays at v0.
		await typeNote(c, U.maya, { private: false, text: "Maya was here" });
		expect(await tripVersion(c.tripId)).toBe(v0);
		expect(events).toEqual([
			{
				type: "invalidate",
				tripId: c.tripId,
				version: v0,
				keys: ["notes", "counts"],
				actor: { userId: U.maya.id, name: U.maya.name, color: 1 },
			},
		]);

		// Dev extends the trip by one day with the version he reviewed.
		const later = {
			tripId: c.tripId,
			startDate: start,
			endDate: addDays(end, 1),
		};
		const preview = await call<{ version: number | null }>(
			previewTripDates,
			U.dev,
			later,
		);
		expect(preview.version).toBe(v0);
		expect(
			await codeOf(
				call(setTripDates, U.dev, { ...later, expectedVersion: v0 }),
			),
		).toBe("ok");

		// Maya reviews the new dates; then Dev types privately ("Only me").
		const v1 = (await graphOf(c.tripId, U.maya)).trip.version;
		expect(v1).toBe(v0 + 1);
		events.length = 0;
		await typeNote(c, U.dev, { private: true, text: "just for me" });
		expect(await tripVersion(c.tripId)).toBe(v1);
		// Only Dev's tabs hear about it: no hint for anyone else.
		expect(events).toEqual([
			expect.objectContaining({
				type: "invalidate",
				version: v1,
				keys: ["notes", "counts"],
				userIds: [U.dev.id],
			}),
		]);

		// Maya's change back applies first time.
		expect(
			await codeOf(
				call(setTripDates, U.maya, {
					tripId: c.tripId,
					startDate: start,
					endDate: end,
					expectedVersion: v1,
				}),
			),
		).toBe("ok");
	});

	it("a structured edit after the review still refuses it (the guard stays)", async () => {
		const c = await cloneDemoTrip(getDb(), U.dev.id);
		const g0 = await graphOf(c.tripId, U.dev);
		const v0 = g0.trip.version;
		await typeNote(c, U.maya, { private: false, text: "a note" });
		await call(createItem, U.maya, {
			tripId: c.tripId,
			dayId: c.ids.days.d2,
			title: "Coffee",
		});
		expect(
			await codeOf(
				call(setTripDates, U.dev, {
					tripId: c.tripId,
					startDate: g0.trip.startDate,
					endDate: addDays(g0.trip.endDate as string, 1),
					expectedVersion: v0,
				}),
			),
		).toBe("CONFLICT");
	});
});

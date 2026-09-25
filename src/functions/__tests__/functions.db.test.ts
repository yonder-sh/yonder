/**
 * The foundation's server functions against real Postgres and Redis (SPEC
 * §18.2 F1s acceptance): the permission matrix for the F mutations, flight
 * blocks, re-keying and detached legs, day operations that never lose items,
 * nodes (slugs, zones, rank rules, delete/restore), leg writes with guest
 * redaction and merge, mentions, activity, and the dev seed.
 *
 * The handlers run for real (validator + body) through `src/test/start-mock.ts`;
 * each test passes `context.user` itself. A throwaway migrated database and
 * an isolated REDIS_PREFIX are created and removed around the file.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Before any import runs: modules read DATABASE_URL / REDIS_PREFIX when first
// used, and the auth options build their Redis key prefix at import time.
const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_fn_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-fntest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { hex, scratchUrl: scratch.toString() };
});

vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
vi.mock(
	"@tanstack/react-start/server",
	() => import("@/test/start-server-mock"),
);

import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { tripMembers, user } from "@/db/schema";
import { demo } from "@/lib/fixtures/demo";
import { mentionToken } from "@/lib/notes/mentions";
import { markdownToYdoc } from "@/lib/notes/ydoc.server";
import { noteDocName } from "@/lib/realtime/protocol";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { redeemShareToken } from "@/server/authz/share-links.server";
import {
	cloneDemoTrip,
	type FixtureClone,
	seedDev,
} from "@/server/fixture.server";
import { closeQueues, getQueue } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { deleteDay, insertDay, moveDay, setDayStay } from "../days.functions";
import { getTripGraph, listActivity } from "../graph.functions";
import {
	createItem,
	deleteItem,
	moveItem,
	restoreItem,
	setItemAssignees,
	updateItem,
} from "../items.functions";
import { ensureLeg, getLeg, relinkLeg, setLeg } from "../legs.functions";
import {
	createNode,
	deleteNode,
	moveNode,
	restoreNode,
	setNodePriority,
	updateNode,
} from "../nodes.functions";
import {
	previewTripDates,
	setTripDates,
	shiftTripDates,
	updateTrip,
} from "../trips.functions";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const { hex, scratchUrl } = testEnv;

/** Handlers as the mock exposes them: `({ data, context }) => result`. */
type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T = Record<string, unknown>>(
	fn: unknown,
	user: AuthUser,
	data: unknown,
) => (fn as Fn)({ data, context: { user } }) as Promise<T>;

/** The ErrorCode a call fails with ("ok" when it succeeds). */
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

async function newUser(
	name: { first: string; last: string } | null,
	email?: string,
): Promise<AuthUser> {
	const id = randomUUID();
	const anonymous = name === null;
	await getDb()
		.insert(user)
		.values({
			id,
			email:
				email ??
				`${anonymous ? "temp" : "u"}-${id}@${anonymous ? "guest.yonder.invalid" : "example.test"}`,
			emailVerified: !anonymous,
			name: anonymous ? "Guest Wren" : `${name.first} ${name.last}`,
			firstName: name?.first ?? "",
			lastName: name?.last ?? "",
			isAnonymous: anonymous,
		});
	const [row] = await getDb()
		.select()
		.from(user)
		.where(sql`${user.id} = ${id}`);
	return row as unknown as AuthUser;
}

const U = {} as Record<
	"owner" | "maya" | "viewer" | "stranger" | "guestViewer" | "guestEditor",
	AuthUser
>;

/** A fresh demo trip for one test group; viewer + both guests get access. */
async function freshTrip(): Promise<FixtureClone> {
	const c = await cloneDemoTrip(getDb(), U.owner.id);
	await getDb().insert(tripMembers).values({
		tripId: c.tripId,
		userId: U.viewer.id,
		status: "active",
		role: "viewer",
		color: 5,
	});
	await redeemShareToken(c.shareTokens.viewer, U.guestViewer.id);
	await redeemShareToken(c.shareTokens.editor, U.guestEditor.id);
	return c;
}

async function graphOf(tripId: string) {
	return call<Awaited<ReturnType<typeof getTripGraph>>>(getTripGraph, U.owner, {
		tripId,
	});
}

beforeAll(async () => {
	await ensureDatabase(scratchUrl);
	await migrateDatabase(scratchUrl);
	U.owner = await newUser({ first: "Dev", last: "Owner" });
	U.maya = await newUser({ first: "Maya", last: "Chen" }, "maya@example.com");
	U.viewer = await newUser({ first: "Vic", last: "Viewer" });
	U.stranger = await newUser({ first: "Sam", last: "Stranger" });
	U.guestViewer = await newUser(null);
	U.guestEditor = await newUser(null);
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
	await dropDatabase(scratchUrl);
});

describe("permission matrix (F mutations)", () => {
	it("editors and guest editors write; viewers get 403, strangers 404", async () => {
		const c = await freshTrip();
		const input = { tripId: c.tripId, dayId: c.ids.days.d2, title: "Coffee" };
		expect(await codeOf(call(createItem, U.owner, input))).toBe("ok");
		expect(await codeOf(call(createItem, U.maya, input))).toBe("ok");
		expect(await codeOf(call(createItem, U.guestEditor, input))).toBe("ok");
		expect(await codeOf(call(createItem, U.viewer, input))).toBe("FORBIDDEN");
		expect(await codeOf(call(createItem, U.guestViewer, input))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(createItem, U.stranger, input))).toBe("NOT_FOUND");
		// Reads: viewers and guests read; strangers see nothing.
		expect(
			await codeOf(call(getTripGraph, U.guestViewer, { tripId: c.tripId })),
		).toBe("ok");
		expect(
			await codeOf(call(getTripGraph, U.stranger, { tripId: c.tripId })),
		).toBe("NOT_FOUND");
		// Owner-only: the slug.
		expect(
			await codeOf(
				call(updateTrip, U.maya, { tripId: c.tripId, slug: `x-${hex}` }),
			),
		).toBe("FORBIDDEN");
		// Every F mutation refuses a viewer.
		const viewerCalls: [unknown, unknown][] = [
			[updateItem, { itemId: c.ids.items.hands, patch: { durationMin: 10 } }],
			[moveItem, { itemId: c.ids.items.hands, dayId: null }],
			[deleteItem, { itemId: c.ids.items.hands }],
			[
				createNode,
				{ tripId: c.tripId, parentId: null, type: "country", name: "Laos" },
			],
			[moveNode, { nodeId: c.ids.nodes.itoya, parentId: c.ids.nodes.shibuya }],
			[deleteNode, { nodeId: c.ids.nodes.itoya }],
			[
				setLeg,
				{
					target: {
						kind: "pair",
						fromItemId: c.ids.items.hands,
						toItemId: c.ids.items.loft,
					},
					patch: { durationMin: 5 },
				},
			],
			[insertDay, { tripId: c.tripId, dayId: c.ids.days.d1, where: "after" }],
			[deleteDay, { dayId: c.ids.days.d1 }],
			[
				setTripDates,
				{ tripId: c.tripId, startDate: "2027-10-03", endDate: "2027-10-09" },
			],
		];
		for (const [fn, data] of viewerCalls)
			expect(await codeOf(call(fn, U.viewer, data))).toBe("FORBIDDEN");
	});

	it("every mutation bumps trips.version by exactly one", async () => {
		const c = await freshTrip();
		const v0 = (await graphOf(c.tripId)).trip.version;
		await call(updateTrip, U.owner, { tripId: c.tripId, name: "Renamed" });
		await call(createItem, U.owner, {
			tripId: c.tripId,
			dayId: null,
			title: "Idea",
		});
		const g = await graphOf(c.tripId);
		expect(g.trip.version).toBe(v0 + 2);
		expect(g.trip.name).toBe("Renamed");
	});
});

describe("items and legs (§7.8, §7.9)", () => {
	it("inserting between two stops detaches their significant leg and queues autofill for the new pairs", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const res = await call<{ itemId: string; detachedLegIds: string[] }>(
			createItem,
			U.owner,
			{
				tripId: c.tripId,
				dayId: c.ids.days.d1,
				nodeId: c.ids.nodes.sensoji,
				afterItemId: I.hands,
			},
		);
		expect(res.detachedLegIds).toEqual([c.ids.legs.handsLoft]);
		// Default duration from the category (temple/shrine: 45 min).
		const g = await graphOf(c.tripId);
		expect(g.items.find((i) => i.id === res.itemId)?.durationMin).toBe(45);
		const jobs = await getQueue("autofill").getJobs([
			"waiting",
			"delayed",
			"prioritized",
		]);
		const targets = jobs.map((j) => JSON.stringify(j.data.target));
		expect(targets).toContain(
			JSON.stringify({
				kind: "pair",
				fromItemId: I.hands,
				toItemId: res.itemId,
			}),
		);
		expect(targets).toContain(
			JSON.stringify({
				kind: "pair",
				fromItemId: res.itemId,
				toItemId: I.loft,
			}),
		);
	});

	it("a significant leg is re-keyed to the next stop at the same place", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const { itemId: loft2 } = await call<{ itemId: string }>(
			createItem,
			U.owner,
			{
				tripId: c.tripId,
				dayId: c.ids.days.d1,
				nodeId: c.ids.nodes.loft,
				afterItemId: I.loft,
			},
		);
		const res = await call<{ detachedLegIds: string[] }>(deleteItem, U.owner, {
			itemId: I.loft,
		});
		expect(res.detachedLegIds).toEqual([]);
		const leg = (await graphOf(c.tripId)).legs.find(
			(l) => l.id === c.ids.legs.handsLoft,
		);
		expect(leg?.toItemId).toBe(loft2);
	});

	it("moving a stop away detaches the leg; relink attaches it to the new pair", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const res = await call<{ detachedLegIds: string[] }>(moveItem, U.owner, {
			itemId: I.loft,
			dayId: c.ids.days.d2,
			beforeItemId: I.sensoji,
		});
		expect(res.detachedLegIds).toEqual([c.ids.legs.handsLoft]);
		expect(
			await codeOf(
				call(relinkLeg, U.owner, {
					legId: c.ids.legs.handsLoft,
					fromItemId: I.hands,
					toItemId: I.itoya,
				}),
			),
		).toBe("CONFLICT");
		await call(relinkLeg, U.owner, {
			legId: c.ids.legs.handsLoft,
			fromItemId: I.hands,
			toItemId: I.meiji,
		});
		const leg = (await graphOf(c.tripId)).legs.find(
			(l) => l.id === c.ids.legs.handsLoft,
		);
		expect([leg?.fromItemId, leg?.toItemId]).toEqual([I.hands, I.meiji]);
	});

	it("flight blocks: nothing goes inside, they don't change day, and they delete and restore as one", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const inside = await codeOf(
			call(createItem, U.owner, {
				tripId: c.tripId,
				dayId: c.ids.days.d5,
				title: "Duty free",
				afterItemId: I.kix,
			}),
		);
		expect(inside).toBe("CONFLICT");
		await expect(
			call(moveItem, U.owner, {
				itemId: I.itoya,
				dayId: c.ids.days.d5,
				afterItemId: I.kix,
			}),
		).rejects.toThrow(/inside flight KE 724/);
		await expect(
			call(moveItem, U.owner, { itemId: I.kix, dayId: c.ids.days.d4 }),
		).rejects.toThrow(/flights move with their times/);
		const del = await call<{ deletedAt: string }>(deleteItem, U.owner, {
			itemId: I.icn,
		});
		let g = await graphOf(c.tripId);
		expect(g.items.some((i) => i.id === I.kix || i.id === I.icn)).toBe(false);
		await call(restoreItem, U.owner, {
			itemId: I.icn,
			deletedAt: del.deletedAt,
		});
		g = await graphOf(c.tripId);
		expect(
			g.items.filter((i) => i.id === I.kix || i.id === I.icn),
		).toHaveLength(2);
	});

	it("an item note's mentions become rows for trip members only", async () => {
		const c = await freshTrip();
		const maya = c.members.maya as string;
		const stranger = randomUUID();
		await call(updateItem, U.owner, {
			itemId: c.ids.items.sky,
			patch: {
				note: `Ask ${mentionToken("Maya Chen", maya)} and ${mentionToken("Nobody", stranger)}`,
			},
		});
		const rows = await getDb().execute(
			sql`select member_id::text as m from mentions where note_item_id = ${c.ids.items.sky}`,
		);
		expect(rows.rows).toEqual([{ m: maya }]);
		await call(updateItem, U.owner, {
			itemId: c.ids.items.sky,
			patch: { note: "no mentions" },
		});
		const after = await getDb().execute(
			sql`select 1 from mentions where note_item_id = ${c.ids.items.sky}`,
		);
		expect(after.rows).toHaveLength(0);
	});

	it("setLeg: a flight gets its instants; a guest editor can't wipe the booking ref and never sees it", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const target = {
			kind: "pair",
			fromItemId: I.kix,
			toItemId: I.icn,
		} as const;
		const flight = {
			kind: "flight",
			flight: {
				flightNumber: "KE724",
				from: {
					iata: "KIX",
					name: "Kansai",
					tz: "Asia/Tokyo",
					lat: 34.43,
					lng: 135.23,
				},
				to: {
					iata: "ICN",
					name: "Incheon",
					tz: "Asia/Seoul",
					lat: 37.46,
					lng: 126.44,
				},
				depLocal: "2027-10-07T14:05",
				arrLocal: "2027-10-07T16:10",
				seats: [{ memberId: c.members.owner, seat: "31A" }],
				bookingRef: "E7K2Q9",
			},
		};
		await call(setLeg, U.owner, {
			target,
			patch: { mode: "flight", details: flight },
		});
		let leg = (await graphOf(c.tripId)).legs.find(
			(l) => l.fromItemId === I.kix,
		);
		expect(leg?.depAt).toBe("2027-10-07T05:05:00.000Z");
		expect(leg?.arrAt).toBe("2027-10-07T07:10:00.000Z");

		const asGuest = await call<{
			details: { flight: { bookingRef?: string; seats: { seat: string }[] } };
		}>(getLeg, U.guestEditor, { target });
		expect(JSON.stringify(asGuest)).not.toContain("E7K2Q9");
		expect(asGuest.details.flight.seats[0]?.seat).toBe("••");
		// The guest saves the redacted form back: the ref and the seat survive.
		await call(setLeg, U.guestEditor, {
			target,
			patch: {
				details: {
					...flight,
					flight: {
						...flight.flight,
						bookingRef: undefined,
						seats: [{ memberId: c.members.owner, seat: "••" }],
					},
				},
			},
		});
		leg = (await graphOf(c.tripId)).legs.find((l) => l.fromItemId === I.kix);
		const stored = leg?.details as {
			flight: { bookingRef?: string; seats: { seat: string }[] };
		};
		expect(stored.flight.bookingRef).toBe("E7K2Q9");
		expect(stored.flight.seats[0]?.seat).toBe("31A");
		// The guest's graph is redacted too.
		const guestGraph = await call(getTripGraph, U.guestEditor, {
			tripId: c.tripId,
		});
		expect(JSON.stringify(guestGraph)).not.toContain("E7K2Q9");
	});
});

describe("days (§7.7): never lose items", () => {
	it("deleteDay moves items to Unscheduled, pulls later days back and re-dates the flight", async () => {
		const c = await freshTrip();
		const D = c.ids.days;
		const I = c.ids.items;
		await call(deleteDay, U.owner, { dayId: D.d4 });
		const g = await graphOf(c.tripId);
		expect(g.days.map((d) => d.date)).toEqual([
			"2027-10-03",
			"2027-10-04",
			"2027-10-05",
			"2027-10-06",
		]);
		expect(g.items.find((i) => i.id === I.kiyomizu)?.dayId).toBeNull();
		expect(g.items.find((i) => i.id === I.ryokanBreakfast)?.dayId).toBeNull();
		expect(g.trip.endDate).toBe("2027-10-06");
		const flight = g.legs.find((l) => l.id === c.ids.legs.flight);
		expect(flight?.depAt).toBe("2027-10-06T04:05:00.000Z"); // 13:05 JST, a day earlier
		const details = flight?.details as
			| { flight?: { depLocal?: string } }
			| undefined;
		expect(details?.flight?.depLocal).toBe("2027-10-06T13:05");
		// The flight's day can't be deleted.
		expect(await codeOf(call(deleteDay, U.owner, { dayId: D.d5 }))).toBe(
			"CONFLICT",
		);
	});

	it("insertDay and moveDay shift dates, keep items with their day", async () => {
		const c = await freshTrip();
		const D = c.ids.days;
		const { dayIds } = await call<{ dayIds: string[] }>(insertDay, U.owner, {
			tripId: c.tripId,
			dayId: D.d1,
			where: "after",
		});
		let g = await graphOf(c.tripId);
		expect(g.days.find((d) => d.id === dayIds[0])?.date).toBe("2027-10-04");
		expect(g.days.find((d) => d.id === D.d2)?.date).toBe("2027-10-05");
		expect(g.days).toHaveLength(6);
		await call(moveDay, U.owner, { dayId: D.d1, toDate: "2027-10-05" });
		g = await graphOf(c.tripId);
		expect(g.days.find((d) => d.id === D.d1)?.date).toBe("2027-10-05");
		expect(g.days.find((d) => d.id === D.d2)?.date).toBe("2027-10-04");
		expect(g.items.filter((i) => i.dayId === D.d1).length).toBe(5);
	});

	it("setTripDates: preview first, refuse to split a flight, shrink moves items to Unscheduled", async () => {
		const c = await freshTrip();
		const range = {
			tripId: c.tripId,
			startDate: "2027-10-03",
			endDate: "2027-10-04",
		};
		const preview = await call<{
			removedDays: string[];
			affectedItems: unknown[];
			blockedBy?: string;
		}>(previewTripDates, U.owner, range);
		expect(preview.removedDays).toEqual([
			"2027-10-05",
			"2027-10-06",
			"2027-10-07",
		]);
		expect(preview.blockedBy).toMatch(/flight/);
		expect(await codeOf(call(setTripDates, U.owner, range))).toBe("CONFLICT");
		const before = (await graphOf(c.tripId)).items.length;
		await call(setTripDates, U.owner, { ...range, endDate: "2027-10-10" });
		await call(shiftTripDates, U.owner, { tripId: c.tripId, deltaDays: 1 });
		const g = await graphOf(c.tripId);
		expect(g.items.length).toBe(before);
		expect(g.trip.startDate).toBe("2027-10-04");
		expect(g.trip.endDate).toBe("2027-10-11");
		expect(g.days).toHaveLength(8);
	});

	it("another member's private day note never blocks or shows, and is kept (ADDENDUM §7.2)", async () => {
		const c = await freshTrip();
		const D = c.ids.days;
		const put = async (dayId: string | null, md: string) => {
			const snap = markdownToYdoc(md);
			const target = dayId
				? ({ kind: "day", dayId } as const)
				: ({ kind: "trip" } as const);
			await getDb().execute(sql`
				insert into yjs_documents (name, trip_id, day_id, owner_user_id, state, json, plain_text)
				values (${noteDocName(c.tripId, target, U.owner.id)}, ${c.tripId}, ${dayId},
				        ${U.owner.id}, ${Buffer.from(snap.state)}, ${JSON.stringify(snap.json)}::jsonb,
				        ${snap.plainText})`);
		};
		const ownerNotes = async () =>
			(
				await getDb().execute(sql`
					select name, day_id as "dayId", plain_text as "text" from yjs_documents
					 where trip_id = ${c.tripId} and owner_user_id = ${U.owner.id}
					 order by name`)
			).rows as { name: string; dayId: string | null; text: string }[];
		const root = noteDocName(c.tripId, { kind: "trip" }, U.owner.id);

		// Day 5 is the flight's; drop Day 1 (a private note, no own trip note
		// yet). Its shared note is emptied first: that one still blocks everyone.
		await getDb().execute(sql`
			delete from yjs_documents
			 where trip_id = ${c.tripId} and day_id = ${D.d1} and owner_user_id is null`);
		await put(D.d1 as string, "PRIVATE DAYNOTE only for me");
		const range = {
			tripId: c.tripId,
			startDate: "2027-10-04",
			endDate: "2027-10-07",
		};
		type Preview = { blockedBy?: string };
		// QA R3: a private note never blocks, its author's own included ("Day 1
		// has a note" named a note his Shared layer didn't show); it moves to
		// his private trip note like anyone else's (the shared note still blocks).
		expect(
			(await call<Preview>(previewTripDates, U.owner, range)).blockedBy,
		).toBeUndefined();
		// Maya can't see it: nothing blocks her and nothing names it.
		expect(
			(await call<Preview>(previewTripDates, U.maya, range)).blockedBy,
		).toBeUndefined();
		expect(await codeOf(call(setTripDates, U.maya, range))).toBe("ok");
		// Kept: it became the owner's private trip note.
		expect(await ownerNotes()).toEqual([
			{ name: root, dayId: null, text: "PRIVATE DAYNOTE only for me" },
		]);

		// With a private trip note already there, a second day's note merges in.
		const d2 = (await graphOf(c.tripId)).days[0]?.id as string;
		await put(d2, "Second private note");
		expect(await codeOf(call(deleteDay, U.maya, { dayId: d2 }))).toBe("ok");
		const after = await ownerNotes();
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({ name: root, dayId: null });
		expect(after[0]?.text).toContain("PRIVATE DAYNOTE only for me");
		expect(after[0]?.text).toContain("Second private note");
		// Maya never gets the text back from any read.
		const mayaGraph = await call(getTripGraph, U.maya, { tripId: c.tripId });
		expect(JSON.stringify(mayaGraph)).not.toContain("PRIVATE DAYNOTE");
	});

	it("setDayStay sets the night for a range", async () => {
		const c = await freshTrip();
		const D = c.ids.days;
		await call(setDayStay, U.owner, {
			fromDayId: D.d1,
			toDayId: D.d2,
			nodeId: c.ids.nodes.ryokan,
		});
		const g = await graphOf(c.tripId);
		expect(
			g.days
				.filter((d) => d.nightNodeId === c.ids.nodes.ryokan)
				.map((d) => d.id),
		).toEqual(expect.arrayContaining([D.d1, D.d2, D.d3]));
		expect(
			await codeOf(
				call(setDayStay, U.owner, {
					fromDayId: D.d1,
					nodeId: c.ids.nodes.tokyo,
				}),
			),
		).toBe("VALIDATION");
	});
});

describe("nodes (§7.1, §7.4)", () => {
	it("unique sibling slugs, zones from coordinates, rank rules, no cycles", async () => {
		const c = await freshTrip();
		const N = c.ids.nodes;
		const a = await call<{ nodeId: string; slug: string }>(
			createNode,
			U.owner,
			{
				tripId: c.tripId,
				parentId: N.japan,
				type: "city",
				name: "Nara",
				lat: 34.6851,
				lng: 135.8048,
			},
		);
		const b = await call<{ slug: string }>(createNode, U.owner, {
			tripId: c.tripId,
			parentId: N.japan,
			type: "city",
			name: "Nara",
		});
		expect([a.slug, b.slug]).toEqual(["nara", "nara-2"]);
		expect(
			(await graphOf(c.tripId)).nodes.find((n) => n.id === a.nodeId)?.tz,
		).toBe("Asia/Tokyo");
		expect(
			await codeOf(
				call(createNode, U.owner, {
					tripId: c.tripId,
					parentId: N.shibuyaSky,
					type: "city",
					name: "X",
				}),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(
				call(moveNode, U.owner, { nodeId: N.japan, parentId: N.tokyo }),
			),
		).toBe("VALIDATION");
		await call(setNodePriority, U.owner, {
			nodeId: N.sensoji,
			memberId: c.members.owner,
			priority: "must",
		});
		expect(
			(await graphOf(c.tripId)).nodes.find((n) => n.id === N.sensoji)
				?.priorities,
		).toEqual({
			[c.members.owner]: "must",
		});
	});

	it("deleteNode takes the subtree and its items; restoreNode brings them back", async () => {
		const c = await freshTrip();
		const N = c.ids.nodes;
		const res = await call<{ deletedAt: string }>(deleteNode, U.owner, {
			nodeId: N.shibuya,
		});
		let g = await graphOf(c.tripId);
		expect(g.nodes.some((n) => n.id === N.hands)).toBe(false);
		expect(g.items.some((i) => i.id === c.ids.items.hands)).toBe(false);
		await call(restoreNode, U.owner, {
			nodeId: N.shibuya,
			deletedAt: res.deletedAt,
		});
		g = await graphOf(c.tripId);
		expect(g.nodes.some((n) => n.id === N.hands)).toBe(true);
		expect(g.items.some((i) => i.id === c.ids.items.hands)).toBe(true);
		const acts = await call<{ summary: string }[]>(listActivity, U.viewer, {
			tripId: c.tripId,
		});
		expect(acts[0]?.summary).toBe("restored Shibuya");
		expect(acts[1]?.summary).toMatch(/^deleted Shibuya/);
	});
});

describe("cross-trip ids are refused (SECURITY §1 IDOR)", () => {
	it("an editor of trip A can't reach trip B through child ids", async () => {
		const a = await freshTrip();
		const b = await cloneDemoTrip(getDb(), U.stranger.id);
		const A = a.ids;
		const B = b.ids;
		const [att] = (
			await getDb().execute(sql`
				insert into attachments (id, trip_id, kind, status, position, url)
				values (${randomUUID()}, ${b.tripId}, 'photo', 'ready', 'a0', 'https://example.com/x.jpg')
				returning id::text as id`)
		).rows as { id: string }[];
		const refused: [string, unknown, unknown, string][] = [
			[
				"createItem dayId",
				createItem,
				{ tripId: a.tripId, dayId: B.days.d1, title: "x" },
				"NOT_FOUND",
			],
			[
				"createItem nodeId",
				createItem,
				{ tripId: a.tripId, dayId: null, nodeId: B.nodes.itoya },
				"NOT_FOUND",
			],
			[
				"createItem afterItemId",
				createItem,
				{
					tripId: a.tripId,
					dayId: A.days.d1,
					title: "x",
					afterItemId: B.items.hands,
				},
				"NOT_FOUND",
			],
			[
				"createItem trip B",
				createItem,
				{ tripId: b.tripId, dayId: null, title: "x" },
				"NOT_FOUND",
			],
			[
				"moveItem to B's day",
				moveItem,
				{ itemId: A.items.hands, dayId: B.days.d1 },
				"NOT_FOUND",
			],
			[
				"moveItem before B's item",
				moveItem,
				{ itemId: A.items.hands, dayId: A.days.d1, beforeItemId: B.items.loft },
				"NOT_FOUND",
			],
			[
				"updateItem nodeId",
				updateItem,
				{ itemId: A.items.lunch1, patch: { nodeId: B.nodes.itoya } },
				"NOT_FOUND",
			],
			[
				"setItemAssignees B member",
				setItemAssignees,
				{ itemId: A.items.hands, memberIds: [b.members.owner] },
				"VALIDATION",
			],
			[
				"setNodePriority B member",
				setNodePriority,
				{ nodeId: A.nodes.itoya, memberId: b.members.owner, priority: "must" },
				"NOT_FOUND",
			],
			[
				"moveNode under B's node",
				moveNode,
				{ nodeId: A.nodes.itoya, parentId: B.nodes.tokyo },
				"NOT_FOUND",
			],
			[
				"setDayStay B node",
				setDayStay,
				{ fromDayId: A.days.d1, nodeId: B.nodes.ryokan },
				"NOT_FOUND",
			],
			[
				"insertDay around B's day",
				insertDay,
				{ tripId: a.tripId, dayId: B.days.d1, where: "after" },
				"NOT_FOUND",
			],
			[
				"relinkLeg to B's items",
				relinkLeg,
				{
					legId: A.legs.handsLoft,
					fromItemId: B.items.hands,
					toItemId: B.items.loft,
				},
				"NOT_FOUND",
			],
			[
				"setLeg on B's pair",
				setLeg,
				{
					target: {
						kind: "pair",
						fromItemId: B.items.hands,
						toItemId: B.items.loft,
					},
					patch: { durationMin: 5 },
				},
				"NOT_FOUND",
			],
			[
				"setLeg mixing trips",
				setLeg,
				{
					target: {
						kind: "pair",
						fromItemId: A.items.hands,
						toItemId: B.items.loft,
					},
					patch: { durationMin: 5 },
				},
				"NOT_FOUND",
			],
			[
				"ensureLeg on B's pair",
				ensureLeg,
				{
					target: {
						kind: "pair",
						fromItemId: B.items.hands,
						toItemId: B.items.loft,
					},
				},
				"NOT_FOUND",
			],
			[
				"updateTrip cover from B",
				updateTrip,
				{ tripId: a.tripId, coverAttachmentId: att?.id },
				"NOT_FOUND",
			],
		];
		for (const [what, fn, data, code] of refused)
			expect(await codeOf(call(fn, U.owner, data)), what).toBe(code);
		// Seat member ids must be members of THIS trip.
		expect(
			await codeOf(
				call(setLeg, U.owner, {
					target: {
						kind: "pair",
						fromItemId: A.items.hands,
						toItemId: A.items.loft,
					},
					patch: {
						mode: "transit",
						details: {
							kind: "transit",
							booking: { seats: [{ memberId: b.members.owner, seat: "12A" }] },
						},
					},
				}),
			),
		).toBe("VALIDATION");
		// B is untouched.
		const gb = await call<Awaited<ReturnType<typeof getTripGraph>>>(
			getTripGraph,
			U.stranger,
			{ tripId: b.tripId },
		);
		expect(gb.trip.version).toBe(0);
	});

	it("updateTrip accepts a live photo of the same trip as the cover", async () => {
		const a = await freshTrip();
		const [att] = (
			await getDb().execute(sql`
				insert into attachments (id, trip_id, kind, status, position, url)
				values (${randomUUID()}, ${a.tripId}, 'photo', 'ready', 'a0', 'https://example.com/y.jpg')
				returning id::text as id`)
		).rows as { id: string }[];
		expect(
			await codeOf(
				call(updateTrip, U.owner, {
					tripId: a.tripId,
					coverAttachmentId: att?.id,
				}),
			),
		).toBe("ok");
		expect(
			await codeOf(
				call(updateTrip, U.owner, {
					tripId: a.tripId,
					coverAttachmentId: null,
				}),
			),
		).toBe("ok");
	});
});

describe("F-ext0: the gate, removed members, share links", () => {
	it("suggesters' writes become proposals, but they set their own priority directly", async () => {
		const c = await freshTrip();
		const sug = await newUser({ first: "Sue", last: "Suggester" });
		const [m] = (
			await getDb().execute(sql`
				insert into trip_members (id, trip_id, user_id, status, role, color)
				values (${randomUUID()}, ${c.tripId}, ${sug.id}, 'active', 'suggester', 6)
				returning id::text as id`)
		).rows as { id: string }[];
		const proposed = await call<{ proposed?: { id: string } }>(
			createItem,
			sug,
			{ tripId: c.tripId, dayId: null, title: "Idea" },
		);
		expect(proposed.proposed?.id).toBeTruthy();
		expect(
			await codeOf(
				call(setNodePriority, sug, {
					nodeId: c.ids.nodes.itoya,
					memberId: m?.id,
					priority: "must",
				}),
			),
		).toBe("ok");
		// …but somebody else's only as a proposal.
		const other = await call<{ proposed?: { id: string } }>(
			setNodePriority,
			sug,
			{ nodeId: c.ids.nodes.itoya, memberId: c.members.owner, priority: "meh" },
		);
		expect(other.proposed?.id).toBeTruthy();
		// ensureLeg is { direct: 'propose' }: suggesters may create the row.
		expect(
			await codeOf(
				call(ensureLeg, sug, {
					target: {
						kind: "pair",
						fromItemId: c.ids.items.hands,
						toItemId: c.ids.items.loft,
					},
				}),
			),
		).toBe("ok");
		// Reads work.
		expect(await codeOf(call(getTripGraph, sug, { tripId: c.tripId }))).toBe(
			"ok",
		);
	});

	it("a proposable input still refuses unknown keys, and accepts a proposal message", async () => {
		const c = await freshTrip();
		expect(
			await codeOf(
				call(createItem, U.owner, {
					tripId: c.tripId,
					dayId: null,
					title: "x",
					nope: 1,
				}),
			),
		).toMatch(/unexpected|VALIDATION/);
		expect(
			await codeOf(
				call(createItem, U.owner, {
					tripId: c.tripId,
					dayId: null,
					title: "x",
					proposal: { message: "fyi" },
				}),
			),
		).toBe("ok");
	});

	it("createItem with a chosen id uses it; a taken id is CONFLICT", async () => {
		const c = await freshTrip();
		const id = randomUUID();
		const r = await call<{ itemId: string }>(createItem, U.owner, {
			tripId: c.tripId,
			id,
			dayId: null,
			title: "Pinned id",
		});
		expect(r.itemId).toBe(id);
		expect(
			await codeOf(
				call(createItem, U.owner, {
					tripId: c.tripId,
					id,
					dayId: null,
					title: "Again",
				}),
			),
		).toBe("CONFLICT");
		expect(
			await codeOf(
				call(createItem, U.owner, {
					tripId: c.tripId,
					id: c.ids.items.hands,
					dayId: null,
					title: "Taken",
				}),
			),
		).toBe("CONFLICT");
	});

	it("a removed member keeps their tags as 'former member' and can't be assigned again", async () => {
		const c = await freshTrip();
		const kai = await newUser({ first: "Kai", last: "Viewer" });
		const kaiMember = randomUUID();
		await getDb().execute(sql`
			insert into trip_members (id, trip_id, user_id, status, role, color)
			values (${kaiMember}, ${c.tripId}, ${kai.id}, 'active', 'viewer', 4)`);
		await call(setItemAssignees, U.owner, {
			itemId: c.ids.items.hands,
			memberIds: [kaiMember],
		});
		await getDb().transaction(async (tx) => {
			const { TxOutbox } = await import("@/server/live/outbox.server");
			const { retireMember } = await import("@/server/members.server");
			await retireMember(tx, new TxOutbox(c.tripId), c.tripId, kaiMember);
		});
		const g = await graphOf(c.tripId);
		const kaiRow = g.members.find((m) => m.id === kaiMember);
		expect(kaiRow).toMatchObject({
			status: "removed",
			userId: null,
			name: "Kai Viewer",
		});
		expect(
			g.items.find((i) => i.id === c.ids.items.hands)?.assigneeIds,
		).toContain(kaiMember);
		// No access any more, and never assignable again.
		expect(await codeOf(call(getTripGraph, kai, { tripId: c.tripId }))).toBe(
			"NOT_FOUND",
		);
		expect(
			await codeOf(
				call(setItemAssignees, U.owner, {
					itemId: c.ids.items.loft,
					memberIds: [kaiMember],
				}),
			),
		).toBe("VALIDATION");
		// The owner can't be retired.
		const { retireMember } = await import("@/server/members.server");
		const { TxOutbox } = await import("@/server/live/outbox.server");
		await expect(
			getDb().transaction((tx) =>
				retireMember(tx, new TxOutbox(c.tripId), c.tripId, c.members.owner),
			),
		).rejects.toThrow(/CONFLICT/);
	});

	it("turning a link off revokes its guests for good; links expire and can be extended", async () => {
		const c = await freshTrip();
		const { setLinkEnabled, extendLink, LINK_TTL_DAYS } = await import(
			"@/server/sharing.server"
		);
		const { TxOutbox } = await import("@/server/live/outbox.server");
		const run = <T>(
			fn: (
				tx: Parameters<
					Parameters<ReturnType<typeof getDb>["transaction"]>[0]
				>[0],
				out: InstanceType<typeof TxOutbox>,
			) => Promise<T>,
		) => getDb().transaction((tx) => fn(tx, new TxOutbox(c.tripId)));
		expect(
			await codeOf(call(getTripGraph, U.guestViewer, { tripId: c.tripId })),
		).toBe("ok");
		await run((tx, out) =>
			setLinkEnabled(tx, out, c.tripId, "viewer", false, U.owner.id),
		);
		expect(
			await codeOf(call(getTripGraph, U.guestViewer, { tripId: c.tripId })),
		).toBe("NOT_FOUND");
		const grants = await getDb().execute(sql`
			select count(*)::int as n from share_grants g join share_links l on l.id = g.share_link_id
			 where l.trip_id = ${c.tripId} and l.role = 'viewer'`);
		expect((grants.rows[0] as { n: number }).n).toBe(0);
		// On again: the old guest is NOT back (they'd need the link again).
		await run((tx, out) =>
			setLinkEnabled(tx, out, c.tripId, "viewer", true, U.owner.id),
		);
		expect(
			await codeOf(call(getTripGraph, U.guestViewer, { tripId: c.tripId })),
		).toBe("NOT_FOUND");
		// A new link carries an expiry; extend pushes it to TTL from now.
		await run((tx, out) =>
			setLinkEnabled(tx, out, c.tripId, "suggester", true, U.owner.id),
		);
		const exp = await getDb().execute(sql`
			select role::text as role, expires_at as "expiresAt" from share_links
			 where trip_id = ${c.tripId} and revoked_at is null and role::text = 'suggester'`);
		const row = exp.rows[0] as { expiresAt: Date };
		const days = (new Date(row.expiresAt).getTime() - Date.now()) / 86_400_000;
		expect(Math.round(days)).toBe(LINK_TTL_DAYS.suggester);
		const iso = await run((tx, out) => extendLink(tx, out, c.tripId));
		expect(new Date(iso).getTime()).toBeGreaterThanOrEqual(
			new Date(row.expiresAt).getTime(),
		);
	});

	it("a guest's digest cursor merges into the account when they sign in", async () => {
		const c = await freshTrip();
		const anon = await newUser(null);
		const acct = await newUser({ first: "Nia", last: "Signed" });
		await getDb().execute(sql`
			insert into trip_seen (trip_id, user_id, seen_version) values
			  (${c.tripId}, ${anon.id}, 7), (${c.tripId}, ${acct.id}, 3)`);
		const { migrateGuestToUser } = await import(
			"@/server/auth/accounts.server"
		);
		await migrateGuestToUser(anon.id, acct.id);
		const rows = await getDb().execute(sql`
			select user_id as "userId", seen_version::int as v from trip_seen where trip_id = ${c.tripId} order by user_id`);
		expect(rows.rows).toEqual([{ userId: acct.id, v: 7 }]);
	});
});

describe("ADDENDUM §9/§10 (F-ext0 columns)", () => {
	it("a member's rating carries an optional comment (≤ 280) that the graph shows", async () => {
		const c = await freshTrip();
		const N = c.ids.nodes;
		const rate = (extra: Record<string, unknown>) =>
			call(setNodePriority, U.owner, {
				nodeId: N.sensoji,
				memberId: c.members.owner,
				priority: "must",
				...extra,
			});
		const commentOf = async () =>
			(await graphOf(c.tripId)).nodes.find((n) => n.id === N.sensoji)
				?.ratingComments;
		await rate({ comment: "  only if we have time after Nishiki " });
		expect(await commentOf()).toEqual({
			[c.members.owner]: "only if we have time after Nishiki",
		});
		// Omitted = kept; null or blank = cleared.
		await rate({});
		expect(await commentOf()).toEqual({
			[c.members.owner]: "only if we have time after Nishiki",
		});
		await rate({ comment: null });
		expect(await commentOf()).toEqual({});
		// The validator refuses it (a 400 in the app; the raw issue in the mock).
		expect(await codeOf(rate({ comment: "x".repeat(281) }))).toMatch(
			/too_big|VALIDATION/,
		);
		// Only its author changes a comment; editors may still set the rating,
		// and write a placeholder's comment (no account can author it).
		const forMember = (memberId: string, extra: Record<string, unknown>) =>
			call(setNodePriority, U.owner, {
				nodeId: N.sensoji,
				memberId,
				priority: "want",
				...extra,
			});
		const maya = c.members.maya as string;
		expect(await codeOf(forMember(maya, { comment: "nope" }))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(forMember(maya, {}))).toBe("ok");
		expect(
			await codeOf(forMember(c.members.audrey, { comment: "from the sheet" })),
		).toBe("ok");
		expect((await commentOf())?.[c.members.audrey]).toBe("from the sheet");
	});

	it("updateNode: a null details key is removed; updateTrip settings patch only the keys sent", async () => {
		const c = await freshTrip();
		const tokyo = c.ids.nodes.tokyo as string;
		const detailsOf = async () =>
			(await graphOf(c.tripId)).nodes.find((n) => n.id === tokyo)?.details;
		await call(updateNode, U.owner, {
			nodeId: tokyo,
			patch: { details: { plannedDays: 4, phone: "+81 3" } },
		});
		expect(await detailsOf()).toMatchObject({ plannedDays: 4, phone: "+81 3" });
		await call(updateNode, U.owner, {
			nodeId: tokyo,
			patch: { details: { plannedDays: null } },
		});
		const after = await detailsOf();
		expect(after).not.toHaveProperty("plannedDays");
		expect(after).toMatchObject({ phone: "+81 3" });

		await call(updateTrip, U.owner, {
			tripId: c.tripId,
			settings: { currency: "JPY", defaultDayStart: "08:30" },
		});
		await call(updateTrip, U.owner, {
			tripId: c.tripId,
			settings: { holidays: [] },
		});
		const settings = (await graphOf(c.tripId)).trip.settings;
		expect(settings).toMatchObject({
			currency: "JPY",
			defaultDayStart: "08:30",
			holidays: [],
		});
	});

	it("updateNode: an editor overrides a node's zone (QA TZ-08); null goes back to the coordinates' zone", async () => {
		const c = await freshTrip();
		const itoya = c.ids.nodes.itoya as string;
		const tzOf = async () =>
			(await graphOf(c.tripId)).nodes.find((n) => n.id === itoya)?.tz;
		await call(updateNode, U.owner, {
			nodeId: itoya,
			patch: { tz: "Asia/Seoul" },
		});
		expect(await tzOf()).toBe("Asia/Seoul");
		expect(
			await codeOf(
				call(updateNode, U.owner, {
					nodeId: itoya,
					patch: { tz: "Mars/Olympus_Mons" },
				}),
			),
		).not.toBe("ok");
		expect(await tzOf()).toBe("Asia/Seoul");
		await call(updateNode, U.owner, { nodeId: itoya, patch: { tz: null } });
		expect(await tzOf()).toBe("Asia/Tokyo");
	});

	it("'Hide from guests' media never reaches a link guest; members still see it", async () => {
		const c = await freshTrip();
		const [open, hidden] = (
			await getDb().execute(sql`
				insert into attachments (id, trip_id, kind, status, position, url, visibility)
				values (${randomUUID()}, ${c.tripId}, 'link', 'ready', 'a0', 'https://example.com/guide', 'everyone'),
				       (${randomUUID()}, ${c.tripId}, 'pdf', 'ready', 'a1', null, 'members')
				returning id::text as id`)
		).rows as { id: string }[];
		const { listTripMedia } = await import("@/features/media/media.functions");
		const ids = async (who: AuthUser) =>
			(
				await call<{ id: string; visibility: string }[]>(listTripMedia, who, {
					tripId: c.tripId,
				})
			).map((m) => m.id);
		expect(await ids(U.viewer)).toEqual(
			expect.arrayContaining([open?.id, hidden?.id]),
		);
		for (const guest of [U.guestViewer, U.guestEditor]) {
			const seen = await ids(guest);
			expect(seen).toContain(open?.id);
			expect(seen).not.toContain(hidden?.id);
		}
	});

	it("a top-level place can't take a route's slug (/t/<trip>/rate)", async () => {
		const c = await freshTrip();
		const top = await call<{ slug: string }>(createNode, U.owner, {
			tripId: c.tripId,
			parentId: null,
			type: "country",
			name: "Rate",
		});
		expect(top.slug).toBe("rate-2");
		const nested = await call<{ slug: string }>(createNode, U.owner, {
			tripId: c.tripId,
			parentId: c.ids.nodes.japan,
			type: "city",
			name: "Rate",
		});
		expect(nested.slug).toBe("rate");
	});
});

describe("dev seed (§17.1)", () => {
	it("is idempotent and writes the fixture with its fixed ids", async () => {
		const a = await seedDev(getDb());
		const b = await seedDev(getDb());
		expect(b.tripId).toBe(a.tripId);
		const counts = await getDb().execute(sql`
			select (select count(*) from items where trip_id = ${a.tripId})::int as items,
			       (select count(*) from legs where trip_id = ${a.tripId})::int as legs,
			       (select count(*) from share_links where trip_id = ${a.tripId})::int as links,
			       (select count(*) from "user" where email in ('dev@example.com', 'maya@example.com'))::int as users`);
		expect(counts.rows[0]).toEqual({
			items: demo.graph.items.length,
			legs: demo.graph.legs.length,
			links: 2,
			users: 2,
		});
		const redeemed = await redeemShareToken(
			"dev-share-token-viewer",
			U.guestViewer.id,
		);
		expect(redeemed?.role).toBe("viewer");
	});
});

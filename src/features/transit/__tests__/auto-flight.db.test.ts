/**
 * FEEDBACK-3 against real Postgres: the default flight between two adjacent
 * airports (FB-19), switching it away for good, adding times later (FB-18),
 * and the owner's test-trip case (FB-19a) end to end through the server.
 *
 * The owner's test trip: JFK ("John F. Kennedy International Airport", a
 * place) on Sat 12 Dec 2026 pinned 00:00 for 2 h, then Haneda ("Haneda
 * Airport", an area) on Sun 13 Dec.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_af_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-aftest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	process.env.GOOGLE_MAPS_API_KEY = "";
	process.env.OSRM_FOOT_URL = "http://127.0.0.1:9";
	return { scratchUrl: scratch.toString() };
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
import { user } from "@/db/schema";
import { getTripGraph } from "@/functions/graph.functions";
import { createItem, moveItem, updateItem } from "@/functions/items.functions";
import { setLeg } from "@/functions/legs.functions";
import { createNodePath } from "@/functions/nodes.functions";
import { createTrip } from "@/functions/trips.functions";
import { indexGraph, pairKey } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import { hhmm } from "@/lib/engine/time";
import type { GraphLeg, TripGraph } from "@/lib/engine/types";
import type { AuthUser } from "@/server/auth.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { autofillLeg } from "../server/autofill.server";
import { saveFlight } from "../transit.functions";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T = Record<string, unknown>>(
	fn: unknown,
	u: AuthUser,
	data: unknown,
) => (fn as Fn)({ data, context: { user: u } }) as Promise<T>;

let owner: AuthUser;

async function newUser(): Promise<AuthUser> {
	const id = randomUUID();
	await getDb()
		.insert(user)
		.values({
			id,
			email: `u-${id}@example.test`,
			emailVerified: true,
			name: "Dennis Test",
			firstName: "Dennis",
			lastName: "Test",
			isAnonymous: false,
		});
	const [row] = await getDb()
		.select()
		.from(user)
		.where(sql`${user.id} = ${id}`);
	return row as unknown as AuthUser;
}

type Trip = {
	tripId: string;
	day: (date: string) => string;
	jfk: string;
	hnd: string;
	shibuya: string;
};

/** A dated trip with JFK (place), Haneda Airport (area) and Shibuya (area). */
async function testTrip(): Promise<Trip> {
	const { tripId } = await call<{ tripId: string }>(createTrip, owner, {
		name: "test",
		startDate: "2026-12-12",
		endDate: "2026-12-14",
		defaultTz: "America/New_York",
	});
	const path = async (chain: unknown[]) =>
		(
			await call<{ nodeIds: string[] }>(createNodePath, owner, {
				tripId,
				chain,
			})
		).nodeIds;
	const [, , jfk] = await path([
		{ type: "country", name: "United States", countryCode: "US" },
		{ type: "city", name: "New York", lat: 40.7128, lng: -74.006 },
		{
			type: "place",
			name: "John F. Kennedy International Airport",
			lat: 40.6413,
			lng: -73.7781,
		},
	]);
	const [japan, tokyo, hnd] = await path([
		{ type: "country", name: "Japan", countryCode: "JP" },
		{ type: "city", name: "Tokyo", lat: 35.6762, lng: 139.6503 },
		{ type: "area", name: "Haneda Airport", lat: 35.5494, lng: 139.7798 },
	]);
	const [, shibuya] = await path([
		{ id: tokyo },
		{ type: "area", name: "Shibuya", lat: 35.6595, lng: 139.7004 },
	]);
	void japan;
	const g = await graphOf(tripId);
	const day = (date: string) => {
		const d = g.days.find((x) => x.date === date);
		if (!d) throw new Error(`no day ${date}`);
		return d.id;
	};
	return {
		tripId,
		day,
		jfk: jfk as string,
		hnd: hnd as string,
		shibuya: shibuya as string,
	};
}

/** A leg's stored flight details (`{}` when it has none). */
const flightOf = (leg: GraphLeg | undefined): Record<string, unknown> =>
	(leg?.details as { flight?: Record<string, unknown> } | undefined)?.flight ??
	{};

const graphOf = (tripId: string) =>
	call<TripGraph>(getTripGraph, owner, { tripId });

async function legBetween(
	tripId: string,
	from: string,
	to: string,
): Promise<GraphLeg | undefined> {
	const g = await graphOf(tripId);
	return g.legs.find((l) => l.fromItemId === from && l.toItemId === to);
}

async function addItem(
	t: Trip,
	date: string,
	nodeId: string,
	extra: Record<string, unknown> = {},
): Promise<string> {
	const r = await call<{ itemId: string }>(createItem, owner, {
		tripId: t.tripId,
		dayId: t.day(date),
		nodeId,
		...extra,
	});
	return r.itemId;
}

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	owner = await newUser();
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

describe("FB-19: the default flight between two adjacent airports", () => {
	it("appears at once, prefilled with both airports and dates, no times or number", async () => {
		const t = await testTrip();
		const a = await addItem(t, "2026-12-12", t.jfk, {
			pinnedStart: "00:00",
			durationMin: 120,
		});
		const b = await addItem(t, "2026-12-13", t.hnd, { durationMin: 60 });
		const leg = await legBetween(t.tripId, a, b);
		expect(leg).toMatchObject({
			mode: "flight",
			source: "estimate",
			isEdited: false,
			depAt: null,
			arrAt: null,
		});
		const f = flightOf(leg);
		expect(f).toMatchObject({
			from: { iata: "JFK", tz: "America/New_York" },
			to: { iata: "HND", tz: "Asia/Tokyo" },
			depDate: "2026-12-12",
			arrDate: "2026-12-13",
		});
		expect(f.flightNumber).toBeUndefined();
		expect(f.depLocal).toBeUndefined();
		// The plan counts the ~14h 5m estimate.
		const ix = indexGraph(await graphOf(t.tripId));
		const s = computeSchedule(ix).legs[pairKey(a, b)];
		expect(s).toMatchObject({ estimate: true, minutes: 845, timed: false });
		// It never blocks the items (not a booked flight block).
		expect(ix.flightBlocks).toEqual([]);
	});

	it("switched to Train it stays Train, also after a reorder", async () => {
		const t = await testTrip();
		const a = await addItem(t, "2026-12-12", t.jfk, { durationMin: 120 });
		const b = await addItem(t, "2026-12-13", t.hnd, { durationMin: 60 });
		const c = await addItem(t, "2026-12-13", t.shibuya, { durationMin: 90 });
		expect((await legBetween(t.tripId, a, b))?.mode).toBe("flight");
		// What the leg editor sends for "Transit".
		await call(setLeg, owner, {
			target: { kind: "pair", fromItemId: a, toItemId: b },
			patch: {
				mode: "transit",
				durationMin: 60,
				estimateMin: 60,
				source: "estimate",
				isEdited: false,
				distanceM: null,
			},
		});
		expect((await legBetween(t.tripId, a, b))?.mode).toBe("transit");
		// Shibuya before HND breaks JFK → HND, then back after it.
		await call(moveItem, owner, {
			itemId: c,
			dayId: t.day("2026-12-13"),
			beforeItemId: b,
		});
		expect((await legBetween(t.tripId, a, c))?.mode ?? null).not.toBe("flight");
		await call(moveItem, owner, {
			itemId: c,
			dayId: t.day("2026-12-13"),
			afterItemId: b,
		});
		const back = await legBetween(t.tripId, a, b);
		expect(back?.mode).toBe("transit");
		// Even the heal-up job leaves it alone.
		await autofillLeg(t.tripId, { kind: "pair", fromItemId: a, toItemId: b });
		expect((await legBetween(t.tripId, a, b))?.mode).toBe("transit");
	});

	it("follows the items until it is edited: new adjacency, new dates, gone", async () => {
		const t = await testTrip();
		const a = await addItem(t, "2026-12-12", t.jfk, { durationMin: 120 });
		const b = await addItem(t, "2026-12-13", t.hnd, { durationMin: 60 });
		// HND moves a day later: the default's arrival date follows.
		await call(moveItem, owner, { itemId: b, dayId: t.day("2026-12-14") });
		let leg = await legBetween(t.tripId, a, b);
		expect(flightOf(leg).arrDate).toBe("2026-12-14");
		// Re-located to Shibuya: no longer two airports, back to "not set".
		await call(updateItem, owner, {
			itemId: b,
			patch: { nodeId: t.shibuya },
		});
		leg = await legBetween(t.tripId, a, b);
		expect(leg?.mode ?? null).toBeNull();
	});

	it("heals a pair of airports planned before the default existed", async () => {
		const t = await testTrip();
		const a = await addItem(t, "2026-12-12", t.jfk, { durationMin: 120 });
		const b = await addItem(t, "2026-12-13", t.hnd, { durationMin: 60 });
		// As if written before FB-19: the leg row cleared.
		await getDb().execute(
			sql`update legs set mode = null, details = '{}'::jsonb where from_item_id = ${a} and to_item_id = ${b}`,
		);
		expect((await legBetween(t.tripId, a, b))?.mode ?? null).toBeNull();
		await autofillLeg(t.tripId, { kind: "pair", fromItemId: a, toItemId: b });
		expect((await legBetween(t.tripId, a, b))?.mode).toBe("flight");
	});
});

describe("FB-18 + FB-19a: times added later, the owner's case", () => {
	it("adding times makes it timed; JFK 00:00 for 2 h then 02:00 is not 'missed'", async () => {
		const t = await testTrip();
		const a = await addItem(t, "2026-12-12", t.jfk, {
			pinnedStart: "00:00",
			durationMin: 120,
		});
		const b = await addItem(t, "2026-12-13", t.hnd, { durationMin: 60 });
		const auto = await legBetween(t.tripId, a, b);
		const f = flightOf(auto);
		await call(saveFlight, owner, {
			target: { kind: "pair", fromItemId: a, toItemId: b },
			flight: {
				...f,
				flightNumber: "NH 744",
				depLocal: "2026-12-12T02:00",
				arrLocal: "2026-12-13T05:25",
			},
		});
		const leg = await legBetween(t.tripId, a, b);
		expect(leg).toMatchObject({
			mode: "flight",
			source: "manual",
			isEdited: true,
			depAt: "2026-12-12T07:00:00.000Z", // 02:00 EST
			arrAt: "2026-12-12T20:25:00.000Z", // 05:25 JST
		});
		const g = await graphOf(t.tripId);
		const ix = indexGraph(g);
		const sched = computeSchedule(ix);
		const s = sched.legs[pairKey(a, b)];
		expect(s?.late).toBeUndefined();
		// The day's 09:00 start is left alone: a first stop pinned before it
		// starts the day early in the schedule (no "after midnight" misread).
		const day = g.days.find((d) => d.date === "2026-12-12");
		expect(day?.startTime).toBe("09:00");
		expect(
			hhmm(sched.days[day?.id as string]?.start as Date, "America/New_York"),
		).toBe("00:00");
		const jfk = sched.items[a];
		expect(hhmm(jfk?.start as Date, "America/New_York")).toBe("00:00");
		expect(hhmm(jfk?.end as Date, "America/New_York")).toBe("02:00");
		expect(sched.days[day?.id as string]?.conflicts).toBe(0);
	});

	it("only a departure time: the arrival is dep + estimate", async () => {
		const t = await testTrip();
		const a = await addItem(t, "2026-12-12", t.jfk, { durationMin: 120 });
		const b = await addItem(t, "2026-12-13", t.hnd, { durationMin: 60 });
		const auto = await legBetween(t.tripId, a, b);
		const f = flightOf(auto);
		await call(saveFlight, owner, {
			target: { kind: "pair", fromItemId: a, toItemId: b },
			flight: { ...f, depLocal: "2026-12-12T02:00" },
		});
		const leg = await legBetween(t.tripId, a, b);
		// 07:00Z + 14h 5m.
		expect(leg?.depAt).toBe("2026-12-12T07:00:00.000Z");
		expect(leg?.arrAt).toBe("2026-12-12T21:05:00.000Z");
		const stored = flightOf(leg);
		expect(stored.arrLocal).toBeUndefined();
		expect(stored.arrDate).toBe("2026-12-13");
	});
});

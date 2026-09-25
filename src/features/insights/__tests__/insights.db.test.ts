/**
 * WP-Insights server functions against real Postgres and Redis:
 * `setOpeningHours` (proposable `node.hours`: roles, manual source, null
 * removes, stale `expectedUpdatedAt` → CONFLICT, activity), `fetchOpeningHours`
 * (edit-only, Google key only, never over manual hours: HRS-04) and
 * `getClimate` (cities/areas only, one archive request per cell then the DB:
 * CLIM-01, out of budget → unavailable: CLIM-02). External hosts are stubbed.
 * A graceful "unavailable" answer is an HTTP 200, not the status of the error
 * it swallowed (the browser logged those as failed requests).
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_ins_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-instest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	process.env.GOOGLE_MAPS_API_KEY = "test-key";
	process.env.GOOGLE_PLACES_URL = "http://places.test";
	process.env.OPEN_METEO_ARCHIVE_URL = "http://archive.test";
	process.env.CLIMATE_ENABLED = "true";
	return { hex, scratchUrl: scratch.toString() };
});

vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
/** Every HTTP status the code under test set (`withStatus`, …), in order. */
const statuses = vi.hoisted(() => [] as number[]);
vi.mock("@tanstack/react-start/server", async () => ({
	...(await import("@/test/start-server-mock")),
	setResponseStatus: (status: number) => {
		statuses.push(status);
	},
}));

import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { climateNormals, nodes, tripMembers, user } from "@/db/schema";
import { getTripGraph, listActivity } from "@/functions/graph.functions";
import type { TripGraph } from "@/lib/engine/types";
import type { OpeningHours } from "@/lib/schemas/hours";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { redeemShareToken } from "@/server/authz/share-links.server";
import { rateLimitPer } from "@/server/cache.server";
import { getEnv } from "@/server/env.server";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import {
	fetchOpeningHours,
	getClimate,
	setOpeningHours,
} from "../insights.functions";
import { climateCell, monthlyNormals } from "../server/climate.server";

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

async function newUser(
	name: { first: string; last: string } | null,
): Promise<AuthUser> {
	const id = randomUUID();
	const anonymous = name === null;
	await getDb()
		.insert(user)
		.values({
			id,
			email: `${anonymous ? "temp" : "u"}-${id}@${anonymous ? "guest.yonder.invalid" : "example.test"}`,
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
	"owner" | "viewer" | "stranger" | "guestEditor" | "guestViewer",
	AuthUser
>;

async function freshTrip(): Promise<FixtureClone> {
	const c = await cloneDemoTrip(getDb(), U.owner.id);
	await getDb().insert(tripMembers).values({
		tripId: c.tripId,
		userId: U.viewer.id,
		status: "active",
		role: "viewer",
		color: 5,
	});
	await redeemShareToken(c.shareTokens.editor, U.guestEditor.id);
	await redeemShareToken(c.shareTokens.viewer, U.guestViewer.id);
	return c;
}

const AT = "2026-09-01T00:00:00.000Z";
const HOURS: OpeningHours = {
	source: "google", // the server stores every person's save as manual
	periods: [0, 1, 2, 4, 5, 6].map((day) => ({
		day,
		open: "10:00",
		close: "19:00",
	})),
	closedNth: [{ day: 2, nth: 2 }],
	lastEntryBeforeCloseMin: 30,
	updatedAt: AT,
};

async function nodeDetails(nodeId: string): Promise<Record<string, unknown>> {
	const [row] = await getDb()
		.select({ details: nodes.details })
		.from(nodes)
		.where(sql`${nodes.id} = ${nodeId}`);
	return (row?.details ?? {}) as Record<string, unknown>;
}

/** Stubs the Google Places and Open-Meteo hosts; counts calls per host. */
const calls = { places: 0, archive: 0 };
/** The archive's HTTP status (anything but 200 answers with an error). */
let archiveStatus = 200;
let placesAnswer: unknown = {
	regularOpeningHours: {
		periods: [1, 2, 3, 4, 5].map((day) => ({
			open: { day, hour: 9, minute: 0 },
			close: { day, hour: 17, minute: 30 },
		})),
	},
};
function archiveBody(): unknown {
	const time: string[] = [];
	const d = new Date("2016-01-01T00:00:00Z");
	while (d.getUTCFullYear() < 2026) {
		time.push(d.toISOString().slice(0, 10));
		d.setUTCDate(d.getUTCDate() + 1);
	}
	const month = (t: string) => Number(t.slice(5, 7));
	return {
		daily: {
			time,
			temperature_2m_max: time.map((t) => 10 + month(t)),
			temperature_2m_min: time.map((t) => month(t)),
			// October: rain on every 3rd day.
			precipitation_sum: time.map((t, i) =>
				month(t) === 10 && i % 3 === 0 ? 6 : 0,
			),
			sunshine_duration: time.map(() => 5 * 3600),
		},
	};
}

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	U.owner = await newUser({ first: "Dev", last: "Owner" });
	U.viewer = await newUser({ first: "Vic", last: "Viewer" });
	U.stranger = await newUser({ first: "Sam", last: "Stranger" });
	U.guestEditor = await newUser(null);
	U.guestViewer = await newUser(null);
	const realFetch = globalThis.fetch;
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url,
			);
			if (url.host === "places.test") {
				calls.places++;
				expect(new Headers(init?.headers).get("X-Goog-FieldMask")).toBe(
					"regularOpeningHours",
				);
				return new Response(JSON.stringify(placesAnswer), { status: 200 });
			}
			if (url.host === "archive.test") {
				calls.archive++;
				expect(url.pathname).toBe("/v1/archive");
				expect(url.searchParams.get("start_date")).toBe("2016-01-01");
				if (archiveStatus !== 200)
					return new Response("unavailable", { status: archiveStatus });
				return new Response(JSON.stringify(archiveBody()), { status: 200 });
			}
			return realFetch(input, init);
		},
	);
});

afterAll(async () => {
	vi.unstubAllGlobals();
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

describe("setOpeningHours (node.hours)", () => {
	it("owners and guest editors save manual hours; viewers 403; strangers 404", async () => {
		const c = await freshTrip();
		const nodeId = c.ids.nodes.itoya;
		const input = { nodeId, hours: HOURS };
		expect(await codeOf(call(setOpeningHours, U.viewer, input))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(setOpeningHours, U.guestViewer, input))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(setOpeningHours, U.stranger, input))).toBe(
			"NOT_FOUND",
		);
		expect(await codeOf(call(setOpeningHours, U.guestEditor, input))).toBe(
			"ok",
		);
		const r = await call<{ updatedAt: string }>(
			setOpeningHours,
			U.owner,
			input,
		);
		expect(typeof r.updatedAt).toBe("string");
		const d = await nodeDetails(nodeId as string);
		expect(d.openingHours).toMatchObject({
			source: "manual",
			closedNth: [{ day: 2, nth: 2 }],
			lastEntryBeforeCloseMin: 30,
		});
		const graph = await call<TripGraph>(getTripGraph, U.viewer, {
			tripId: c.tripId,
		});
		expect(
			graph.nodes.find((n) => n.id === nodeId)?.details.openingHours?.source,
		).toBe("manual");
		const activity = await call<{ summary: string; nodeId: string | null }[]>(
			listActivity,
			U.owner,
			{ tripId: c.tripId },
		);
		expect(
			activity.some(
				(a) =>
					a.nodeId === nodeId && a.summary === "updated hours of Itoya Ginza",
			),
		).toBe(true);
	});

	it("keeps other details, removes hours with null, and refuses a stale save", async () => {
		const c = await freshTrip();
		const nodeId = c.ids.nodes.itoya as string;
		await getDb()
			.update(nodes)
			.set({
				details: {
					openHoursText: "10:30–19:00; closed 2nd Tue",
					website: "https://www.ito-ya.co.jp/",
				},
			})
			.where(sql`${nodes.id} = ${nodeId}`);
		const first = await call<{ updatedAt: string }>(setOpeningHours, U.owner, {
			nodeId,
			hours: HOURS,
		});
		expect(await nodeDetails(nodeId)).toMatchObject({
			openHoursText: "10:30–19:00; closed 2nd Tue",
			website: "https://www.ito-ya.co.jp/",
		});
		expect(
			await codeOf(
				call(setOpeningHours, U.owner, {
					nodeId,
					hours: HOURS,
					expectedUpdatedAt: AT,
				}),
			),
		).toBe("CONFLICT");
		expect(
			await codeOf(
				call(setOpeningHours, U.owner, {
					nodeId,
					hours: null,
					expectedUpdatedAt: first.updatedAt,
				}),
			),
		).toBe("ok");
		const d = await nodeDetails(nodeId);
		expect(d.openingHours).toBeUndefined();
		expect(d.openHoursText).toBe("10:30–19:00; closed 2nd Tue");
	});

	it("validates the hours", async () => {
		const c = await freshTrip();
		const bad = {
			...HOURS,
			periods: [{ day: 9, open: "25:00", close: "10:00" }],
		};
		expect(
			await codeOf(
				call(setOpeningHours, U.owner, {
					nodeId: c.ids.nodes.itoya,
					hours: bad,
				}),
			),
		).not.toBe("ok");
	});
});

describe("fetchOpeningHours", () => {
	it("writes Google hours to places with a place id, never over manual hours (HRS-04)", async () => {
		const c = await freshTrip();
		const itoya = c.ids.nodes.itoya as string;
		const loft = c.ids.nodes.loft as string;
		await getDb()
			.update(nodes)
			.set({ googlePlaceId: "ChIJ_itoya_place_id" })
			.where(sql`${nodes.id} = ${itoya}`);
		await getDb()
			.update(nodes)
			.set({ googlePlaceId: "ChIJ_loft_place_id00" })
			.where(sql`${nodes.id} = ${loft}`);
		await call(setOpeningHours, U.owner, { nodeId: loft, hours: HOURS });
		const before = calls.places;
		const r = await call<{ updated: string[] }>(fetchOpeningHours, U.owner, {
			tripId: c.tripId,
			nodeIds: [itoya, loft],
		});
		expect(r.updated).toEqual([itoya]);
		expect(calls.places - before).toBe(1);
		const d = await nodeDetails(itoya);
		expect(d.openingHours).toMatchObject({
			source: "google",
			periods: [
				{ day: 1, open: "09:00", close: "17:30" },
				{ day: 2 },
				{ day: 3 },
				{ day: 4 },
				{ day: 5 },
			],
		});
		expect(typeof d.openingHoursFetchedAt).toBe("string");
		expect(
			((await nodeDetails(loft)).openingHours as { source: string }).source,
		).toBe("manual");
		// Fetched within 30 days: nothing to do (and no Google call).
		const again = await call<{ updated: string[] }>(
			fetchOpeningHours,
			U.owner,
			{ tripId: c.tripId, nodeIds: [itoya] },
		);
		expect(again.updated).toEqual([]);
		expect(calls.places - before).toBe(1);
	});

	it("is edit-only and needs a Google key", async () => {
		const c = await freshTrip();
		const input = { tripId: c.tripId, nodeIds: [c.ids.nodes.itoya] };
		expect(await codeOf(call(fetchOpeningHours, U.viewer, input))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(fetchOpeningHours, U.stranger, input))).toBe(
			"NOT_FOUND",
		);
		const env = getEnv() as { GOOGLE_MAPS_API_KEY?: string };
		const key = env.GOOGLE_MAPS_API_KEY;
		env.GOOGLE_MAPS_API_KEY = undefined;
		try {
			expect(await codeOf(call(fetchOpeningHours, U.owner, input))).toBe(
				"VALIDATION",
			);
		} finally {
			env.GOOGLE_MAPS_API_KEY = key;
		}
		placesAnswer = {};
		expect(await call(fetchOpeningHours, U.guestEditor, input)).toEqual({
			updated: [],
		});
	});
});

describe("getClimate", () => {
	it("fetches a cell once, then answers from the table (CLIM-01)", async () => {
		const c = await freshTrip();
		const tokyo = c.ids.nodes.tokyo as string;
		const kyoto = c.ids.nodes.kyoto as string;
		const before = calls.archive;
		const r = await call<{
			byNode: Record<
				string,
				{
					month: number;
					tMaxC: number;
					precipMm: number;
					wetDays: number;
					sunHours: number;
				}[]
			>;
			years: string;
			attribution: string;
			unavailable: string[];
		}>(getClimate, U.guestViewer, {
			tripId: c.tripId,
			nodeIds: [tokyo, kyoto],
		});
		expect(calls.archive - before).toBe(2);
		expect(r.years).toBe("2016–2025");
		expect(r.attribution).toContain("Open-Meteo.com");
		expect(r.unavailable).toEqual([]);
		const oct = r.byNode[tokyo]?.[9];
		expect(oct).toMatchObject({ month: 10, tMaxC: 20, sunHours: 5 });
		expect(oct?.wetDays).toBeGreaterThan(9);
		expect(oct?.wetDays).toBeLessThan(12);
		const rows = await getDb()
			.select()
			.from(climateNormals)
			.where(sql`${climateNormals.cell} = ${climateCell(35.6762, 139.6503)}`);
		expect(rows).toHaveLength(12);
		await call(getClimate, U.owner, { tripId: c.tripId, nodeIds: [tokyo] });
		expect(calls.archive - before).toBe(2);
	});

	it("refuses places, countries and strangers", async () => {
		const c = await freshTrip();
		expect(
			await codeOf(
				call(getClimate, U.owner, {
					tripId: c.tripId,
					nodeIds: [c.ids.nodes.itoya],
				}),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(
				call(getClimate, U.owner, {
					tripId: c.tripId,
					nodeIds: [c.ids.nodes.japan],
				}),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(
				call(getClimate, U.stranger, {
					tripId: c.tripId,
					nodeIds: [c.ids.nodes.tokyo],
				}),
			),
		).toBe("NOT_FOUND");
	});

	it("says unavailable when the user is out of budget (CLIM-02)", async () => {
		const c = await freshTrip();
		for (let i = 0; i < 30; i++)
			await rateLimitPer(`climate:u:${U.viewer.id}`, 30, 3600);
		statuses.length = 0;
		const r = await call<{
			byNode: Record<string, unknown>;
			unavailable: string[];
		}>(getClimate, U.viewer, {
			tripId: c.tripId,
			nodeIds: [c.ids.nodes.seoul, c.ids.nodes.tokyo],
		});
		// Tokyo is in the table already (no budget needed); Seoul would need a request.
		expect(Object.keys(r.byNode)).toEqual([c.ids.nodes.tokyo]);
		expect(r.unavailable).toEqual([c.ids.nodes.seoul]);
		// The swallowed RATE_LIMITED set a 429; the answer itself is a 200.
		expect(statuses).toContain(429);
		expect(statuses.at(-1)).toBe(200);
	});

	it("says unavailable, with a 200, when the archive fails", async () => {
		const c = await freshTrip();
		archiveStatus = 503;
		statuses.length = 0;
		try {
			const r = await call<{
				byNode: Record<string, unknown>;
				unavailable: string[];
			}>(getClimate, U.owner, {
				tripId: c.tripId,
				nodeIds: [c.ids.nodes.taipei],
			});
			expect(r.byNode).toEqual({});
			expect(r.unavailable).toEqual([c.ids.nodes.taipei]);
			expect(statuses).toContain(502);
			expect(statuses.at(-1)).toBe(200);
		} finally {
			archiveStatus = 200;
		}
	});
});

describe("monthlyNormals", () => {
	it("averages per month over the years", () => {
		const months = monthlyNormals(
			(archiveBody() as { daily: Parameters<typeof monthlyNormals>[0] }).daily,
		);
		expect(months).toHaveLength(12);
		expect(months[0]).toMatchObject({
			month: 1,
			tMaxC: 11,
			tMinC: 1,
			precipMm: 0,
			wetDays: 0,
			sunHours: 5,
		});
	});
});

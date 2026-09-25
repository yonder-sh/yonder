/**
 * WP-Transit's server functions against real Postgres and Redis: the Japan
 * `estimate` provider through `getTransitOptions` and the autofill job,
 * custom routes (save / update / delete with fallback), reserved times and
 * bookings (guest merge, never leaked), flights (airports replaced from
 * airports.json, validation, seats → travellers) and flight blocks with a
 * layover (`createFlightWithAirports`), reset, choose and lock.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_tr_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-trtest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	// No provider keys: Google stays off, so nothing leaves the machine.
	process.env.GOOGLE_MAPS_API_KEY = "";
	// OSRM foot unreachable: walks fall back to the estimate, offline.
	process.env.OSRM_FOOT_URL = "http://127.0.0.1:9";
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
import { activityLog, legs, nodes, tripMembers, user } from "@/db/schema";
import { setDayStay } from "@/functions/days.functions";
import { getTripGraph } from "@/functions/graph.functions";
import { getLeg, setLeg } from "@/functions/legs.functions";
import { indexGraph, pairKey } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import type { GraphLeg, TripGraph } from "@/lib/engine/types";
import type { TransitRoute } from "@/lib/schemas/legs";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { redeemShareToken } from "@/server/authz/share-links.server";
import { cacheSet } from "@/server/cache.server";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { autofillLeg } from "../server/autofill.server";
import { walkFarPastEstimate } from "../server/walk.server";
import {
	chooseTransitOption,
	createFlightWithAirports,
	deleteCustomRoute,
	estimateWalk,
	getTransitOptions,
	lockTransitTimes,
	railRide,
	resetLegEstimate,
	saveCustomRoute,
	saveFlight,
	saveTransitDetails,
	searchRail,
	updateCustomRoute,
} from "../transit.functions";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const { scratchUrl } = testEnv;

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
	"owner" | "viewer" | "stranger" | "guestEditor",
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
	return c;
}

async function legOf(
	c: FixtureClone,
	from: string,
	to: string,
): Promise<GraphLeg | undefined> {
	const g = await call<{ legs: GraphLeg[] }>(getTripGraph, U.owner, {
		tripId: c.tripId,
	});
	return g.legs.find((l) => l.fromItemId === from && l.toItemId === to);
}

/** The trip's activity verbs, oldest first. */
async function verbsOf(c: FixtureClone): Promise<string[]> {
	const rows = await getDb()
		.select({ verb: activityLog.verb })
		.from(activityLog)
		.where(sql`${activityLog.tripId} = ${c.tripId}`)
		.orderBy(activityLog.createdAt);
	return rows.map((r) => r.verb);
}

const pair = (from: string, to: string) =>
	({ kind: "pair", fromItemId: from, toItemId: to }) as const;

beforeAll(async () => {
	await ensureDatabase(scratchUrl);
	await migrateDatabase(scratchUrl);
	U.owner = await newUser({ first: "Dev", last: "Owner" });
	U.viewer = await newUser({ first: "Vic", last: "Viewer" });
	U.stranger = await newUser({ first: "Sam", last: "Stranger" });
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

describe("Japan transit: the estimate provider", () => {
	it("returns 2–3 rail options fastest first with Open in Google Maps, and chooses the fastest", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const target = pair(I.loft as string, I.meiji as string);
		const res = await call<{
			provider: string;
			options: TransitRoute[];
			googleMapsUrl?: string;
			attribution?: string;
		}>(getTransitOptions, U.owner, {
			target,
			departAt: "2027-10-03T01:33:00.000Z",
		});
		expect(res.provider).toBe("estimate");
		expect(res.options.length).toBeGreaterThanOrEqual(2);
		expect(res.options.length).toBeLessThanOrEqual(3);
		const mins = res.options.map((o) => o.durationMin);
		expect([...mins].sort((a, b) => a - b)).toEqual(mins);
		for (const o of res.options) {
			expect(o.source).toBe("estimate");
			expect(o.range?.lo).toBeLessThanOrEqual(o.durationMin);
			expect(o.dataBuild).toMatch(/^N02-25\./);
			expect(o.geometry?.coordinates.length ?? 0).toBeLessThanOrEqual(200);
		}
		expect(res.googleMapsUrl).toMatch(
			/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&origin=35\.66\d*,139\.69\d*&destination=35\.67\d*,139\.69\d*&travelmode=transit$/,
		);
		expect(res.attribution).toContain("MLIT");
		const leg = await legOf(c, I.loft as string, I.meiji as string);
		expect(leg?.mode).toBe("transit");
		expect(leg?.source).toBe("estimate");
		expect(leg?.durationMin).toBe(res.options[0]?.durationMin);
		expect(leg?.isEdited).toBe(false);
	});

	it("keeps a person's own minutes (isEdited) and only stores the options", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const target = pair(I.itoya as string, I.dropBags as string);
		await call(getTransitOptions, U.owner, {
			target,
			departAt: "2027-10-05T00:00:00.000Z",
		});
		const leg = await legOf(c, I.itoya as string, I.dropBags as string);
		expect(leg?.durationMin).toBe(116);
		const row = await call<{ alternatives: TransitRoute[] }>(getLeg, U.owner, {
			target,
		});
		expect(row.alternatives.length).toBeGreaterThan(0);
	});

	it("is edit-only: viewers and strangers can't fetch", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const data = {
			target: pair(I.loft as string, I.meiji as string),
			departAt: "2027-10-03T01:33:00.000Z",
		};
		expect(await codeOf(call(getTransitOptions, U.viewer, data))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(getTransitOptions, U.stranger, data))).toBe(
			"NOT_FOUND",
		);
	});

	it("autofill writes the fastest estimate for an unset Japan transit leg, and never overwrites a choice", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		// Across a night with no stay, the pair is an overnight connector
		// (SPEC §9.2): autofill leaves it alone.
		expect(
			(await autofillLeg(c.tripId, pair(I.sky as string, I.sensoji as string)))
				.keys,
		).toEqual([]);
		expect(
			(await legOf(c, I.sky as string, I.sensoji as string))?.mode ?? null,
		).toBeNull();
		const target = pair(I.loft as string, I.meiji as string);
		const before = await legOf(c, I.loft as string, I.meiji as string);
		expect(before?.mode ?? null).toBeNull();
		const r = await autofillLeg(c.tripId, target);
		expect(r.keys).toEqual(["graph"]);
		const leg = await legOf(c, I.loft as string, I.meiji as string);
		expect(leg?.mode).toBe("transit");
		expect(leg?.source).toBe("estimate");
		const d = leg?.details as { route?: TransitRoute };
		expect(d.route?.source).toBe("estimate");
		// Every option is kept for the picker (written through writeLeg + alternatives).
		const [row] = await getDb()
			.select({ alternatives: legs.alternatives, queriedFor: legs.queriedFor })
			.from(legs)
			.where(sql`${legs.id} = ${leg?.id as string}`);
		expect(
			(row?.alternatives as TransitRoute[] | undefined)?.length ?? 0,
		).toBeGreaterThan(1);
		expect(row?.queriedFor).not.toBeNull();
		// A second run changes nothing (the leg has a mode now).
		expect((await autofillLeg(c.tripId, target)).keys).toEqual([]);
	});

	it("autofill writes a walk, not a walk-only 'transit' leg, when walking beats every train (QA MT-06)", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const N = c.ids.nodes;
		// Loft → Meiji Jingu moved to Oishi Park → Lake Kawaguchiko (1.6 km).
		await getDb()
			.update(nodes)
			.set({ lat: 35.5237, lng: 138.742 })
			.where(sql`${nodes.id} = ${N.loft as string}`);
		await getDb()
			.update(nodes)
			.set({ lat: 35.514, lng: 138.755 })
			.where(sql`${nodes.id} = ${N.meijiJingu as string}`);
		const target = pair(I.loft as string, I.meiji as string);
		expect((await autofillLeg(c.tripId, target)).keys).toEqual(["graph"]);
		const leg = await legOf(c, I.loft as string, I.meiji as string);
		expect(leg?.mode).toBe("walk");
		expect(leg?.isEdited).toBe(false);
		expect(((leg as GraphLeg).details as { kind: string }).kind).not.toBe(
			"transit",
		);
		// Asked for transit options, the walk-only one is listed but never picked.
		await call(setLeg, U.owner, { target, patch: { mode: "transit" } });
		const res = await call<{ options: TransitRoute[] }>(
			getTransitOptions,
			U.owner,
			{ target, departAt: "2027-10-03T01:33:00.000Z" },
		);
		const after = await legOf(c, I.loft as string, I.meiji as string);
		const chosen = ((after as GraphLeg).details as { route?: TransitRoute })
			.route;
		if (chosen)
			expect(chosen.segments.every((s) => s.mode === "walk")).toBe(false);
		expect(res.options.length).toBeGreaterThan(0);
	});

	it("autofill leaves the leg unset when the real walk is far past the estimate that chose walking (QA MT-R2-03)", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const N = c.ids.nodes;
		const setAt = async (node: string, lat: number, lng: number) =>
			getDb().update(nodes).set({ lat, lng }).where(sql`${nodes.id} = ${node}`);
		// OSRM's answer for a pair, as its cache holds it (no network in tests).
		const osrmSays = (
			a: [number, number],
			b: [number, number],
			walk: { minutes: number; distanceM: number },
		) =>
			cacheSet(
				["route", "osrm", "foot", ...[...a, ...b].map((x) => x.toFixed(5))],
				{ ...walk, source: "osrm" },
				600,
			);
		const target = pair(I.loft as string, I.meiji as string);
		const modeOf = async () =>
			(await legOf(c, I.loft as string, I.meiji as string))?.mode ?? null;

		// Oishi Park → Lake Kawaguchiko (the node sits in the lake): the rail
		// estimate's walk is 28 min (likely 24–36), OSRM walks 5.9 km round
		// the shore in 78 min. Nothing is written: no "22m late" on Thu 7 Oct.
		const oishi: [number, number] = [35.5237, 138.742];
		const lake: [number, number] = [35.514, 138.755];
		await setAt(N.loft as string, ...oishi);
		await setAt(N.meijiJingu as string, ...lake);
		await osrmSays(oishi, lake, { minutes: 78, distanceM: 5859 });
		expect((await autofillLeg(c.tripId, target)).keys).toEqual([]);
		expect(await modeOf()).toBeNull();

		// A real walk inside the estimate's range is written as the walk.
		await osrmSays(oishi, lake, { minutes: 30, distanceM: 2300 });
		expect((await autofillLeg(c.tripId, target)).keys).toEqual(["graph"]);
		const leg = await legOf(c, I.loft as string, I.meiji as string);
		expect(leg?.mode).toBe("walk");
		expect(leg?.source).toBe("osrm");
		expect(leg?.durationMin).toBe(30);
		// Back to unset (an autofilled leg only; nobody edited it).
		await getDb()
			.delete(legs)
			.where(sql`${legs.id} = ${leg?.id as string}`);
		expect(await modeOf()).toBeNull();

		// A plain walk suggestion (< 1.5 km) is held to the same rule: 1.1 km
		// across the water that OSRM walks in 70 min writes nothing.
		const shore: [number, number] = [35.5237, 138.754];
		await setAt(N.meijiJingu as string, ...shore);
		await osrmSays(oishi, shore, { minutes: 70, distanceM: 5200 });
		expect((await autofillLeg(c.tripId, target)).keys).toEqual([]);
		expect(await modeOf()).toBeNull();
	});

	it("walkFarPastEstimate: past the likely range in minutes and metres; a slower pace alone still fits", () => {
		const est = { minutes: 28, hiMin: 36, straightM: 1600 };
		const osrm = (minutes: number, distanceM: number) =>
			({ minutes, distanceM, source: "osrm" }) as const;
		expect(walkFarPastEstimate(osrm(78, 5859), est)).toBe(true);
		expect(walkFarPastEstimate(osrm(36, 2300), est)).toBe(false);
		// Slower, same path (the trip's walk speed vs the provider's pace).
		expect(walkFarPastEstimate(osrm(45, 2200), est)).toBe(false);
		// The chain's own estimate always fits.
		expect(
			walkFarPastEstimate({ ...osrm(78, 5859), source: "estimate" }, est),
		).toBe(false);
		// No route range: ERROR_BAND (+20 % + 3 min) on the estimate.
		const bare = { minutes: 20, straightM: 1100 };
		expect(walkFarPastEstimate(osrm(27, 4000), bare)).toBe(false);
		expect(walkFarPastEstimate(osrm(28, 4000), bare)).toBe(true);
	});

	it("choose picks another option; lock refuses estimates; reset restores the estimate", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const target = pair(I.loft as string, I.meiji as string);
		const res = await call<{ options: TransitRoute[] }>(
			getTransitOptions,
			U.owner,
			{ target, departAt: "2027-10-03T01:33:00.000Z" },
		);
		const second = res.options[1] as TransitRoute;
		await call(chooseTransitOption, U.owner, { target, optionId: second.id });
		let leg = await legOf(c, I.loft as string, I.meiji as string);
		expect(leg?.durationMin).toBe(second.durationMin);
		expect(
			await codeOf(
				call(lockTransitTimes, U.owner, { target, optionId: second.id }),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(
				call(chooseTransitOption, U.viewer, { target, optionId: second.id }),
			),
		).toBe("FORBIDDEN");
		await call(resetLegEstimate, U.owner, { target });
		leg = await legOf(c, I.loft as string, I.meiji as string);
		expect(leg?.isEdited).toBe(false);
	});
});

/** OSRM's answer for a pair, as its cache holds it (no network in tests). */
const osrmSays = (
	a: [number, number],
	b: [number, number],
	walk: { minutes: number; distanceM: number },
) =>
	cacheSet(
		["route", "osrm", "foot", ...[...a, ...b].map((x) => x.toFixed(5))],
		{ ...walk, source: "osrm" },
		600,
	);

describe("walk ↔ transit (QA MT-06 residual, FB-09)", () => {
	const isWalkOnly = (r: TransitRoute) =>
		r.segments.length > 0 && r.segments.every((s) => s.mode === "walk");
	/** Moves Loft → Meiji Jingu to Oishi Park → Lake Kawaguchiko (1.6 km across the water). */
	async function oishiToLake(c: FixtureClone) {
		const N = c.ids.nodes;
		const oishi: [number, number] = [35.5237, 138.742];
		const lake: [number, number] = [35.514, 138.755];
		await getDb()
			.update(nodes)
			.set({ lat: oishi[0], lng: oishi[1] })
			.where(sql`${nodes.id} = ${N.loft as string}`);
		await getDb()
			.update(nodes)
			.set({ lat: lake[0], lng: lake[1] })
			.where(sql`${nodes.id} = ${N.meijiJingu as string}`);
		return { oishi, lake };
	}

	it("a measured walk switched to transit loses the walk's distance (every transit write)", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const target = pair(I.loft as string, I.meiji as string);
		const loft: [number, number] = [35.6612, 139.6987];
		const meiji: [number, number] = [35.6764, 139.6993];
		await osrmSays(loft, meiji, { minutes: 20, distanceM: 1474 });
		const leg = () => legOf(c, I.loft as string, I.meiji as string);
		const walk = async () => {
			await call(estimateWalk, U.owner, { target, apply: true });
			const w = await leg();
			expect(w?.mode).toBe("walk");
			expect(w?.distanceM).toBe(1474);
		};
		// 1. The Transit tab of an older client (no distanceM in the patch),
		//    then the options: the fastest ride is chosen, the walk's 1.5 km goes.
		await walk();
		await call(setLeg, U.owner, { target, patch: { mode: "transit" } });
		const res = await call<{ options: TransitRoute[] }>(
			getTransitOptions,
			U.owner,
			{ target, departAt: "2027-10-03T01:33:00.000Z" },
		);
		let t = await leg();
		expect(t?.mode).toBe("transit");
		expect(t?.distanceM ?? null).toBeNull();
		// 2. Choosing a listed ride straight from the walk.
		await walk();
		const ride = res.options.find((o) => !isWalkOnly(o)) as TransitRoute;
		await call(chooseTransitOption, U.owner, { target, optionId: ride.id });
		t = await leg();
		expect(t?.mode).toBe("transit");
		expect(t?.durationMin).toBe(ride.durationMin);
		expect(t?.distanceM ?? null).toBeNull();
		// 3. A custom route saved on the walk.
		await walk();
		await call(saveCustomRoute, U.owner, {
			target,
			route: {
				id: `m:${randomUUID()}`,
				source: "manual",
				durationMin: 12,
				segments: [{ mode: "bus", lineName: "Toei Bus 88", durationMin: 12 }],
			},
		});
		t = await leg();
		expect(t?.mode).toBe("transit");
		expect(t?.distanceM ?? null).toBeNull();
		// 4. The same through setLeg with the UI's patch (distanceM: null).
		await walk();
		await call(setLeg, U.owner, {
			target,
			patch: { mode: "other", durationMin: 9, distanceM: null },
		});
		expect((await leg())?.distanceM ?? null).toBeNull();
	});

	it("drops the straight-line walk-only option when the real walk contradicts it (MT-06c)", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const { oishi, lake } = await oishiToLake(c);
		const target = pair(I.loft as string, I.meiji as string);
		// OSRM walks round the shore: 5.9 km in 78 min (the line says 28 min).
		await osrmSays(oishi, lake, { minutes: 78, distanceM: 5859 });
		await call(estimateWalk, U.owner, { target, apply: true });
		const w = await legOf(c, I.loft as string, I.meiji as string);
		expect(w?.durationMin).toBe(78);
		// The Transit tab: no 28-minute "Walk · est." transit route any more.
		await call(setLeg, U.owner, {
			target,
			patch: { mode: "transit", distanceM: null },
		});
		const res = await call<{ options: TransitRoute[] }>(
			getTransitOptions,
			U.owner,
			{ target, departAt: "2027-10-07T01:00:00.000Z" },
		);
		expect(res.options.some(isWalkOnly)).toBe(false);
		const row = await call<{ alternatives: TransitRoute[] }>(getLeg, U.owner, {
			target,
		});
		expect(row.alternatives.some(isWalkOnly)).toBe(false);
		const t = await legOf(c, I.loft as string, I.meiji as string);
		expect(t?.distanceM ?? null).toBeNull();
	});

	it("choosing a walk-only option saves a walk with the real walk time (MT-06c)", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const { oishi, lake } = await oishiToLake(c);
		const target = pair(I.loft as string, I.meiji as string);
		// A real walk inside the line's likely range: the option stays listed.
		await osrmSays(oishi, lake, { minutes: 31, distanceM: 2300 });
		await call(setLeg, U.owner, { target, patch: { mode: "transit" } });
		const res = await call<{ options: TransitRoute[] }>(
			getTransitOptions,
			U.owner,
			{ target, departAt: "2027-10-07T01:00:00.000Z" },
		);
		const walkOnly = res.options.find(isWalkOnly);
		expect(walkOnly).toBeTruthy();
		await call(chooseTransitOption, U.owner, {
			target,
			optionId: walkOnly?.id,
		});
		const leg = await legOf(c, I.loft as string, I.meiji as string);
		expect(leg?.mode).toBe("walk");
		expect(leg?.durationMin).toBe(31);
		expect(leg?.distanceM).toBe(2300);
		expect(leg?.source).toBe("osrm");
		expect((leg?.details as { kind?: string } | undefined)?.kind).not.toBe(
			"transit",
		);
	});
});

describe("custom routes and reserved times", () => {
	it("a custom Shinkansen route (2h15) is saved, edited and deleted (falling back to the fastest option)", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const from = I.itoya as string;
		const to = I.dropBags as string;
		const target = pair(from, to);
		const route: TransitRoute = {
			id: "m:shinkansen",
			source: "manual",
			durationMin: 135,
			walkMin: 0,
			transfers: 0,
			label: "Nozomi 21",
			segments: [
				{
					mode: "high_speed",
					lineName: "Tokaido Shinkansen",
					from: { name: "Tokyo" },
					to: { name: "Kyoto" },
					durationMin: 135,
				},
			],
		};
		await call(saveCustomRoute, U.owner, { target, route });
		expect(await verbsOf(c)).toContain("transit.route");
		let leg = await legOf(c, from, to);
		expect(leg?.mode).toBe("transit");
		expect(leg?.durationMin).toBe(135);
		expect(leg?.source).toBe("manual");
		expect(((leg as GraphLeg).details as { chosenId?: string }).chosenId).toBe(
			"m:shinkansen",
		);
		await call(updateCustomRoute, U.owner, {
			target,
			routeId: "m:shinkansen",
			route: { ...route, durationMin: 140 },
		});
		leg = await legOf(c, from, to);
		expect(leg?.durationMin).toBe(140);
		// Fetched options survive next to the manual one; deleting the chosen
		// manual route falls back to the fastest remaining option.
		await call(getTransitOptions, U.owner, {
			target,
			departAt: "2027-10-05T00:00:00.000Z",
		});
		await call(deleteCustomRoute, U.owner, { target, routeId: "m:shinkansen" });
		leg = await legOf(c, from, to);
		const d = leg?.details as { route?: TransitRoute };
		expect(d.route?.source).toBe("estimate");
		const row = await call<{ alternatives: TransitRoute[] }>(getLeg, U.owner, {
			target,
		});
		expect(row.alternatives.some((r) => r.id === "m:shinkansen")).toBe(false);
		expect(
			await codeOf(
				call(deleteCustomRoute, U.owner, { target, routeId: "m:nope" }),
			),
		).toBe("NOT_FOUND");
	});

	it("an imported manual route (details.route only) survives fetching and can be chosen, edited and deleted (QA MT-01)", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const from = I.itoya as string;
		const to = I.dropBags as string;
		const target = pair(from, to);
		// What the sheet importer and the QA seed write: the route, no alternatives.
		const sheet: TransitRoute = {
			id: "sheet",
			source: "manual",
			durationMin: 125,
			walkMin: 0,
			transfers: 0,
			label: "Fuji Excursion (Shinjuku → Kawaguchiko)",
			segments: [],
		};
		await getDb()
			.update(legs)
			.set({
				mode: "transit",
				durationMin: 125,
				source: "manual",
				isEdited: true,
				details: { kind: "transit", route: sheet, chosenId: "sheet" },
				alternatives: null,
			})
			.where(
				sql`${legs.tripId} = ${c.tripId} and ${legs.fromItemId} = ${from} and ${legs.toItemId} = ${to}`,
			);
		// Chosen before any fetch.
		await call(chooseTransitOption, U.owner, { target, optionId: "sheet" });
		const res = await call<{ options: TransitRoute[] }>(
			getTransitOptions,
			U.owner,
			{ target, departAt: "2027-10-05T00:00:00.000Z" },
		);
		expect(res.options.map((o) => o.id)).toContain("sheet");
		expect(res.options.some((o) => o.source === "estimate")).toBe(true);
		const row = await call<{ alternatives: TransitRoute[] }>(getLeg, U.owner, {
			target,
		});
		expect(row.alternatives.map((r) => r.id)).toContain("sheet");
		let leg = await legOf(c, from, to);
		let d = leg?.details as { route?: TransitRoute; chosenId?: string };
		expect(d.chosenId).toBe("sheet");
		expect(leg?.durationMin).toBe(125);
		// Edit and delete find it.
		await call(updateCustomRoute, U.owner, {
			target,
			routeId: "sheet",
			route: { ...sheet, durationMin: 130 },
		});
		leg = await legOf(c, from, to);
		expect(leg?.durationMin).toBe(130);
		await call(deleteCustomRoute, U.owner, { target, routeId: "sheet" });
		leg = await legOf(c, from, to);
		d = leg?.details as { route?: TransitRoute; chosenId?: string };
		expect(d.route?.source).toBe("estimate");

		// A leg that was never fetched: editing and deleting work straight away.
		const t2 = pair(I.loft as string, I.meiji as string);
		await call(saveCustomRoute, U.owner, {
			target: t2,
			route: { ...sheet, id: "m:x", durationMin: 20 },
		});
		await getDb()
			.update(legs)
			.set({
				details: {
					kind: "transit",
					route: { ...sheet, durationMin: 20 },
					chosenId: "sheet",
				},
				alternatives: null,
			})
			.where(
				sql`${legs.tripId} = ${c.tripId} and ${legs.fromItemId} = ${I.loft as string} and ${legs.toItemId} = ${I.meiji as string}`,
			);
		expect(
			await codeOf(
				call(deleteCustomRoute, U.owner, { target: t2, routeId: "sheet" }),
			),
		).toBe("ok");
	});

	it("a custom route and a plain duration work on a stay leg too (hard acceptance: custom entry everywhere)", async () => {
		const c = await freshTrip();
		// Stay at Itoya Ginza after day 1: day 1 ends with an evening stay leg
		// (Shibuya Sky → the stay) and day 2 starts with a morning one.
		const day1 = Object.values(c.ids.days)[0] as string;
		await call(setDayStay, U.owner, {
			fromDayId: day1,
			nodeId: c.ids.nodes.itoya,
		});
		const g = await call<TripGraph>(getTripGraph, U.owner, {
			tripId: c.tripId,
		});
		const ix = indexGraph(g);
		const stay = g.days
			.flatMap((d) => [
				ix.morningStay(d.id) ? { dayId: d.id, end: "start" as const } : null,
				ix.eveningStay(d.id) ? { dayId: d.id, end: "end" as const } : null,
			])
			.find((t) => t !== null);
		expect(stay).toBeTruthy();
		const target = {
			kind: "stay" as const,
			...(stay as { dayId: string; end: "start" | "end" }),
		};
		const route: TransitRoute = {
			id: "m:bus",
			source: "manual",
			durationMin: 25,
			walkMin: 0,
			transfers: 0,
			label: "Retro bus",
			segments: [{ mode: "bus", lineName: "Retro bus", durationMin: 25 }],
		};
		await call(saveCustomRoute, U.owner, { target, route });
		const find = async () =>
			(
				await call<{ legs: GraphLeg[] }>(getTripGraph, U.owner, {
					tripId: c.tripId,
				})
			).legs.find(
				(l) =>
					l.stayDayId === target.dayId &&
					l.kind === (target.end === "start" ? "stay_start" : "stay_end"),
			);
		let leg = await find();
		expect(leg?.mode).toBe("transit");
		expect(leg?.durationMin).toBe(25);
		// "Just a duration": a route with no steps.
		await call(saveCustomRoute, U.owner, {
			target,
			route: {
				...route,
				id: "m:dur",
				label: undefined,
				segments: [],
				durationMin: 40,
			},
		});
		leg = await find();
		expect(leg?.durationMin).toBe(40);
		expect(leg?.source).toBe("manual");
		// Viewers can't.
		expect(
			await codeOf(call(saveCustomRoute, U.viewer, { target, route })),
		).toBe("FORBIDDEN");
	});

	it("reserved Fuji Excursion 08:30 → 10:26 pins the leg; a guest editor keeps the stored ref and never sees it", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const target = pair(I.itoya as string, I.dropBags as string);
		await call(saveCustomRoute, U.owner, {
			target,
			route: {
				id: "m:fuji",
				source: "manual",
				durationMin: 136,
				walkMin: 20,
				transfers: 0,
				label: "Fuji Excursion 7",
				segments: [
					{ mode: "walk", durationMin: 10 },
					{
						mode: "train",
						lineName: "Fuji Excursion 7",
						from: { name: "Shinjuku" },
						to: { name: "Kawaguchiko" },
						durationMin: 116,
					},
					{ mode: "other", vehicleType: "TAXI", durationMin: 10 },
				],
			},
		});
		await call(saveTransitDetails, U.owner, {
			target,
			fixed: {
				departLocal: "2027-10-05T08:30",
				arriveLocal: "2027-10-05T10:26",
				fromTz: "Asia/Tokyo",
				toTz: "Asia/Tokyo",
				accessMin: 10,
				egressMin: 10,
			},
			booking: {
				ref: "e7k2q9",
				trainNumber: "Fuji Excursion 7",
				car: "3",
				seats: [
					{ memberId: c.members.owner, seat: "5A" },
					{ memberId: c.members.audrey, seat: "5B" },
				],
			},
		});
		let leg = await legOf(c, I.itoya as string, I.dropBags as string);
		expect(leg?.depAt).toBe("2027-10-04T23:30:00.000Z");
		expect(leg?.arrAt).toBe("2027-10-05T01:26:00.000Z");
		expect(leg?.durationMin).toBe(116);
		const stored = leg?.details as { booking: { ref: string } };
		expect(stored.booking.ref).toBe("E7K2Q9");

		const asGuest = await call(getLeg, U.guestEditor, { target });
		expect(JSON.stringify(asGuest)).not.toContain("E7K2Q9");
		expect(JSON.stringify(asGuest)).not.toContain('"5A"');
		// The guest saves the masked booking back with a new class.
		await call(saveTransitDetails, U.guestEditor, {
			target,
			booking: {
				trainNumber: "Fuji Excursion 7",
				class: "Reserved",
				car: "3",
				seats: [
					{ memberId: c.members.owner, seat: "••" },
					{ memberId: c.members.audrey, seat: "••" },
				],
			},
		});
		leg = await legOf(c, I.itoya as string, I.dropBags as string);
		const after = leg?.details as {
			booking: { ref: string; class: string; seats: { seat: string }[] };
		};
		expect(after.booking.ref).toBe("E7K2Q9");
		expect(after.booking.class).toBe("Reserved");
		expect(after.booking.seats.map((s) => s.seat)).toEqual(["5A", "5B"]);
	});
});

describe("flights", () => {
	it("saveFlight takes zones from airports.json, normalises nh9, defaults travellers from seats, and validates", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const target = pair(I.kix as string, I.icn as string);
		const flight = {
			airline: { iata: "KE", name: "Korean Air" },
			flightNumber: "ke 724",
			from: {
				iata: "kix",
				name: "whatever",
				tz: "America/New_York",
				lat: 0,
				lng: 0,
				terminal: "1",
			},
			to: { iata: "ICN", name: "x", tz: "UTC", lat: 0, lng: 0 },
			depLocal: "2027-10-07T13:05",
			arrLocal: "2027-10-07T15:05",
			cabin: "business",
			seats: [{ memberId: c.members.owner, seat: "8D" }],
			bookingRef: "zk4p7q",
		};
		// "kix" is looked up as KIX (QA FLT-03); zones and coordinates come from airports.json.
		const ok = flight;
		await call(saveFlight, U.owner, { target, flight: ok });
		expect(await verbsOf(c)).toContain("flight.save");
		const leg = await legOf(c, I.kix as string, I.icn as string);
		const f = ((leg as GraphLeg).details as { flight: Record<string, unknown> })
			.flight as {
			flightNumber: string;
			from: { tz: string; lat: number; terminal?: string };
			to: { tz: string };
			bookingRef: string;
		};
		expect(f.flightNumber).toBe("KE724");
		expect((f.from as { iata?: string }).iata).toBe("KIX");
		expect(f.from.tz).toBe("Asia/Tokyo");
		expect(f.from.lat).toBeGreaterThan(34);
		expect(f.from.terminal).toBe("1");
		expect(f.to.tz).toBe("Asia/Seoul");
		expect(f.bookingRef).toBe("ZK4P7Q");
		expect(leg?.depAt).toBe("2027-10-07T04:05:00.000Z");
		expect(leg?.assigneeIds).toEqual([c.members.owner]);

		const bad = await codeOf(
			call(saveFlight, U.owner, {
				target,
				flight: {
					...ok,
					to: { ...ok.to, iata: "JFK" },
					arrLocal: "2027-10-07T00:05",
				},
			}),
		);
		expect(bad).toBe("VALIDATION");
		expect(
			await codeOf(
				call(saveFlight, U.owner, {
					target,
					flight: { ...ok, to: { ...ok.to, iata: "JFQ" } },
				}),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(call(saveFlight, U.viewer, { target, flight: ok })),
		).toBe("FORBIDDEN");
	});

	it("a repeated arrival time is stored as the chosen one: EWR 01:30 EST (QA TZ-07)", async () => {
		const c = await freshTrip();
		const I = c.ids.items;
		const target = pair(I.kix as string, I.icn as string);
		const flight = {
			flightNumber: "TK11",
			from: { iata: "IST", name: "IST", tz: "UTC", lat: 0, lng: 0 },
			to: { iata: "EWR", name: "EWR", tz: "UTC", lat: 0, lng: 0 },
			depLocal: "2027-11-06T19:30",
			arrLocal: "2027-11-07T01:30",
			seats: [],
		};
		await call(saveFlight, U.owner, { target, flight });
		let leg = await legOf(c, I.kix as string, I.icn as string);
		expect(leg?.arrAt).toBe("2027-11-07T05:30:00.000Z"); // 01:30 EDT
		await call(saveFlight, U.owner, {
			target,
			flight: { ...flight, arrFold: "later", depFold: "later" },
		});
		leg = await legOf(c, I.kix as string, I.icn as string);
		expect(leg?.arrAt).toBe("2027-11-07T06:30:00.000Z"); // 01:30 EST
		expect(leg?.depAt).toBe("2027-11-06T16:30:00.000Z");
		const f = ((leg as GraphLeg).details as { flight: Record<string, unknown> })
			.flight;
		expect(f.arrFold).toBe("later");
		// 19:30 in Istanbul isn't repeated: that fold isn't kept.
		expect(f.depFold).toBeUndefined();
	});

	it("createFlightWithAirports: HND → KIX → ICN makes a layover, connections and airport nodes", async () => {
		const c = await freshTrip();
		const seg = (
			n: string,
			from: string,
			to: string,
			dep: string,
			arr: string,
		) => ({
			flightNumber: n,
			from: { iata: from, name: from, tz: "UTC", lat: 0, lng: 0 },
			to: { iata: to, name: to, tz: "UTC", lat: 0, lng: 0 },
			depLocal: dep,
			arrLocal: arr,
			seats: [],
		});
		const res = await call<{
			itemIds: string[];
			legIds: string[];
			detachedLegIds: string[];
		}>(createFlightWithAirports, U.owner, {
			tripId: c.tripId,
			segments: [
				seg("JL225", "HND", "KIX", "2027-10-06T07:00", "2027-10-06T08:15"),
				seg("KE724", "KIX", "ICN", "2027-10-06T10:00", "2027-10-06T12:00"),
			],
			bookingRef: "abc123",
		});
		expect(res.itemIds).toHaveLength(3);
		expect(res.legIds).toHaveLength(2);
		expect(await verbsOf(c)).toContain("flight.create");
		const g = await call<{
			items: {
				id: string;
				title: string | null;
				durationMin: number;
				dayId: string | null;
				nodeId: string | null;
			}[];
			nodes: {
				id: string;
				parentId: string | null;
				details: { iata?: string };
			}[];
			legs: GraphLeg[];
		}>(getTripGraph, U.owner, { tripId: c.tripId });
		const layover = g.items.find((i) => i.id === res.itemIds[1]);
		expect(layover?.title).toBe("Layover");
		expect(layover?.durationMin).toBe(105);
		const hnd = g.nodes.find((n) => n.details.iata === "HND");
		expect(hnd?.parentId).toBe(c.ids.nodes.tokyo);
		const [l1, l2] = res.legIds.map((id) => g.legs.find((l) => l.id === id));
		const f1 = (
			(l1 as GraphLeg).details as {
				flight: { connection?: { nextLegId?: string }; bookingRef?: string };
			}
		).flight;
		const f2 = (
			(l2 as GraphLeg).details as {
				flight: { connection?: { prevLegId?: string }; bookingRef?: string };
			}
		).flight;
		expect(f1.connection?.nextLegId).toBe(res.legIds[1]);
		expect(f2.connection?.prevLegId).toBe(res.legIds[0]);
		expect(f1.bookingRef).toBe("ABC123");
		expect(f2.bookingRef).toBe("ABC123");
		expect(
			await codeOf(
				call(createFlightWithAirports, U.owner, {
					tripId: c.tripId,
					segments: [
						seg("JL1", "HND", "KIX", "2027-12-06T07:00", "2027-12-06T08:15"),
					],
				}),
			),
		).toBe("VALIDATION"); // not a day of this trip
	});
});

describe("an early flight on a day that starts later (QA MT-08)", () => {
	it("moves the day start so the new flight isn't created in conflict", async () => {
		const c = await freshTrip();
		const seg = (
			n: string,
			from: string,
			to: string,
			dep: string,
			arr: string,
		) => ({
			flightNumber: n,
			from: { iata: from, name: from, tz: "UTC", lat: 0, lng: 0 },
			to: { iata: to, name: to, tz: "UTC", lat: 0, lng: 0 },
			depLocal: dep,
			arrLocal: arr,
			seats: [],
		});
		// Mon 4 Oct starts 09:00; the flight leaves 06:00 (no airport buffers).
		const day = c.ids.days.d2 as string;
		const res = await call<{ itemIds: string[] }>(
			createFlightWithAirports,
			U.owner,
			{
				tripId: c.tripId,
				dayId: day,
				segments: [
					seg("JL225", "HND", "KIX", "2027-10-04T06:00", "2027-10-04T07:15"),
				],
			},
		);
		const g = await call<TripGraph>(getTripGraph, U.owner, {
			tripId: c.tripId,
		});
		expect(g.days.find((d) => d.id === day)?.startTime).toBe("06:00");
		const sched = computeSchedule(indexGraph(g));
		const flight =
			sched.legs[pairKey(res.itemIds[0] as string, res.itemIds[1] as string)];
		expect(flight?.late).toBeUndefined();
		expect(sched.days[day]?.conflicts ?? 0).toBe(0);

		// A flight that doesn't open its day leaves the start alone.
		const later = await call<{ itemIds: string[] }>(
			createFlightWithAirports,
			U.owner,
			{
				tripId: c.tripId,
				afterItemId: c.ids.items.itoya,
				segments: [
					seg("JL123", "HND", "KIX", "2027-10-04T21:00", "2027-10-04T22:15"),
				],
			},
		);
		expect(later.itemIds).toHaveLength(2);
		const g2 = await call<TripGraph>(getTripGraph, U.owner, {
			tripId: c.tripId,
		});
		expect(g2.days.find((d) => d.id === day)?.startTime).toBe("06:00");
	});
});

describe("N02 look-ups for custom routes", () => {
	it("finds stations by English name, Japanese name and number, and rides between them on real track", async () => {
		const c = await freshTrip();
		const byEn = await call<{
			stations: { name: string; nameEn?: string; lat: number; lng: number }[];
		}>(searchRail, U.owner, {
			tripId: c.tripId,
			q: "Shinjuku",
			near: { lat: 35.69, lng: 139.7 },
		});
		const shinjuku = byEn.stations.find((s) => s.name === "新宿");
		expect(shinjuku).toBeDefined();
		const byJa = await call<{
			stations: { name: string; lat: number; lng: number }[];
		}>(searchRail, U.owner, { tripId: c.tripId, q: "河口湖" });
		const kawaguchiko = byJa.stations.find((s) => s.name === "河口湖");
		expect(kawaguchiko).toBeDefined();
		const ride = await call<{
			durationMin: number;
			segment: { geometry?: { coordinates: unknown[] }; lineName?: string };
		} | null>(railRide, U.owner, {
			tripId: c.tripId,
			from: shinjuku,
			to: kawaguchiko,
		});
		expect(ride?.durationMin).toBeGreaterThan(90);
		expect(ride?.durationMin).toBeLessThan(160);
		expect(ride?.segment.geometry?.coordinates.length ?? 0).toBeGreaterThan(10);
		expect(
			await codeOf(
				call(searchRail, U.stranger, { tripId: c.tripId, q: "Shinjuku" }),
			),
		).toBe("NOT_FOUND");
	});
});

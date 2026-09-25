/**
 * OSM opening hours against real Postgres and Redis (Overpass is a fake: no
 * network): which places are due (`dueOsmNodes`), what a sync writes
 * (`syncOsmHours`: hours, fetch stamps, the trip version only when hours
 * changed), precedence under the row lock (manual and Google hours are never
 * touched), and the node cores queueing `hours.osm` for new or re-linked
 * places.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_osm_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-osmtest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	process.env.OVERPASS_URL = "http://overpass.test/api/interpreter";
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
import { nodes, trips, user } from "@/db/schema";
import type { OpeningHours } from "@/lib/schemas/hours";
import type { NodeDetails } from "@/lib/schemas/nodes";
import type { AuthUser } from "@/server/auth.server";
import { createNodeCore, updateNodeCore } from "@/server/cores/nodes.server";
import { cloneDemoTrip } from "@/server/fixture.server";
import { closeQueues, getQueue } from "@/server/live/jobs.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { withTripTx } from "@/server/tx.server";
import {
	dueOsmNodes,
	osmHoursForTrip,
	syncOsmHours,
} from "../server/osm-hours-sync.server";
import { memoryPace, type OverpassDeps } from "../server/overpass.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let owner: AuthUser;

/** A fake Overpass: `tags[ref]` (undefined → the object has no hours). */
function fakeOverpass(tags: Record<string, string | undefined>) {
	const asked: string[][] = [];
	const deps: OverpassDeps = {
		url: "http://overpass.test/api/interpreter",
		userAgent: "Yonder/1.0 (+test)",
		pace: memoryPace(),
		sleep: async () => {},
		cache: { get: async () => null, set: async () => {} },
		fetch: async (_url, init) => {
			const q = new URLSearchParams(String(init?.body ?? "")).get("data") ?? "";
			const ids = [...q.matchAll(/(node|way|rel)\(id:([\d,]+)\)/g)].flatMap(
				(m) =>
					(m[2] ?? "")
						.split(",")
						.map(
							(id) =>
								`${{ node: "N", way: "W", rel: "R" }[m[1] as "node"]}${id}`,
						),
			);
			asked.push(ids);
			return Response.json({
				elements: ids.map((ref) => ({
					type: { N: "node", W: "way", R: "relation" }[ref[0] as "N"],
					id: Number(ref.slice(1)),
					tags:
						tags[ref] === undefined
							? { name: "x" }
							: { opening_hours: tags[ref] },
				})),
			});
		},
	};
	return { deps, asked };
}

type Place = {
	type?: "place" | "city";
	category?: string;
	osmRef?: string | null;
	details?: NodeDetails;
	deleted?: boolean;
};

async function tripWith(places: Record<string, Place>) {
	const c = await cloneDemoTrip(getDb(), owner.id);
	const ids: Record<string, string> = {};
	for (const [key, p] of Object.entries(places)) {
		const id = randomUUID();
		ids[key] = id;
		await getDb()
			.insert(nodes)
			.values({
				id,
				tripId: c.tripId,
				parentId: null,
				type: p.type ?? "place",
				category:
					(p.type ?? "place") === "place"
						? ((p.category ?? "sight") as never)
						: null,
				name: key,
				slug: `${key}-${id.slice(0, 8)}`,
				position: `a${Object.keys(ids).length}`,
				osmRef: p.osmRef === undefined ? null : p.osmRef,
				details: p.details ?? {},
				...(p.deleted ? { deletedAt: new Date() } : {}),
			});
	}
	return { tripId: c.tripId, ids };
}

async function detailsOf(id: string): Promise<NodeDetails> {
	const [row] = await getDb()
		.select({ details: nodes.details })
		.from(nodes)
		.where(sql`${nodes.id} = ${id}`);
	return (row?.details ?? {}) as NodeDetails;
}
async function versionOf(tripId: string): Promise<number> {
	const [row] = await getDb()
		.select({ version: trips.version })
		.from(trips)
		.where(sql`${trips.id} = ${tripId}`);
	return Number(row?.version);
}

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const manual: OpeningHours = {
	source: "manual",
	periods: [{ day: 1, open: "08:00", close: "12:00" }],
	updatedAt: ago(1),
};

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	const id = randomUUID();
	await getDb()
		.insert(user)
		.values({
			id,
			email: `u-${id}@example.test`,
			emailVerified: true,
			name: "Dev Owner",
			firstName: "Dev",
			lastName: "Owner",
			isAnonymous: false,
		});
	const [row] = await getDb()
		.select()
		.from(user)
		.where(sql`${user.id} = ${id}`);
	owner = row as unknown as AuthUser;
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

describe("dueOsmNodes", () => {
	it("picks places with an OSM ref not yet fetched for it; stale ones only when asked", async () => {
		const { tripId, ids } = await tripWith({
			fresh: { osmRef: "N1" },
			prefixed: { osmRef: "osm:W2" },
			relinked: {
				osmRef: "N3",
				details: { openingHoursRef: "N99", openingHoursFetchedAt: ago(1) },
			},
			done: {
				osmRef: "N4",
				details: { openingHoursRef: "N4", openingHoursFetchedAt: ago(1) },
			},
			stale: {
				osmRef: "N5",
				details: { openingHoursRef: "N5", openingHoursFetchedAt: ago(40) },
			},
			manual: { osmRef: "N6", details: { openingHours: manual } },
			google: {
				osmRef: "N7",
				details: { openingHours: { ...manual, source: "google" } },
			},
			hotel: { osmRef: "N8", category: "lodging" },
			city: { type: "city", osmRef: "R9" },
			gone: { osmRef: "N10", deleted: true },
			google_id: { osmRef: "ChIJabc" },
			none: {},
		});
		const names = (rows: { id: string }[]) =>
			rows.map((r) => Object.keys(ids).find((k) => ids[k] === r.id)).sort();
		expect(
			names(await dueOsmNodes({ tripId, stale: false, limit: 100 })),
		).toEqual(["fresh", "prefixed", "relinked"]);
		expect(
			names(await dueOsmNodes({ tripId, stale: true, limit: 100 })),
		).toEqual(["fresh", "prefixed", "relinked", "stale"]);
		// Never fetched first; the backfill's cursor walks by id.
		const first = await dueOsmNodes({ tripId, stale: true, limit: 1 });
		expect(["fresh", "prefixed"]).toContain(names(first)[0]);
		const all = await dueOsmNodes({
			tripId,
			stale: false,
			limit: 100,
			afterId: "00000000-0000-0000-0000-000000000000",
		});
		expect(all.map((r) => r.id)).toEqual([...all.map((r) => r.id)].sort());
	});
});

describe("syncOsmHours", () => {
	it("writes OSM hours and stamps, one batched request, a new trip version only for real changes", async () => {
		const { tripId, ids } = await tripWith({
			a: { osmRef: "N11" },
			b: { osmRef: "osm:W12" },
			c: { osmRef: "N13" },
			d: { osmRef: "N14" },
		});
		const fake = fakeOverpass({
			N11: "Mo-Fr 09:00-18:00; PH off",
			W12: "sunrise-sunset",
			N13: undefined,
			N14: "Tu-Su 10:00-17:00",
		});
		const v0 = await versionOf(tripId);
		const r = await osmHoursForTrip(tripId, { deps: fake.deps });
		expect(fake.asked).toHaveLength(1);
		expect(fake.asked[0]?.sort()).toEqual(["N11", "N13", "N14", "W12"]);
		expect(r).toMatchObject({ looked: 4, stamped: 4 });
		expect(r.changed.sort()).toEqual([ids.a, ids.b, ids.d].map(String).sort());
		expect(await versionOf(tripId)).toBe(v0 + 1);

		const a = await detailsOf(ids.a ?? "");
		expect(a).toMatchObject({
			openingHoursRef: "N11",
			openingHours: { source: "osm", closedOnHolidays: true },
		});
		expect(a.openingHours?.periods).toHaveLength(5);
		expect(a.openingHoursFetchedAt).toBeTruthy();
		// Unreadable: the raw tag as the note.
		expect((await detailsOf(ids.b ?? "")).openingHours).toMatchObject({
			source: "osm",
			periods: [],
			note: "sunrise-sunset",
		});
		// No tag: only the stamp.
		const c = await detailsOf(ids.c ?? "");
		expect(c.openingHours).toBeUndefined();
		expect(c.openingHoursRef).toBe("N13");

		// Nothing is due any more; a refresh of the same tags changes nothing
		// and doesn't bump the version.
		expect(await osmHoursForTrip(tripId, { deps: fake.deps })).toMatchObject({
			looked: 0,
		});
		const v1 = await versionOf(tripId);
		const again = await syncOsmHours(
			Object.values(ids).map((id, i) => ({
				id,
				tripId,
				osmRef: ["N11", "W12", "N13", "N14"][i] ?? "",
			})),
			{ deps: fake.deps },
		);
		expect(again).toMatchObject({ stamped: 4, changed: [] });
		expect(await versionOf(tripId)).toBe(v1);
	});

	it("never overwrites hours a person saved meanwhile (checked under the row lock)", async () => {
		const { tripId, ids } = await tripWith({ p: { osmRef: "N21" } });
		const due = await dueOsmNodes({ tripId, stale: false, limit: 10 });
		expect(due).toHaveLength(1);
		// A person saves manual hours between the selection and the write.
		await getDb()
			.update(nodes)
			.set({ details: { openingHours: manual } })
			.where(sql`${nodes.id} = ${ids.p}`);
		const r = await syncOsmHours(due, {
			deps: fakeOverpass({ N21: "24/7" }).deps,
		});
		expect(r).toMatchObject({ stamped: 0, changed: [] });
		expect(await detailsOf(ids.p ?? "")).toEqual({ openingHours: manual });
	});

	it("a newer OSM fetch replaces OSM hours, and removes them when the tag is gone", async () => {
		const { tripId, ids } = await tripWith({ p: { osmRef: "N31" } });
		await osmHoursForTrip(tripId, {
			deps: fakeOverpass({ N31: "Mo-Fr 09:00-18:00" }).deps,
		});
		const row = { id: ids.p ?? "", tripId, osmRef: "N31" };
		await syncOsmHours([row], {
			deps: fakeOverpass({ N31: "Mo-Su 10:00-22:00" }).deps,
		});
		expect((await detailsOf(row.id)).openingHours?.periods).toHaveLength(7);
		await syncOsmHours([row], { deps: fakeOverpass({}).deps });
		const d = await detailsOf(row.id);
		expect(d.openingHours).toBeUndefined();
		expect(d.openingHoursRef).toBe("N31");
	});
});

describe("node cores queue hours.osm", () => {
	it("for a new place with an OSM ref and a re-linked one, not for other edits", async () => {
		const { tripId } = await tripWith({});
		const queue = getQueue("hours");
		await queue.obliterate({ force: true }).catch(() => {});
		const ctx = {
			access: { tripId } as never,
			user: owner,
			actor: { userId: owner.id, name: owner.name, color: 1 },
			inputRedacted: false,
			dryRun: false,
		} as never;
		const { nodeId } = await withTripTx(tripId, (tx, out: TxOutbox) =>
			createNodeCore(
				tx,
				out,
				{
					tripId,
					parentId: null,
					type: "place",
					category: "cafe",
					name: "Kissa",
					osmRef: "N41",
				},
				ctx,
			),
		);
		const jobs = async () =>
			(await queue.getJobs(["delayed", "waiting"])).filter(
				(j) => j.name === "hours.osm" && j.data.tripId === tripId,
			);
		expect(await jobs()).toHaveLength(1);
		// While that job waits, more changes to the trip don't add another.
		await withTripTx(tripId, (tx, out) =>
			updateNodeCore(tx, out, { nodeId, patch: { osmRef: "N42" } }, ctx),
		);
		await withTripTx(tripId, (tx, out) =>
			updateNodeCore(tx, out, { nodeId, patch: { name: "Kissa 2" } }, ctx),
		);
		expect(await jobs()).toHaveLength(1);
		await queue.obliterate({ force: true });
	});
});

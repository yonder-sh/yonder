/**
 * Many saved items into a trip against real Postgres and Redis: ideas under
 * the trip's city (a city made under its country), links and notes on them,
 * one row per item and trip (again: left as they are), a missing country
 * made, a suggester's as suggestions (Undo withdraws them), never a
 * viewer's, Undo, and a new trip's countries and cities ("Plan a trip").
 * No outside service: link previews only get queued.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_savedbulk_${hex}`;
	const old = new URL(base);
	old.pathname = `/yonder_savedbulk_mig_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-savedbulktest-${hex}`;
	process.env.BETTER_AUTH_URL = "http://localhost:3000";
	process.env.APP_URL = "http://localhost:3000";
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { scratchUrl: scratch.toString(), oldUrl: old.toString() };
});

/** `/api/saved/…` reads the session from the request: tests name the user. */
const sessions = vi.hoisted(() => ({ byId: new Map<string, unknown>() }));

vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
vi.mock("@/server/authz/session.server", async (orig) => ({
	...(await orig<typeof import("@/server/authz/session.server")>()),
	loadSession: async (h: Headers) => {
		const u = sessions.byId.get(h.get("x-test-user") ?? "");
		return u ? { user: u, session: {} } : null;
	},
}));
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
import { resolveProposal } from "@/functions/proposals.functions";
import { createTrip } from "@/functions/trips.functions";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import {
	type AddedToTrip,
	addSavedToTrip,
	listSavedLinks,
	markSavedAdded,
	saveSharedLink,
	setSavedPlace,
	undoSavedToTrip,
} from "../saved.functions";
import type { SavedLink } from "../types";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T = Record<string, unknown>>(
	fn: unknown,
	u: AuthUser,
	data?: unknown,
) => (fn as Fn)({ data, context: { user: u } }) as Promise<T>;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return errorCode(e) ?? `unexpected: ${(e as Error).message}`;
	}
}

async function newUser(first: string): Promise<AuthUser> {
	const id = randomUUID();
	await getDb()
		.insert(user)
		.values({
			id,
			email: `u-${id}@example.test`,
			emailVerified: true,
			name: `${first} Test`,
			firstName: first,
			lastName: "Test",
			isAnonymous: false,
		});
	const [row] = await getDb()
		.select()
		.from(user)
		.where(sql`${user.id} = ${id}`);
	sessions.byId.set(id, row);
	return row as unknown as AuthUser;
}

const save = async (
	u: AuthUser,
	data: Record<string, unknown>,
	where?: { countryCode: string; city?: string },
) => {
	const { id } = await call<{ id: string }>(saveSharedLink, u, data);
	if (where)
		await call(setSavedPlace, u, {
			ids: [id],
			where: {
				countryCode: where.countryCode,
				city: where.city ? { name: where.city, lat: 35, lng: 135 } : null,
			},
		});
	return id;
};
const list = (u: AuthUser) => call<SavedLink[]>(listSavedLinks, u);
const add = (u: AuthUser, data: Record<string, unknown>) =>
	call<AddedToTrip>(addSavedToTrip, u, data);

type NodeRow = {
	id: string;
	name: string;
	type: string;
	parent: string | null;
	description: string | null;
	deleted: boolean;
};
async function node(id: string): Promise<NodeRow> {
	const r = await getDb().execute(sql`
		select n.id::text as id, n.name, n.type, p.name as parent, n.description,
		       n.deleted_at is not null as deleted
		  from nodes n left join nodes p on p.id = n.parent_id where n.id = ${id}`);
	return r.rows[0] as NodeRow;
}

let trip: FixtureClone;
const U = {} as Record<"me" | "other" | "viewer" | "sug", AuthUser>;

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	U.me = await newUser("Dennis");
	U.other = await newUser("Maya");
	U.viewer = await newUser("Vic");
	U.sug = await newUser("Sam");
	trip = await cloneDemoTrip(getDb(), U.me.id);
	await getDb()
		.insert(tripMembers)
		.values([
			{
				tripId: trip.tripId,
				userId: U.viewer.id,
				status: "active",
				role: "viewer",
				color: 5,
			},
			{
				tripId: trip.tripId,
				userId: U.sug.id,
				status: "active",
				role: "suggester",
				color: 6,
			},
		]);
});

afterAll(async () => {
	await closeQueues().catch(() => {});
	const keys = await redis().keys(`${redisPrefix()}:*`);
	if (keys.length) await redis().del(...keys);
	await closeRedis();
	await closeDb();
	await dropDatabase(testEnv.scratchUrl);
	await dropDatabase(testEnv.oldUrl).catch(() => {});
});

describe("adding many to a trip", () => {
	it("each becomes an idea under its city, with its link; once per trip; Undo takes them out", async () => {
		const tiktok = await save(
			U.me,
			{ url: "https://www.tiktok.com/@kyoto.eats/video/7300000000000000901" },
			{ countryCode: "JP", city: "Kyoto" },
		);
		const nara = await save(
			U.me,
			{ url: "https://www.instagram.com/reel/C0BULKNARA/" },
			{ countryCode: "JP", city: "Nara" },
		);
		const note = await save(U.me, { text: "Ask Audrey about the onsen" });
		const theirs = await save(U.other, { url: "https://other.example/x" });

		const r = await add(U.me, {
			tripId: trip.tripId,
			ids: [tiktok, nara, note, theirs],
		});
		expect(r.already).toBe(0);
		expect(r.added.map((a) => a.savedId)).toEqual([tiktok, nara, note]);
		const [k, n, t] = await Promise.all(r.added.map((a) => node(a.nodeId)));
		expect(k).toMatchObject({
			name: "New place",
			type: "place",
			parent: "Kyoto",
		});
		// Nara isn't in the trip: made under Japan, like one added alone.
		expect(n).toMatchObject({ name: "New place", parent: "Nara" });
		expect(r.made).toHaveLength(1);
		expect(await node(r.made[0] as string)).toMatchObject({
			type: "city",
			name: "Nara",
			parent: "Japan",
		});
		expect(t).toMatchObject({
			name: "Note",
			parent: null,
			description: "Ask Audrey about the onsen",
		});
		expect(r.cities).toEqual([trip.ids.nodes.kyoto, r.made[0]]);
		const links = await getDb().execute(sql`
			select node_id::text as "nodeId", url from attachments
			 where trip_id = ${trip.tripId} and node_id = any(${sql.param(r.added.map((a) => a.nodeId))}::uuid[])
			 order by url`);
		expect(links.rows).toEqual([
			{
				nodeId: r.added[1]?.nodeId,
				url: "https://www.instagram.com/reel/C0BULKNARA/",
			},
			{
				nodeId: r.added[0]?.nodeId,
				url: "https://www.tiktok.com/@kyoto.eats/video/7300000000000000901",
			},
		]);
		const mine = await list(U.me);
		for (const id of [tiktok, nara, note])
			expect(mine.find((l) => l.id === id)?.trips.map((x) => x.id)).toEqual([
				trip.tripId,
			]);
		// Theirs wasn't touched.
		expect((await list(U.other))[0]?.trips).toEqual([]);

		// Again (and one added alone before): only the new one goes in.
		const solo = await save(U.me, { url: "https://solo.example/kissa" });
		await call(markSavedAdded, U.me, {
			id: solo,
			tripId: trip.tripId,
			nodeId: null,
		});
		const fresh = await save(U.me, { url: "https://fresh.example/" });
		const again = await add(U.me, {
			tripId: trip.tripId,
			ids: [tiktok, nara, note, solo, fresh],
		});
		expect(again.already).toBe(4);
		expect(again.added.map((a) => a.savedId)).toEqual([fresh]);
		const rows = await getDb().execute(sql`
			select count(*)::int as n from saved_link_trips where trip_id = ${trip.tripId}`);
		expect((rows.rows[0] as { n: number }).n).toBe(5);

		// Undo: the ideas, the city made for them and the marks go.
		await call(undoSavedToTrip, U.me, {
			tripId: trip.tripId,
			added: r.added,
			made: r.made,
		});
		for (const a of r.added) expect((await node(a.nodeId)).deleted).toBe(true);
		expect((await node(r.made[0] as string)).deleted).toBe(true);
		expect((await node(trip.ids.nodes.kyoto as string)).deleted).toBe(false);
		const after = await list(U.me);
		for (const id of [tiktok, nara, note])
			expect(after.find((l) => l.id === id)?.trips).toEqual([]);
		expect(after.find((l) => l.id === fresh)?.trips).toHaveLength(1);
	});

	it("only someone who can edit the trip (a viewer can't)", async () => {
		const l = await save(U.viewer, { url: "https://viewer.example/bulk" });
		expect(
			await codeOf(add(U.viewer, { tripId: trip.tripId, ids: [l] })),
		).not.toBe("ok");
		expect((await list(U.viewer)).find((x) => x.id === l)?.trips).toEqual([]);
		expect(
			await codeOf(
				call(undoSavedToTrip, U.viewer, {
					tripId: trip.tripId,
					added: [],
					made: [],
				}),
			),
		).not.toBe("ok");
	});

	it("a new trip from them gets their countries and cities, in order", async () => {
		const u = await newUser("Ana");
		const kyoto = await save(
			u,
			{ url: "https://kyoto.example/" },
			{ countryCode: "JP", city: "Kyoto" },
		);
		const osaka = await save(
			u,
			{ url: "https://osaka.example/" },
			{ countryCode: "JP", city: "Osaka" },
		);
		const seoul = await save(
			u,
			{ url: "https://seoul.example/" },
			{ countryCode: "KR", city: "Seoul" },
		);
		const t = await call<{ tripId: string }>(createTrip, u, {
			name: "Kyoto & Seoul",
		});
		const r = await add(u, {
			tripId: t.tripId,
			ids: [kyoto, osaka, seoul],
		});
		expect(r.added).toHaveLength(3);
		const made = await Promise.all(r.made.map(node));
		expect(made.map((m) => [m.type, m.name, m.parent])).toEqual([
			["country", "Japan", null],
			["city", "Kyoto", "Japan"],
			["city", "Osaka", "Japan"],
			["country", "South Korea", null],
			["city", "Seoul", "South Korea"],
		]);
		expect(r.cities).toEqual([r.made[1], r.made[2], r.made[4]]);
	});
	it("a country the trip hasn't got is made, with the city under it", async () => {
		const bkk = await save(
			U.me,
			{ url: "https://bangkok.example/" },
			{ countryCode: "TH", city: "Bangkok" },
		);
		const r = await add(U.me, { tripId: trip.tripId, ids: [bkk] });
		const made = await Promise.all(r.made.map(node));
		expect(made.map((m) => [m.type, m.name, m.parent])).toEqual([
			["country", "Thailand", null],
			["city", "Bangkok", "Thailand"],
		]);
		expect(await node(r.added[0]?.nodeId as string)).toMatchObject({
			name: "New place",
			parent: "Bangkok",
		});
		expect(r.proposals).toEqual([]);
	});

	it("a suggester's become suggestions; once per trip; Undo withdraws them", async () => {
		const hanoi = await save(
			U.sug,
			{ url: "https://www.instagram.com/reel/C0BULKHANOI/" },
			{ countryCode: "VN", city: "Hanoi" },
		);
		const kyoto = await save(
			U.sug,
			{ url: "https://kyoto-sug.example/" },
			{ countryCode: "JP", city: "Kyoto" },
		);
		const r = await add(U.sug, { tripId: trip.tripId, ids: [hanoi, kyoto] });
		expect(r.added.map((a) => a.savedId)).toEqual([hanoi, kyoto]);
		// Nothing applied: Vietnam, Hanoi, two ideas and their links suggested.
		for (const id of [...r.made, ...r.added.map((a) => a.nodeId)])
			expect(await node(id)).toBeUndefined();
		const open = await getDb().execute(sql`
			select id::text as id, op, created_ids::text[] as "createdIds", requires::text[] as requires
			  from proposals
			 where id = any(${sql.param(r.proposals)}::uuid[]) and status = 'open'
			   and author_user_id = ${U.sug.id}
			 order by created_at, id`);
		type P = {
			id: string;
			op: string;
			createdIds: string[];
			requires: string[];
		};
		const ps = open.rows as P[];
		expect(ps.map((p) => p.op)).toEqual([
			"node.create",
			"node.create",
			"node.create",
			"attachment.link",
			"node.create",
			"attachment.link",
		]);
		const by = (id: string) => ps.find((p) => p.createdIds.includes(id)) as P;
		const [vn, city] = r.made as [string, string];
		const [hIdea, kIdea] = r.added.map((a) => a.nodeId) as [string, string];
		expect(by(city).requires).toEqual([by(vn).id]);
		expect(by(hIdea).requires).toEqual([by(vn).id, by(city).id]);
		expect(by(kIdea).requires).toEqual([]);
		// In the trip already (while suggested): not suggested twice.
		const mine = await list(U.sug);
		for (const id of [hanoi, kyoto])
			expect(mine.find((l) => l.id === id)?.trips.map((x) => x.id)).toEqual([
				trip.tripId,
			]);
		const again = await add(U.sug, { tripId: trip.tripId, ids: [hanoi] });
		expect(again).toMatchObject({ added: [], already: 1, proposals: [] });

		// The owner takes the Kyoto idea; Undo withdraws the rest.
		expect(
			await call(resolveProposal, U.me, {
				proposalId: by(kIdea).id,
				decision: "accept",
			}),
		).toMatchObject({ ok: true });
		expect(await node(kIdea)).toMatchObject({
			name: "New place",
			parent: "Kyoto",
		});
		await call(undoSavedToTrip, U.sug, {
			tripId: trip.tripId,
			added: r.added,
			made: r.made,
			proposals: r.proposals,
		});
		const left = await getDb().execute(sql`
			select count(*)::int as n from proposals
			 where id = any(${sql.param(r.proposals)}::uuid[]) and status = 'open'`);
		expect((left.rows[0] as { n: number }).n).toBe(0);
		expect((await node(kIdea)).deleted).toBe(false);
		const after = await list(U.sug);
		expect(after.find((l) => l.id === hanoi)?.trips).toEqual([]);
		expect(after.find((l) => l.id === kyoto)?.trips).toHaveLength(1);
		// Withdrawn: it can be suggested again.
		const re = await add(U.sug, { tripId: trip.tripId, ids: [hanoi] });
		expect(re.added).toHaveLength(1);
	});

	it("a suggestion turned down frees the item again", async () => {
		const l = await save(U.sug, { url: "https://turned-down.example/" });
		const r = await add(U.sug, { tripId: trip.tripId, ids: [l] });
		const idea = r.proposals[0] as string;
		expect(
			await call(resolveProposal, U.me, {
				proposalId: idea,
				decision: "reject",
			}),
		).toMatchObject({ ok: true });
		expect((await list(U.sug)).find((x) => x.id === l)?.trips).toEqual([]);
		expect((await add(U.sug, { tripId: trip.tripId, ids: [l] })).already).toBe(
			0,
		);
	});
});

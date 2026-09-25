/**
 * docs/PLACES.md §3/§7 against real Postgres: the new node columns
 * (`idea_status`, `shortlist_pin`, a clearable `time_needed_min`) reach the
 * graph; pin, unpin and drop are ordinary node edits (applied for editors,
 * proposed for suggesters, the columns kept in step); an unpinned place goes
 * back to `auto` when its ratings change; the trip's `shortlistMinScore`.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_places_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-placestest-${hex}`;
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
import { nodes, tripMembers, user } from "@/db/schema";
import { getTripGraph } from "@/functions/graph.functions";
import { setNodePriority, updateNode } from "@/functions/nodes.functions";
import { resolveProposal } from "@/functions/proposals.functions";
import { updateTrip } from "@/functions/trips.functions";
import type { TripGraph } from "@/lib/engine/types";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T = Record<string, unknown>>(
	fn: unknown,
	u: AuthUser,
	data: unknown,
) => (fn as Fn)({ data, context: { user: u } }) as Promise<T>;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		const r = (await p) as { proposed?: unknown } | undefined;
		return r && typeof r === "object" && "proposed" in r ? "proposed" : "ok";
	} catch (e) {
		return (
			errorCode(e) ??
			`unexpected: ${e instanceof Error ? e.message : String(e)}`
		);
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
	return row as unknown as AuthUser;
}

let owner: AuthUser;
let maya: AuthUser;
let c: FixtureClone;

async function row(nodeId: string) {
	const [r] = await getDb()
		.select({
			status: nodes.status,
			ideaStatus: nodes.ideaStatus,
			shortlistPin: nodes.shortlistPin,
			timeNeededMin: nodes.timeNeededMin,
		})
		.from(nodes)
		.where(sql`${nodes.id} = ${nodeId}`);
	return r;
}

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	owner = await newUser("Dev");
	maya = await newUser("Maya");
	c = await cloneDemoTrip(getDb(), owner.id);
	await getDb().insert(tripMembers).values({
		tripId: c.tripId,
		userId: maya.id,
		status: "active",
		role: "suggester",
		color: 2,
	});
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

describe("the places lifecycle (docs/PLACES.md §3)", () => {
	it("new nodes start as ideas, auto; the graph carries both columns", async () => {
		const sky = c.ids.nodes.shibuyaSky as string;
		expect(await row(sky)).toMatchObject({
			status: "active",
			ideaStatus: "idea",
			shortlistPin: "auto",
		});
		const g = await call<TripGraph>(getTripGraph, owner, { tripId: c.tripId });
		expect(g.nodes.find((n) => n.id === sky)).toMatchObject({
			ideaStatus: "idea",
			shortlistPin: "auto",
		});
	});

	it("pin / unpin / auto keep idea_status in step", async () => {
		const id = c.ids.nodes.itoya as string;
		const pin = (shortlistPin: string) =>
			call(updateNode, owner, { nodeId: id, patch: { shortlistPin } });
		expect(await codeOf(pin("pinned"))).toBe("ok");
		expect(await row(id)).toMatchObject({
			ideaStatus: "shortlist",
			shortlistPin: "pinned",
		});
		expect(await codeOf(pin("unpinned"))).toBe("ok");
		expect(await row(id)).toMatchObject({
			ideaStatus: "idea",
			shortlistPin: "unpinned",
		});
		expect(await codeOf(pin("auto"))).toBe("ok");
		expect(await row(id)).toMatchObject({
			ideaStatus: "idea",
			shortlistPin: "auto",
		});
	});

	it("dropping (either column) drops both; bringing back restores the pin", async () => {
		const id = c.ids.nodes.loft as string;
		await call(updateNode, owner, {
			nodeId: id,
			patch: { shortlistPin: "pinned" },
		});
		await call(updateNode, owner, {
			nodeId: id,
			patch: { status: "dropped", ideaStatus: "dropped" },
		});
		expect(await row(id)).toMatchObject({
			status: "dropped",
			ideaStatus: "dropped",
			shortlistPin: "pinned",
		});
		await call(updateNode, owner, { nodeId: id, patch: { status: "active" } });
		expect(await row(id)).toMatchObject({
			status: "active",
			ideaStatus: "shortlist",
		});
		// The Outline's plain Drop (status only) keeps idea_status in step too.
		await call(updateNode, owner, { nodeId: id, patch: { status: "dropped" } });
		expect(await row(id)).toMatchObject({
			status: "dropped",
			ideaStatus: "dropped",
		});
		await call(updateNode, owner, { nodeId: id, patch: { status: "active" } });
	});

	it("an unpinned place goes back to auto when its ratings change (not on a comment)", async () => {
		const id = c.ids.nodes.hands as string;
		await call(updateNode, owner, {
			nodeId: id,
			patch: { shortlistPin: "unpinned" },
		});
		const rate = (priority: string, comment?: string) =>
			call(setNodePriority, owner, {
				nodeId: id,
				memberId: c.members.owner,
				priority,
				...(comment ? { comment } : {}),
			});
		await rate("must");
		expect((await row(id))?.shortlistPin).toBe("auto");
		await call(updateNode, owner, {
			nodeId: id,
			patch: { shortlistPin: "unpinned" },
		});
		// The same rating again, with a comment: not a change of ratings.
		await rate("must", "only if we have time");
		expect((await row(id))?.shortlistPin).toBe("unpinned");
	});

	it("time needed can be set and cleared back to 'not set'", async () => {
		const id = c.ids.nodes.meijiJingu as string;
		await call(updateNode, owner, { nodeId: id, patch: { timeNeededMin: 90 } });
		expect((await row(id))?.timeNeededMin).toBe(90);
		await call(updateNode, owner, {
			nodeId: id,
			patch: { timeNeededMin: null },
		});
		expect((await row(id))?.timeNeededMin).toBeNull();
		expect(
			await codeOf(
				call(updateNode, owner, { nodeId: id, patch: { timeNeededMin: 5000 } }),
			),
		).toMatch(/too_big|VALIDATION/);
	});

	it("a suggester's pin and drop are proposals; accepting applies them", async () => {
		const id = c.ids.nodes.knifeShop as string;
		const r = (await call(updateNode, maya, {
			nodeId: id,
			patch: { shortlistPin: "pinned" },
		})) as { proposed?: { id: string; summary: string } };
		expect(r.proposed?.id).toBeTruthy();
		expect(await row(id)).toMatchObject({
			shortlistPin: "auto",
			ideaStatus: "idea",
		});
		await call(resolveProposal, owner, {
			proposalId: r.proposed?.id,
			decision: "accept",
		});
		expect(await row(id)).toMatchObject({
			shortlistPin: "pinned",
			ideaStatus: "shortlist",
		});
		// Drop: proposed, nothing changes until someone accepts it.
		const other = c.ids.nodes.sensoji as string;
		expect(
			await codeOf(
				call(updateNode, maya, {
					nodeId: other,
					patch: { status: "dropped", ideaStatus: "dropped" },
				}),
			),
		).toBe("proposed");
		expect(await row(other)).toMatchObject({
			status: "active",
			ideaStatus: "idea",
		});
	});

	it("the shortlist threshold is a trip setting", async () => {
		await call(updateTrip, owner, {
			tripId: c.tripId,
			settings: { shortlistMinScore: 5 },
		});
		const g = await call<TripGraph>(getTripGraph, owner, { tripId: c.tripId });
		expect(g.trip.settings.shortlistMinScore).toBe(5);
		expect(
			await codeOf(
				call(updateTrip, maya, {
					tripId: c.tripId,
					settings: { shortlistMinScore: 1 },
				}),
			),
		).not.toBe("ok");
	});
});

/**
 * `note.append` (WP-Suggest's propose-only def) against real Postgres: the
 * trip comes from the target row, the core only accepts a live target of the
 * caller's trip, the input is strict and bounded, and the gate's roles hold
 * (viewers 403, strangers 404, suggesters propose).
 *
 * Then the whole life of an addition through F-ext1's platform: the summary
 * names the note, two additions stay two proposals (never amended, never in
 * conflict with each other), the accept needs the reviewer's insert first
 * (`appliedClientSide`) and logs "Maya (accepted by Dennis)", a deleted place
 * makes it `gone`, and reject (with its note) and withdraw close it.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_sug_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-sugtest-${hex}`;
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
import {
	listProposals,
	type ResolveResult,
	resolveProposal,
	withdrawProposal,
} from "@/functions/proposals.functions";
import type { TripAccess } from "@/lib/auth/roles";
import type { ProposalDto } from "@/lib/schemas/proposals";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import type { CoreCtx } from "@/server/proposals/types";
import { defs, ProposeNoteAppendInput } from "../server/proposable.server";
import { proposeNoteAppend } from "../suggest.functions";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const { scratchUrl } = testEnv;
const def = defs["note.append"];

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = (fn: unknown, u: AuthUser, data: unknown) =>
	(fn as Fn)({ data, context: { user: u } });

async function outcome(p: Promise<unknown>): Promise<string> {
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
	// "Dennis Test" → the accept's activity actor is "Maya (accepted by Dennis)".
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

const U = {} as Record<"owner" | "suggester" | "viewer" | "stranger", AuthUser>;
let A: FixtureClone;
let B: FixtureClone;

beforeAll(async () => {
	await ensureDatabase(scratchUrl);
	await migrateDatabase(scratchUrl);
	U.owner = await newUser("Dennis");
	U.suggester = await newUser("Maya");
	U.viewer = await newUser("Vic");
	U.stranger = await newUser("Sam");
	A = await cloneDemoTrip(getDb(), U.owner.id);
	B = await cloneDemoTrip(getDb(), U.owner.id);
	await getDb()
		.insert(tripMembers)
		.values([
			{
				tripId: A.tripId,
				userId: U.suggester.id,
				status: "active",
				role: "suggester",
				color: 2,
			},
			{
				tripId: A.tripId,
				userId: U.viewer.id,
				status: "active",
				role: "viewer",
				color: 5,
			},
		]);
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

const nodeTarget = (c: FixtureClone, key = "shibuyaSky") => ({
	kind: "node" as const,
	nodeId: c.ids.nodes[key] ?? "",
});

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return errorCode(e) ?? `unexpected: ${String(e)}`;
	}
}

describe("note.append def", () => {
	it("the input is strict, trimmed and ≤ 4,000 characters", () => {
		const base = { tripId: A.tripId, target: nodeTarget(A) };
		expect(
			ProposeNoteAppendInput.safeParse({ ...base, markdown: "  - hi  " }).data
				?.markdown,
		).toBe("- hi");
		expect(
			ProposeNoteAppendInput.safeParse({ ...base, markdown: "   " }).success,
		).toBe(false);
		expect(
			ProposeNoteAppendInput.safeParse({ ...base, markdown: "x".repeat(4001) })
				.success,
		).toBe(false);
		expect(
			ProposeNoteAppendInput.safeParse({ ...base, markdown: "ok", force: true })
				.success,
		).toBe(false);
	});

	it("the trip comes from the target row, which must be in the named trip", async () => {
		const db = getDb();
		const md = "- sunset";
		expect(
			await def.tripIdOf(
				{ tripId: A.tripId, target: nodeTarget(A), markdown: md },
				db,
			),
		).toBe(A.tripId);
		expect(
			await def.tripIdOf(
				{ tripId: A.tripId, target: { kind: "trip" }, markdown: md },
				db,
			),
		).toBe(A.tripId);
		expect(
			await def.tripIdOf(
				{
					tripId: A.tripId,
					target: { kind: "day", dayId: A.ids.days.d1 ?? "" },
					markdown: md,
				},
				db,
			),
		).toBe(A.tripId);
		// B's node named with A's trip id, and a missing node: NOT_FOUND alike.
		expect(
			await codeOf(
				def.tripIdOf(
					{ tripId: A.tripId, target: nodeTarget(B), markdown: md },
					db,
				),
			),
		).toBe("NOT_FOUND");
		expect(
			await codeOf(
				def.tripIdOf(
					{
						tripId: A.tripId,
						target: { kind: "node", nodeId: randomUUID() },
						markdown: md,
					},
					db,
				),
			),
		).toBe("NOT_FOUND");
		expect(
			def.entityOf({ tripId: A.tripId, target: nodeTarget(A), markdown: md }),
		).toEqual({
			kind: "note",
			id: A.ids.nodes.shibuyaSky,
		});
		expect(
			def.entityOf({
				tripId: A.tripId,
				target: { kind: "trip" },
				markdown: md,
			}),
		).toEqual({
			kind: "note",
			id: null,
		});
		expect(def.proposeOnly).toBe(true);
	});

	it("the core accepts a live target of this trip only (a deleted place is gone)", async () => {
		const ctx = (tripId: string) =>
			({
				access: { tripId } as TripAccess,
				actor: { userId: U.owner.id, name: "Dennis" },
			}) as unknown as CoreCtx;
		const out = { version: 1 } as TxOutbox;
		const run = (target: unknown, tripId = A.tripId) =>
			getDb().transaction((tx) =>
				def.core(
					tx,
					out,
					{ tripId, target: target as never, markdown: "x" },
					ctx(tripId),
				),
			);
		expect(await run(nodeTarget(A))).toEqual({ ok: true });
		expect(await run({ kind: "trip" })).toEqual({ ok: true });
		expect(await run({ kind: "item", itemId: A.ids.items.itoya })).toEqual({
			ok: true,
		});
		expect(await codeOf(run(nodeTarget(B)))).toBe("NOT_FOUND");
		await getDb().execute(
			sql`update nodes set deleted_at = now() where id = ${A.ids.nodes.loft ?? ""}`,
		);
		expect(await codeOf(run(nodeTarget(A, "loft")))).toBe("NOT_FOUND");
	});
});

describe("proposeNoteAppend through the gate", () => {
	const input = () => ({
		tripId: A.tripId,
		target: nodeTarget(A),
		markdown: "**Book** 4 weeks ahead",
	});

	it("suggesters and editors propose; viewers are refused; strangers see nothing", async () => {
		expect(await outcome(call(proposeNoteAppend, U.suggester, input()))).toBe(
			"proposed",
		);
		expect(await outcome(call(proposeNoteAppend, U.owner, input()))).toBe(
			"proposed",
		);
		expect(await outcome(call(proposeNoteAppend, U.viewer, input()))).toBe(
			"FORBIDDEN",
		);
		expect(await outcome(call(proposeNoteAppend, U.stranger, input()))).toBe(
			"NOT_FOUND",
		);
	});

	it("a note addition is its own proposal: named, never amended, never stacked", async () => {
		const first = (await call(proposeNoteAppend, U.suggester, {
			...input(),
			markdown: "- **Sunset** slots sell out",
		})) as { proposed: { id: string; summary: string } };
		const second = (await call(proposeNoteAppend, U.suggester, {
			...input(),
			markdown: "- Bring a jacket, it's windy",
		})) as { proposed: { id: string; summary: string } };
		expect(first.proposed.summary).toBe("added to the notes of Shibuya Sky");
		expect(second.proposed.id).not.toBe(first.proposed.id);
		const list = (await call(listProposals, U.owner, {
			tripId: A.tripId,
		})) as ProposalDto[];
		const mine = list.filter(
			(p) => p.id === first.proposed.id || p.id === second.proposed.id,
		);
		expect(mine).toHaveLength(2);
		for (const p of mine) {
			expect(p).toMatchObject({
				op: "note.append",
				status: "open",
				entityKind: "note",
				entityId: A.ids.nodes.shibuyaSky,
				fields: [],
			});
		}
		expect(mine.map((p) => p.payload.markdown).sort()).toEqual([
			"- **Sunset** slots sell out",
			"- Bring a jacket, it's windy",
		]);
		// The suggester's own list has them too (ReviewDrawer → Mine).
		const theirs = (await call(listProposals, U.suggester, {
			tripId: A.tripId,
		})) as ProposalDto[];
		expect(theirs.some((p) => p.id === first.proposed.id)).toBe(true);
	});

	it("accept needs the insert first, logs the author's activity, and leaves other additions open", async () => {
		const a = (await call(proposeNoteAppend, U.suggester, input())) as {
			proposed: { id: string };
		};
		const b = (await call(proposeNoteAppend, U.suggester, {
			...input(),
			markdown: "- second thought",
		})) as { proposed: { id: string } };
		// Without the reviewer's editor insert: refused, still open.
		expect(
			await outcome(
				call(resolveProposal, U.owner, {
					proposalId: a.proposed.id,
					decision: "accept",
				}),
			),
		).toBe("VALIDATION");
		const r = (await call(resolveProposal, U.owner, {
			proposalId: a.proposed.id,
			decision: "accept",
			appliedClientSide: true,
		})) as ResolveResult;
		expect(r).toEqual({ ok: true, status: "accepted" });
		const rows = (
			await getDb().execute(sql`
				select actor_name as "actor", summary, node_id::text as "nodeId"
				  from activity_log
				 where trip_id = ${A.tripId} and verb = 'note.append'
				   and actor_name like '%accepted by%'`)
		).rows as { actor: string; summary: string; nodeId: string }[];
		expect(rows).toEqual([
			{
				actor: "Maya (accepted by Dennis)",
				summary: "added to the notes of Shibuya Sky",
				nodeId: A.ids.nodes.shibuyaSky,
			},
		]);
		// The other addition to the same note is untouched (no conflict).
		const list = (await call(listProposals, U.owner, {
			tripId: A.tripId,
		})) as ProposalDto[];
		const other = list.find((p) => p.id === b.proposed.id);
		expect(other?.status).toBe("open");
		expect(other?.lastError ?? null).toBeNull();
	});

	it("reject keeps the note for the author; withdraw closes it; a deleted place is gone", async () => {
		const target = { kind: "day" as const, dayId: A.ids.days.d2 ?? "" };
		const rej = (await call(proposeNoteAppend, U.suggester, {
			...input(),
			target,
		})) as { proposed: { id: string; summary: string } };
		expect(rej.proposed.summary).toBe("added to the notes of Day 2");
		expect(
			await call(resolveProposal, U.owner, {
				proposalId: rej.proposed.id,
				decision: "reject",
				note: "already in the day plan",
			}),
		).toEqual({ ok: true, status: "rejected" });
		const wd = (await call(proposeNoteAppend, U.suggester, {
			...input(),
			target,
		})) as { proposed: { id: string } };
		expect(
			await call(withdrawProposal, U.suggester, { proposalId: wd.proposed.id }),
		).toEqual({ ok: true });
		const theirs = (await call(listProposals, U.suggester, {
			tripId: A.tripId,
		})) as ProposalDto[];
		expect(theirs.find((p) => p.id === rej.proposed.id)).toMatchObject({
			status: "rejected",
			reviewNote: "already in the day plan",
		});
		expect(theirs.find((p) => p.id === wd.proposed.id)?.status).toBe(
			"withdrawn",
		);

		// The place goes away before the review: the accept answers `gone`.
		const gone = (await call(proposeNoteAppend, U.suggester, {
			...input(),
			target: nodeTarget(A, "itoya"),
		})) as { proposed: { id: string } };
		await getDb().execute(
			sql`update nodes set deleted_at = now() where id = ${A.ids.nodes.itoya ?? ""}`,
		);
		const r = (await call(resolveProposal, U.owner, {
			proposalId: gone.proposed.id,
			decision: "accept",
			appliedClientSide: true,
		})) as ResolveResult;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.conflict.reason).toBe("gone");
	});

	it("a target in another trip is NOT_FOUND, even for its owner", async () => {
		expect(
			await outcome(
				call(proposeNoteAppend, U.owner, { ...input(), target: nodeTarget(B) }),
			),
		).toBe("NOT_FOUND");
	});
});

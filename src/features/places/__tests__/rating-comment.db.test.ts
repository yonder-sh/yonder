/**
 * PLAN-R3-03 against real Postgres: a rating comment's limit is the 280
 * characters you SEE, however many mentions it has. A mention is stored as
 * `[@Audrey Tester](mention:<uuid>)` (about 50 characters more than the
 * "@Audrey Tester" you see), so the old stored check (≤ 280, the DB's
 * `node_priorities_comment_ck` and the validator) refused a 240-character
 * comment with two mentions. Now the validator counts what you see and the
 * stored check leaves room for the tokens.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_rate_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-ratetest-${hex}`;
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
import { nodePriorities, user } from "@/db/schema";
import { getTripGraph } from "@/functions/graph.functions";
import { setNodePriority } from "@/functions/nodes.functions";
import type { TripGraph } from "@/lib/engine/types";
import { mentionsAsText, mentionToken } from "@/lib/notes/mentions";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { COMMENT_MAX, commentLength } from "../lib/rate";

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

let owner: AuthUser;
let c: FixtureClone;

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
	c = await cloneDemoTrip(getDb(), owner.id);
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

describe("rating comments with mentions (PLAN-R3-03)", () => {
	const rate = (comment: string) =>
		call(setNodePriority, owner, {
			nodeId: c.ids.nodes.sensoji,
			memberId: c.members.owner,
			priority: "must",
			comment,
		});
	const stored = async () => {
		const [row] = await getDb()
			.select({ comment: nodePriorities.ratingComment })
			.from(nodePriorities)
			.where(
				sql`${nodePriorities.nodeId} = ${c.ids.nodes.sensoji} and ${nodePriorities.memberId} = ${c.members.owner}`,
			);
		return row?.comment ?? null;
	};

	it("saves 240 visible characters with two mentions (stored > 280)", async () => {
		// The QA repro: 200 × "x", " ask @Audrey Tester", " and @Maya Suggester"
		// (the clone has no Maya account: the second token names the owner).
		const text = `${"x".repeat(200)} ask ${mentionToken("Audrey Tester", c.members.audrey)} and ${mentionToken("Maya Suggester", c.members.owner)}`;
		expect(mentionsAsText(text).length).toBe(239);
		expect(text.length).toBeGreaterThan(280);
		expect(commentLength(text).over).toBeNull();
		expect(await codeOf(rate(text))).toBe("ok");
		expect(await stored()).toBe(text);
		// The graph shows it as stored.
		const graph = await call<TripGraph>(getTripGraph, owner, {
			tripId: c.tripId,
		});
		expect(
			graph.nodes.find((n) => n.id === c.ids.nodes.sensoji)?.ratingComments[
				c.members.owner
			],
		).toBe(text);
	});

	it("takes exactly 280 visible characters, however many mentions", async () => {
		const mentions = Array.from(
			{ length: 5 },
			() => `${mentionToken("Audrey Tester", c.members.audrey)} `,
		).join("");
		const seen = mentionsAsText(mentions).length;
		const text = `${mentions}${"y".repeat(COMMENT_MAX - seen)}`;
		expect(mentionsAsText(text).length).toBe(COMMENT_MAX);
		expect(text.length).toBeGreaterThan(COMMENT_MAX + 150);
		expect(await codeOf(rate(text))).toBe("ok");
		expect(await stored()).toBe(text);
	});

	it("refuses 281 visible characters, mentions or not", async () => {
		expect(await codeOf(rate("z".repeat(281)))).toMatch(/too_big|VALIDATION/);
		const withMention = `${mentionToken("Maya Suggester", c.members.owner)} ${"z".repeat(COMMENT_MAX - 15)}`;
		expect(mentionsAsText(withMention).length).toBe(COMMENT_MAX + 1);
		expect(await codeOf(rate(withMention))).toMatch(/too_big|VALIDATION/);
	});
});

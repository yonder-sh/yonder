/**
 * Live smoke check of a RUNNING stack (collab server, worker, Redis, Postgres), from
 * the browser's point of view:
 *
 *   N pnpm dev:all                                   # or: vite + collab + worker
 *   N pnpm exec tsx --env-file=.env collab/smoke.ts  # COLLAB_URL=ws://localhost:3000/collab by default
 *
 * It creates a throwaway named user, a trip they own and a Better Auth session,
 * connects through `COLLAB_URL` (default: the Vite proxy, same-origin `/collab`)
 * with that session as a bearer token, and checks: authentication + `hello`, a
 * published `invalidate` arriving, and (unless SMOKE_SKIP_WORKER=1) a `test.ping`
 * job producing `job` progress. Everything it created is deleted again.
 * Exit code 0 = all good.
 */
import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db/db.server";
import { tripMembers, trips, user } from "@/db/schema";
import { CollabClient } from "@/lib/realtime/collab-client";
import type { ChannelMessage } from "@/lib/realtime/protocol";
import { channelDocName, parseChannelMessage } from "@/lib/realtime/protocol";
import { authOptions } from "@/server/auth-options";
import { closeQueues, enqueue } from "@/server/live/jobs.server";
import { publishTripChange } from "@/server/live/realtime.server";
import { closeRedis } from "@/server/live/redis.server";

const url =
	process.env.COLLAB_URL ??
	`ws://localhost:${process.env.APP_PORT ?? 3000}/collab`;
const hex = randomBytes(4).toString("hex");
const db = getDb();
const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => {
	results.push([name, ok, detail]);
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
	);
};
const until = async (pred: () => boolean, ms: number) => {
	const t0 = Date.now();
	while (!pred() && Date.now() - t0 < ms)
		await new Promise((r) => setTimeout(r, 20));
	return pred() ? Date.now() - t0 : -1;
};

const userId = `smoke-${hex}`;
let tripId = "";
let client: CollabClient | undefined;
try {
	await db.insert(user).values({
		id: userId,
		email: `smoke-${hex}@example.com`,
		emailVerified: true,
		name: "Smoke Test",
		firstName: "Smoke",
		lastName: "Test",
	});
	const [trip] = await db
		.insert(trips)
		.values({ slug: `smoke-${hex}`, name: "Smoke", createdBy: userId })
		.returning({ id: trips.id });
	if (!trip) throw new Error("trip insert failed");
	tripId = trip.id;
	await db
		.insert(tripMembers)
		.values({ tripId, userId, status: "active", role: "owner", color: 0 });
	const ctx = await betterAuth(authOptions).$context;
	const session = await ctx.internalAdapter.createSession(userId);

	client = new CollabClient({ url, token: session.token, lingerMs: 0 });
	const lease = client.acquire(channelDocName(tripId));
	const messages: ChannelMessage[] = [];
	lease.onStateless((p) => {
		const m = parseChannelMessage(p);
		if (m) messages.push(m);
	});

	const authMs = await until(
		() => lease.getSnapshot().status !== "connecting",
		8_000,
	);
	check(
		`authenticated via ${url}`,
		lease.getSnapshot().status === "authenticated",
		authMs < 0
			? "timeout"
			: `${authMs} ms, ${lease.getSnapshot().reason ?? "ok"}`,
	);
	await until(() => messages.some((m) => m.type === "hello"), 3_000);
	const hello = messages.find((m) => m.type === "hello");
	check(
		"hello with version and role",
		hello?.type === "hello" && hello.you.role === "owner",
		JSON.stringify(hello),
	);

	const t0 = Date.now();
	const subscribers = await publishTripChange({
		type: "invalidate",
		tripId,
		version: 1,
		keys: ["graph"],
	});
	const gotMs = await until(
		() => messages.some((m) => m.type === "invalidate"),
		3_000,
	);
	check(
		"published invalidate delivered",
		gotMs >= 0,
		`${Date.now() - t0} ms, ${subscribers} Redis subscriber(s)`,
	);

	if (process.env.SMOKE_SKIP_WORKER !== "1") {
		await enqueue("media", "test.ping", { tripId, keys: ["media"] });
		const jobMs = await until(
			() => messages.some((m) => m.type === "job"),
			8_000,
		);
		check(
			"worker ran test.ping and emitted a job event",
			jobMs >= 0,
			jobMs >= 0 ? `${jobMs} ms` : "is the worker running?",
		);
	}
} catch (e) {
	check("smoke run", false, e instanceof Error ? e.message : String(e));
} finally {
	client?.destroy();
	if (tripId)
		await db
			.delete(trips)
			.where(eq(trips.id, tripId))
			.catch(() => {});
	await db
		.delete(user)
		.where(eq(user.id, userId))
		.catch(() => {});
	await closeQueues();
	await closeRedis();
	await closeDb();
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `${failed} check(s) FAILED` : "ALL GOOD");
process.exit(failed ? 1 : 0);

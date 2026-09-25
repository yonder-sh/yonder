/**
 * WP-Lists server functions against real Postgres and Redis: the list cores
 * through the gate (create, update, status, move, targets, assignees, delete,
 * restore), relative due rules, mentions, activity, and the ADDENDUM §7.2
 * privacy rules (private items reach only their author: never in anyone
 * else's reads, counts, activity, mentions or inbox; never proposals), plus
 * the collab notes hook (mention rows + markdown for shared notes) and the
 * cross-trip mention reads.
 *
 * Handlers run for real through `src/test/start-mock.ts`; each test passes
 * `context.user` itself. A throwaway migrated database and an isolated
 * REDIS_PREFIX are created and removed around the file.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_lists_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-liststest-${hex}`;
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
import { getDigest } from "@/functions/activity.functions";
import { getTripCounts, listActivity } from "@/functions/graph.functions";
import {
	listProposals,
	resolveProposal,
} from "@/functions/proposals.functions";
import { mentionToken } from "@/lib/notes/mentions";
import { isProposed, type ProposalDto } from "@/lib/schemas/proposals";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { redeemShareToken } from "@/server/authz/share-links.server";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { loadInbox } from "@/server/inbox.server";
import { closeQueues } from "@/server/live/jobs.server";
import { TxOutbox } from "@/server/live/outbox.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { notesHooks } from "../../../../collab/notes-hooks";
import {
	listMyMentions,
	markMentionsRead,
} from "../../notes/mentions.functions";
import {
	createListItem,
	deleteListItem,
	type ListItemDto,
	listTripListItems,
	moveListItem,
	restoreListItem,
	setListItemAssignees,
	setListItemStatus,
	setListItemTargets,
	updateListItem,
} from "../lists.functions";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const { scratchUrl } = testEnv;

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
	| "owner"
	| "maya"
	| "viewer"
	| "suggester"
	| "stranger"
	| "guestEditor"
	| "guestViewer",
	AuthUser
>;

type Trip = FixtureClone & {
	suggesterMemberId: string;
	viewerMemberId: string;
};

async function freshTrip(): Promise<Trip> {
	const c = await cloneDemoTrip(getDb(), U.owner.id);
	// Maya is seeded as an editor only when her email is maya@example.com; add her.
	if (!c.members.maya) {
		const [m] = await getDb()
			.insert(tripMembers)
			.values({
				tripId: c.tripId,
				userId: U.maya.id,
				status: "active",
				role: "editor",
				color: 2,
			})
			.returning({ id: tripMembers.id });
		c.members.maya = m?.id ?? null;
	}
	const [viewer] = await getDb()
		.insert(tripMembers)
		.values({
			tripId: c.tripId,
			userId: U.viewer.id,
			status: "active",
			role: "viewer",
			color: 5,
		})
		.returning({ id: tripMembers.id });
	const [sugg] = await getDb()
		.insert(tripMembers)
		.values({
			tripId: c.tripId,
			userId: U.suggester.id,
			status: "active",
			role: "suggester",
			color: 6,
		})
		.returning({ id: tripMembers.id });
	await redeemShareToken(c.shareTokens.editor, U.guestEditor.id);
	await redeemShareToken(c.shareTokens.viewer, U.guestViewer.id);
	return {
		...c,
		suggesterMemberId: sugg?.id as string,
		viewerMemberId: viewer?.id as string,
	};
}

const list = (u: AuthUser, tripId: string) =>
	call<ListItemDto[]>(listTripListItems, u, { tripId });

const q = async <T>(query: ReturnType<typeof sql>) =>
	(await getDb().execute(query)).rows as T[];

beforeAll(async () => {
	await ensureDatabase(scratchUrl);
	await migrateDatabase(scratchUrl);
	U.owner = await newUser({ first: "Dev", last: "Owner" });
	U.maya = await newUser({ first: "Maya", last: "Chen" });
	U.viewer = await newUser({ first: "Vic", last: "Viewer" });
	U.suggester = await newUser({ first: "Sue", last: "Suggester" });
	U.stranger = await newUser({ first: "Sam", last: "Stranger" });
	U.guestEditor = await newUser(null);
	U.guestViewer = await newUser(null);
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

describe("list cores", () => {
	it("create → read → update → tick → move → delete → restore", async () => {
		const c = await freshTrip();
		const created = await call<ListItemDto>(createListItem, U.owner, {
			tripId: c.tripId,
			target: { kind: "node", nodeId: c.ids.nodes.knifeShop },
			list: "shopping",
			text: "Whetstone",
			quantity: 2,
			priceAmount: 4500,
			priceCurrency: "JPY",
			assigneeIds: [c.members.owner],
			extraTargetNodeIds: [c.ids.nodes.itoya],
		});
		expect(created).toMatchObject({
			text: "Whetstone",
			list: "shopping",
			quantity: 2,
			priceAmount: 4500,
			priceCurrency: "JPY",
			assigneeIds: [c.members.owner],
			extraTargetNodeIds: [c.ids.nodes.itoya],
			status: "open",
			mine: true,
			isPrivate: false,
		});
		const rows = await list(U.maya, c.tripId);
		expect(rows.some((r) => r.id === created.id && !r.mine)).toBe(true);

		// Update with a stale version → CONFLICT; a fresh one applies.
		expect(
			await codeOf(
				call(updateListItem, U.owner, {
					id: created.id,
					patch: { text: "Whetstone #1000" },
					expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
				}),
			),
		).toBe("CONFLICT");
		await call(updateListItem, U.maya, {
			id: created.id,
			patch: {
				text: "Whetstone #1000",
				quantity: null,
				note: "the **fine** one",
			},
			expectedUpdatedAt: created.updatedAt,
		});

		await call(setListItemStatus, U.maya, { id: created.id, status: "done" });
		let row = (await list(U.owner, c.tripId)).find((r) => r.id === created.id);
		expect(row).toMatchObject({
			text: "Whetstone #1000",
			quantity: null,
			note: "the **fine** one",
			status: "done",
		});
		expect(row?.doneAt).not.toBeNull();
		await call(setListItemStatus, U.owner, { id: created.id, status: "open" });

		// Move to the trip root, then back before the petty knife.
		await call(moveListItem, U.owner, {
			id: created.id,
			target: { kind: "trip" },
		});
		row = (await list(U.owner, c.tripId)).find((r) => r.id === created.id);
		expect(row?.target).toEqual({ kind: "trip" });
		const petty = (await list(U.owner, c.tripId)).find(
			(r) => r.text === "Petty knife",
		);
		await call(moveListItem, U.owner, {
			id: created.id,
			target: { kind: "node", nodeId: c.ids.nodes.knifeShop },
			beforeId: petty?.id,
		});
		const shop = (await list(U.owner, c.tripId)).filter(
			(r) =>
				r.target.kind === "node" && r.target.nodeId === c.ids.nodes.knifeShop,
		);
		expect(shop.map((r) => r.text)).toEqual(["Whetstone #1000", "Petty knife"]);

		await call(setListItemTargets, U.owner, { id: created.id, nodeIds: [] });
		await call(setListItemAssignees, U.owner, {
			id: created.id,
			memberIds: [c.members.maya as string],
		});
		row = (await list(U.owner, c.tripId)).find((r) => r.id === created.id);
		expect(row?.extraTargetNodeIds).toEqual([]);
		expect(row?.assigneeIds).toEqual([c.members.maya]);

		const del = await call<{ deletedAt: string }>(deleteListItem, U.owner, {
			id: created.id,
		});
		expect(del.deletedAt).toMatch(/Z$/);
		expect(
			(await list(U.owner, c.tripId)).some((r) => r.id === created.id),
		).toBe(false);
		await call(restoreListItem, U.owner, { id: created.id });
		expect(
			(await list(U.owner, c.tripId)).some((r) => r.id === created.id),
		).toBe(true);

		const verbs = (
			await q<{ verb: string }>(
				sql`select verb from activity_log where trip_id = ${c.tripId}`,
			)
		).map((a) => a.verb);
		expect(verbs).toContain("list.create");
		expect(verbs).toContain("list.done");
		expect(verbs).toContain("list.delete");
	});

	it("roles: viewers and guest viewers can't write, strangers get 404, guest editors can", async () => {
		const c = await freshTrip();
		const input = {
			tripId: c.tripId,
			target: { kind: "trip" },
			list: "todo",
			text: "Buy a SIM",
		};
		expect(await codeOf(call(createListItem, U.viewer, input))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(createListItem, U.guestViewer, input))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(createListItem, U.stranger, input))).toBe(
			"NOT_FOUND",
		);
		expect(await codeOf(call(createListItem, U.guestEditor, input))).toBe("ok");
		// A guest can't keep a private item, nor be assigned.
		expect(
			await codeOf(
				call(createListItem, U.guestEditor, { ...input, isPrivate: true }),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(
				call(createListItem, U.owner, {
					...input,
					assigneeIds: [randomUUID()],
				}),
			),
		).toBe("VALIDATION");
		// Targets and neighbours from another trip are refused.
		const other = await freshTrip();
		expect(
			await codeOf(
				call(createListItem, U.owner, {
					...input,
					target: { kind: "node", nodeId: other.ids.nodes.itoya },
				}),
			),
		).toBe("NOT_FOUND");
		expect(
			await codeOf(
				call(createListItem, U.owner, {
					...input,
					extraTargetNodeIds: [other.ids.nodes.itoya],
				}),
			),
		).toBe("NOT_FOUND");
	});

	it("suggesters: an assignee ticks directly; their own private items apply directly", async () => {
		const c = await freshTrip();
		const assigned = await call<ListItemDto>(createListItem, U.owner, {
			tripId: c.tripId,
			target: { kind: "trip" },
			list: "todo",
			text: "Print the JR pass voucher",
			assigneeIds: [c.suggesterMemberId],
		});
		const other = await call<ListItemDto>(createListItem, U.owner, {
			tripId: c.tripId,
			target: { kind: "trip" },
			list: "todo",
			text: "Not assigned to Sue",
		});
		expect(
			await codeOf(
				call(setListItemStatus, U.suggester, {
					id: assigned.id,
					status: "done",
				}),
			),
		).toBe("ok");
		// Not an assignee: a proposal (QA DUE-07), never a direct write.
		const ticked = await call(setListItemStatus, U.suggester, {
			id: other.id,
			status: "done",
		});
		expect(isProposed(ticked)).toBe(true);
		const still = (await list(U.owner, c.tripId)).find(
			(r) => r.id === other.id,
		);
		expect(still?.status).toBe("open");
		// A shared to-do from a suggester is a proposal too (no row yet).
		const suggested = await call(createListItem, U.suggester, {
			tripId: c.tripId,
			target: { kind: "trip" },
			list: "todo",
			text: "Maybe: rent a pocket wifi",
		});
		expect(isProposed(suggested)).toBe(true);
		expect(
			(await list(U.owner, c.tripId)).some((r) =>
				r.text.includes("pocket wifi"),
			),
		).toBe(false);
		const open = await getDb().execute(sql`
			select op from proposals
			 where trip_id = ${c.tripId} and status = 'open' order by created_at`);
		expect((open.rows as { op: string }[]).map((r) => r.op)).toEqual([
			"list.status",
			"list.create",
		]);
		// A suggester's edit and delete of an existing row are proposals too.
		expect(
			isProposed(
				await call(updateListItem, U.suggester, {
					id: other.id,
					patch: { text: "Not assigned to Sue (edited)" },
				}),
			),
		).toBe(true);
		expect(
			isProposed(await call(deleteListItem, U.suggester, { id: other.id })),
		).toBe(true);
		// The owner accepts the tick and the new to-do: they apply.
		if (!isProposed(ticked) || !isProposed(suggested)) throw new Error("x");
		for (const proposalId of [ticked.proposed.id, suggested.proposed.id]) {
			const r = await call<{ status: string }>(resolveProposal, U.owner, {
				proposalId,
				decision: "accept",
			});
			expect(r.status).toBe("accepted");
		}
		const after = await list(U.owner, c.tripId);
		expect(after.find((r) => r.id === other.id)?.status).toBe("done");
		expect(after.some((r) => r.text === "Maybe: rent a pocket wifi")).toBe(
			true,
		);
		// Own private item: direct.
		const gift = await call<ListItemDto>(createListItem, U.suggester, {
			tripId: c.tripId,
			target: { kind: "trip" },
			list: "shopping",
			text: "Gift for Dennis",
			isPrivate: true,
		});
		expect(gift.isPrivate).toBe(true);
		expect(
			await codeOf(
				call(updateListItem, U.suggester, {
					id: gift.id,
					patch: { text: "Gift for Dennis (tea)" },
				}),
			),
		).toBe("ok");
		expect(
			await codeOf(call(deleteListItem, U.suggester, { id: gift.id })),
		).toBe("ok");
	});

	it("relative due rules replace absolute fields, and an absolute date turns them off", async () => {
		const c = await freshTrip();
		const rule = {
			kind: "days" as const,
			itemId: c.ids.items.kix as string,
			days: 355,
			time: "09:00",
			tz: "Asia/Tokyo",
		};
		const li = await call<ListItemDto>(createListItem, U.owner, {
			tripId: c.tripId,
			target: { kind: "item", itemId: c.ids.items.kix },
			list: "todo",
			text: "Book ANA award seats",
			dueKind: "opens",
			dueRule: rule,
			dueDate: "2026-01-01",
		});
		expect(li.dueRule).toEqual(rule);
		expect(li.dueDate).toBeNull();
		expect(li.dueKind).toBe("opens");
		// A rule on an item from another trip is refused.
		const other = await freshTrip();
		expect(
			await codeOf(
				call(updateListItem, U.owner, {
					id: li.id,
					patch: { dueRule: { ...rule, itemId: other.ids.items.kix } },
				}),
			),
		).toBe("NOT_FOUND");
		await call(updateListItem, U.owner, {
			id: li.id,
			patch: {
				dueDate: "2027-09-01",
				dueTime: "20:00",
				dueTz: "America/New_York",
			},
		});
		let row = (await list(U.owner, c.tripId)).find((r) => r.id === li.id);
		expect(row).toMatchObject({
			dueRule: null,
			dueDate: "2027-09-01",
			dueTime: "20:00",
			dueTz: "America/New_York",
		});
		// A time without a zone gets the trip's; clearing the date clears the time.
		await call(updateListItem, U.owner, {
			id: li.id,
			patch: { dueTime: "10:00", dueTz: null },
		});
		row = (await list(U.owner, c.tripId)).find((r) => r.id === li.id);
		expect(row?.dueTz).toBe("Asia/Tokyo");
		await call(updateListItem, U.owner, {
			id: li.id,
			patch: { dueDate: null },
		});
		row = (await list(U.owner, c.tripId)).find((r) => r.id === li.id);
		expect(row).toMatchObject({ dueDate: null, dueTime: null, dueTz: null });
	});
});

describe("privacy (ADDENDUM §7.2)", () => {
	it("Maya never sees Dennis's private item, its count, its activity or its mention", async () => {
		const c = await freshTrip();
		const maya = c.members.maya as string;
		const countsBefore = await call<{ root: { shop: number } }>(
			getTripCounts,
			U.maya,
			{ tripId: c.tripId },
		);
		const gift = await call<ListItemDto>(createListItem, U.owner, {
			tripId: c.tripId,
			target: { kind: "trip" },
			list: "shopping",
			text: `Birthday gift for ${mentionToken("Maya Chen", maya)}`,
			isPrivate: true,
		});
		expect(gift.isPrivate).toBe(true);
		expect((await list(U.owner, c.tripId)).some((r) => r.id === gift.id)).toBe(
			true,
		);
		expect((await list(U.maya, c.tripId)).some((r) => r.id === gift.id)).toBe(
			false,
		);
		expect(
			(await list(U.guestViewer, c.tripId)).some((r) => r.id === gift.id),
		).toBe(false);
		const countsAfter = await call<{ root: { shop: number } }>(
			getTripCounts,
			U.maya,
			{ tripId: c.tripId },
		);
		expect(countsAfter.root.shop).toBe(countsBefore.root.shop);
		expect(
			await q(sql`select 1 from mentions where list_item_id = ${gift.id}`),
		).toHaveLength(0);
		const acts = await call<{ summary: string }[]>(listActivity, U.maya, {
			tripId: c.tripId,
		});
		expect(acts.some((a) => a.summary.includes("Birthday"))).toBe(false);
		expect(
			(await loadInbox(U.maya.id, { tripId: c.tripId })).items.some(
				(i) => i.kind === "mention" && (i.excerpt ?? "").includes("Birthday"),
			),
		).toBe(false);
		// Every write on it answers NOT_FOUND to Maya (like a missing row).
		for (const [fn, data] of [
			[updateListItem, { id: gift.id, patch: { text: "x" } }],
			[setListItemStatus, { id: gift.id, status: "done" }],
			[moveListItem, { id: gift.id, target: { kind: "trip" } }],
			[setListItemTargets, { id: gift.id, nodeIds: [] }],
			[setListItemAssignees, { id: gift.id, memberIds: [] }],
			[deleteListItem, { id: gift.id }],
		] as const)
			expect(await codeOf(call(fn, U.maya, data))).toBe("NOT_FOUND");
		// Deleted by its author: restore is still NOT_FOUND for Maya.
		await call(deleteListItem, U.owner, { id: gift.id });
		expect(await codeOf(call(restoreListItem, U.maya, { id: gift.id }))).toBe(
			"NOT_FOUND",
		);
		await call(restoreListItem, U.owner, { id: gift.id });
		// Only the author flips privacy.
		const shared = await call<ListItemDto>(createListItem, U.owner, {
			tripId: c.tripId,
			target: { kind: "trip" },
			list: "todo",
			text: `Ask ${mentionToken("Maya Chen", maya)} about the ryokan`,
		});
		expect(
			await q(sql`select 1 from mentions where list_item_id = ${shared.id}`),
		).toHaveLength(1);
		expect(
			await codeOf(
				call(updateListItem, U.maya, {
					id: shared.id,
					patch: { isPrivate: true },
				}),
			),
		).toBe("FORBIDDEN");
		await call(updateListItem, U.owner, {
			id: shared.id,
			patch: { isPrivate: true },
		});
		expect(
			await q(sql`select 1 from mentions where list_item_id = ${shared.id}`),
		).toHaveLength(0);
		expect((await list(U.maya, c.tripId)).some((r) => r.id === shared.id)).toBe(
			false,
		);
	});

	it("SEC-R3-01: a suggester shares her own private to-do only through review", async () => {
		const c = await freshTrip();
		const stamp = randomUUID().slice(0, 8);
		const text = `Pay the deposit to Sue's friend ${stamp}`;
		const tokyo = c.ids.nodes.tokyo as string;
		const people = [c.members.owner, c.members.audrey].sort();
		// The QA repro: a private to-do with a date, a link and two assignees…
		const priv = await call<ListItemDto>(createListItem, U.suggester, {
			tripId: c.tripId,
			target: { kind: "node", nodeId: tokyo },
			list: "todo",
			text,
			isPrivate: true,
			dueDate: "2026-09-24",
			dueTime: "09:00",
			dueTz: "Asia/Tokyo",
			url: "https://example.com/pay-here",
			assigneeIds: people,
		});
		expect(priv.isPrivate).toBe(true);
		// …whose edits apply directly while it stays private…
		expect(
			await codeOf(
				call(updateListItem, U.suggester, {
					id: priv.id,
					patch: { note: "cash only", isPrivate: true },
				}),
			),
		).toBe("ok");
		// …but sharing it (alone or with an edit) is never applied, and a
		// suggestion about the private row can't exist: FORBIDDEN.
		for (const patch of [
			{ isPrivate: false },
			{ isPrivate: false, text: `${text} (shared)` },
		])
			expect(
				await codeOf(call(updateListItem, U.suggester, { id: priv.id, patch })),
			).toBe("FORBIDDEN");
		// "Suggest sharing with the trip": a suggested shared copy (the UI's
		// `shareCopyOf`), reviewed like any new to-do.
		const copy = {
			tripId: c.tripId,
			target: { kind: "node", nodeId: tokyo },
			list: "todo",
			text: `${text} (shared)`,
			note: "cash only",
			url: "https://example.com/pay-here",
			dueDate: "2026-09-24",
			dueTime: "09:00",
			dueTz: "Asia/Tokyo",
			assigneeIds: people,
			fromPrivateId: priv.id,
		};
		const flip = await call(createListItem, U.suggester, copy);
		if (!isProposed(flip)) throw new Error(`applied: ${JSON.stringify(flip)}`);
		const hers = (await list(U.suggester, c.tripId)).find(
			(r) => r.id === priv.id,
		);
		expect(hers).toMatchObject({ isPrivate: true, text });
		// Nobody else has it yet: no row, and the only activity line and inbox
		// item are the suggestion itself.
		expect(
			(await list(U.owner, c.tripId)).some((r) => r.text.includes(stamp)),
		).toBe(false);
		const acts = await call<{ summary: string }[]>(listActivity, U.owner, {
			tripId: c.tripId,
		});
		expect(
			acts.filter((a) => a.summary.includes(stamp)).map((a) => a.summary),
		).toEqual([`suggested: added “${text} (shared)” to to-dos`]);
		expect(
			JSON.stringify(
				(await loadInbox(U.owner.id, { tripId: c.tripId })).items.filter(
					(i) => i.kind !== "review",
				),
			),
		).not.toContain(stamp);
		// The reviewers get a suggested shared to-do with everything on it.
		const props = await call<ProposalDto[]>(listProposals, U.owner, {
			tripId: c.tripId,
		});
		const p = props.find((x) => x.id === flip.proposed.id);
		expect(p?.op).toBe("list.create");
		expect(p?.payload).toMatchObject({
			text: `${text} (shared)`,
			note: "cash only",
			url: "https://example.com/pay-here",
			dueDate: "2026-09-24",
			dueTime: "09:00",
			dueTz: "Asia/Tokyo",
			fromPrivateId: priv.id,
			target: { kind: "node", nodeId: tokyo },
		});
		expect(p?.payload).not.toHaveProperty("isPrivate");
		// Asking again while it waits: refused.
		expect(await codeOf(call(createListItem, U.suggester, copy))).toBe(
			"CONFLICT",
		);
		// Nobody else can retire her private row through `fromPrivateId`.
		const decoy = await call<ListItemDto>(createListItem, U.owner, {
			tripId: c.tripId,
			target: { kind: "trip" },
			list: "todo",
			text: `Decoy ${stamp}`,
			fromPrivateId: priv.id,
		});
		expect(decoy.isPrivate).toBe(false);
		expect(
			(await list(U.suggester, c.tripId)).some((r) => r.id === priv.id),
		).toBe(true);
		// Accepted: a live shared to-do; her private copy is gone.
		const r = await call<{ status: string }>(resolveProposal, U.owner, {
			proposalId: flip.proposed.id,
			decision: "accept",
		});
		expect(r.status).toBe("accepted");
		const live = (await list(U.owner, c.tripId)).find(
			(x) => x.text === `${text} (shared)`,
		);
		expect(live).toMatchObject({
			isPrivate: false,
			note: "cash only",
			url: "https://example.com/pay-here",
			dueDate: "2026-09-24",
			dueTime: "09:00",
			target: { kind: "node", nodeId: tokyo },
		});
		expect([...(live?.assigneeIds ?? [])].sort()).toEqual(people);
		const after = (await list(U.suggester, c.tripId)).filter((x) =>
			x.text.includes(stamp),
		);
		expect(after.map((x) => [x.id === priv.id, x.isPrivate])).toEqual([
			[false, false],
			[false, false],
		]);
		// A rejected one leaves the private to-do as it was.
		const gift = await call<ListItemDto>(createListItem, U.suggester, {
			tripId: c.tripId,
			target: { kind: "trip" },
			list: "shopping",
			text: `Gift ${stamp}`,
			isPrivate: true,
		});
		const again = await call(createListItem, U.suggester, {
			tripId: c.tripId,
			target: { kind: "trip" },
			list: "shopping",
			text: `Gift ${stamp}`,
			fromPrivateId: gift.id,
		});
		if (!isProposed(again)) throw new Error("applied");
		await call(resolveProposal, U.owner, {
			proposalId: again.proposed.id,
			decision: "reject",
		});
		expect(
			(await list(U.suggester, c.tripId)).find((x) => x.id === gift.id),
		).toMatchObject({ isPrivate: true });
		expect(
			(await list(U.owner, c.tripId)).some((x) => x.text.includes("Gift")),
		).toBe(false);
		// An editor still shares her own directly.
		const mine = await call<ListItemDto>(createListItem, U.maya, {
			tripId: c.tripId,
			target: { kind: "trip" },
			list: "todo",
			text: `Maya's own ${stamp}`,
			isPrivate: true,
		});
		const direct = await call(updateListItem, U.maya, {
			id: mine.id,
			patch: { isPrivate: false },
		});
		expect(isProposed(direct)).toBe(false);
		expect(
			(await list(U.owner, c.tripId)).find((x) => x.id === mine.id)?.isPrivate,
		).toBe(false);
	});

	it("making a shared item private drops its earlier activity lines for everyone (DUE-10)", async () => {
		const c = await freshTrip();
		const maya = c.members.maya as string;
		const shop = c.ids.nodes.knifeShop as string;
		// Maya's first digest call only stamps her seen version.
		await call(getDigest, U.maya, { tripId: c.tripId });
		const gift = await call<ListItemDto>(createListItem, U.owner, {
			tripId: c.tripId,
			target: { kind: "node", nodeId: shop },
			list: "shopping",
			text: `SURPRISE cake stand for ${mentionToken("Maya Chen", maya)}`,
		});
		const other = await call<ListItemDto>(createListItem, U.owner, {
			tripId: c.tripId,
			target: { kind: "node", nodeId: shop },
			list: "shopping",
			text: "Knife roll",
		});
		await call(setListItemStatus, U.owner, { id: gift.id, status: "done" });
		await call(setListItemStatus, U.owner, { id: gift.id, status: "open" });
		// A pre-`listItemId` row for the same item (older data): matched by name + target.
		await q(sql`
			insert into activity_log (id, trip_id, actor_user_id, actor_name, verb, summary, node_id, version, meta)
			values (${randomUUID()}, ${c.tripId}, ${U.owner.id}, 'Dev', 'list.done', 'ticked off “SURPRISE cake stand for @Maya Chen”',
			        ${shop}, 1, ${JSON.stringify({ name: "SURPRISE cake stand for @Maya Chen" })}::jsonb)`);
		const surprise = (rows: { summary: string }[]) =>
			rows.filter((a) => a.summary.includes("SURPRISE")).length;
		expect(
			surprise(
				await call<{ summary: string }[]>(listActivity, U.maya, {
					tripId: c.tripId,
				}),
			),
		).toBe(3);
		await call(updateListItem, U.owner, {
			id: gift.id,
			patch: { isPrivate: true },
		});
		for (const u of [U.maya, U.guestViewer, U.owner]) {
			const acts = await call<{ summary: string }[]>(listActivity, u, {
				tripId: c.tripId,
			});
			expect(surprise(acts)).toBe(0);
			// Other items' lines stay.
			expect(acts.some((a) => a.summary.includes("Knife roll"))).toBe(true);
			const node = await call<{ summary: string }[]>(listActivity, u, {
				tripId: c.tripId,
				nodeId: shop,
			});
			expect(surprise(node)).toBe(0);
		}
		const digest = await call<{ rows: { summary: string; meta: unknown }[] }>(
			getDigest,
			U.maya,
			{ tripId: c.tripId },
		);
		expect(surprise(digest.rows)).toBe(0);
		expect(JSON.stringify(digest.rows)).not.toContain("SURPRISE");
		expect(digest.rows.some((r) => r.summary.includes("Knife roll"))).toBe(
			true,
		);
		expect(
			await q(
				sql`select 1 from activity_log where meta->>'listItemId' = ${other.id}`,
			),
		).toHaveLength(1);
		// Shared again: nothing comes back, and nothing new is logged by the flip.
		await call(updateListItem, U.owner, {
			id: gift.id,
			patch: { isPrivate: false },
		});
		expect(
			await q(
				sql`select 1 from activity_log where meta->>'listItemId' = ${gift.id}`,
			),
		).toHaveLength(0);
	});
});

describe("mentions", () => {
	it("list-item mentions follow edits; listMyMentions + markMentionsRead", async () => {
		const c = await freshTrip();
		const maya = c.members.maya as string;
		const li = await call<ListItemDto>(createListItem, U.owner, {
			tripId: c.tripId,
			target: { kind: "node", nodeId: c.ids.nodes.shibuyaSky },
			list: "todo",
			text: `${mentionToken("Maya Chen", maya)} books the slot`,
		});
		let mine = await call<
			{
				id: string;
				sel: string | null;
				tab: string;
				readAt: string | null;
				excerpt: string | null;
			}[]
		>(listMyMentions, U.maya);
		const hit = mine.find((m) => (m.excerpt ?? "").includes("books the slot"));
		expect(hit?.sel).toBe(`n.${c.ids.nodes.shibuyaSky}`);
		expect(hit?.tab).toBe("lists");
		expect(hit?.readAt).toBeNull();
		// Someone else's ids change nothing.
		expect(
			(
				await call<{ updated: number }>(markMentionsRead, U.owner, {
					ids: [hit?.id],
				})
			).updated,
		).toBe(0);
		expect(
			(
				await call<{ updated: number }>(markMentionsRead, U.maya, {
					ids: [hit?.id],
				})
			).updated,
		).toBe(1);
		mine = await call(listMyMentions, U.maya);
		expect(mine.find((m) => m.id === hit?.id)?.readAt).not.toBeNull();
		// Removing the token removes the row.
		await call(updateListItem, U.owner, {
			id: li.id,
			patch: { text: "Someone books the slot" },
		});
		expect(
			await q(sql`select 1 from mentions where list_item_id = ${li.id}`),
		).toHaveLength(0);
		expect(
			(await call<{ updated: number }>(markMentionsRead, U.maya, { all: true }))
				.updated,
		).toBeGreaterThanOrEqual(0);
	});

	it("the notes hook keeps mention rows for members only and writes markdown", async () => {
		const c = await freshTrip();
		const maya = c.members.maya as string;
		const doc = `trip/${c.tripId}/node/${c.ids.nodes.shibuyaSky}`;
		await getDb().execute(sql`
			insert into yjs_documents (name, trip_id, node_id, state)
			values (${doc}, ${c.tripId}, ${c.ids.nodes.shibuyaSky}, ''::bytea)`);
		const json = (ids: string[]) => ({
			type: "doc",
			content: [
				{
					type: "heading",
					attrs: { level: 2 },
					content: [{ type: "text", text: "Sunset" }],
				},
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "Ask " },
						...ids.map((id) => ({
							type: "mention",
							attrs: { id, label: "Someone" },
						})),
						{ type: "text", text: " to book" },
					],
				},
			],
		});
		const store = async (ids: string[]) => {
			const out = new TxOutbox(c.tripId);
			await getDb().transaction((tx) =>
				notesHooks.afterStore({
					tx,
					out,
					documentName: doc,
					tripId: c.tripId,
					target: { kind: "node", id: c.ids.nodes.shibuyaSky as string },
					json: json(ids),
					plainText: "",
					context: null,
				}),
			);
			return out;
		};
		const out = await store([maya, randomUUID(), "not-a-uuid"]);
		expect(out.events().some((e) => e.type === "mention")).toBe(true);
		const rows = await q<{ memberId: string; excerpt: string }>(
			sql`select member_id::text as "memberId", excerpt from mentions where doc_name = ${doc}`,
		);
		expect(rows.map((r) => r.memberId)).toEqual([maya]);
		expect(rows[0]?.excerpt).toMatch(/^Ask @Someone.* to book$/);
		const [md] = await q<{ markdown: string }>(
			sql`select markdown from yjs_documents where name = ${doc}`,
		);
		expect(md?.markdown).toContain("## Sunset");
		// Unchanged → no new event; removed → row deleted.
		expect(
			(await store([maya])).events().some((e) => e.type === "mention"),
		).toBe(false);
		await store([]);
		expect(
			await q(sql`select 1 from mentions where doc_name = ${doc}`),
		).toHaveLength(0);
		const mine = await call<{ tab: string; sel: string | null }[]>(
			listMyMentions,
			U.maya,
		);
		expect(mine.every((m) => m.tab !== "notes" || m.sel)).toBe(true);
	});
});

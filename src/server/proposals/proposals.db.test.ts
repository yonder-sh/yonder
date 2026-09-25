/**
 * E7 proposals against real Postgres and Redis (EXTENSIONS §3.4–§3.5, QA
 * SUG-*): the gate's propose path (dry run, amend, chain, ghosts), the
 * permission matrix incl. member and guest suggesters, accept with its
 * conflicts, reject/withdraw cascades, access loss, guest redaction, and the
 * private-item guard. The server functions run for real through
 * `src/test/start-mock.ts`; the suggest-mode header comes from `hdr.mode`.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_prop_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-proptest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { hex, scratchUrl: scratch.toString() };
});
/** The calling tab's suggest mode (`x-yonder-mode`). */
const hdr = vi.hoisted(() => ({ mode: null as string | null }));

vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
vi.mock("@tanstack/react-start/server", async () => {
	const base = await import("@/test/start-server-mock");
	return {
		...base,
		getRequestHeaders: () =>
			new Headers(hdr.mode ? { "x-yonder-mode": hdr.mode } : {}),
	};
});

import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { tripMembers, user } from "@/db/schema";
import { createListItem } from "@/features/lists/lists.functions";
import { getTripGraph, listActivity } from "@/functions/graph.functions";
import {
	createItem,
	deleteItem,
	moveItem,
	updateItem,
} from "@/functions/items.functions";
import { setLeg } from "@/functions/legs.functions";
import { createNode, moveNode, updateNode } from "@/functions/nodes.functions";
import {
	listProposals,
	resolveProposal,
	resolveProposals,
	withdrawProposal,
} from "@/functions/proposals.functions";
import { shiftTripDates, updateTrip } from "@/functions/trips.functions";
import type { ProposalDto } from "@/lib/schemas/proposals";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import {
	cloneDemoTrip,
	type FixtureClone,
	joinTestLink,
} from "@/server/fixture.server";
import { closeQueues, getQueue } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { changeMemberRole } from "@/server/members.server";
import { removeGuestGrants } from "@/server/sharing.server";
import { withTripTx } from "@/server/tx.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T = Record<string, unknown>>(
	fn: unknown,
	u: AuthUser,
	data: unknown,
	mode: "suggest" | null = null,
) => {
	hdr.mode = mode;
	return (fn as Fn)({ data, context: { user: u } }).finally(() => {
		hdr.mode = null;
	}) as Promise<T>;
};

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		const r = await p;
		return r && typeof r === "object" && "proposed" in r ? "proposed" : "ok";
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
	| "editor"
	| "sue"
	| "viewer"
	| "stranger"
	| "guestViewer"
	| "guestEditor"
	| "guestSuggester",
	AuthUser
>;

type Trip = FixtureClone & { sueMember: string };

/** A fresh demo trip: owner, editor, suggester and viewer members, three kinds of link guests. */
async function freshTrip(): Promise<Trip> {
	const c = await cloneDemoTrip(getDb(), U.owner.id);
	const sueMember = randomUUID();
	await getDb()
		.insert(tripMembers)
		.values([
			{
				tripId: c.tripId,
				userId: U.editor.id,
				status: "active",
				role: "editor",
				color: 4,
			},
			{
				id: sueMember,
				tripId: c.tripId,
				userId: U.sue.id,
				status: "active",
				role: "suggester",
				color: 6,
			},
			{
				tripId: c.tripId,
				userId: U.viewer.id,
				status: "active",
				role: "viewer",
				color: 5,
			},
		]);
	await joinTestLink(getDb(), c, U.guestViewer.id, "viewer");
	await joinTestLink(getDb(), c, U.guestEditor.id, "editor");
	await joinTestLink(getDb(), c, U.guestSuggester.id, "suggester");
	return { ...c, sueMember };
}

async function graphOf(tripId: string) {
	return call<Awaited<ReturnType<typeof getTripGraph>>>(getTripGraph, U.owner, {
		tripId,
	});
}
const itemDay = async (tripId: string, itemId: string) =>
	(await graphOf(tripId)).items.find((i) => i.id === itemId)?.dayId ?? null;

async function proposalsOf(u: AuthUser, tripId: string) {
	return call<ProposalDto[]>(listProposals, u, { tripId });
}
async function rowOf(id: string) {
	const res = await getDb().execute(sql`
		select status::text as status, payload, review_note as "reviewNote",
		       last_error as "lastError", requires::text[] as requires
		  from proposals where id = ${id}`);
	return res.rows[0] as {
		status: string;
		payload: Record<string, unknown>;
		reviewNote: string | null;
		lastError: { reason: string; fields?: string[] } | null;
		requires: string[];
	};
}
type P = { proposed: { id: string; summary: string } };

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	U.owner = await newUser({ first: "Dennis", last: "Owner" });
	U.editor = await newUser({ first: "Maya", last: "Editor" });
	U.sue = await newUser({ first: "Sue", last: "Suggester" });
	U.viewer = await newUser({ first: "Vic", last: "Viewer" });
	U.stranger = await newUser({ first: "Sam", last: "Stranger" });
	U.guestViewer = await newUser(null);
	U.guestEditor = await newUser(null);
	U.guestSuggester = await newUser(null);
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

describe("the gate: permission matrix (EXTENSIONS §3.1, §3.4)", () => {
	it("applies, proposes or refuses per role, incl. member and guest suggesters", async () => {
		const t = await freshTrip();
		const move = (dayId: string) => ({ itemId: t.ids.items.itoya, dayId });
		const d = t.ids.days;
		expect(await codeOf(call(moveItem, U.owner, move(d.d1 ?? "")))).toBe("ok");
		expect(await codeOf(call(moveItem, U.editor, move(d.d2 ?? "")))).toBe("ok");
		expect(await codeOf(call(moveItem, U.guestEditor, move(d.d3 ?? "")))).toBe(
			"ok",
		);
		// Suggesters (member and link guest) propose; the item doesn't move.
		expect(await codeOf(call(moveItem, U.sue, move(d.d4 ?? "")))).toBe(
			"proposed",
		);
		expect(
			await codeOf(call(moveItem, U.guestSuggester, move(d.d5 ?? ""))),
		).toBe("proposed");
		expect(await itemDay(t.tripId, t.ids.items.itoya ?? "")).toBe(d.d3);
		// An editor in suggest mode proposes too.
		expect(
			await codeOf(call(moveItem, U.editor, move(d.d1 ?? ""), "suggest")),
		).toBe("proposed");
		// A guest suggester never becomes a guest editor, even with the header off.
		expect(
			await codeOf(
				call(updateTrip, U.guestSuggester, { tripId: t.tripId, name: "x" }),
			),
		).toBe("FORBIDDEN");
		// Viewers can't propose; strangers don't see the trip.
		expect(await codeOf(call(moveItem, U.viewer, move(d.d1 ?? "")))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(moveItem, U.guestViewer, move(d.d1 ?? "")))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(moveItem, U.stranger, move(d.d1 ?? "")))).toBe(
			"NOT_FOUND",
		);
		// The header only downgrades: a viewer "suggesting" is still refused.
		expect(
			await codeOf(call(moveItem, U.viewer, move(d.d1 ?? ""), "suggest")),
		).toBe("FORBIDDEN");
	});

	it("lists proposals for proposers and reviewers only; resolving needs reviewProposals", async () => {
		const t = await freshTrip();
		const p = await call<P>(moveItem, U.sue, {
			itemId: t.ids.items.itoya,
			dayId: t.ids.days.d1,
		});
		for (const u of [U.owner, U.editor, U.guestEditor, U.sue, U.guestSuggester])
			expect((await proposalsOf(u, t.tripId)).map((x) => x.id)).toContain(
				p.proposed.id,
			);
		expect(await proposalsOf(U.viewer, t.tripId)).toEqual([]);
		expect(await proposalsOf(U.guestViewer, t.tripId)).toEqual([]);
		expect(await codeOf(proposalsOf(U.stranger, t.tripId))).toBe("NOT_FOUND");
		const reject = { proposalId: p.proposed.id, decision: "reject" as const };
		for (const u of [U.sue, U.guestSuggester, U.viewer, U.guestViewer])
			expect(await codeOf(call(resolveProposal, u, reject))).toBe("FORBIDDEN");
		expect(await codeOf(call(resolveProposal, U.stranger, reject))).toBe(
			"NOT_FOUND",
		);
		// Only the author withdraws.
		expect(
			await codeOf(
				call(withdrawProposal, U.guestSuggester, {
					proposalId: p.proposed.id,
				}),
			),
		).toBe("FORBIDDEN");
		expect(
			await codeOf(
				call(withdrawProposal, U.owner, { proposalId: p.proposed.id }),
			),
		).toBe("FORBIDDEN");
		// A guest editor reviews.
		expect(await call(resolveProposal, U.guestEditor, reject)).toEqual({
			ok: true,
			status: "rejected",
		});
	});
});

describe("propose → accept (SUG-01, SUG-02)", () => {
	it("stores the proposal with before-values; accepting applies it as the author", async () => {
		const t = await freshTrip();
		const itoya = t.ids.items.itoya ?? "";
		const before = await itemDay(t.tripId, itoya);
		const v0 = (await graphOf(t.tripId)).trip.version;
		const p = await call<P>(moveItem, U.sue, {
			itemId: itoya,
			dayId: t.ids.days.d5,
			proposal: { message: "closer to the airport" },
		});
		expect(p.proposed.summary).toMatch(/Itoya/);
		// One transaction: one version bump; the item didn't move.
		const g = await graphOf(t.tripId);
		expect(g.trip.version).toBe(v0 + 1);
		expect(await itemDay(t.tripId, itoya)).toBe(before);
		const [dto] = (await proposalsOf(U.owner, t.tripId)).filter(
			(x) => x.id === p.proposed.id,
		);
		expect(dto).toMatchObject({
			op: "item.move",
			entityKind: "item",
			entityId: itoya,
			status: "open",
			message: "closer to the airport",
			fields: ["dayId", "position"],
			author: { name: "Sue Suggester", isGuest: false, memberId: t.sueMember },
		});
		expect(dto?.before.dayId).toBe(before);
		expect(dto && "base" in dto).toBe(false);

		expect(
			await call(resolveProposal, U.owner, {
				proposalId: p.proposed.id,
				decision: "accept",
			}),
		).toEqual({ ok: true, status: "accepted" });
		expect(await itemDay(t.tripId, itoya)).toBe(t.ids.days.d5);
		const activity = await call<{ actorName: string; summary: string }[]>(
			listActivity,
			U.owner,
			{ tripId: t.tripId },
		);
		// The change is logged as the author, the accept as the reviewer.
		expect(
			activity.some(
				(a) =>
					a.actorName === "Sue (accepted by Dennis)" && /Itoya/.test(a.summary),
			),
		).toBe(true);
		expect(
			activity.some(
				(a) =>
					a.actorName === "Dennis Owner" &&
					a.summary.startsWith("accepted Sue's suggestion"),
			),
		).toBe(true);
		expect((await rowOf(p.proposed.id)).status).toBe("accepted");
	});

	it("returns the editors' validation from the dry run (SUG-04)", async () => {
		const t = await freshTrip();
		// A city can't go inside a place.
		const code = await codeOf(
			call(moveNode, U.sue, {
				nodeId: t.ids.nodes.tokyo,
				parentId: t.ids.nodes.itoya,
			}),
		);
		expect(["VALIDATION", "CONFLICT"]).toContain(code);
		const direct = await codeOf(
			call(moveNode, U.owner, {
				nodeId: t.ids.nodes.tokyo,
				parentId: t.ids.nodes.itoya,
			}),
		);
		expect(code).toBe(direct);
		expect(await proposalsOf(U.owner, t.tripId)).toEqual([]);
	});
});

describe("amend (SUG-06)", () => {
	it("a second move of the same item amends; moving it back withdraws", async () => {
		const t = await freshTrip();
		const itoya = t.ids.items.itoya ?? "";
		const home = await itemDay(t.tripId, itoya);
		const a = await call<P>(moveItem, U.sue, {
			itemId: itoya,
			dayId: t.ids.days.d4,
		});
		const b = await call<P>(moveItem, U.sue, {
			itemId: itoya,
			dayId: t.ids.days.d5,
		});
		expect(b.proposed.id).toBe(a.proposed.id);
		expect((await rowOf(a.proposed.id)).payload.dayId).toBe(t.ids.days.d5);
		expect(
			(await proposalsOf(U.owner, t.tripId)).filter((x) => x.status === "open"),
		).toHaveLength(1);
		await call<P>(moveItem, U.sue, { itemId: itoya, dayId: home });
		expect((await rowOf(a.proposed.id)).status).toBe("withdrawn");
	});

	it("renaming my own proposed place twice is one proposal; deleting it withdraws it and its dependants", async () => {
		const t = await freshTrip();
		const nodeId = randomUUID();
		const create = await call<P>(createNode, U.sue, {
			tripId: t.tripId,
			id: nodeId,
			parentId: t.ids.nodes.tokyo,
			type: "place",
			name: "Nakamise",
		});
		const r1 = await call<P>(updateNode, U.sue, {
			nodeId,
			patch: { name: "Nakamise-dori" },
		});
		const r2 = await call<P>(updateNode, U.sue, {
			nodeId,
			patch: { name: "Nakamise Street" },
		});
		expect(r1.proposed.id).toBe(create.proposed.id);
		expect(r2.proposed.id).toBe(create.proposed.id);
		expect((await rowOf(create.proposed.id)).payload.name).toBe(
			"Nakamise Street",
		);
		// An item on the ghost place chains (requires) it.
		const item = await call<P>(createItem, U.sue, {
			tripId: t.tripId,
			dayId: t.ids.days.d2,
			nodeId,
		});
		expect(item.proposed.id).not.toBe(create.proposed.id);
		expect((await rowOf(item.proposed.id)).requires).toEqual([
			create.proposed.id,
		]);
		// Someone else can't build on my ghost.
		expect(
			await codeOf(
				call(createItem, U.owner, {
					tripId: t.tripId,
					dayId: t.ids.days.d2,
					nodeId,
				}),
			),
		).toBe("CONFLICT");
		const del = await call<P>(
			(await import("@/functions/nodes.functions")).deleteNode,
			U.sue,
			{ nodeId },
		);
		expect(del.proposed.id).toBe(create.proposed.id);
		expect((await rowOf(create.proposed.id)).status).toBe("withdrawn");
		const dep = await rowOf(item.proposed.id);
		expect(dep.status).toBe("withdrawn");
		expect(dep.reviewNote).toBe("depends on a withdrawn suggestion");
	});
});

describe("ghost ids can't be hijacked", () => {
	it("a proposal can't claim an existing row's id, in any trip", async () => {
		const a = await freshTrip();
		const b = await freshTrip();
		const victim = b.ids.nodes.itoya ?? "";
		expect(
			await codeOf(
				call(createNode, U.sue, {
					tripId: a.tripId,
					id: victim,
					parentId: a.ids.nodes.tokyo,
					type: "place",
					name: "Mine now",
				}),
			),
		).toBe("CONFLICT");
		// Unused `ids` of a path are not claimed; the other trip's owner edits freely.
		const p = await call<P>(
			(await import("@/functions/nodes.functions")).createNodePath,
			U.sue,
			{
				tripId: a.tripId,
				chain: [{ id: a.ids.nodes.japan }, { type: "city", name: "Nagoya" }],
				ids: [randomUUID(), victim],
			},
		);
		const row = await getDb().execute(
			sql`select created_ids::text[] as ids from proposals where id = ${p.proposed.id}`,
		);
		expect((row.rows[0] as { ids: string[] }).ids).not.toContain(victim);
		expect(
			await codeOf(
				call(updateNode, U.owner, {
					nodeId: victim,
					patch: { name: "Itoya (Ginza)" },
				}),
			),
		).toBe("ok");
	});
});

describe("chains, conflicts and cascades", () => {
	it("accepting an item on a proposed place accepts both; rejecting the place rejects both (SUG-05)", async () => {
		const t = await freshTrip();
		const mk = async () => {
			const nodeId = randomUUID();
			const node = await call<P>(createNode, U.sue, {
				tripId: t.tripId,
				id: nodeId,
				parentId: t.ids.nodes.tokyo,
				type: "place",
				name: `Spot ${nodeId.slice(0, 4)}`,
			});
			const item = await call<P>(createItem, U.sue, {
				tripId: t.tripId,
				dayId: t.ids.days.d2,
				nodeId,
			});
			return { nodeId, node: node.proposed.id, item: item.proposed.id };
		};
		const a = await mk();
		expect(
			await call(resolveProposal, U.owner, {
				proposalId: a.item,
				decision: "accept",
			}),
		).toEqual({ ok: true, status: "accepted" });
		expect((await rowOf(a.node)).status).toBe("accepted");
		const g = await graphOf(t.tripId);
		expect(g.nodes.some((n) => n.id === a.nodeId)).toBe(true);
		expect(g.items.some((i) => i.nodeId === a.nodeId)).toBe(true);

		const b = await mk();
		await call(resolveProposal, U.owner, {
			proposalId: b.node,
			decision: "reject",
			note: "too far",
		});
		const [node, item] = [await rowOf(b.node), await rowOf(b.item)];
		expect(node).toMatchObject({ status: "rejected", reviewNote: "too far" });
		expect(item).toMatchObject({
			status: "rejected",
			reviewNote: "depends on a rejected suggestion",
		});
	});

	it("a changed base is a conflict; Accept anyway applies it; a deleted row is gone (SUG-03)", async () => {
		const t = await freshTrip();
		const itoya = t.ids.items.itoya ?? "";
		const p = await call<P>(moveItem, U.sue, {
			itemId: itoya,
			dayId: t.ids.days.d4,
		});
		await call(moveItem, U.owner, { itemId: itoya, dayId: t.ids.days.d1 });
		const r = await call<{
			ok: boolean;
			conflict?: { reason: string; fields?: string[] };
		}>(resolveProposal, U.owner, {
			proposalId: p.proposed.id,
			decision: "accept",
		});
		expect(r.ok).toBe(false);
		expect(r.conflict?.reason).toBe("changed");
		expect(r.conflict?.fields).toContain("dayId");
		expect((await rowOf(p.proposed.id)).lastError?.reason).toBe("changed");
		expect(await itemDay(t.tripId, itoya)).toBe(t.ids.days.d1);
		expect(
			await call(resolveProposal, U.owner, {
				proposalId: p.proposed.id,
				decision: "accept",
				force: true,
			}),
		).toEqual({ ok: true, status: "accepted" });
		expect(await itemDay(t.tripId, itoya)).toBe(t.ids.days.d4);

		const loft = t.ids.items.loft ?? "";
		const q = await call<P>(updateItem, U.sue, {
			itemId: loft,
			patch: { durationMin: 90 },
		});
		await call(deleteItem, U.owner, { itemId: loft });
		const gone = await call<{ ok: boolean; conflict?: { reason: string } }>(
			resolveProposal,
			U.owner,
			{ proposalId: q.proposed.id, decision: "accept", force: true },
		);
		expect(gone).toMatchObject({ ok: false, conflict: { reason: "gone" } });
	});

	it("stacked alternatives: accepting one puts the other under conflicts (SUG-16)", async () => {
		const t = await freshTrip();
		const knives = t.ids.items.knives ?? "";
		const maya = await call<P>(moveItem, U.sue, {
			itemId: knives,
			dayId: t.ids.days.d4,
		});
		const guest = await call<P>(moveItem, U.guestSuggester, {
			itemId: knives,
			dayId: t.ids.days.d1,
		});
		expect(guest.proposed.id).not.toBe(maya.proposed.id);
		const res = await call<Record<string, { ok: boolean }>>(
			resolveProposals,
			U.owner,
			{ ids: [guest.proposed.id], decision: "accept" },
		);
		expect(res[guest.proposed.id]?.ok).toBe(true);
		const other = await rowOf(maya.proposed.id);
		expect(other.status).toBe("open");
		expect(other.lastError?.reason).toBe("changed");
	});

	it("a trip.shift proposal is accepted after unrelated edits (SUG-15)", async () => {
		const t = await freshTrip();
		const g0 = await graphOf(t.tripId);
		const p = await call<P>(shiftTripDates, U.sue, {
			tripId: t.tripId,
			deltaDays: 1,
			expectedVersion: g0.trip.version,
		});
		expect((await rowOf(p.proposed.id)).payload).not.toHaveProperty(
			"expectedVersion",
		);
		await call(updateTrip, U.owner, { tripId: t.tripId, name: "Renamed" });
		await call(updateItem, U.owner, {
			itemId: t.ids.items.hands,
			patch: { durationMin: 50 },
		});
		expect(
			await call(resolveProposal, U.owner, {
				proposalId: p.proposed.id,
				decision: "accept",
			}),
		).toEqual({ ok: true, status: "accepted" });
		const g1 = await graphOf(t.tripId);
		expect(g1.days[0]?.date).not.toBe(g0.days[0]?.date);
	});
});

describe("withdraw and access loss", () => {
	it("the author withdraws; turning away a guest withdraws their proposals and dependants (SUG-10, SUG-12)", async () => {
		const t = await freshTrip();
		const p = await call<P>(moveItem, U.sue, {
			itemId: t.ids.items.itoya,
			dayId: t.ids.days.d1,
		});
		expect(
			await call(withdrawProposal, U.sue, { proposalId: p.proposed.id }),
		).toEqual({ ok: true });
		expect((await rowOf(p.proposed.id)).status).toBe("withdrawn");
		expect(
			await codeOf(
				call(withdrawProposal, U.sue, { proposalId: p.proposed.id }),
			),
		).toBe("CONFLICT");

		const nodeId = randomUUID();
		const node = await call<P>(createNode, U.guestSuggester, {
			tripId: t.tripId,
			id: nodeId,
			parentId: t.ids.nodes.tokyo,
			type: "place",
			name: "Guest spot",
		});
		await withTripTx(t.tripId, (tx, out) =>
			removeGuestGrants(tx, out, t.tripId, U.guestSuggester.id),
		);
		expect((await rowOf(node.proposed.id)).status).toBe("withdrawn");
	});

	it("changeMemberRole: a downgrade re-checks sockets; to viewer withdraws open proposals (SUG-17)", async () => {
		const t = await freshTrip();
		const p = await call<P>(moveItem, U.sue, {
			itemId: t.ids.items.itoya,
			dayId: t.ids.days.d1,
		});
		const events = await withTripTx(t.tripId, async (tx, out) => {
			await changeMemberRole(tx, out, t.tripId, t.sueMember, "viewer");
			return out.events();
		});
		expect(events.some((e) => e.type === "access")).toBe(true);
		expect((await rowOf(p.proposed.id)).status).toBe("withdrawn");
		expect(
			await codeOf(
				call(moveItem, U.sue, {
					itemId: t.ids.items.itoya,
					dayId: t.ids.days.d2,
				}),
			),
		).toBe("FORBIDDEN");
		// Editor → suggester: an access event (read-only note sockets), no withdrawals.
		const edMember = (
			await getDb().execute(
				sql`select id::text as id from trip_members where trip_id = ${t.tripId} and user_id = ${U.editor.id}`,
			)
		).rows[0] as { id: string };
		const ev2 = await withTripTx(t.tripId, async (tx, out) => {
			await changeMemberRole(tx, out, t.tripId, edMember.id, "suggester");
			return out.events();
		});
		expect(ev2.some((e) => e.type === "access")).toBe(true);
		expect(
			await codeOf(
				call(moveItem, U.editor, {
					itemId: t.ids.items.itoya,
					dayId: t.ids.days.d2,
				}),
			),
		).toBe("proposed");
	});
});

describe("guests and private items", () => {
	it("a guest suggester's leg proposal is stored without booking refs or seats (SUG-08)", async () => {
		const t = await freshTrip();
		const target = {
			kind: "pair",
			fromItemId: t.ids.items.hands,
			toItemId: t.ids.items.loft,
		};
		const p = await call<P>(setLeg, U.guestSuggester, {
			target,
			patch: {
				mode: "transit",
				details: {
					kind: "transit",
					booking: {
						ref: "PNR123",
						seats: [{ memberId: t.members.owner, seat: "12A" }],
					},
				},
			},
		});
		const stored = JSON.stringify((await rowOf(p.proposed.id)).payload);
		expect(stored).not.toContain("PNR123");
		expect(stored).not.toContain("12A");
		const [dto] = (await proposalsOf(U.guestEditor, t.tripId)).filter(
			(x) => x.id === p.proposed.id,
		);
		expect(JSON.stringify(dto)).not.toContain("PNR123");
		// A member suggester's booking ref stays in the DB but never reaches guests.
		const q = await call<P>(setLeg, U.sue, {
			target,
			patch: {
				mode: "transit",
				details: { kind: "transit", booking: { ref: "SECRET9", seats: [] } },
			},
		});
		expect(JSON.stringify((await rowOf(q.proposed.id)).payload)).toContain(
			"SECRET9",
		);
		const guestView = await proposalsOf(U.guestSuggester, t.tripId);
		expect(JSON.stringify(guestView)).not.toContain("SECRET9");
		const memberView = await proposalsOf(U.owner, t.tripId);
		expect(JSON.stringify(memberView)).toContain("SECRET9");
	});

	it("private list items never become proposals", async () => {
		const t = await freshTrip();
		expect(
			await codeOf(
				call(createListItem, U.guestSuggester, {
					tripId: t.tripId,
					target: { kind: "trip" },
					list: "todo",
					text: "Gift for Audrey",
					isPrivate: true,
				}),
			),
		).toBe("FORBIDDEN");
		// Someone else's private row doesn't exist for a suggester.
		const li = randomUUID();
		await getDb().execute(sql`
			insert into list_items (id, trip_id, list, text, position, is_private, created_by)
			values (${li}, ${t.tripId}, 'todo', 'Secret gift', 'a0', true, ${U.owner.id})`);
		const { setListItemStatus } = await import(
			"@/features/lists/lists.functions"
		);
		expect(
			await codeOf(call(setListItemStatus, U.sue, { id: li, status: "done" })),
		).toBe("NOT_FOUND");
		expect(await proposalsOf(U.owner, t.tripId)).toEqual([]);
	});

	it("making a to-do private withdraws suggestions about it and drops their activity (COLLAB-R2-02)", async () => {
		const t = await freshTrip();
		const { updateListItem } = await import("@/features/lists/lists.functions");
		const li = await call<{ id: string }>(createListItem, U.editor, {
			tripId: t.tripId,
			target: { kind: "trip" },
			list: "todo",
			text: "Gift idea X",
		});
		const p = await call<P>(updateListItem, U.sue, {
			id: li.id,
			patch: { text: "Gift idea X: a Montblanc pen for Dennis" },
		});
		expect(p.proposed.summary).toMatch(/Gift idea X/);
		expect((await proposalsOf(U.owner, t.tripId)).map((x) => x.id)).toContain(
			p.proposed.id,
		);
		await call(updateListItem, U.editor, {
			id: li.id,
			patch: { isPrivate: true },
		});
		expect(await rowOf(p.proposed.id)).toMatchObject({
			status: "withdrawn",
			reviewNote: "the to-do is private now",
		});
		// Nobody but the item's author sees it any more, open or closed.
		for (const u of [U.owner, U.sue, U.viewer])
			expect(
				JSON.stringify(await call(listProposals, u, { tripId: t.tripId })),
			).not.toMatch(/Gift idea X|Montblanc/);
		const activity = await call<{ summary: string }[]>(listActivity, U.owner, {
			tripId: t.tripId,
		});
		expect(JSON.stringify(activity)).not.toMatch(/Gift idea X|Montblanc/);
	});

	it("a cover hidden from guests isn't in their graph (SEC-R1-12)", async () => {
		const t = await freshTrip();
		const att = randomUUID();
		await getDb().execute(sql`
			insert into attachments (id, trip_id, kind, status, visibility, position, created_by)
			values (${att}, ${t.tripId}, 'photo', 'ready', 'members', 'a0', ${U.owner.id})`);
		await getDb().execute(
			sql`update trips set cover_attachment_id = ${att} where id = ${t.tripId}`,
		);
		const coverOf = async (u: AuthUser) =>
			(
				await call<Awaited<ReturnType<typeof getTripGraph>>>(getTripGraph, u, {
					tripId: t.tripId,
				})
			).trip.coverAttachmentId;
		expect(await coverOf(U.owner)).toBe(att);
		expect(await coverOf(U.guestViewer)).toBeNull();
		expect(await coverOf(U.guestEditor)).toBeNull();
		await getDb().execute(
			sql`update attachments set visibility = 'everyone' where id = ${att}`,
		);
		expect(await coverOf(U.guestViewer)).toBe(att);
	});

	it("a guest's activity is always marked, and a guest can't take a member's name (SEC-R1-04)", async () => {
		const t = await freshTrip();
		const { renameGuest } = await import("@/lib/auth/share.functions");
		for (const name of ["Dennis Owner", "dennis", "Maya Editor"])
			expect(await codeOf(call(renameGuest, U.guestEditor, { name }))).toBe(
				"VALIDATION",
			);
		await call(moveItem, U.guestEditor, {
			itemId: t.ids.items.itoya,
			dayId: t.ids.days.d2,
		});
		await call(moveItem, U.owner, {
			itemId: t.ids.items.itoya,
			dayId: t.ids.days.d3,
		});
		// The anonymous user going away keeps the mark (it's written with the row).
		const rows = await call<
			{ actorName: string; actorIsGuest: boolean; summary: string }[]
		>(listActivity, U.owner, { tripId: t.tripId, limit: 5 });
		const [mine, guest] = rows;
		expect(mine?.actorIsGuest).toBe(false);
		expect(mine?.actorName).toBe("Dennis Owner");
		expect(guest?.actorIsGuest).toBe(true);
		expect(guest?.actorName).toBe("Guest Wren (guest)");
		const meta = await getDb().execute(sql`
			select meta->>'guest' as g from activity_log
			 where trip_id = ${t.tripId} and actor_user_id = ${U.guestEditor.id}`);
		expect((meta.rows[0] as { g: string }).g).toBe("true");
	});

	it("suggestions about a hidden attachment never reach link guests, who can't resolve them (CONTENT-01)", async () => {
		const t = await freshTrip();
		const att = randomUUID();
		await getDb().execute(sql`
			insert into attachments (id, trip_id, item_id, kind, status, visibility, title, caption, position, created_by)
			values (${att}, ${t.tripId}, ${t.ids.items.itoya}, 'pdf', 'ready', 'members',
			        'QA flight NH 9.pdf', 'PNR ZK4P7Q — Dennis 8D', 'a0', ${U.owner.id})`);
		const { updateAttachment, deleteAttachment } = await import(
			"@/features/media/media.functions"
		);
		const upd = await call<P>(updateAttachment, U.sue, {
			id: att,
			caption: "SECRETREF XJ4K2Q seat 8G",
		});
		const del = await call<P>(deleteAttachment, U.sue, { id: att });
		const ids = [upd.proposed.id, del.proposed.id];
		// Members (the reviewers) see both.
		const owner = await proposalsOf(U.owner, t.tripId);
		expect(owner.filter((p) => ids.includes(p.id))).toHaveLength(2);
		// No guest learns anything: not the file, not either caption.
		for (const g of [U.guestEditor, U.guestSuggester]) {
			const seen = JSON.stringify(await proposalsOf(g, t.tripId));
			expect(seen).not.toContain("SECRETREF");
			expect(seen).not.toContain("ZK4P7Q");
			expect(seen).not.toContain("NH 9");
		}
		// The guest editor can't accept or reject it, and leaves no trace.
		for (const decision of ["accept", "reject"] as const)
			expect(
				await codeOf(
					call(resolveProposal, U.guestEditor, {
						proposalId: upd.proposed.id,
						decision,
					}),
				),
			).toBe("NOT_FOUND");
		const batch = await call<Record<string, { ok: boolean }>>(
			resolveProposals,
			U.guestEditor,
			{ ids, decision: "accept" },
		);
		expect(Object.values(batch).every((r) => !r.ok)).toBe(true);
		for (const id of ids) {
			const row = await rowOf(id);
			expect(row.status).toBe("open");
			expect(row.lastError).toBeNull();
		}
		// Hiding an everyone-visible attachment later hides its suggestions too.
		await getDb().execute(
			sql`update attachments set visibility = 'everyone' where id = ${att}`,
		);
		expect(
			(await proposalsOf(U.guestEditor, t.tripId)).filter((p) =>
				ids.includes(p.id),
			),
		).toHaveLength(2);
	});
});

describe("job wiring (money, climate)", () => {
	const jobsOf = async (queue: "money" | "climate") =>
		(await getQueue(queue).getJobs(["waiting", "delayed", "prioritized"])).map(
			(j) => ({ name: j.name, data: j.data as Record<string, unknown> }),
		);

	it("a city with coordinates queues its climate cell once; a dry run queues nothing", async () => {
		const t = await freshTrip();
		// A suggester's proposal runs the core in a dry run: its jobs are dropped.
		await call<P>(createNode, U.sue, {
			tripId: t.tripId,
			parentId: t.ids.nodes.japan,
			type: "city",
			name: "Nara",
			lat: 34.6851,
			lng: 135.8048,
		});
		expect(
			(await jobsOf("climate")).filter((j) => j.data.cell === "34.75,135.75"),
		).toEqual([]);
		for (const name of ["Nara", "Nara-machi"])
			await call(createNode, U.owner, {
				tripId: t.tripId,
				parentId: t.ids.nodes.japan,
				type: "city",
				name,
				lat: 34.6851,
				lng: 135.8048,
			});
		const nara = (await jobsOf("climate")).filter(
			(j) => j.data.cell === "34.75,135.75",
		);
		expect(nara).toEqual([
			{
				name: "climate.cell",
				data: { cell: "34.75,135.75", tripId: t.tripId },
			},
		]);
	});

	it("a new home currency queues money.fxRehome for the trip", async () => {
		const t = await freshTrip();
		await call(updateTrip, U.owner, {
			tripId: t.tripId,
			settings: { currency: "CAD" },
		});
		expect(
			(await jobsOf("money")).some(
				(j) => j.name === "money.fxRehome" && j.data.tripId === t.tripId,
			),
		).toBe(true);
	});

	it("a link guest can't change the home currency; nobody sets an unsupported one (SEC-R1-02)", async () => {
		const t = await freshTrip();
		const currency = async () =>
			(
				(
					await getDb().execute(
						sql`select coalesce(settings->>'currency', 'USD') as c from trips where id = ${t.tripId}`,
					)
				).rows[0] as { c: string }
			).c;
		const before = await currency();
		expect(
			await codeOf(
				call(updateTrip, U.guestEditor, {
					tripId: t.tripId,
					settings: { currency: before === "VND" ? "JPY" : "VND" },
				}),
			),
		).toBe("FORBIDDEN");
		// Other settings (with the unchanged currency along) still save.
		expect(
			await codeOf(
				call(updateTrip, U.guestEditor, {
					tripId: t.tripId,
					settings: { currency: before, defaultDayStart: "08:30" },
				}),
			),
		).toBe("ok");
		expect(
			await codeOf(
				call(updateTrip, U.owner, {
					tripId: t.tripId,
					settings: { currency: "ZZZ" },
				}),
			),
		).toBe("VALIDATION");
		expect(await currency()).toBe(before);
	});
});

describe("test fixture options (WP-Suggest T1)", () => {
	it("clones with Maya as a suggester and her demo suggestions proposed for real", async () => {
		const mayaId = randomUUID();
		await getDb().insert(user).values({
			id: mayaId,
			email: "maya@example.com",
			emailVerified: true,
			name: "Maya Chen",
			firstName: "Maya",
			lastName: "Chen",
			isAnonymous: false,
		});
		try {
			const c = await cloneDemoTrip(getDb(), U.owner.id, {
				mayaRole: "suggester",
				proposals: true,
			});
			const role = await getDb().execute(sql`
				select role::text as role from trip_members where id = ${c.members.maya}`);
			expect(role.rows[0]).toEqual({ role: "suggester" });
			expect(c.proposals?.ids.length).toBeGreaterThanOrEqual(4);
			// The guest's flight and Audrey's stacked move have no account here.
			expect(c.proposals?.skipped.map((s) => s.op).sort()).toEqual([
				"flight.save",
				"item.move",
			]);
			const open = (await proposalsOf(U.owner, c.tripId)).filter(
				(p) => p.status === "open",
			);
			expect(open.map((p) => p.id).sort()).toEqual(
				[...(c.proposals?.ids ?? [])].sort(),
			);
			expect(new Set(open.map((p) => p.author.name))).toEqual(
				new Set(["Maya Chen"]),
			);
			// The node.create ghost got a fresh id of this clone.
			const create = open.find((p) => p.op === "node.create");
			expect(create?.entityId).toBeTruthy();
			expect(create?.entityId).not.toBe(c.ids.nodes.kyoto);
		} finally {
			await getDb().execute(sql`delete from "user" where id = ${mayaId}`);
		}
	});
});

/**
 * WP-Money server functions against real Postgres and Redis (EXTENSIONS §8.6
 * QA MONEY-*): the permission matrix, privacy, splits and payments, FX per
 * paid date (the rates source is stubbed), settlements with `net_after`,
 * edits after a settlement, budgets (default + override, notice, private),
 * a home-currency change, and the CSV.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_money_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-moneytest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	process.env.FX_URL =
		"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1";
	process.env.FX_FALLBACK_URL = "https://latest.currency-api.pages.dev/v1";
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
import { listActivity } from "@/functions/graph.functions";
import { updateTrip } from "@/functions/trips.functions";
import { balances } from "@/lib/engine/money";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import {
	cloneDemoTrip,
	type FixtureClone,
	joinTestLink,
} from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { retireMember } from "@/server/members.server";
import { withTripTx } from "@/server/tx.server";
import {
	createExpense,
	createSettlement,
	deleteBudgetLine,
	deleteExpense,
	deleteSettlement,
	exportMoneyCsv,
	listMoney,
	type MoneyDto,
	markExpensePaid,
	restoreExpense,
	setBudgetLine,
	setBudgetPrivate,
	setExpenseRate,
	updateExpense,
} from "../money.functions";
import { _resetFxMemo, fxDaily, fxRehome } from "../server/fx.server";
import { balanceEdits, balanceSinceSettlement } from "../server/money.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// ---- a stubbed currency-api: JPY 150 per USD, except 140 on 2026-06-01 ----
const JPY_ON: Record<string, number> = { "2026-06-01": 140 };
let fxCalls = 0;
vi.stubGlobal(
	"fetch",
	vi.fn(async (input: string | URL) => {
		const url = String(input);
		fxCalls += 1;
		const m =
			url.match(/@(\d{4}-\d{2}-\d{2})\//) ??
			url.match(/\/\/(\d{4}-\d{2}-\d{2})\./);
		const date = m?.[1] ?? new Date().toISOString().slice(0, 10);
		const body = {
			date,
			usd: {
				usd: 1,
				jpy: JPY_ON[date] ?? 150,
				cad: 1.4,
				krw: 1400,
				vnd: 25_000,
				twd: 32,
				try: 40,
				eur: 0.9,
				gbp: 0.8,
				aud: 1.5,
				chf: 0.88,
				cny: 7.1,
				btc: 0.00001,
			},
		};
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}),
);

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
	"owner" | "maya" | "viewer" | "suggester" | "stranger" | "guestEditor",
	AuthUser
>;
type Trip = FixtureClone & { viewerMember: string; suggesterMember: string };

async function freshTrip(): Promise<Trip> {
	const c = await cloneDemoTrip(getDb(), U.owner.id);
	const [v] = await getDb()
		.insert(tripMembers)
		.values({
			tripId: c.tripId,
			userId: U.viewer.id,
			status: "active",
			role: "viewer",
			color: 5,
		})
		.returning({ id: tripMembers.id });
	const [s] = await getDb()
		.insert(tripMembers)
		.values({
			tripId: c.tripId,
			userId: U.suggester.id,
			status: "active",
			role: "suggester",
			color: 6,
		})
		.returning({ id: tripMembers.id });
	await joinTestLink(getDb(), c, U.guestEditor.id, "editor");
	return {
		...c,
		viewerMember: v?.id as string,
		suggesterMember: s?.id as string,
	};
}

const NOW = new Date().toISOString();
async function activityVerbs(tripId: string): Promise<string[]> {
	const res = await getDb().execute(
		sql`select verb from activity_log where trip_id = ${tripId}`,
	);
	return (res.rows as { verb: string }[]).map((r) => r.verb);
}
const TZ = "Asia/Tokyo";
const money = (t: Trip, u: AuthUser = U.owner) =>
	call<MoneyDto>(listMoney, u, { tripId: t.tripId });
const one = async (t: Trip, id: string, u: AuthUser = U.owner) =>
	(await money(t, u)).expenses.find((e) => e.id === id);
const pay = (
	amountMinor: number,
	memberId: string,
	paidAt = NOW,
	currency = "JPY",
) => ({
	paidAt,
	paidTz: TZ,
	currency,
	amountMinor,
	payers: [{ memberId, amountMinor }],
});

beforeAll(async () => {
	await ensureDatabase(scratchUrl);
	await migrateDatabase(scratchUrl);
	U.owner = await newUser({ first: "Dev", last: "Owner" });
	U.maya = await newUser({ first: "Maya", last: "Chen" }, "maya@example.com");
	U.viewer = await newUser({ first: "Vic", last: "Viewer" });
	U.suggester = await newUser({ first: "Sue", last: "Suggester" });
	U.stranger = await newUser({ first: "Sam", last: "Stranger" });
	U.guestEditor = await newUser(null);
});

beforeEach(() => {
	_resetFxMemo();
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
	vi.unstubAllGlobals();
});

describe("access (MONEY-04, MONEY-05, MONEY-10)", () => {
	it("members read; guests get 403 and strangers 404; viewers can't write; suggesters write directly", async () => {
		const t = await freshTrip();
		expect(await codeOf(money(t, U.maya))).toBe("ok");
		expect(await codeOf(money(t, U.viewer))).toBe("ok");
		expect(await codeOf(money(t, U.guestEditor))).toBe("FORBIDDEN");
		expect(await codeOf(money(t, U.stranger))).toBe("NOT_FOUND");
		const input = {
			tripId: t.tripId,
			target: { kind: "trip" },
			amountMinor: 3000,
			currency: "JPY",
		};
		expect(await codeOf(call(createExpense, U.viewer, input))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(createExpense, U.guestEditor, input))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(createExpense, U.stranger, input))).toBe(
			"NOT_FOUND",
		);
		const r = await call<{ id: string }>(createExpense, U.suggester, input);
		expect((await one(t, r.id))?.title).toBe("Fees & other");
		expect(
			await codeOf(call(exportMoneyCsv, U.guestEditor, { tripId: t.tripId })),
		).toBe("FORBIDDEN");
	});

	it("MONEY-05: a guest's activity has no money rows; a member's has them without amounts", async () => {
		const t = await freshTrip();
		await call(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Ramen Ichiran",
			amountMinor: 4200,
			currency: "JPY",
		});
		type Row = { summary: string };
		const mine = await call<Row[]>(listActivity, U.maya, { tripId: t.tripId });
		const row = mine.find((r) => r.summary.startsWith("added an expense"));
		expect(row?.summary).toBe("added an expense: Ramen Ichiran");
		expect(row?.summary).not.toMatch(/4200|4,200|¥/);
		const guest = await call<Row[]>(listActivity, U.guestEditor, {
			tripId: t.tripId,
		});
		expect(guest.length).toBeGreaterThanOrEqual(0);
		expect(guest.some((r) => r.summary.includes("expense"))).toBe(false);
		const verbs = await activityVerbs(t.tripId);
		expect(verbs).toContain("expense.add");
	});
});

describe("expenses", () => {
	it("MONEY-01: an equal ¥ split over everyone, remainder to the payer, converted at home", async () => {
		const t = await freshTrip();
		const r = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "item", itemId: t.ids.items.kiyomizu },
			amountMinor: 1000,
			currency: "JPY",
			payments: [pay(1000, t.members.owner)],
		});
		const e = await one(t, r.id);
		expect(e?.title).toBe("Kiyomizu-dera");
		expect(e?.category).toBe("activities");
		expect(e?.status).toBe("paid");
		expect(e?.homeCurrency).toBe("USD");
		expect(e?.homeAmountMinor).toBe(667);
		expect(e?.payments[0]?.homeAmountMinor).toBe(667);
		// Default split: every person on the trip (owner, Maya, Audrey, viewer, suggester).
		expect(e?.shares.length).toBe(5);
		const d = await money(t);
		const net = balances(d.expenses, d.settlements);
		expect(Object.values(net).reduce((a, b) => a + b, 0)).toBe(0);
		expect(net[t.members.owner]).toBe(667 - 134);
	});

	it("defaults the split to the people tagged on the item", async () => {
		const t = await freshTrip();
		await getDb().execute(sql`
			insert into item_assignees (trip_id, item_id, member_id)
			values (${t.tripId}, ${t.ids.items.hands}, ${t.members.owner}), (${t.tripId}, ${t.ids.items.hands}, ${t.members.audrey})`);
		const r = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "item", itemId: t.ids.items.hands },
			amountMinor: 2000,
			currency: "JPY",
		});
		const e = await one(t, r.id);
		expect(e?.shares.map((s) => s.memberId).sort()).toEqual(
			[t.members.owner, t.members.audrey].sort(),
		);
		expect(e?.category).toBe("shopping");
		expect(e?.status).toBe("planned");
	});

	it("validates sums, members and signs with readable messages", async () => {
		const t = await freshTrip();
		const base = {
			tripId: t.tripId,
			target: { kind: "trip" },
			currency: "JPY",
		};
		const err = async (data: unknown) => {
			try {
				await call(createExpense, U.owner, data);
				return "ok";
			} catch (e) {
				return (e as Error).message;
			}
		};
		expect(
			await err({
				...base,
				amountMinor: 3000,
				split: {
					mode: "exact",
					shares: [{ memberId: t.members.owner, amountMinor: 1000 }],
				},
			}),
		).toMatch(/Exact amounts must add up/);
		expect(
			await err({
				...base,
				amountMinor: 3000,
				payments: [
					{
						...pay(3000, t.members.owner),
						payers: [{ memberId: t.members.owner, amountMinor: 2000 }],
					},
				],
			}),
		).toMatch(/Payers must add up/);
		expect(await err({ ...base, amountMinor: -300 })).toMatch(
			/Only a refund can be negative/,
		);
		expect(
			await err({
				...base,
				amountMinor: 3000,
				split: { mode: "equal", shares: [{ memberId: randomUUID() }] },
			}),
		).toMatch(/isn't on the trip/);
		const other = await freshTrip();
		expect(
			await codeOf(
				call(createExpense, U.owner, {
					...base,
					amountMinor: 1,
					target: { kind: "node", nodeId: other.ids.nodes.tokyo },
				}),
			),
		).toBe("NOT_FOUND");
	});

	it("MONEY-13 + MONEY-14: two payers pool an itemized bill with a 10% service charge", async () => {
		const t = await freshTrip();
		const O = t.members.owner;
		const A = t.members.audrey;
		const r = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Izakaya",
			amountMinor: 2860,
			currency: "JPY",
			lines: [
				{ label: "Ramen", amountMinor: 1200, memberIds: [O] },
				{ label: "Gyoza", amountMinor: 600, memberIds: [O, A] },
				{ label: "Beer", amountMinor: 800, memberIds: [A] },
			],
			fees: [{ label: "Service", kind: "percent", percent: 10 }],
			payments: [
				{
					paidAt: NOW,
					paidTz: TZ,
					currency: "JPY",
					amountMinor: 2860,
					payers: [
						{ memberId: O, amountMinor: 2000 },
						{ memberId: A, amountMinor: 860 },
					],
				},
			],
		});
		const e = await one(t, r.id);
		expect(e?.lines).toHaveLength(3);
		expect(e?.fees[0]?.percent).toBe(10);
		expect(e?.payments[0]?.payers).toHaveLength(2);
		const d = await money(t);
		const net = balances(d.expenses, d.settlements);
		// Home 2860 ¥ → $19.07; owner owes 1650/2860, Audrey 1210/2860 of it.
		expect((net[O] ?? 0) + (net[A] ?? 0)).toBe(0);
		expect(net[O]).toBeGreaterThan(0);
		expect(
			await codeOf(
				call(createExpense, U.owner, {
					tripId: t.tripId,
					target: { kind: "trip" },
					amountMinor: 3000,
					currency: "JPY",
					lines: [{ label: "Ramen", amountMinor: 1200, memberIds: [O] }],
				}),
			),
		).toBe("VALIDATION");
	});

	it("MONEY-16: a deposit then the rest, each at its own date ('¥10k of ¥60k' in between)", async () => {
		const t = await freshTrip();
		const r = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "day", dayId: t.ids.days.d3 },
			title: "Kawaguchiko Ryokan",
			category: "lodging",
			amountMinor: 60_000,
			currency: "JPY",
			payments: [pay(10_000, t.members.audrey, "2026-06-01T12:00:00+09:00")],
		});
		let e = await one(t, r.id);
		expect(e?.status).toBe("partial");
		expect(e?.payments[0]?.homeAmountMinor).toBe(7143); // ¥10k at 140
		expect(e?.payments[0]?.fxDate).toBe("2026-06-01");
		await call(markExpensePaid, U.owner, { id: r.id });
		e = await one(t, r.id);
		expect(e?.status).toBe("paid");
		expect(e?.payments).toHaveLength(2);
		expect(e?.payments[1]?.amountMinor).toBe(50_000);
		expect(e?.payments[1]?.homeAmountMinor).toBe(33_333); // ¥50k at 150
		expect(e?.payments[1]?.payers).toEqual([
			{ memberId: t.members.owner, amountMinor: 50_000 },
		]);
		expect(await codeOf(call(markExpensePaid, U.owner, { id: r.id }))).toBe(
			"VALIDATION",
		);
	});

	it("MONEY-15: a refund splits back in the original's proportions", async () => {
		const t = await freshTrip();
		const O = t.members.owner;
		const A = t.members.audrey;
		const orig = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Tickets",
			amountMinor: 3000,
			currency: "JPY",
			split: {
				mode: "exact",
				shares: [
					{ memberId: O, amountMinor: 2000 },
					{ memberId: A, amountMinor: 1000 },
				],
			},
			payments: [pay(3000, O)],
		});
		const ref = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			refundOfId: orig.id,
			amountMinor: -600,
			currency: "JPY",
			payments: [pay(-600, O)],
		});
		const e = await one(t, ref.id);
		// Named after the original, not its place or category (QA MONEY-QA-11).
		expect(e?.title).toBe("Refund · Tickets");
		expect(e?.splitMode).toBe("exact");
		expect(
			Object.fromEntries(
				e?.shares.map((s) => [s.memberId, s.amountMinor]) ?? [],
			),
		).toEqual({
			[O]: -400,
			[A]: -200,
		});
		expect(
			await codeOf(
				call(createExpense, U.owner, {
					tripId: t.tripId,
					target: { kind: "trip" },
					refundOfId: ref.id,
					amountMinor: -1,
					currency: "JPY",
				}),
			),
		).toBe("VALIDATION");
	});

	it("MONEY-12: a private expense is invisible to Maya, off balances and activity; its leg's deletion leaves it trip-wide", async () => {
		const t = await freshTrip();
		const r = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "leg", legId: t.ids.legs.fuji },
			title: "Fountain pen (gift)",
			amountMinor: 18_000,
			currency: "JPY",
			isPrivate: true,
			payments: [pay(18_000, t.members.owner)],
		});
		expect((await one(t, r.id))?.isPrivate).toBe(true);
		expect(await one(t, r.id, U.maya)).toBeUndefined();
		const d = await money(t);
		expect(
			Object.values(balances(d.expenses, d.settlements)).every((v) => v === 0),
		).toBe(true);
		expect(
			(await activityVerbs(t.tripId)).some((v) => v.startsWith("expense.")),
		).toBe(false);
		expect(
			await codeOf(
				call(updateExpense, U.maya, { id: r.id, patch: { title: "x" } }),
			),
		).toBe("NOT_FOUND");
		expect(await codeOf(call(deleteExpense, U.maya, { id: r.id }))).toBe(
			"NOT_FOUND",
		);
		// Someone else can't be the payer of my private expense.
		expect(
			await codeOf(
				call(createExpense, U.owner, {
					tripId: t.tripId,
					target: { kind: "trip" },
					amountMinor: 100,
					currency: "JPY",
					isPrivate: true,
					payments: [pay(100, t.members.audrey)],
				}),
			),
		).toBe("VALIDATION");
		await getDb().execute(sql`delete from legs where id = ${t.ids.legs.fuji}`);
		expect((await one(t, r.id))?.target).toEqual({ kind: "trip" });
	});

	it("gift privacy: an expense from a private list item starts private", async () => {
		const t = await freshTrip();
		const [li] = (
			await getDb().execute(sql`
			insert into list_items (id, trip_id, list, text, position, is_private, created_by)
			values (${randomUUID()}, ${t.tripId}, 'shopping', 'Pen for Audrey', 'a0', true, ${U.owner.id}) returning id::text as id`)
		).rows as { id: string }[];
		const r = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			amountMinor: 5000,
			currency: "JPY",
			listItemId: li?.id,
		});
		const e = await one(t, r.id);
		expect(e?.isPrivate).toBe(true);
		expect(e?.listItemId).toBe(li?.id);
		expect(
			await codeOf(
				call(createExpense, U.maya, {
					tripId: t.tripId,
					target: { kind: "trip" },
					amountMinor: 5000,
					currency: "JPY",
					listItemId: li?.id,
				}),
			),
		).toBe("NOT_FOUND");
	});

	it("updates (payments replace the list; ids kept), deletes and restores", async () => {
		const t = await freshTrip();
		const r = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Taxi",
			amountMinor: 3000,
			currency: "JPY",
			payments: [pay(3000, t.members.owner)],
		});
		const e0 = await one(t, r.id);
		const pid = e0?.payments[0]?.id as string;
		const up = await call<{ updatedAt: string }>(updateExpense, U.maya, {
			id: r.id,
			patch: {
				title: "Taxi to Haneda",
				amountMinor: 4500,
				payments: [{ ...pay(4500, t.members.owner), id: pid }],
			},
			expectedUpdatedAt: e0?.updatedAt,
		});
		const e1 = await one(t, r.id);
		expect(e1?.title).toBe("Taxi to Haneda");
		expect(e1?.payments.map((p) => p.id)).toEqual([pid]);
		expect(e1?.updatedAt).toBe(up.updatedAt);
		expect(
			await codeOf(
				call(updateExpense, U.owner, {
					id: r.id,
					patch: { title: "x" },
					expectedUpdatedAt: e0?.updatedAt,
				}),
			),
		).toBe("CONFLICT");
		expect(
			await codeOf(
				call(updateExpense, U.owner, { id: r.id, patch: { nope: 1 } }),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(
				call(updateExpense, U.viewer, { id: r.id, patch: { title: "x" } }),
			),
		).toBe("FORBIDDEN");
		const del = await call<{ deletedAt: string }>(deleteExpense, U.owner, {
			id: r.id,
		});
		expect(del.deletedAt).toBeTruthy();
		expect(await one(t, r.id)).toBeUndefined();
		await call(restoreExpense, U.owner, { id: r.id });
		expect((await one(t, r.id))?.title).toBe("Taxi to Haneda");
	});
});

describe("FX", () => {
	it("MONEY-07: a manual rate survives the daily job; null goes back to the source", async () => {
		const t = await freshTrip();
		const r = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			amountMinor: 15_000,
			currency: "JPY",
			payments: [pay(15_000, t.members.owner)],
		});
		const pid = (await one(t, r.id))?.payments[0]?.id as string;
		await call(setExpenseRate, U.owner, {
			id: r.id,
			paymentId: pid,
			rate: 0.0065,
		});
		await call(setExpenseRate, U.owner, { id: r.id, rate: 0.0065 });
		let e = await one(t, r.id);
		expect(e?.payments[0]?.fxManual).toBe(true);
		expect(e?.payments[0]?.homeAmountMinor).toBe(9750);
		expect(e?.fxManual).toBe(true);
		await fxDaily();
		e = await one(t, r.id);
		expect(e?.payments[0]?.homeAmountMinor).toBe(9750);
		expect(e?.homeAmountMinor).toBe(9750);
		await call(setExpenseRate, U.owner, {
			id: r.id,
			paymentId: pid,
			rate: null,
		});
		// Without its own rate the payment follows the cost's manual rate…
		e = await one(t, r.id);
		expect(e?.payments[0]?.homeAmountMinor).toBe(9750);
		// …and back to the source's rate once the cost's rate is cleared too.
		await call(setExpenseRate, U.owner, { id: r.id, rate: null });
		e = await one(t, r.id);
		expect(e?.fxManual).toBe(false);
		expect(e?.payments[0]?.fxManual).toBe(false);
		expect(e?.payments[0]?.homeAmountMinor).toBe(10_000);
		expect(fxCalls).toBeGreaterThan(0);
	});

	it("MONEY-06: a home-currency change re-converts expenses, payments and settlements", async () => {
		const t = await freshTrip();
		const r = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			amountMinor: 15_000,
			currency: "JPY",
			payments: [pay(15_000, t.members.owner)],
		});
		await call(createSettlement, U.owner, {
			tripId: t.tripId,
			fromMemberId: t.members.audrey,
			toMemberId: t.members.owner,
			amountMinor: 1500,
			currency: "JPY",
			settledAt: NOW,
			settledTz: TZ,
		});
		await call(updateTrip, U.owner, {
			tripId: t.tripId,
			settings: { currency: "CAD" },
		});
		// Before the job runs, reads already show CAD (converted for display).
		let d = await money(t);
		expect(d.homeCurrency).toBe("CAD");
		expect(d.expenses[0]?.homeCurrency).toBe("CAD");
		expect(d.expenses[0]?.homeAmountMinor).toBe(14_000);
		await fxRehome(t.tripId);
		d = await money(t);
		const e = d.expenses.find((x) => x.id === r.id);
		expect(e?.homeAmountMinor).toBe(14_000);
		expect(e?.payments[0]?.homeAmountMinor).toBe(14_000);
		expect(d.settlements[0]?.homeCurrency).toBe("CAD");
		expect(d.settlements[0]?.homeAmountMinor).toBe(1400);
		const [row] = (
			await getDb().execute(
				sql`select home_currency from expense_payments where expense_id = ${r.id}`,
			)
		).rows as { home_currency: string }[];
		expect(row?.home_currency).toBe("CAD");
	});
});

describe("settlements (MONEY-03, MONEY-11, MONEY-21)", () => {
	it("settle-up transfers zero the balances, net_after is stored, and later edits are flagged", async () => {
		const t = await freshTrip();
		const O = t.members.owner;
		const M = t.members.maya as string;
		const r = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Ramen Ichiran",
			amountMinor: 3000,
			currency: "JPY",
			split: { mode: "equal", shares: [{ memberId: O }, { memberId: M }] },
			payments: [pay(3000, O)],
		});
		let d = await money(t);
		let net = balances(d.expenses, d.settlements);
		expect(net).toMatchObject({ [O]: 1000, [M]: -1000 });
		// MONEY-11: Maya pays ¥1,500 → $10.00 at 150.
		const s = await call<{ id: string }>(createSettlement, U.maya, {
			tripId: t.tripId,
			fromMemberId: M,
			toMemberId: O,
			amountMinor: 1500,
			currency: "JPY",
			settledAt: NOW,
			settledTz: TZ,
			method: "cash",
			scope: { nodeId: t.ids.nodes.kyoto },
		});
		d = await money(t);
		net = balances(d.expenses, d.settlements);
		expect(Math.abs(net[O] ?? 0)).toBeLessThanOrEqual(1);
		expect(Math.abs(net[M] ?? 0)).toBeLessThanOrEqual(1);
		const stored = d.settlements.find((x) => x.id === s.id);
		expect(stored?.scope).toEqual({ nodeId: t.ids.nodes.kyoto });
		expect(stored?.netAfter?.[O]).toBe(net[O]);
		// MONEY-21: Maya edits the expense after the settlement; the owner sees why.
		await call(updateExpense, U.maya, {
			id: r.id,
			patch: { amountMinor: 3600, payments: [pay(3600, O)] },
		});
		d = await money(t);
		expect(d.recentEdits?.[0]).toMatchObject({
			actorName: "Maya Chen",
			verb: "expense.update",
			title: "Ramen Ichiran",
		});
		const since = await balanceSinceSettlement(getDb(), t.tripId, O);
		expect(since.afterMinor).toBe(stored?.netAfter?.[O]);
		expect(since.netMinor - (since.afterMinor ?? 0)).toBe(200);
		expect(await codeOf(call(deleteSettlement, U.viewer, { id: s.id }))).toBe(
			"FORBIDDEN",
		);
		await call(deleteSettlement, U.owner, { id: s.id });
		expect((await money(t)).settlements).toHaveLength(0);
		expect(
			await codeOf(
				call(createSettlement, U.owner, {
					tripId: t.tripId,
					fromMemberId: O,
					toMemberId: randomUUID(),
					amountMinor: 1,
					currency: "USD",
					settledAt: NOW,
					settledTz: TZ,
				}),
			),
		).toBe("VALIDATION");
	});

	it("MONEY-09: a retired member keeps their money rows as a former member", async () => {
		const t = await freshTrip();
		const M = t.members.maya as string;
		await call(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			amountMinor: 3000,
			currency: "JPY",
			split: {
				mode: "equal",
				shares: [{ memberId: t.members.owner }, { memberId: M }],
			},
			payments: [pay(3000, M)],
		});
		await withTripTx(t.tripId, (tx, out) => retireMember(tx, out, t.tripId, M));
		const d = await money(t);
		const e = d.expenses[0];
		expect(e?.payments[0]?.payers[0]?.memberId).toBe(M);
		expect(balances(d.expenses, d.settlements)[M]).toBeGreaterThan(0);
		// The expense stays editable, and the former member can still be settled with.
		await call(updateExpense, U.owner, {
			id: e?.id,
			patch: { title: "Dinner (Maya paid)" },
		});
		expect((await money(t)).expenses[0]?.title).toBe("Dinner (Maya paid)");
		await call(createSettlement, U.owner, {
			tripId: t.tripId,
			fromMemberId: t.members.owner,
			toMemberId: M,
			amountMinor: 1500,
			currency: "JPY",
			settledAt: NOW,
			settledTz: TZ,
		});
		// …but a retired member can't be added to a new expense.
		expect(
			await codeOf(
				call(createExpense, U.owner, {
					tripId: t.tripId,
					target: { kind: "trip" },
					amountMinor: 100,
					currency: "JPY",
					split: { mode: "equal", shares: [{ memberId: M }] },
				}),
			),
		).toBe("VALIDATION");
	});
});

describe("budgets (MONEY-17)", () => {
	it("trip default + own override, the notice after a default change, and visibility", async () => {
		const t = await freshTrip();
		const def = await call<{ id: string }>(setBudgetLine, U.owner, {
			tripId: t.tripId,
			nodeId: null,
			category: null,
			memberId: null,
			amountMinor: 350_000,
			kind: "total",
		});
		expect(
			await codeOf(
				call(setBudgetLine, U.suggester, {
					tripId: t.tripId,
					nodeId: null,
					category: null,
					memberId: null,
					amountMinor: 1,
					kind: "total",
				}),
			),
		).toBe("FORBIDDEN");
		expect(
			await codeOf(
				call(setBudgetLine, U.maya, {
					tripId: t.tripId,
					nodeId: null,
					category: null,
					memberId: t.members.owner,
					amountMinor: 1,
					kind: "total",
				}),
			),
		).toBe("FORBIDDEN");
		const mine = await call<{ id: string }>(setBudgetLine, U.maya, {
			tripId: t.tripId,
			nodeId: null,
			category: null,
			memberId: t.members.maya,
			amountMinor: 300_000,
			kind: "total",
		});
		await call(setBudgetLine, U.suggester, {
			tripId: t.tripId,
			nodeId: t.ids.nodes.tokyo,
			category: "food_drink",
			memberId: t.suggesterMember,
			amountMinor: 5_000,
			kind: "per_day",
		});
		let d = await money(t, U.maya);
		const myLine = d.budgets.find((b) => b.id === mine.id);
		expect(myLine?.defaultSeenMinor).toBe(350_000);
		// The owner raises the default: Maya's line stays and her seen value doesn't move.
		await call(setBudgetLine, U.owner, {
			tripId: t.tripId,
			nodeId: null,
			category: null,
			memberId: null,
			amountMinor: 380_000,
			kind: "total",
		});
		d = await money(t, U.maya);
		expect(d.budgets.find((b) => b.id === def.id)?.amountMinor).toBe(380_000);
		expect(d.budgets.find((b) => b.id === mine.id)?.defaultSeenMinor).toBe(
			350_000,
		);
		expect(d.budgets).toHaveLength(3);
		// Private: others stop seeing Maya's lines and see "private".
		await call(setBudgetPrivate, U.maya, { tripId: t.tripId, private: true });
		const o = await money(t, U.owner);
		expect(o.budgets.some((b) => b.id === mine.id)).toBe(false);
		expect(o.privateBudgetMemberIds).toEqual([t.members.maya]);
		expect((await money(t, U.maya)).budgets.some((b) => b.id === mine.id)).toBe(
			true,
		);
		// "Follow default" = delete my line; nobody else can.
		expect(await codeOf(call(deleteBudgetLine, U.owner, { id: mine.id }))).toBe(
			"NOT_FOUND",
		);
		await call(deleteBudgetLine, U.maya, { id: mine.id });
		expect(
			await codeOf(call(deleteBudgetLine, U.suggester, { id: def.id })),
		).toBe("FORBIDDEN");
	});
});

describe("CSV (MONEY-20)", () => {
	it("exports the scope's rows with totals that match", async () => {
		const t = await freshTrip();
		await call(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "item", itemId: t.ids.items.kiyomizu },
			title: "=cmd|' /C calc'!A0",
			amountMinor: 1500,
			currency: "JPY",
			payments: [pay(1500, t.members.owner)],
		});
		await call(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "item", itemId: t.ids.items.hands },
			title: "Hands",
			amountMinor: 3000,
			currency: "JPY",
		});
		const kyoto = await call<{ filename: string; csv: string }>(
			exportMoneyCsv,
			U.maya,
			{
				tripId: t.tripId,
				nodeId: t.ids.nodes.kyoto,
				displayCurrency: "CAD",
			},
		);
		expect(kyoto.filename).toMatch(/-kyoto-money-\d{4}-\d{2}-\d{2}\.csv$/);
		expect(kyoto.csv).toContain("'=cmd|' /C calc'!A0");
		expect(kyoto.csv).not.toContain("Hands");
		expect(kyoto.csv).toContain("Total,,,,,,,10.00,10.00");
		expect(kyoto.csv).toContain("Net (≈ CAD)");
		const all = await call<{ csv: string }>(exportMoneyCsv, U.owner, {
			tripId: t.tripId,
		});
		expect(all.csv).toContain("Hands");
		// + the open Petty knife (~¥12,000) from the shopping list, as in the tab.
		expect(all.csv).toContain("Petty knife");
		expect(all.csv).toContain("Total,,,,,,,110.00,10.00");
	});
});

describe("QA round 1 fixes", () => {
	it("MONEY-QA-01: a refund's amount can be edited; its split follows the original again", async () => {
		const t = await freshTrip();
		const O = t.members.owner;
		const A = t.members.audrey;
		const orig = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "node", nodeId: t.ids.nodes.kyoto },
			title: "Kaiseki",
			amountMinor: 6600,
			currency: "JPY",
			split: { mode: "equal", shares: [{ memberId: O }, { memberId: A }] },
			payments: [pay(6600, O)],
		});
		const ref = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "node", nodeId: t.ids.nodes.kyoto },
			refundOfId: orig.id,
			amountMinor: -660,
			currency: "JPY",
			payments: [pay(-660, O)],
		});
		const before = await one(t, ref.id);
		expect(before?.title).toBe("Refund · Kaiseki");
		// The editor's patch: no split (it follows the original).
		await call(updateExpense, U.owner, {
			id: ref.id,
			patch: {
				amountMinor: -1320,
				currency: "JPY",
				payments: [{ ...pay(-1320, O), id: before?.payments[0]?.id }],
			},
		});
		const e = await one(t, ref.id);
		expect(e?.amountMinor).toBe(-1320);
		expect(e?.title).toBe("Refund · Kaiseki");
		expect(
			Object.fromEntries(
				e?.shares.map((s) => [s.memberId, s.amountMinor]) ?? [],
			),
		).toEqual({ [O]: -660, [A]: -660 });
		// Still refused: a positive refund.
		expect(
			await codeOf(
				call(updateExpense, U.owner, {
					id: ref.id,
					patch: { amountMinor: 500, currency: "JPY", payments: [] },
				}),
			),
		).toBe("VALIDATION");
	});

	it("MONEY-QA-03: the cost's manual rate converts what was paid; balances use it", async () => {
		const t = await freshTrip();
		const O = t.members.owner;
		const A = t.members.audrey;
		// New paid expense with "Your rate" (the editor sends it on the cost).
		const r = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Card at my bank's rate",
			amountMinor: 10_000,
			currency: "JPY",
			fxRate: 0.01,
			split: { mode: "equal", shares: [{ memberId: O }, { memberId: A }] },
			payments: [pay(10_000, O)],
		});
		let e = await one(t, r.id);
		expect(e?.homeAmountMinor).toBe(10_000);
		expect(e?.payments[0]?.homeAmountMinor).toBe(10_000);
		expect(e?.status).toBe("paid");
		// An already-paid cost gets a rate later: its payment follows.
		const r2 = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			amountMinor: 3000,
			currency: "JPY",
			split: { mode: "equal", shares: [{ memberId: O }, { memberId: A }] },
			payments: [pay(3000, O)],
		});
		expect((await one(t, r2.id))?.payments[0]?.homeAmountMinor).toBe(2000);
		await call(setExpenseRate, U.owner, { id: r2.id, rate: 0.01 });
		e = await one(t, r2.id);
		expect(e?.homeAmountMinor).toBe(3000);
		expect(e?.payments[0]?.homeAmountMinor).toBe(3000);
		const d = await money(t);
		const net = balances(
			d.expenses.filter((x) => !x.isPrivate),
			d.settlements,
		);
		// Audrey owes half of $100 + half of $30 at my rates.
		expect(net[A]).toBe(-6500);
		// "Mark paid" on a cost with a manual rate uses it too.
		const r3 = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			amountMinor: 5000,
			currency: "JPY",
			fxRate: 0.01,
		});
		await call(markExpensePaid, U.owner, { id: r3.id });
		expect((await one(t, r3.id))?.payments[0]?.homeAmountMinor).toBe(5000);
	});

	it("MONEY-QA-09: an expense from a shopping item ticks the item off", async () => {
		const t = await freshTrip();
		const [knife] = (
			await getDb().execute(
				sql`select id::text as id from list_items where trip_id = ${t.tripId} and text = 'Petty knife'`,
			)
		).rows as { id: string }[];
		expect(knife).toBeTruthy();
		await call(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "node", nodeId: t.ids.nodes.knifeShop },
			title: "Petty knife",
			category: "shopping",
			amountMinor: 12_000,
			currency: "JPY",
			listItemId: knife?.id,
			taxFreePending: true,
			payments: [pay(12_000, t.members.owner)],
		});
		const [row] = (
			await getDb().execute(
				sql`select status::text as status, done_by from list_items where id = ${knife?.id}`,
			)
		).rows as { status: string; done_by: string | null }[];
		expect(row?.status).toBe("done");
		expect(row?.done_by).toBe(U.owner.id);
	});

	it("MONEY-QA-07: the CSV matches the tab: shopping costs in, private rows below the Total, Only + days", async () => {
		const t = await freshTrip();
		const O = t.members.owner;
		await call(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "node", nodeId: t.ids.nodes.tokyo },
			title: "Tokyo lunch",
			amountMinor: 3000,
			currency: "JPY",
			payments: [pay(3000, O)],
		});
		await call(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "node", nodeId: t.ids.nodes.kyoto },
			title: "Kyoto ryokan",
			amountMinor: 45_000,
			currency: "JPY",
		});
		await call(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "node", nodeId: t.ids.nodes.kyoto },
			title: "Secret gift",
			amountMinor: 7500,
			currency: "JPY",
			isPrivate: true,
		});
		const { csv } = await call<{ csv: string }>(exportMoneyCsv, U.owner, {
			tripId: t.tripId,
			nodeId: t.ids.nodes.japan,
		});
		const lines = csv.split("\r\n");
		// ¥3,000 + ¥45,000 + the knife's ~¥12,000 = $400.00 planned; $20.00 paid.
		expect(lines).toContain("Total,,,,,,,400.00,20.00");
		const total = lines.indexOf("Total,,,,,,,400.00,20.00");
		const knife = lines.findIndex((l) => l.includes("Petty knife"));
		expect(knife).toBeGreaterThan(0);
		expect(knife).toBeLessThan(total);
		expect(lines.findIndex((l) => l.includes("Secret gift"))).toBeGreaterThan(
			total,
		);
		expect(lines).toContain("Private total,,,,,,,50.00,0.00");
		// Maya never sees my private row.
		const maya = await call<{ csv: string }>(exportMoneyCsv, U.maya, {
			tripId: t.tripId,
			nodeId: t.ids.nodes.japan,
		});
		expect(maya.csv).not.toContain("Secret gift");
		// "Only Kyoto": Kyoto's own costs, nothing below it.
		const only = await call<{ csv: string }>(exportMoneyCsv, U.owner, {
			tripId: t.tripId,
			nodeId: t.ids.nodes.tokyo,
			only: true,
		});
		expect(only.csv).toContain("Tokyo lunch");
		expect(only.csv).not.toContain("Petty knife");
		// A day range: trip-wide and undated node costs drop out.
		const days = await call<{ csv: string }>(exportMoneyCsv, U.owner, {
			tripId: t.tripId,
			days: { from: "2000-01-01", to: "2000-01-02" },
		});
		expect(days.csv).toContain("Total,,,,,,,0.00,0.00");
	});

	it("MONEY-QA-08 / SEC-R1-03: a home-currency change re-bases every budget line", async () => {
		const t = await freshTrip();
		await call(setBudgetLine, U.owner, {
			tripId: t.tripId,
			nodeId: null,
			category: null,
			memberId: null,
			amountMinor: 300_000,
			kind: "total",
		});
		await call(setBudgetLine, U.owner, {
			tripId: t.tripId,
			nodeId: null,
			category: null,
			memberId: t.members.owner,
			amountMinor: 123_456,
			kind: "total",
		});
		await call(setBudgetLine, U.maya, {
			tripId: t.tripId,
			nodeId: t.ids.nodes.tokyo,
			category: "food_drink",
			memberId: t.members.maya,
			amountMinor: 5000,
			kind: "per_day",
		});
		await call(setBudgetPrivate, U.maya, { tripId: t.tripId, private: true });
		const amounts = async () =>
			Object.fromEntries(
				(
					(
						await getDb().execute(
							sql`select coalesce(member_id::text, 'default') as k, amount_minor as a, default_seen_minor as s from budget_lines where trip_id = ${t.tripId}`,
						)
					).rows as { k: string; a: number; s: number | null }[]
				).map((r) => [r.k, [Number(r.a), r.s === null ? null : Number(r.s)]]),
			);
		await call(updateTrip, U.owner, {
			tripId: t.tripId,
			settings: { currency: "JPY" },
		});
		// $3,000 → ¥450,000; $1,234.56 → ¥185,184 (seen: the $3,000 default).
		expect(await amounts()).toEqual({
			default: [450_000, null],
			[t.members.owner]: [185_184, 450_000],
			[t.members.maya as string]: [7500, null],
		});
		await call(updateTrip, U.owner, {
			tripId: t.tripId,
			settings: { currency: "USD" },
		});
		expect((await amounts())[t.members.owner]).toEqual([123_456, 300_000]);
		// Reads show the re-based amounts at once (no job needed).
		const d = await money(t);
		expect(d.budgets.find((b) => b.memberId === null)?.amountMinor).toBe(
			300_000,
		);
	});
});

describe("QA round 2 fixes", () => {
	const refund = (t: Trip, of: string, amountMinor: number, currency = "JPY") =>
		call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			refundOfId: of,
			amountMinor,
			currency,
		});

	it("MONEY-R2-02: deleting an expense takes its refunds along; Undo brings back exactly those", async () => {
		const t = await freshTrip();
		const O = t.members.owner;
		const M = t.members.maya as string;
		const orig = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Tax-free camera",
			category: "shopping",
			amountMinor: 100_000,
			currency: "JPY",
			split: { mode: "equal", shares: [{ memberId: O }, { memberId: M }] },
			payments: [pay(100_000, O)],
		});
		const ref = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			refundOfId: orig.id,
			amountMinor: -10_000,
			currency: "JPY",
			payments: [pay(-10_000, O)],
		});
		// A refund deleted on its own earlier stays deleted after the Undo.
		const old = await refund(t, orig.id, -1000);
		await call(deleteExpense, U.owner, { id: old.id });
		const del = await call<{ refunds: number }>(deleteExpense, U.owner, {
			id: orig.id,
		});
		expect(del.refunds).toBe(1);
		let d = await money(t);
		expect(d.expenses.map((e) => e.id)).not.toContain(ref.id);
		// Nothing was spent any more: the trip squares (no orphaned refund).
		expect(
			Object.values(balances(d.expenses, d.settlements)).every((v) => v === 0),
		).toBe(true);
		expect((await balanceSinceSettlement(getDb(), t.tripId, O)).netMinor).toBe(
			0,
		);
		// A refund can't come back without its original.
		expect(await codeOf(call(restoreExpense, U.owner, { id: ref.id }))).toBe(
			"VALIDATION",
		);
		await call(restoreExpense, U.owner, { id: orig.id });
		d = await money(t);
		const ids = d.expenses.map((e) => e.id);
		expect(ids).toContain(orig.id);
		expect(ids).toContain(ref.id);
		expect(ids).not.toContain(old.id);
		expect(balances(d.expenses, d.settlements)[M]).toBeLessThan(0);
	});

	it("MONEY-R2-03: refunds can't add up to more than their original", async () => {
		const t = await freshTrip();
		const orig = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Camera",
			amountMinor: 100_000,
			currency: "JPY",
		});
		expect(await codeOf(refund(t, orig.id, -500_000))).toBe("VALIDATION");
		const r1 = await refund(t, orig.id, -60_000);
		expect(await codeOf(refund(t, orig.id, -50_000))).toBe("VALIDATION");
		await refund(t, orig.id, -40_000);
		// Editing a refund counts the others, not its own old amount.
		expect(
			await codeOf(
				call(updateExpense, U.owner, {
					id: r1.id,
					patch: { amountMinor: -61_000 },
				}),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(
				call(updateExpense, U.owner, {
					id: r1.id,
					patch: { amountMinor: -59_000 },
				}),
			),
		).toBe("ok");
		// The original can't shrink below what was refunded.
		expect(
			await codeOf(
				call(updateExpense, U.owner, {
					id: orig.id,
					patch: { amountMinor: 90_000 },
				}),
			),
		).toBe("VALIDATION");
		// Another currency: compared at home (¥30,000 = $200 at 150).
		const o2 = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Kaiseki",
			amountMinor: 30_000,
			currency: "JPY",
		});
		expect(await codeOf(refund(t, o2.id, -30_000, "USD"))).toBe("VALIDATION");
		expect(await codeOf(refund(t, o2.id, -15_000, "USD"))).toBe("ok");
		const d = await money(t);
		expect(
			d.expenses
				.filter((e) => e.refundOfId === orig.id)
				.reduce((a, e) => a + (e.amountMinor ?? 0), 0),
		).toBe(-99_000);
		// A refund restored alone must still fit (the room was used meanwhile).
		await call(deleteExpense, U.owner, { id: r1.id });
		await refund(t, orig.id, -60_000);
		expect(await codeOf(call(restoreExpense, U.owner, { id: r1.id }))).toBe(
			"VALIDATION",
		);
	});

	it("COLLAB-R2-03: an expense made private afterwards leaves nothing in others' activity or digest", async () => {
		const t = await freshTrip();
		await call(getDigest, U.maya, { tripId: t.tripId }); // Maya's "seen" mark
		const e = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Engagement ring X",
			amountMinor: 250_000,
			currency: "USD",
		});
		await call(updateExpense, U.owner, { id: e.id, patch: { note: "size 6" } });
		const before = JSON.stringify(
			await call(listActivity, U.maya, { tripId: t.tripId }),
		);
		expect(before).toContain("Engagement ring X");
		await call(updateExpense, U.owner, {
			id: e.id,
			patch: { isPrivate: true },
		});
		expect(await one(t, e.id, U.maya)).toBeUndefined();
		const act = JSON.stringify(
			await call(listActivity, U.maya, { tripId: t.tripId }),
		);
		expect(act).not.toContain("Engagement ring");
		const dig = JSON.stringify(
			await call(getDigest, U.maya, { tripId: t.tripId }),
		);
		expect(dig).not.toContain("Engagement ring");
		const left = await getDb().execute(
			sql`select 1 from activity_log where trip_id = ${t.tripId} and meta->>'expenseId' = ${e.id}`,
		);
		expect(left.rows).toHaveLength(0);
		// A private cost's refund quotes its title: it's private too.
		const ref = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			refundOfId: e.id,
			amountMinor: -10_000,
			currency: "USD",
		});
		expect((await one(t, ref.id))?.isPrivate).toBe(true);
		expect(await one(t, ref.id, U.maya)).toBeUndefined();
		expect(
			JSON.stringify(await call(listActivity, U.maya, { tripId: t.tripId })),
		).not.toContain("Engagement ring");
		// A cost whose refund the group sees can't turn private under it.
		const e2 = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Dinner",
			amountMinor: 10_000,
			currency: "USD",
		});
		await refund(t, e2.id, -1000, "USD");
		expect(
			await codeOf(
				call(updateExpense, U.owner, {
					id: e2.id,
					patch: { isPrivate: true },
				}),
			),
		).toBe("VALIDATION");
	});

	it("MONEY-R2-08: currencies the app doesn't know are refused", async () => {
		const t = await freshTrip();
		const base = { tripId: t.tripId, target: { kind: "trip" } };
		expect(
			await codeOf(
				call(createExpense, U.owner, {
					...base,
					amountMinor: 1000,
					currency: "QQQ",
					payments: [pay(1000, t.members.owner, NOW, "QQQ")],
				}),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(
				call(createExpense, U.owner, {
					...base,
					amountMinor: 1000,
					currency: "USD",
					payments: [pay(1000, t.members.owner, NOW, "QQQ")],
				}),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(
				call(createSettlement, U.maya, {
					tripId: t.tripId,
					fromMemberId: t.members.maya,
					toMemberId: t.members.owner,
					amountMinor: 1000,
					currency: "QQQ",
					settledAt: NOW,
					settledTz: TZ,
				}),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(
				call(exportMoneyCsv, U.owner, {
					tripId: t.tripId,
					displayCurrency: "QQQ",
				}),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(
				call(createExpense, U.owner, {
					...base,
					amountMinor: 1000,
					currency: "CHF",
				}),
			),
		).toBe("ok");
		expect((await money(t)).expenses.some((e) => e.currency === "QQQ")).toBe(
			false,
		);
	});

	it("MONEY-R2-07: a settlement can be tagged to a day", async () => {
		const t = await freshTrip();
		const dayId = Object.values(t.ids.days)[0] as string;
		const s = await call<{ id: string }>(createSettlement, U.maya, {
			tripId: t.tripId,
			fromMemberId: t.members.maya,
			toMemberId: t.members.owner,
			amountMinor: 700,
			currency: "USD",
			settledAt: NOW,
			settledTz: TZ,
			method: "cash",
			scope: { dayId },
		});
		expect(
			(await money(t)).settlements.find((x) => x.id === s.id)?.scope,
		).toEqual({ dayId });
	});
});

describe("QA round 3 fixes (WP-Money fix round)", () => {
	it("MONEY-01/14: negative exact parts, negative items and a cash price ≤ 0 are refused", async () => {
		const t = await freshTrip();
		const O = t.members.owner;
		const M = t.members.maya as string;
		const base = {
			tripId: t.tripId,
			target: { kind: "trip" },
			amountMinor: 1000,
			currency: "JPY",
			payments: [pay(1000, O)],
		};
		expect(
			await codeOf(
				call(createExpense, U.owner, {
					...base,
					split: {
						mode: "exact",
						shares: [
							{ memberId: O, amountMinor: 1500 },
							{ memberId: M, amountMinor: -500 },
						],
					},
				}),
			),
		).toBe("VALIDATION");
		expect(
			await codeOf(
				call(createExpense, U.owner, {
					...base,
					lines: [
						{ label: "Set", amountMinor: 1500, memberIds: [O] },
						{ label: "Coupon", amountMinor: -500, memberIds: [M] },
					],
				}),
			),
		).toBe("VALIDATION");
		for (const cashValueMinor of [-5000, 0])
			expect(
				await codeOf(
					call(createExpense, U.owner, {
						tripId: t.tripId,
						target: { kind: "trip" },
						points: {
							program: "Aeroplan",
							points: 1000,
							cashValueMinor,
							cashValueCurrency: "USD",
						},
					}),
				),
			).toBe("VALIDATION");
		// The same through an edit of a good one.
		const ok = await call<{ id: string }>(createExpense, U.owner, {
			...base,
			split: {
				mode: "exact",
				shares: [
					{ memberId: O, amountMinor: 600 },
					{ memberId: M, amountMinor: 400 },
				],
			},
		});
		expect(
			await codeOf(
				call(updateExpense, U.owner, {
					id: ok.id,
					patch: {
						split: {
							mode: "exact",
							shares: [
								{ memberId: O, amountMinor: 1200 },
								{ memberId: M, amountMinor: -200 },
							],
						},
					},
				}),
			),
		).toBe("VALIDATION");
		// Zero parts and non-negative items still save; nothing negative was stored.
		expect(
			await codeOf(
				call(createExpense, U.owner, {
					...base,
					lines: [
						{ label: "Set", amountMinor: 1000, memberIds: [O] },
						{ label: "Water", amountMinor: 0, memberIds: [M] },
					],
				}),
			),
		).toBe("ok");
		const d = await money(t);
		expect(
			d.expenses.some(
				(e) =>
					e.shares.some((s) => (s.amountMinor ?? 0) < 0) ||
					e.lines.some((l) => l.amountMinor < 0),
			),
		).toBe(false);
	});

	it("MONEY-16: the CSV counts a part-paid cost as its deposit (at its date) + the rest at today's rate", async () => {
		const t = await freshTrip();
		const O = t.members.owner;
		// ¥60,000; ¥14,000 paid on 2026-06-01 at 140/$ = $100.00; today 150/$.
		const r = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "node", nodeId: t.ids.nodes.kyoto },
			title: "Ryokan deposit",
			amountMinor: 60_000,
			currency: "JPY",
			split: { mode: "equal", shares: [{ memberId: O }] },
			payments: [pay(14_000, O, "2026-06-01T03:00:00.000Z")],
		});
		const e = await one(t, r.id);
		expect(e?.status).toBe("partial");
		expect(e?.payments[0]?.homeAmountMinor).toBe(10_000);
		expect(e?.homeAmountMinor).toBe(40_000);
		const { csv } = await call<{ csv: string }>(exportMoneyCsv, U.owner, {
			tripId: t.tripId,
			nodeId: t.ids.nodes.kyoto,
		});
		// ¥46,000 still to pay at 150 = $306.67; planned = $100.00 + $306.67.
		const lines = csv.split("\r\n");
		expect(lines.find((l) => l.includes("Ryokan deposit"))).toContain(
			",406.67,100.00,",
		);
		expect(lines).toContain("Total,,,,,,,406.67,100.00");
	});

	it("MONEY-20: the CSV starts with a UTF-8 BOM", async () => {
		const t = await freshTrip();
		const { csv } = await call<{ csv: string }>(exportMoneyCsv, U.owner, {
			tripId: t.tripId,
		});
		expect(csv.charCodeAt(0)).toBe(0xfeff);
		expect(csv.slice(1).startsWith("Expenses — ")).toBe(true);
	});

	it("MONEY-21: 'balance changed' names the edit that moved MY balance, worded like the inbox", async () => {
		const t = await freshTrip();
		const O = t.members.owner;
		const M = t.members.maya as string;
		const A = t.members.audrey;
		const usd = (a: number) => pay(a, O, NOW, "USD");
		const ramen = await call<{ id: string }>(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Ramen",
			amountMinor: 2000,
			currency: "USD",
			split: { mode: "equal", shares: [{ memberId: O }, { memberId: M }] },
			payments: [usd(2000)],
		});
		await call(createSettlement, U.maya, {
			tripId: t.tripId,
			fromMemberId: M,
			toMemberId: O,
			amountMinor: 1000,
			currency: "USD",
			settledAt: NOW,
			settledTz: TZ,
		});
		await new Promise((r) => setTimeout(r, 20));
		await call(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Olga's museum",
			amountMinor: 1000,
			currency: "USD",
			split: { mode: "equal", shares: [{ memberId: O }, { memberId: M }] },
			payments: [usd(1000)],
		});
		const cause = async () => (await money(t, U.maya)).recentEdits?.[0];
		expect(await cause()).toMatchObject({
			title: "Olga's museum",
			cause: "Dev added an expense: Olga's museum",
		});
		// A taxi between the owner and Audrey doesn't touch Maya's balance.
		await call(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Olga and Audrey taxi",
			amountMinor: 3000,
			currency: "USD",
			split: { mode: "equal", shares: [{ memberId: O }, { memberId: A }] },
			payments: [usd(3000)],
		});
		expect((await cause())?.title).toBe("Olga's museum");
		const direct = await balanceEdits(getDb(), {
			tripId: t.tripId,
			memberId: M,
			userId: U.maya.id,
			since: new Date(0),
			limit: 10,
		});
		expect(direct.map((r) => r.title)).not.toContain("Olga and Audrey taxi");
		// A refund of a cost Maya shares is hers even though only the owner got it back.
		await call(createExpense, U.owner, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Ramen refund",
			refundOfId: ramen.id,
			amountMinor: -400,
			currency: "USD",
			payments: [
				{ ...usd(-400), payers: [{ memberId: O, amountMinor: -400 }] },
			],
		});
		expect((await cause())?.title).toBe("Ramen refund");
		// Deleting a cost she shared moves her balance too.
		await call(deleteExpense, U.owner, { id: ramen.id });
		expect(await cause()).toMatchObject({
			verb: "expense.delete",
			cause: "Dev deleted Ramen",
		});
		// Her own edits are never the cause.
		await call(createExpense, U.maya, {
			tripId: t.tripId,
			target: { kind: "trip" },
			title: "Maya's own",
			amountMinor: 500,
			currency: "USD",
			split: { mode: "equal", shares: [{ memberId: M }, { memberId: O }] },
			payments: [pay(500, M, NOW, "USD")],
		});
		expect((await cause())?.title).not.toBe("Maya's own");
	});
});

/**
 * Day operations (SPEC §7.6, §7.7, §13.1): inputs and DB-only cores for the
 * proposable day ops (EXTENSIONS §3.3). A date change never deletes an item:
 * items of a removed day move to Unscheduled. Every operation runs in one
 * `withTripTx` under the trip lock, re-dates the timed legs of moved days,
 * and refuses to split a flight block.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/db.server";
import { tripDays } from "@/db/schema";
import { addDays } from "@/lib/engine/time";
import { HHmm, IsoDate } from "@/lib/schemas/common";
import { logActivity } from "@/server/activity.server";
import { fail } from "@/server/authz/session.server";
import {
	assertBlocksMoveTogether,
	dayRemovalBlocker,
	evacuateDay,
	insertDays,
	redateDays,
	syncTripDates,
} from "@/server/days.server";
import { indexTx, reconcileLegs } from "@/server/legs.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import type { CoreCtx } from "@/server/proposals/types";
import { assertFreshIds } from "./ids.server";

export type DayMutationResult = { dayIds: string[]; detachedLegIds: string[] };

export const InsertDayInput = z
	.object({
		tripId: z.uuid(),
		dayId: z.uuid(),
		where: z.enum(["before", "after"]),
		/** EXTENSIONS §2.2: `[day]`, the new day's id. */
		ids: z.array(z.uuid()).max(1).optional(),
	})
	.strict();

export const MoveDayInput = z
	.object({ dayId: z.uuid(), toDate: IsoDate })
	.strict();

export const DeleteDayInput = z.object({ dayId: z.uuid() }).strict();

export const UpdateDayInput = z
	.object({
		dayId: z.uuid(),
		startTime: HHmm.optional(),
		title: z.string().max(200).nullable().optional(),
		expectedUpdatedAt: z.string().optional(),
	})
	.strict();

export const SetDayStayInput = z
	.object({
		fromDayId: z.uuid(),
		toDayId: z.uuid().optional(),
		nodeId: z.uuid().nullable(),
	})
	.strict();

type In<S extends z.ZodType> = z.output<S>;

/** `day.insert`: a day before/after `dayId`; later days shift by one. Keys: graph. */
export async function insertDayCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof InsertDayInput>,
	ctx: CoreCtx,
): Promise<DayMutationResult> {
	const newId = data.ids?.[0];
	if (newId) await assertFreshIds(tx, "trip_days", [newId]);
	const ix = await indexTx(tx, data.tripId);
	const pivot = ix.day(data.dayId);
	if (!pivot) return fail("NOT_FOUND");
	const newDate = data.where === "after" ? addDays(pivot.date, 1) : pivot.date;
	const moves = new Map<string, string>();
	const deltas = new Map<string, number>();
	for (const d of ix.days) {
		if (d.date >= newDate) {
			moves.set(d.id, addDays(d.date, 1));
			deltas.set(d.id, 1);
		}
	}
	assertBlocksMoveTogether(ix, deltas);
	await redateDays(tx, ix, data.tripId, moves);
	const [id] = await insertDays(
		tx,
		data.tripId,
		[newDate],
		ix.settings.defaultDayStart,
		newId ? [newId] : undefined,
	);
	await syncTripDates(tx, data.tripId);
	await logActivity(tx, out, {
		tripId: data.tripId,
		actor: ctx.actor,
		verb: "day.insert",
		summary: `added a day on ${newDate}`,
		dayId: id,
	});
	out.emit({ entity: "day", ids: id ? [id] : [] });
	return { dayIds: id ? [id] : [], detachedLegIds: [] };
}

/** `day.move`: to another date of the trip; the days between shift by one. Keys: graph. */
export async function moveDayCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof MoveDayInput>,
	ctx: CoreCtx,
): Promise<DayMutationResult> {
	const tripId = ctx.access.tripId;
	const ix = await indexTx(tx, tripId);
	const day = ix.day(data.dayId);
	if (!day) return fail("NOT_FOUND");
	if (!ix.dayOfDate(data.toDate))
		return fail("VALIDATION", "move a day onto one of the trip's dates");
	if (data.toDate === day.date) return { dayIds: [], detachedLegIds: [] };
	const moves = new Map<string, string>([[day.id, data.toDate]]);
	const deltas = new Map<string, number>();
	const down = day.date < data.toDate;
	for (const d of ix.days) {
		if (d.id === day.id) continue;
		if (down && d.date > day.date && d.date <= data.toDate) {
			moves.set(d.id, addDays(d.date, -1));
			deltas.set(d.id, -1);
		} else if (!down && d.date >= data.toDate && d.date < day.date) {
			moves.set(d.id, addDays(d.date, 1));
			deltas.set(d.id, 1);
		}
	}
	deltas.set(
		day.id,
		Math.round((Date.parse(data.toDate) - Date.parse(day.date)) / 86_400_000),
	);
	assertBlocksMoveTogether(ix, deltas);
	await redateDays(tx, ix, tripId, moves);
	const { detachedLegIds } = await reconcileLegs(tx, out, tripId, ix);
	await logActivity(tx, out, {
		tripId,
		actor: ctx.actor,
		verb: "day.move",
		summary: `moved Day ${ix.dayNumber(day.id)} to ${data.toDate}`,
		dayId: day.id,
	});
	out.emit({ entity: "day", ids: [...moves.keys()] });
	return { dayIds: [...moves.keys()], detachedLegIds };
}

/** `day.delete`: its items move to Unscheduled; later days move back one. Keys: graph, lists, media, notes, counts, money. */
export async function deleteDayCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof DeleteDayInput>,
	ctx: CoreCtx,
): Promise<DayMutationResult> {
	const tripId = ctx.access.tripId;
	const ix = await indexTx(tx, tripId);
	const day = ix.day(data.dayId);
	if (!day) return fail("NOT_FOUND");
	const blocker = await dayRemovalBlocker(tx, ix, day.id);
	if (blocker) return fail("CONFLICT", blocker);
	const moved = await evacuateDay(tx, tripId, day.id, out);
	await tx.delete(tripDays).where(sql`${tripDays.id} = ${day.id}`);
	const later = new Map<string, string>();
	const deltas = new Map<string, number | null>([[day.id, null]]);
	for (const d of ix.days) {
		if (d.date > day.date) {
			later.set(d.id, addDays(d.date, -1));
			deltas.set(d.id, -1);
		}
	}
	assertBlocksMoveTogether(ix, deltas);
	await redateDays(tx, ix, tripId, later);
	await syncTripDates(tx, tripId);
	const { detachedLegIds } = await reconcileLegs(tx, out, tripId, ix, {
		changed: moved,
	});
	await logActivity(tx, out, {
		tripId,
		actor: ctx.actor,
		verb: "day.delete",
		summary: `deleted Day ${ix.dayNumber(day.id)} (${moved.length} items to Unscheduled)`,
		dayId: day.id,
		meta: { count: moved.length },
	});
	out.emit({
		entity: "day",
		ids: [...later.keys()],
		keys: ["lists", "media", "notes", "counts", "money"],
	});
	return { dayIds: [...later.keys()], detachedLegIds };
}

/** `day.update`: start time and title. Keys: graph. */
export async function updateDayCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof UpdateDayInput>,
	ctx: CoreCtx,
): Promise<{ updatedAt: string }> {
	const tripId = ctx.access.tripId;
	const patch: Partial<typeof tripDays.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (data.startTime !== undefined) patch.startTime = data.startTime;
	if (data.title !== undefined) patch.title = data.title?.trim() || null;
	const [row] = await tx
		.update(tripDays)
		.set(patch)
		.where(
			sql`${tripDays.id} = ${data.dayId} and ${tripDays.tripId} = ${tripId}`,
		)
		.returning({ updatedAt: tripDays.updatedAt });
	if (!row) return fail("NOT_FOUND");
	out.emit({ entity: "day", ids: [data.dayId] });
	return { updatedAt: row.updatedAt.toISOString() };
}

/**
 * `day.stay`: the night's stay for a day range: a live place (the hotel), or
 * the town you sleep in before one is picked (a city, region or area; the
 * Schedule step's day split). Never a country. Keys: graph.
 */
export async function setDayStayCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof SetDayStayInput>,
	ctx: CoreCtx,
): Promise<{ dayIds: string[] }> {
	const tripId = ctx.access.tripId;
	const ix = await indexTx(tx, tripId);
	const from = ix.day(data.fromDayId);
	const to = ix.day(data.toDayId ?? data.fromDayId);
	if (!from || !to) return fail("NOT_FOUND");
	if (to.date < from.date)
		return fail("VALIDATION", "the range ends before it starts");
	if (data.nodeId) {
		const node = ix.node(data.nodeId);
		if (!node) return fail("NOT_FOUND", "place");
		if (node.type === "country")
			return fail("VALIDATION", "a stay is a place or a town");
		if (ix.isDropped(node.id))
			return fail("CONFLICT", "restore the place first");
	}
	const dayIds = ix.days
		.filter((d) => d.date >= from.date && d.date <= to.date)
		.map((d) => d.id);
	await tx.execute(sql`
		update trip_days set night_node_id = ${data.nodeId}, updated_at = now()
		 where trip_id = ${tripId} and id = any(${sql.param(dayIds)}::uuid[])`);
	// Stay legs whose anchors or stays changed get autofilled after COMMIT.
	await reconcileLegs(tx, out, tripId, ix);
	const name = data.nodeId
		? (ix.node(data.nodeId)?.name ?? "a place")
		: "nowhere";
	await logActivity(tx, out, {
		tripId,
		actor: ctx.actor,
		verb: "day.stay",
		summary: `set the stay to ${name} for ${dayIds.length} night${dayIds.length === 1 ? "" : "s"}`,
		dayId: from.id,
		nodeId: data.nodeId,
		meta: { name, count: dayIds.length },
	});
	out.emit({ entity: "day", ids: dayIds });
	return { dayIds };
}

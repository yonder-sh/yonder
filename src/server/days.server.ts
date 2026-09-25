/**
 * Day operations (SPEC §7.7): the shared steps behind `setTripDates`,
 * `shiftTripDates`, `insertDay`, `moveDay` and `deleteDay`. No date operation
 * ever deletes an item: items of a removed day move to Unscheduled and its
 * bundle rows (attachments, list items) to the trip root.
 *
 * Every step runs inside the caller's `withTripTx` transaction; the
 * `(trip_id, date)` uniqueness is DEFERRABLE INITIALLY DEFERRED (§6.4), so days
 * can swap and shift dates freely until COMMIT.
 */
import { sql } from "drizzle-orm";
import * as Y from "yjs";
import type { Tx } from "@/db/db.server";
import { tripDays } from "@/db/schema";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { addDays } from "@/lib/engine/time";
import { notePlainText } from "@/lib/notes/plain-text";
import {
	jsonToMarkdown,
	ydocFromState,
	ydocToJSON,
} from "@/lib/notes/ydoc.server";
import { noteDocName } from "@/lib/realtime/protocol";
import { fail } from "./authz/session.server";
import { blockLabel, shiftTimedLegs } from "./legs.server";
import type { TxOutbox } from "./live/outbox.server";
import { positionsFor } from "./position.server";

/** `trips.start_date/end_date` = min/max of the trip's days (null when there are none). */
export async function syncTripDates(tx: Tx, tripId: string): Promise<void> {
	await tx.execute(sql`
		update trips t set
		  start_date = (select min(date) from trip_days d where d.trip_id = t.id),
		  end_date = (select max(date) from trip_days d where d.trip_id = t.id),
		  updated_at = now()
		 where t.id = ${tripId}`);
}

/**
 * Refuses a date change that would split a flight block: every day holding
 * part of one block must move by the same delta (`deltaByDay`; missing = 0,
 * `null` = the day is removed).
 */
export function assertBlocksMoveTogether(
	ix: GraphIndex,
	deltaByDay: ReadonlyMap<string, number | null>,
): void {
	for (const block of ix.flightBlocks) {
		const days = new Set(
			block.map((id) => ix.item(id)?.dayId).filter((d): d is string => !!d),
		);
		const deltas = new Set<number | null>(
			[...days].map((d) => {
				const v = deltaByDay.get(d);
				return v === undefined ? 0 : v;
			}),
		);
		if (deltas.has(null) || deltas.size > 1)
			fail(
				"CONFLICT",
				`inside flight ${blockLabel(ix, block)} — edit the flight first`,
			);
	}
}

/**
 * Why a day can't be removed (part of a flight block, or a non-empty SHARED
 * day note), or null. Private notes never block, the viewer's own included
 * (QA R3: "Day 1 has a note" named a note the shared layer didn't show, and
 * reached a suggester through the accepter's error, SEC-R3-02): every
 * member's private day note moves to their private trip note instead
 * (`rehomePrivateDayNotes`).
 */
export async function dayRemovalBlocker(
	tx: Tx,
	ix: GraphIndex,
	dayId: string,
): Promise<string | null> {
	for (const block of ix.flightBlocks) {
		if (block.some((id) => ix.item(id)?.dayId === dayId))
			return `Day ${ix.dayNumber(dayId)} holds flight ${blockLabel(ix, block)}`;
	}
	const res = await tx.execute(sql`
		select 1 from yjs_documents
		 where day_id = ${dayId} and coalesce(plain_text, '') <> ''
		   and owner_user_id is null
		 limit 1`);
	if (res.rows.length) return `Day ${ix.dayNumber(dayId)} has a note`;
	return null;
}

const bytesOf = (b: Buffer | Uint8Array): Uint8Array =>
	new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/**
 * ADDENDUM §7.2: a member's private note on a day that is being removed is
 * kept, not cascaded away with the day. It moves to that member's private
 * trip note: renamed when they have none, else merged into it (a Yjs merge,
 * so both texts survive). Empty ones go with the day, like the empty shared
 * note. Returns the moves (`from` → `to` document names) for collab, which
 * folds in anything still unsaved and refreshes an open target (QA P1).
 */
export async function rehomePrivateDayNotes(
	tx: Tx,
	tripId: string,
	dayId: string,
): Promise<{ from: string; to: string }[]> {
	const res = await tx.execute(sql`
		select name, owner_user_id as "ownerUserId", state from yjs_documents
		 where trip_id = ${tripId} and day_id = ${dayId}
		   and owner_user_id is not null and coalesce(plain_text, '') <> ''
		 order by name`);
	const moved: { from: string; to: string }[] = [];
	for (const r of res.rows as {
		name: string;
		ownerUserId: string;
		state: Buffer;
	}[]) {
		const target = noteDocName(tripId, { kind: "trip" }, r.ownerUserId);
		moved.push({ from: r.name, to: target });
		const cur = await tx.execute(
			sql`select state from yjs_documents where name = ${target} for update`,
		);
		const root = cur.rows[0] as { state: Buffer } | undefined;
		if (!root) {
			await tx.execute(sql`
				update yjs_documents set name = ${target}, day_id = null, updated_at = now()
				 where name = ${r.name}`);
			continue;
		}
		const merged = Y.mergeUpdates([bytesOf(root.state), bytesOf(r.state)]);
		const json = ydocToJSON(ydocFromState(merged));
		await tx.execute(sql`
			update yjs_documents set
			  state = ${Buffer.from(merged)},
			  json = ${JSON.stringify(json)}::jsonb,
			  markdown = ${jsonToMarkdown(json)},
			  plain_text = ${notePlainText(json)},
			  updated_at = now()
			 where name = ${target}`);
		await tx.execute(sql`delete from yjs_documents where name = ${r.name}`);
	}
	return moved;
}

/**
 * Moves everything off a day that is about to be deleted: its items (live and
 * soft-deleted, which the NO ACTION FK would otherwise block) to the end of
 * Unscheduled in their order, its attachments and list items to the trip
 * root, and private notes to their owner's private trip note. The empty
 * day note row cascades with the day; `out` tells collab to close the day's
 * open note documents (QA P1). Returns the moved live item ids.
 */
export async function evacuateDay(
	tx: Tx,
	tripId: string,
	dayId: string,
	out?: Pick<TxOutbox, "notes">,
): Promise<string[]> {
	// Every note document of the day, saved or not (an editor may have one
	// open that was never stored): collab closes them after COMMIT.
	const docs = await tx.execute(
		sql`select name from yjs_documents where trip_id = ${tripId} and day_id = ${dayId}`,
	);
	const moved = await rehomePrivateDayNotes(tx, tripId, dayId);
	out?.notes({
		gone: [
			...(docs.rows as { name: string }[]).map((r) => r.name),
			noteDocName(tripId, { kind: "day", dayId }),
		],
		moved,
	});
	const res = await tx.execute(sql`
		select id::text as id, deleted_at is null as live from items
		 where trip_id = ${tripId} and day_id = ${dayId}
		 order by position collate "C", id`);
	const rows = res.rows as { id: string; live: boolean }[];
	if (rows.length) {
		const keys = await positionsFor(
			tx,
			{ table: "items", tripId, dayId: null },
			rows.length,
		);
		for (const [i, r] of rows.entries()) {
			await tx.execute(
				sql`update items set day_id = null, position = ${keys[i] as string}, updated_at = now() where id = ${r.id}`,
			);
		}
	}
	await tx.execute(
		sql`update attachments set day_id = null, updated_at = now() where trip_id = ${tripId} and day_id = ${dayId}`,
	);
	await tx.execute(
		sql`update list_items set day_id = null, updated_at = now() where trip_id = ${tripId} and day_id = ${dayId}`,
	);
	return rows.filter((r) => r.live).map((r) => r.id);
}

/**
 * Applies new dates to existing days (`newDateByDay`), re-dates the timed legs
 * that start on them, and keeps `trips.start_date/end_date` in sync.
 */
export async function redateDays(
	tx: Tx,
	ix: GraphIndex,
	tripId: string,
	newDateByDay: ReadonlyMap<string, string>,
): Promise<void> {
	const deltas = new Map<string, number>();
	for (const [dayId, date] of newDateByDay) {
		const day = ix.day(dayId);
		if (!day || day.date === date) continue;
		deltas.set(dayId, daysBetweenIso(day.date, date));
		await tx.execute(
			sql`update trip_days set date = ${date}, updated_at = now() where id = ${dayId} and trip_id = ${tripId}`,
		);
	}
	await shiftTimedLegs(tx, tripId, deltas);
	await syncTripDates(tx, tripId);
}

/** Whole days from `a` to `b` (`YYYY-MM-DD`). */
export function daysBetweenIso(a: string, b: string): number {
	return Math.round(
		(Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
	);
}

/** Inserts empty days for `dates` (which must be free). Returns their ids. */
export async function insertDays(
	tx: Tx,
	tripId: string,
	dates: readonly string[],
	startTime?: string,
	/** Chosen ids, by position (EXTENSIONS §2.2); the rest are generated. */
	ids?: readonly string[],
): Promise<string[]> {
	if (dates.length === 0) return [];
	const rows = await tx
		.insert(tripDays)
		.values(
			dates.map((date, i) => ({
				...(ids?.[i] ? { id: ids[i] } : {}),
				tripId,
				date,
				...(startTime ? { startTime } : {}),
			})),
		)
		.returning({ id: tripDays.id });
	return rows.map((r) => r.id);
}

/** Every date from `start` to `end`, inclusive. */
export function dateRange(start: string, end: string, max = 366): string[] {
	const out: string[] = [];
	for (let d = start; d <= end && out.length <= max; d = addDays(d, 1))
		out.push(d);
	return out;
}

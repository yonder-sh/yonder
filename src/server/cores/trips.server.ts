/**
 * Trip-level inputs and cores (SPEC §7.7, §13.1; EXTENSIONS §5): the trip
 * date ops are proposable (`trip.dates`, `trip.shift`, capability
 * `editTripDates`); `updateTrip` and `deleteTrip` are direct functions.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db, type Tx } from "@/db/db.server";
import { tripDays, trips } from "@/db/schema";
import { HOME_CURRENCIES } from "@/features/home/currencies";
import { rebaseBudgets } from "@/features/money/server/money.server";
import { can, type TripAccess } from "@/lib/auth/roles";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { addDays } from "@/lib/engine/time";
import type { GraphDay } from "@/lib/engine/types";
import { formatDayDate } from "@/lib/format";
import { IsoDate, Tz } from "@/lib/schemas/common";
import { TripSettingsPatch } from "@/lib/schemas/trips";
import { logActivity } from "@/server/activity.server";
import { fail } from "@/server/authz/session.server";
import {
	dayRemovalBlocker,
	evacuateDay,
	insertDays,
	redateDays,
	syncTripDates,
} from "@/server/days.server";
import { indexTx, reconcileLegs } from "@/server/legs.server";
import { readTripVersion, type TxOutbox } from "@/server/live/outbox.server";
import type { CoreCtx } from "@/server/proposals/types";

export const TripSlug = z.string().regex(/^[a-z0-9-]{1,100}$/);
export const TripName = z.string().trim().min(1).max(120);
/** Trips longer than a year are almost certainly a typo in the dates. */
export const MAX_TRIP_DAYS = 366;

/** Inclusive `YYYY-MM-DD` dates from `start` to `end` (UTC calendar arithmetic). */
export function datesBetween(start: string, end: string): string[] {
	const out: string[] = [];
	const d = new Date(`${start}T00:00:00Z`);
	const last = new Date(`${end}T00:00:00Z`);
	while (d <= last && out.length <= MAX_TRIP_DAYS) {
		out.push(d.toISOString().slice(0, 10));
		d.setUTCDate(d.getUTCDate() + 1);
	}
	return out;
}

export const CreateTripInput = z
	.object({
		name: TripName,
		startDate: IsoDate.optional(),
		endDate: IsoDate.optional(),
		defaultTz: Tz.optional(),
	})
	.strict()
	.refine((v) => !v.startDate === !v.endDate, {
		message: "Give both dates or neither",
	})
	.refine((v) => !v.startDate || !v.endDate || v.startDate <= v.endDate, {
		message: "The trip ends before it starts",
	});
export type CreateTripInput = z.infer<typeof CreateTripInput>;

export const UpdateTripInput = z
	.object({
		tripId: z.uuid(),
		name: TripName.optional(),
		slug: TripSlug.optional(),
		coverAttachmentId: z.uuid().nullable().optional(),
		/** Only the keys sent are written (no defaults fill in the rest). */
		settings: TripSettingsPatch.optional(),
	})
	.strict();
export type UpdateTripInput = z.infer<typeof UpdateTripInput>;

/** "The trip changed while you were looking" guard for date ops (EXTENSIONS §5). */
const ExpectedVersion = z.number().int().nonnegative().optional();

const DatesShape = z
	.object({
		tripId: z.uuid(),
		startDate: IsoDate,
		endDate: IsoDate,
		expectedVersion: ExpectedVersion,
	})
	.strict();
export const SetTripDatesInput = DatesShape.refine(
	(v) => v.startDate <= v.endDate,
	{ message: "The trip ends before it starts" },
).refine((v) => datesBetween(v.startDate, v.endDate).length <= MAX_TRIP_DAYS, {
	message: "A trip can be at most a year long.",
});

export const ShiftTripDatesInput = z
	.object({
		tripId: z.uuid(),
		deltaDays: z.number().int().min(-366).max(366),
		expectedVersion: ExpectedVersion,
	})
	.strict();

/**
 * `previewTripDates` takes a range (the dates dialog) or a delta (the E2
 * what-if, where only `blockedBy` matters).
 */
export const PreviewTripDatesInput = z.union([
	DatesShape.omit({ expectedVersion: true }).refine(
		(v) =>
			v.startDate <= v.endDate &&
			datesBetween(v.startDate, v.endDate).length <= MAX_TRIP_DAYS,
		{ message: "Invalid date range" },
	),
	z
		.object({
			tripId: z.uuid(),
			deltaDays: z.number().int().min(-366).max(366),
		})
		.strict(),
]);

export type PreviewTripDatesResult = {
	removedDays: string[];
	affectedItems: { id: string; title: string }[];
	blockedBy?: string;
	/**
	 * The `trips.version` this preview reflects: what the user reviewed, so the
	 * dates dialog sends it as `expectedVersion` (a change made after the
	 * preview → CONFLICT, a change made before it doesn't). Null: no such trip.
	 */
	version: number | null;
};

type In<S extends z.ZodType> = z.output<S>;

/** The version check for date ops: `out.version` is already bumped by one. */
function assertExpectedVersion(
	out: TxOutbox,
	expectedVersion: number | undefined,
): void {
	if (expectedVersion === undefined || out.version === null) return;
	if (out.version - 1 !== expectedVersion)
		fail("CONFLICT", "The trip changed while you were looking — review again.");
}

/** What `setTripDates` would do: the days that go, their items, and what refuses it. */
export async function planTripDates(
	tx: Tx,
	tripId: string,
	startDate: string,
	endDate: string,
): Promise<{
	ix: GraphIndex;
	removed: GraphDay[];
	added: string[];
	affected: { id: string; title: string }[];
	blockedBy?: string;
}> {
	const ix = await indexTx(tx, tripId);
	const removed = ix.days.filter((d) => d.date < startDate || d.date > endDate);
	const have = new Set(ix.days.map((d) => d.date));
	const added = datesBetween(startDate, endDate).filter((d) => !have.has(d));
	const affected = removed.flatMap((d) =>
		(ix.itemsByDay.get(d.id) ?? []).map((it) => ({
			id: it.id,
			title: it.title ?? ix.node(it.nodeId)?.name ?? "Item",
		})),
	);
	let blockedBy: string | undefined;
	for (const d of removed) {
		const why = await dayRemovalBlocker(tx, ix, d.id);
		if (why) {
			blockedBy = why;
			break;
		}
	}
	return { ix, removed, added, affected, ...(blockedBy ? { blockedBy } : {}) };
}

/** Read-only preview (QA TRIP-02; E2 what-if blockers). */
export async function previewTripDatesRead(
	data: In<typeof PreviewTripDatesInput>,
): Promise<PreviewTripDatesResult> {
	return db.transaction(async (tx) => {
		// Read first: a change committed while the plan is read makes this
		// version older than what is shown, which errs towards a CONFLICT.
		const version = await readTripVersion(tx, data.tripId);
		if ("deltaDays" in data) {
			// A shift removes no day; only a flight block could refuse it, and a
			// uniform shift moves every block together.
			return { removedDays: [], affectedItems: [], version };
		}
		const plan = await planTripDates(
			tx,
			data.tripId,
			data.startDate,
			data.endDate,
		);
		return {
			removedDays: plan.removed.map((d) => d.date),
			affectedItems: plan.affected,
			...(plan.blockedBy ? { blockedBy: plan.blockedBy } : {}),
			version,
		};
	});
}

/** `trip.dates` (§7.7): never deletes items (they move to Unscheduled). Keys: graph, lists, media, notes, counts, money. */
export async function setTripDatesCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof SetTripDatesInput>,
	ctx: CoreCtx,
): Promise<{ ok: true; version: number | null }> {
	assertExpectedVersion(out, data.expectedVersion);
	const plan = await planTripDates(
		tx,
		data.tripId,
		data.startDate,
		data.endDate,
	);
	if (plan.blockedBy) return fail("CONFLICT", plan.blockedBy);
	const moved: string[] = [];
	for (const d of plan.removed) {
		moved.push(...(await evacuateDay(tx, data.tripId, d.id, out)));
		await tx.delete(tripDays).where(eq(tripDays.id, d.id));
	}
	await insertDays(
		tx,
		data.tripId,
		plan.added,
		plan.ix.settings.defaultDayStart,
	);
	await syncTripDates(tx, data.tripId);
	await reconcileLegs(tx, out, data.tripId, plan.ix, { changed: moved });
	await logActivity(tx, out, {
		tripId: data.tripId,
		actor: ctx.actor,
		verb: "trip.dates",
		summary: `changed the dates to ${data.startDate} – ${data.endDate}${moved.length ? ` (${moved.length} items to Unscheduled)` : ""}`,
		meta: { count: moved.length },
	});
	out.emit({
		entity: "trip",
		keys: ["graph", "lists", "media", "notes", "counts", "money"],
	});
	return { ok: true as const, version: out.version };
}

/** `trip.shift` (§7.7): shifts every day (and re-dates timed legs). Keys: graph. */
export async function shiftTripDatesCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof ShiftTripDatesInput>,
	ctx: CoreCtx,
): Promise<{ ok: true; version: number | null }> {
	assertExpectedVersion(out, data.expectedVersion);
	if (data.deltaDays === 0) return { ok: true as const, version: out.version };
	const ix = await indexTx(tx, data.tripId);
	const moves = new Map(
		ix.days.map((d) => [d.id, addDays(d.date, data.deltaDays)]),
	);
	await redateDays(tx, ix, data.tripId, moves);
	const first = ix.days[0];
	const sign = data.deltaDays > 0 ? "+" : "";
	await logActivity(tx, out, {
		tripId: data.tripId,
		actor: ctx.actor,
		verb: "trip.dates",
		summary: `shifted the trip ${sign}${data.deltaDays} day${Math.abs(data.deltaDays) === 1 ? "" : "s"}${first ? ` (${formatDayDate(first.date)} → ${formatDayDate(addDays(first.date, data.deltaDays))})` : ""}`,
		meta: { count: data.deltaDays },
	});
	out.emit({ entity: "trip" });
	return { ok: true as const, version: out.version };
}

/**
 * `updateTrip` ({ direct: 'tripSettings' }; the slug needs `changeSlug`).
 * The cover must be a live photo or video of THIS trip (no cross-trip media).
 * Keys: graph (trip).
 */
export async function updateTripCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof UpdateTripInput>,
	access: Pick<TripAccess, "role" | "isGuest">,
): Promise<{ slug: string }> {
	if (data.slug) {
		const [clash] = await tx
			.select({ id: trips.id })
			.from(trips)
			.where(
				and(
					eq(trips.slug, data.slug),
					isNull(trips.deletedAt),
					sql`${trips.id} <> ${data.tripId}`,
				),
			)
			.limit(1);
		if (clash) return fail("CONFLICT", "That link is already taken.");
	}
	if (data.coverAttachmentId) {
		const cover = await tx.execute(sql`
			select 1 from attachments
			 where id = ${data.coverAttachmentId} and trip_id = ${data.tripId}
			   and deleted_at is null and kind in ('photo', 'video')`);
		if (!cover.rows.length) return fail("NOT_FOUND", "cover");
	}
	const patch: PgUpdateSetSource<typeof trips> = {
		updatedAt: new Date(),
	};
	if (data.name !== undefined) patch.name = data.name;
	if (data.slug !== undefined) patch.slug = data.slug;
	if (data.coverAttachmentId !== undefined)
		patch.coverAttachmentId = data.coverAttachmentId;
	let rehome = false;
	let currencyChange: { from: string; to: string } | null = null;
	if (data.settings !== undefined) {
		// Merge: keys not sent keep their value.
		patch.settings = sql`${trips.settings} || ${JSON.stringify(data.settings)}::jsonb`;
		const next = (data.settings as { currency?: unknown }).currency;
		if (typeof next === "string") {
			const cur = await tx.execute(
				// Unset means USD (the money engine's default), so re-saving it is no change.
				sql`select coalesce(settings->>'currency', 'USD') as currency from trips where id = ${data.tripId}`,
			);
			const prev =
				(cur.rows[0] as { currency: string | null } | undefined)?.currency ??
				"USD";
			rehome = prev !== next;
			if (rehome) currencyChange = { from: prev, to: next };
			// The home currency is money (ADDENDUM §6–§7): only people who manage
			// budgets change it, never a link guest, and only to a supported one.
			if (rehome && !can(access, "manageBudgets"))
				return fail("FORBIDDEN", "not allowed: manageBudgets");
			if (rehome && !(HOME_CURRENCIES as readonly string[]).includes(next))
				return fail("VALIDATION", "currency");
		}
	}
	const [row] = await tx
		.update(trips)
		.set(patch)
		.where(eq(trips.id, data.tripId))
		.returning({ slug: trips.slug });
	if (!row) return fail("NOT_FOUND");
	out.emit({ entity: "trip" });
	// EXTENSIONS §8.5: a new home currency re-converts every expense, payment
	// and settlement (WP-Money's `fxRehome`, after commit).
	if (rehome) {
		// Budget amounts are in the home currency (ADDENDUM §7.1): WP-Money
		// re-bases them in this transaction, so none is read in the wrong one.
		if (currencyChange)
			await rebaseBudgets(
				tx,
				data.tripId,
				currencyChange.from,
				currencyChange.to,
			);
		out.emit({ keys: ["money"] });
		out.job(
			"money",
			"money.fxRehome",
			{ tripId: data.tripId },
			{ dedupeId: `fxRehome:${data.tripId}` },
		);
	}
	return { slug: row.slug };
}

/**
 * Leg rules shared by the foundation's server functions and the feature
 * packages' server code (SPEC §7.6–§7.9, §9.2, §10.9, §11.3):
 *
 * - `reconcileLegs` — after a change to the located sequence: the flight-block
 *   guard, re-keying significant legs, detached legs, autofill for new pairs.
 * - `writeLeg` / `ensureLegRow` — the one way a leg row is created or changed
 *   (details checked against the mode, timed instants, guest merge).
 * - `shiftTimedLegs` — re-dates flights and fixed transit when days move.
 *
 * Everything runs inside the caller's `withTripTx` transaction.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@/db/db.server";
import { legs } from "@/db/schema";
import type { AirportRecord } from "@/features/transit/server/airports.server";
import {
	autoFlightFor,
	sameAutoFlight,
} from "@/features/transit/server/auto-flight.server";
import { flightTimes, isAutoFlight, shiftFlight } from "@/lib/engine/flights";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { indexGraph, pairKey } from "@/lib/engine/graph-index";
import { addDays, localDateTimeToEpoch } from "@/lib/engine/time";
import type { GraphLeg, TripGraph } from "@/lib/engine/types";
import type { LegMode, LegSource } from "@/lib/schemas/enums";
import {
	type FlightDetails,
	type LegDetails,
	readLegDetails,
	type Seat,
} from "@/lib/schemas/legs";
import type { LegTarget } from "@/lib/schemas/targets";
import { fail } from "./authz/session.server";
import { loadGraphForServer } from "./graph.server";
import { enqueueAutofill, type TxOutbox } from "./live/outbox.server";
import { tripMemberIds } from "./perms.server";

// ---------------------------------------------------------------------------
// Loading the trip inside the transaction
// ---------------------------------------------------------------------------

/** The trip graph as the transaction sees it (uncommitted writes included), indexed. */
export async function indexTx(tx: Tx, tripId: string): Promise<GraphIndex> {
	const g: TripGraph | null = await loadGraphForServer(tx, tripId);
	if (!g) return fail("NOT_FOUND");
	return indexGraph(g);
}

// ---------------------------------------------------------------------------
// Flight blocks (§7.9)
// ---------------------------------------------------------------------------

/** "NH 9"-style label of the flight that starts a block, for CONFLICT messages. */
export function blockLabel(ix: GraphIndex, block: readonly string[]): string {
	const [a, b] = block;
	const leg = a && b ? ix.legByPair.get(pairKey(a, b)) : undefined;
	const d = leg ? ix.legDetails(leg) : null;
	const n = d?.kind === "flight" ? d.flight.flightNumber : undefined;
	return n ? n.replace(/^([A-Z0-9]{2})\s*(\d)/, "$1 $2") : "flight";
}

/**
 * §7.9 rule 1: no item may sit between two items of a flight block, and a
 * block's items stay scheduled together. Checks the blocks of `before` (so a
 * located item dropped into a block is caught even though it breaks the
 * block's pairs) and of `after`.
 */
export function assertFlightBlocks(
	before: GraphIndex,
	after: GraphIndex,
): void {
	const check = (ix: GraphIndex, block: readonly string[]) => {
		const idx = block.map((id) => after.orderOf(id));
		const live = block.filter((id) => after.item(id));
		if (live.length === 0) return; // the whole block was deleted
		if (live.length < block.length)
			fail("CONFLICT", `inside flight ${blockLabel(ix, block)}`);
		if (idx.some((i) => i < 0)) {
			if (idx.every((i) => i < 0)) return; // unscheduled together (restore paths)
			fail("CONFLICT", "flights move with their times — edit the flight");
		}
		for (let k = 1; k < idx.length; k++) {
			if ((idx[k] as number) !== (idx[k - 1] as number) + 1)
				fail("CONFLICT", `inside flight ${blockLabel(ix, block)}`);
		}
	};
	for (const b of before.flightBlocks) check(before, b);
	for (const b of after.flightBlocks) check(after, b);
}

// ---------------------------------------------------------------------------
// reconcileLegs (§7.8)
// ---------------------------------------------------------------------------

export type ReconcileOptions = {
	/** Items this mutation moved, removed or re-located (re-keying looks at these). */
	changed?: readonly string[];
};

/**
 * Call after every write that changes the located sequence (create, move,
 * delete or restore an item, re-locate it, unschedule it, the day operations),
 * with the index taken before the writes. Returns the ids of significant legs
 * that became detached by this change (§7.8 step 3).
 */
export async function reconcileLegs(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	before: GraphIndex,
	opts: ReconcileOptions = {},
): Promise<{ detachedLegIds: string[]; after: GraphIndex }> {
	let after = await indexTx(tx, tripId);

	// 1. Flight-block guard (throws; the transaction rolls back).
	assertFlightBlocks(before, after);

	// 2–3. Significant pair legs whose pair broke: re-key or detach.
	const changed = new Set(opts.changed ?? []);
	const wasDetached = new Set(before.detachedLegs.map((d) => d.legId));
	const detached: string[] = [];
	let rekeyed = false;
	for (const leg of before.graph.legs) {
		if (leg.kind !== "pair" || !leg.fromItemId || !leg.toItemId) continue;
		if (!before.isPair(leg.fromItemId, leg.toItemId)) continue;
		if (after.isPair(leg.fromItemId, leg.toItemId)) continue;
		if (!before.isSignificant(leg)) continue; // autofilled only: vanishes silently

		const a = leg.fromItemId;
		const b = leg.toItemId;
		const bNode = before.item(b)?.nodeId ?? null;
		const bGone =
			changed.has(b) || after.orderOf(b) < 0 || !after.item(b)?.nodeId;
		if (after.orderOf(a) >= 0 && after.item(a)?.nodeId && bGone && bNode) {
			const x = after.nextLocated(a);
			if (x && x.id !== b && x.nodeId === bNode) {
				const there = after.legByPair.get(pairKey(a, x.id));
				if (!there || !after.isSignificant(there)) {
					if (there) await tx.delete(legs).where(sql`${legs.id} = ${there.id}`);
					await tx.execute(
						sql`update legs set to_item_id = ${x.id}, updated_at = now() where id = ${leg.id}`,
					);
					rekeyed = true;
					continue;
				}
			}
		}
		if (!wasDetached.has(leg.id)) detached.push(leg.id);
	}
	if (rekeyed) after = await indexTx(tx, tripId);

	// 3b. The default flight between two adjacent airports (FB-19).
	if (await syncAutoFlights(tx, out, tripId, after))
		after = await indexTx(tx, tripId);

	// 4. Autofill for newly formed pairs and changed stay anchors (after COMMIT).
	const targets: LegTarget[] = [];
	for (const p of after.pairs) {
		if (before.isPair(p.fromItemId, p.toItemId)) continue;
		const row = after.legByPair.get(p.key);
		if (row?.mode || row?.isEdited) continue;
		// No pair travel across a night (overnight connector / stay legs).
		const kind = after.boundaryKind(p.fromItemId, p.toItemId);
		if (kind === "stay" || kind === "overnight") continue;
		targets.push({
			kind: "pair",
			fromItemId: p.fromItemId,
			toItemId: p.toItemId,
		});
	}
	for (const d of after.days) {
		for (const end of ["start", "end"] as const) {
			const now =
				end === "start" ? after.morningStay(d.id) : after.eveningStay(d.id);
			if (!now) continue;
			const was =
				end === "start" ? before.morningStay(d.id) : before.eveningStay(d.id);
			if (
				was &&
				was.anchorItemId === now.anchorItemId &&
				was.stayNodeId === now.stayNodeId
			)
				continue;
			const row = after.legByStay.get(`${d.id}:${end}`);
			if (row?.isEdited) continue;
			targets.push({ kind: "stay", dayId: d.id, end });
		}
	}
	enqueueAutofill(out, targets, { enabled: after.settings.autofillLegs });

	return { detachedLegIds: detached, after };
}

/**
 * FB-19: every current pair of two different airports (at least 150 km apart)
 * gets a default Flight leg — a real row, `source: 'estimate'`, not edited,
 * prefilled with both airports and the items' dates, no times or number — and
 * an existing default follows the items (new airports or dates). A row a
 * person chose (any mode, or edited) is never touched, so switching the
 * default to Train sticks. A default whose pair is no longer two airports
 * goes back to "not set". Returns whether anything was written.
 */
export async function syncAutoFlights(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	ix: GraphIndex,
): Promise<boolean> {
	let wrote = false;
	const meta = { userId: null, isGuest: false } as const;
	const airports = new Map<string, AirportRecord | null>();
	for (const p of ix.pairs) {
		const row = ix.legByPair.get(p.key) ?? null;
		const auto = isAutoFlight(row);
		if (row && !auto && (row.mode || row.isEdited)) continue;
		const target = {
			kind: "pair" as const,
			fromItemId: p.fromItemId,
			toItemId: p.toItemId,
		};
		const flight = autoFlightFor(ix, p.fromItemId, p.toItemId, airports);
		if (flight) {
			if (auto && row && sameAutoFlight(ix.legDetails(row), flight)) continue;
			await writeLeg(
				tx,
				out,
				tripId,
				target,
				{
					mode: "flight",
					source: "estimate",
					isEdited: false,
					distanceM: null,
					details: { kind: "flight", flight },
				},
				meta,
			);
			wrote = true;
		} else if (auto && row) {
			await writeLeg(
				tx,
				out,
				tripId,
				target,
				{ mode: null, details: { kind: "none" }, isEdited: false },
				meta,
			);
			wrote = true;
		}
	}
	return wrote;
}

// ---------------------------------------------------------------------------
// Leg rows
// ---------------------------------------------------------------------------

type LegRow = typeof legs.$inferSelect;

/** The row for a target, or undefined. */
export async function findLeg(
	tx: DbOrTx,
	tripId: string,
	target: LegTarget,
): Promise<LegRow | undefined> {
	const where =
		target.kind === "pair"
			? sql`${legs.tripId} = ${tripId} and ${legs.kind} = 'pair' and ${legs.fromItemId} = ${target.fromItemId} and ${legs.toItemId} = ${target.toItemId}`
			: sql`${legs.tripId} = ${tripId} and ${legs.stayDayId} = ${target.dayId} and ${legs.kind} = ${target.end === "start" ? "stay_start" : "stay_end"}`;
	const [row] = await tx.select().from(legs).where(where).limit(1);
	return row;
}

/**
 * The target's row, created with `mode: null` if missing. A pair must be the
 * current pair of two located items (§7.8); a stay leg records the anchor it
 * was created for.
 */
export async function ensureLegRow(
	tx: Tx,
	tripId: string,
	target: LegTarget,
	userId: string | null,
	ix?: GraphIndex,
): Promise<{ row: LegRow; created: boolean }> {
	const existing = await findLeg(tx, tripId, target);
	if (existing) return { row: existing, created: false };
	const index = ix ?? (await indexTx(tx, tripId));
	let values: typeof legs.$inferInsert;
	if (target.kind === "pair") {
		if (!index.item(target.fromItemId) || !index.item(target.toItemId))
			return fail("NOT_FOUND");
		if (!index.isPair(target.fromItemId, target.toItemId))
			return fail("CONFLICT", "those stops are not next to each other");
		values = {
			tripId,
			kind: "pair",
			fromItemId: target.fromItemId,
			toItemId: target.toItemId,
			createdBy: userId,
		};
	} else {
		if (!index.day(target.dayId)) return fail("NOT_FOUND");
		const plan =
			target.end === "start"
				? index.morningStay(target.dayId)
				: index.eveningStay(target.dayId);
		values = {
			tripId,
			kind: target.end === "start" ? "stay_start" : "stay_end",
			stayDayId: target.dayId,
			anchorItemId: plan?.anchorItemId ?? null,
			createdBy: userId,
		};
	}
	const [row] = await tx.insert(legs).values(values).returning();
	if (!row) throw new Error("ensureLegRow: insert returned no row");
	return { row, created: true };
}

export type LegPatchInput = {
	mode?: LegMode | null;
	durationMin?: number | null;
	distanceM?: number | null;
	source?: LegSource;
	estimateMin?: number | null;
	isEdited?: boolean;
	details?: LegDetails;
};

/** `details.kind` must fit the mode: none always; otherwise the same kind. */
export function assertDetailsFit(
	mode: LegMode | null,
	details: LegDetails,
	kind: GraphLeg["kind"],
): void {
	if (details.kind !== "none" && details.kind !== mode)
		fail(
			"VALIDATION",
			`details of kind ${details.kind} need mode ${details.kind}`,
		);
	if (mode === "flight") {
		if (kind !== "pair") fail("VALIDATION", "a flight joins two stops");
		if (details.kind !== "flight")
			fail("VALIDATION", "a flight needs its details");
	}
}

/**
 * §9.2 timed instants: flights from `depLocal`/`arrLocal` in the airports'
 * zones, transit with `fixed` from its local times. Everything else is untimed.
 */
export function timedInstants(details: LegDetails): {
	depAt: Date | null;
	arrAt: Date | null;
} {
	type Wall = [local: string, tz: string, fold?: "earlier" | "later"];
	const pair = (a: Wall, b: Wall) => {
		const dep = localDateTimeToEpoch(a[0], a[1], a[2]);
		const arr = localDateTimeToEpoch(b[0], b[1], b[2]);
		if (dep === null || arr === null)
			return fail("VALIDATION", "bad local time");
		if (arr <= dep)
			return fail("VALIDATION", "arrival must be after departure");
		return { depAt: new Date(dep), arrAt: new Date(arr) };
	};
	if (details.kind === "flight") {
		const f = details.flight;
		// FB-18: no departure time → an untimed leg (the estimate counts).
		if (!f.depLocal) return { depAt: null, arrAt: null };
		// Only a departure time: the arrival is dep + the great-circle estimate.
		if (!f.arrLocal) {
			const t = flightTimes(f);
			if (t.depMs === null || t.arrMs === null)
				return fail("VALIDATION", "bad local time");
			return { depAt: new Date(t.depMs), arrAt: new Date(t.arrMs) };
		}
		// QA TZ-07: a repeated local time (clocks go back) honours its fold.
		return pair(
			[f.depLocal, f.from.tz, f.depFold],
			[f.arrLocal, f.to.tz, f.arrFold],
		);
	}
	if (details.kind === "transit" && details.fixed) {
		const x = details.fixed;
		return pair([x.departLocal, x.fromTz], [x.arriveLocal, x.toTz]);
	}
	return { depAt: null, arrAt: null };
}

/** Keeps a seat's stored value when the guest's copy was redacted. */
function mergeSeats(stored: Seat[], incoming: Seat[]): Seat[] {
	return incoming.map((s, i) => {
		const same =
			(s.memberId && stored.find((t) => t.memberId === s.memberId)) ||
			stored[i];
		return same ? { ...s, seat: same.seat } : s;
	});
}

/**
 * §11.3: a guest editor saving a (redacted) form keeps the stored booking
 * refs, seats, costs, points and fees whatever the input says.
 */
export function mergeGuestDetails(
	stored: LegDetails,
	incoming: LegDetails,
): LegDetails {
	if (incoming.kind === "flight") {
		const old: Partial<FlightDetails> =
			stored.kind === "flight" ? stored.flight : {};
		const {
			bookingRef: _b,
			cost: _c,
			points: _p,
			fees: _f,
			...rest
		} = incoming.flight;
		return {
			kind: "flight",
			flight: {
				...rest,
				...(old.bookingRef !== undefined ? { bookingRef: old.bookingRef } : {}),
				...(old.cost !== undefined ? { cost: old.cost } : {}),
				...(old.points !== undefined ? { points: old.points } : {}),
				...(old.fees !== undefined ? { fees: old.fees } : {}),
				seats: mergeSeats(old.seats ?? [], incoming.flight.seats),
			},
		};
	}
	if (incoming.kind === "transit" && incoming.booking) {
		const oldBooking = stored.kind === "transit" ? stored.booking : undefined;
		const { ref: _r, ...rest } = incoming.booking;
		return {
			...incoming,
			booking: {
				...rest,
				...(oldBooking?.ref !== undefined ? { ref: oldBooking.ref } : {}),
				seats: mergeSeats(oldBooking?.seats ?? [], incoming.booking.seats),
			},
		};
	}
	return incoming;
}

export type WriteLegMeta = {
	userId: string | null;
	isGuest: boolean;
	/** The row's `updatedAt` when the form was opened; a stale one + `details` → CONFLICT (§10.8). */
	expectedUpdatedAt?: string;
	/**
	 * `false` for job handlers: write without `out.emit` (the worker's gated
	 * refetch announces the change). Default true.
	 */
	emit?: boolean;
};

/**
 * Creates or updates the target's leg (the body of `setLeg`, and the helper
 * WP-Transit's server code uses). Emits `leg` for the row unless
 * `meta.emit === false` (job handlers).
 */
/** Seat `memberId`s must be (non-removed) members of THIS trip (schemas/legs.ts `Seat`). */
async function assertSeatMembers(
	tx: Tx,
	tripId: string,
	details: LegDetails,
): Promise<void> {
	const seats =
		details.kind === "flight"
			? details.flight.seats
			: details.kind === "transit"
				? (details.booking?.seats ?? [])
				: [];
	const ids = [
		...new Set(seats.flatMap((s) => (s.memberId ? [s.memberId] : []))),
	];
	if (!ids.length) return;
	const ok = await tripMemberIds(tx, tripId, ids);
	if (ok.length !== ids.length)
		fail("VALIDATION", "seats can only belong to members of this trip");
}

export async function writeLeg(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	target: LegTarget,
	patch: LegPatchInput,
	meta: WriteLegMeta,
): Promise<{ row: LegRow; modeChanged: boolean }> {
	const { row } = await ensureLegRow(tx, tripId, target, meta.userId);
	if (
		patch.details &&
		meta.expectedUpdatedAt &&
		new Date(meta.expectedUpdatedAt).getTime() !== row.updatedAt.getTime()
	)
		fail("CONFLICT", "changed by someone else");

	const stored = readLegDetails(row.details);
	const mode = patch.mode !== undefined ? patch.mode : row.mode;
	let details: LegDetails = patch.details ?? stored;
	// A mode change without new details drops details of the old kind.
	if (!patch.details && details.kind !== "none" && details.kind !== mode)
		details = { kind: "none" };
	if (patch.details && meta.isGuest)
		details = mergeGuestDetails(stored, details);
	assertDetailsFit(mode, details, row.kind);
	if (patch.details) await assertSeatMembers(tx, tripId, details);
	const { depAt, arrAt } = timedInstants(details);

	const [updated] = await tx
		.update(legs)
		.set({
			mode,
			durationMin:
				mode === "flight"
					? null
					: patch.durationMin !== undefined
						? patch.durationMin
						: row.durationMin,
			distanceM:
				patch.distanceM !== undefined ? patch.distanceM : row.distanceM,
			source: patch.source ?? row.source,
			estimateMin:
				patch.estimateMin !== undefined ? patch.estimateMin : row.estimateMin,
			isEdited: patch.isEdited ?? row.isEdited,
			details: details.kind === "none" ? {} : details,
			depAt,
			arrAt,
			updatedAt: new Date(),
		})
		.where(sql`${legs.id} = ${row.id}`)
		.returning();
	if (!updated) return fail("NOT_FOUND");
	if (meta.emit !== false) out.emit({ entity: "leg", ids: [row.id] });
	return { row: updated, modeChanged: mode !== row.mode };
}

// ---------------------------------------------------------------------------
// Re-dating timed legs when days move (§7.7)
// ---------------------------------------------------------------------------

const shiftLocal = (local: string, days: number): string =>
	`${addDays(local.slice(0, 10), days)}${local.slice(10)}`;

/** Shifts a timed leg's local times by `days` (flights, with or without times, and fixed transit). */
export function shiftDetails(details: LegDetails, days: number): LegDetails {
	if (details.kind === "flight")
		return { kind: "flight", flight: shiftFlight(details.flight, days) };
	if (details.kind === "transit" && details.fixed) {
		const x = details.fixed;
		return {
			...details,
			fixed: {
				...x,
				departLocal: shiftLocal(x.departLocal, days),
				arriveLocal: shiftLocal(x.arriveLocal, days),
			},
		};
	}
	return details;
}

/**
 * Every timed leg whose from-item is on a shifted day moves by that day's
 * delta: local times shifted, `dep_at`/`arr_at` recomputed (§7.7).
 */
export async function shiftTimedLegs(
	tx: Tx,
	tripId: string,
	deltaByDay: ReadonlyMap<string, number>,
): Promise<string[]> {
	const dayIds = [...deltaByDay.entries()]
		.filter(([, d]) => d !== 0)
		.map(([id]) => id);
	if (dayIds.length === 0) return [];
	// Flights without times (FB-18) carry their dates: they move too.
	const res = await tx.execute(sql`
		select l.id::text as id, l.details, i.day_id::text as "dayId"
		  from legs l join items i on i.id = l.from_item_id
		 where l.trip_id = ${tripId} and (l.dep_at is not null or l.mode = 'flight')
		   and i.day_id = any(${sql.param(dayIds)}::uuid[])`);
	const moved: string[] = [];
	for (const r of res.rows as {
		id: string;
		details: unknown;
		dayId: string;
	}[]) {
		const delta = deltaByDay.get(r.dayId) ?? 0;
		if (!delta) continue;
		const details = shiftDetails(readLegDetails(r.details), delta);
		const { depAt, arrAt } = timedInstants(details);
		await tx
			.update(legs)
			.set({ details, depAt, arrAt, updatedAt: new Date() })
			.where(sql`${legs.id} = ${r.id}`);
		moved.push(r.id);
	}
	return moved;
}

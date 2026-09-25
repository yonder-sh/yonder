/**
 * Flights (SPEC §7.9, §13.2): airport lookups that replace a client's zones
 * and coordinates, airport nodes under Country › City, flight blocks
 * (departure, layovers, arrival) created on the right local days, and
 * re-homing a block's items when a flight's times change.
 */
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { COUNTRY_VIEWS } from "@/data/countries";
import type { Tx } from "@/db/db.server";
import { items, legAssignees, legs } from "@/db/schema";
import {
	flightArrDate,
	flightDepDate,
	flightTimes,
	nodeIsAirport,
} from "@/lib/engine/flights";
import { haversineKm, lngLatOf } from "@/lib/engine/geo";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { pairKey } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import { hhmm, localDateOf, localDateTimeToEpoch } from "@/lib/engine/time";
import type { Airport, FlightDetails } from "@/lib/schemas/legs";
import { fail } from "@/server/authz/session.server";
import { updateDayCore } from "@/server/cores/days.server";
import { createNodePathCore } from "@/server/cores/nodes.server";
import { indexTx } from "@/server/legs.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { positionsFor } from "@/server/position.server";
import type { CoreCtx } from "@/server/proposals/types";
import { normalizeFlightNumber, storedFold } from "../lib/flight";
import { airportByIata } from "./airports.server";

/** Replaces zone, coordinates, country, name and city from airports.json (D14). */
export function canonicalAirport(a: Airport, which: "from" | "to"): Airport {
	const rec = airportByIata(a.iata);
	if (!rec) return fail("VALIDATION", `Unknown airport (${which}): ${a.iata}`);
	return {
		iata: rec.iata,
		name: rec.name,
		city: rec.city,
		country: rec.country,
		tz: rec.tz,
		lat: rec.lat,
		lng: rec.lng,
		...(a.terminal?.trim() ? { terminal: a.terminal.trim().slice(0, 20) } : {}),
		...(a.gate?.trim() ? { gate: a.gate.trim().slice(0, 20) } : {}),
	};
}

/**
 * A flight as the server stores it: canonical airports, "NH9", checked
 * times. FB-18: the number, the airline and both times are optional; the
 * departure date is required (`depLocal` or `depDate`). The dates are kept
 * equal to the dates of the local times; an arrival without a departure
 * time isn't a time anyone can use and is refused.
 */
export function normalizeFlight(f: FlightDetails): FlightDetails {
	const from = canonicalAirport(f.from, "from");
	const to = canonicalAirport(f.to, "to");
	const flightNumber = f.flightNumber
		? normalizeFlightNumber(f.flightNumber)
		: null;
	if (f.flightNumber && !flightNumber)
		fail("VALIDATION", "Not a flight number");
	if (f.arrLocal && !f.depLocal)
		fail("VALIDATION", "An arrival time needs a departure time");
	// QA TZ-07: a fold is kept only where the clocks repeat that local time.
	const depFold = f.depLocal
		? storedFold(f.depLocal, from.tz, f.depFold)
		: undefined;
	const arrFold = f.arrLocal
		? storedFold(f.arrLocal, to.tz, f.arrFold)
		: undefined;
	const dep = f.depLocal
		? localDateTimeToEpoch(f.depLocal, from.tz, depFold)
		: null;
	const arr = f.arrLocal
		? localDateTimeToEpoch(f.arrLocal, to.tz, arrFold)
		: null;
	if ((f.depLocal && dep === null) || (f.arrLocal && arr === null))
		fail("VALIDATION", "bad local time");
	if (dep !== null && arr !== null && arr <= dep)
		fail("VALIDATION", "Arrival is before departure");
	const depDate = flightDepDate(f);
	if (!depDate) fail("VALIDATION", "A flight needs its date");
	// Only a departure time: the arrival date follows the estimate.
	const estArr =
		dep !== null && arr === null ? flightTimes({ ...f, from, to }).arrMs : null;
	const arrDate =
		f.arrLocal?.slice(0, 10) ??
		(estArr !== null ? localDateOf(estArr, to.tz) : null) ??
		f.arrDate ??
		depDate;
	const out: FlightDetails = {
		...f,
		from,
		to,
		depDate: depDate as string,
		arrDate: arrDate as string,
		depFold,
		arrFold,
		bookingRef: f.bookingRef?.trim().toUpperCase() || undefined,
		airline: f.airline
			? {
					...(f.airline.iata ? { iata: f.airline.iata.toUpperCase() } : {}),
					name: f.airline.name,
				}
			: undefined,
	};
	if (flightNumber) out.flightNumber = flightNumber;
	else delete out.flightNumber;
	for (const k of [
		"bookingRef",
		"airline",
		"depFold",
		"arrFold",
		"depLocal",
		"arrLocal",
	] as const)
		if (out[k] === undefined) delete out[k];
	return out;
}

/**
 * The instants a block's items are placed by: the times when known, else
 * the local dates at noon (FB-18), so an untimed flight's items still sit on
 * its dates.
 */
const depMs = (f: FlightDetails) => {
	const t = flightTimes(f);
	return t.depMs ?? noonOf(flightDepDate(f), f.from.tz);
};
const arrMs = (f: FlightDetails) => {
	const t = flightTimes(f);
	return t.depMs !== null && t.arrMs !== null
		? t.arrMs
		: noonOf(flightArrDate(f) ?? flightDepDate(f), f.to.tz);
};
const noonOf = (date: string | null, tz: string) =>
	date ? (localDateTimeToEpoch(`${date}T12:00`, tz) ?? 0) : 0;

const countryName = (cc: string): string => {
	try {
		return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) ?? cc;
	} catch {
		return cc;
	}
};

const norm = (s: string) =>
	s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/**
 * The airport's node: reused by `details.iata`, else created under the
 * country (by ISO code) › city (by name under it), creating what's missing.
 */
export async function ensureAirportNode(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	airport: Airport,
	ctx: CoreCtx,
): Promise<string> {
	const ix = await indexTx(tx, tripId);
	const live = ix.graph.nodes.filter((n) => n.status !== "dropped");
	const existing =
		live.find(
			(n) =>
				n.type === "place" &&
				(n.details as { iata?: string }).iata === airport.iata,
		) ??
		// An airport added as a plain place (the palette, the demo) carries no
		// IATA code: the airport-category place within 5 km is the same one
		// (found at integration: a second "Incheon International Airport" and
		// a 3 h walk between the two).
		live.find(
			(n) =>
				n.type === "place" &&
				n.category === "airport" &&
				n.lat != null &&
				n.lng != null &&
				haversineKm([n.lng, n.lat], [airport.lng, airport.lat]) < 5,
		) ??
		// FB-19: a place or area named like the airport within 5 km ("Haneda
		// Airport" is an area in the owner's test trip).
		live.find((n) => nodeIsAirport(n, lngLatOf(n), airport));
	if (existing) return existing.id;
	const cc = airport.country ?? "";
	const country = live.find(
		(n) => n.type === "country" && n.countryCode?.toUpperCase() === cc,
	);
	const city = country
		? live.find(
				(n) =>
					n.type === "city" &&
					ix.isWithin(n.id, country.id) &&
					norm(n.name) === norm(airport.city ?? ""),
			)
		: undefined;
	const leaf = {
		type: "place" as const,
		category: "airport" as const,
		name: airport.name.slice(0, 200),
		lat: airport.lat,
		lng: airport.lng,
		countryCode: /^[A-Z]{2}$/.test(cc) ? cc : undefined,
		details: { iata: airport.iata },
	};
	const view = COUNTRY_VIEWS[cc];
	const chain: Parameters<typeof createNodePathCore>[2]["chain"] = city
		? [{ id: city.id }, leaf]
		: country
			? [
					{ id: country.id },
					{
						type: "city",
						name: (airport.city || airport.name).slice(0, 200),
						lat: airport.lat,
						lng: airport.lng,
					},
					leaf,
				]
			: [
					{
						type: "country",
						name: countryName(cc),
						...(/^[A-Z]{2}$/.test(cc) ? { countryCode: cc } : {}),
						...(view ? { lng: view[0], lat: view[1] } : {}),
					},
					{
						type: "city",
						name: (airport.city || airport.name).slice(0, 200),
						lat: airport.lat,
						lng: airport.lng,
					},
					leaf,
				];
	const { nodeIds } = await createNodePathCore(tx, out, { tripId, chain }, ctx);
	const id = nodeIds.at(-1);
	if (!id) throw new Error("ensureAirportNode: no node");
	return id;
}

/** The trip day for a local date, else undefined. */
const dayOn = (ix: GraphIndex, epoch: number, tz: string) =>
	ix.dayOfDate(localDateOf(epoch, tz));

/**
 * Where a new block's first item goes on its day: after `afterItemId` when
 * it's on that day, else before the first item scheduled after departure
 * (or at the end). A block that spans days starts at the end of its day.
 */
function insertionPoint(
	ix: GraphIndex,
	dayId: string,
	dep: number,
	spansDays: boolean,
	afterItemId?: string,
): { afterId?: string; beforeId?: string } {
	const list = ix.itemsByDay.get(dayId) ?? [];
	if (spansDays) return list.length ? { afterId: list.at(-1)?.id } : {};
	if (afterItemId && list.some((i) => i.id === afterItemId))
		return { afterId: afterItemId };
	const sched = computeSchedule(ix).items;
	const next = list.find((i) => {
		const s = sched[i.id];
		return s ? s.start.getTime() > dep : false;
	});
	return next
		? { beforeId: next.id }
		: list.length
			? { afterId: list.at(-1)?.id }
			: {};
}

export type CreatedBlock = {
	itemIds: string[];
	legIds: string[];
	flights: FlightDetails[];
};

/**
 * §7.9 `createFlightWithAirports`: the departure item, one Layover per
 * connection, the arrival item, and one flight leg per segment, placed on the
 * local days of their times. `ids`: [from item, to item, leg] per segment.
 */
export async function createFlightBlock(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	input: {
		segments: FlightDetails[];
		bookingRef?: string;
		afterItemId?: string;
		dayId?: string;
		ids?: string[];
	},
	ctx: CoreCtx,
): Promise<CreatedBlock> {
	const shared = input.bookingRef?.trim().toUpperCase() || undefined;
	const flights = input.segments.map((s) =>
		normalizeFlight(shared ? { ...s, bookingRef: shared } : s),
	);
	for (let i = 1; i < flights.length; i++) {
		const prev = flights[i - 1] as FlightDetails;
		const next = flights[i] as FlightDetails;
		if (depMs(next) < arrMs(prev))
			fail("VALIDATION", `Segment ${i + 1} departs before segment ${i} lands`);
	}
	// Airport nodes (created or reused), in stop order.
	const stops = [
		(flights[0] as FlightDetails).from,
		...flights.map((f) => f.to),
	];
	const nodeIds: string[] = [];
	for (const a of stops)
		nodeIds.push(await ensureAirportNode(tx, out, tripId, a, ctx));
	const ix = await indexTx(tx, tripId);

	// Chosen ids (EXTENSIONS §2.2): per segment [from item, to item, leg].
	const ids = input.ids ?? [];
	const itemIds = stops.map((_, k) =>
		k === 0 ? (ids[0] ?? uuidv7()) : (ids[3 * (k - 1) + 1] ?? uuidv7()),
	);
	const legIds = flights.map((_, k) => ids[3 * k + 2] ?? uuidv7());

	// Local days of each stop: departure on its dep date, others on the inbound arrival date.
	const first = flights[0] as FlightDetails;
	const stopTimes = [
		{ at: depMs(first), tz: first.from.tz },
		...flights.map((f) => ({ at: arrMs(f), tz: f.to.tz })),
	];
	const days = stopTimes.map((t, k) => {
		const d = dayOn(ix, t.at, t.tz);
		if (d) return d.id;
		if (k === 0 && input.dayId && ix.day(input.dayId)) return input.dayId;
		return fail(
			"VALIDATION",
			`${localDateOf(t.at, t.tz)} isn't a day of this trip — add the day first`,
		);
	});
	const spans = new Set(days).size > 1;

	// Positions: contiguous runs per day.
	let prevId: string | undefined;
	let prevDay: string | undefined;
	const rows: (typeof items.$inferInsert)[] = [];
	for (const [k, dayId] of days.entries()) {
		let where: { afterId?: string; beforeId?: string };
		if (k === 0)
			where = insertionPoint(ix, dayId, depMs(first), spans, input.afterItemId);
		else if (dayId === prevDay) where = { afterId: prevId };
		else {
			const list = ix.itemsByDay.get(dayId) ?? [];
			where = list[0] ? { beforeId: list[0].id } : {};
		}
		const [position] = await positionsFor(
			tx,
			{ table: "items", tripId, dayId },
			1,
			where,
		);
		const id = itemIds[k] as string;
		const isLayover = k > 0 && k < days.length - 1;
		const inbound = flights[k - 1];
		const outbound = flights[k];
		rows.push({
			id,
			tripId,
			dayId,
			nodeId: nodeIds[k] as string,
			title: isLayover ? "Layover" : null,
			position: position as string,
			durationMin:
				isLayover && inbound && outbound
					? Math.max(0, Math.round((depMs(outbound) - arrMs(inbound)) / 60_000))
					: 0,
			createdBy: ctx.user.id,
		});
		// Insert now so the next position sees it.
		await tx.insert(items).values(rows.at(-1) as typeof items.$inferInsert);
		prevId = id;
		prevDay = dayId;
	}

	// Legs, with connections.
	for (const [k, f] of flights.entries()) {
		const connection: FlightDetails["connection"] = {};
		if (k > 0) connection.prevLegId = legIds[k - 1];
		if (k < flights.length - 1) connection.nextLegId = legIds[k + 1];
		f.connection = Object.keys(connection).length ? connection : undefined;
		if (!f.connection) delete f.connection;
		await tx.insert(legs).values({
			id: legIds[k] as string,
			tripId,
			kind: "pair",
			fromItemId: itemIds[k] as string,
			toItemId: itemIds[k + 1] as string,
			createdBy: ctx.user.id,
		});
	}
	return { itemIds, legIds, flights };
}

/**
 * A new block that opens its day (nothing planned before the departure
 * airport) but leaves before the day's start time: the day starts when the
 * traveller must set off instead, so the flight isn't created in conflict
 * (QA MT-08: an empty day starting 09:00 and NH 9 at 02:00 read "Misses NH 9
 * by 540 min"). Only ever earlier, never before midnight. Call it after the
 * flight legs are written. Returns the new start time, or null.
 */
export async function fitDayStartToFlight(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	block: Pick<CreatedBlock, "itemIds">,
	ctx: CoreCtx,
): Promise<string | null> {
	const [depItemId, nextItemId] = block.itemIds;
	if (!depItemId || !nextItemId) return null;
	const ix = await indexTx(tx, tripId);
	const day = ix.day(ix.item(depItemId)?.dayId ?? null);
	if (!day || ix.itemsByDay.get(day.id)?.[0]?.id !== depItemId) return null;
	const sched = computeSchedule(ix);
	const leg = sched.legs[pairKey(depItemId, nextItemId)];
	const late = leg?.late;
	const start = sched.days[day.id];
	if (!leg || !late || late.minutes <= 0 || !start) return null;
	// The departure airport's own (unpinned) stop is the time at the airport:
	// the day starts early enough for the whole stop, not just the flight.
	const dep = ix.item(depItemId);
	const stopMin = dep && !dep.pinnedStart ? dep.durationMin : 0;
	const at = Math.min(
		start.start.getTime() - late.minutes * 60_000,
		leg.start.getTime() - stopMin * 60_000,
	);
	const startTime =
		localDateOf(at, start.tz) < day.date ? "00:00" : hhmm(at, start.tz);
	if (startTime === day.startTime) return null;
	await updateDayCore(tx, out, { dayId: day.id, startTime }, ctx);
	return startTime;
}

/**
 * §7.9 rule 3: after a flight's times change, its block's items sit on the
 * local dates of their times (the departure on the departure date, later
 * stops on the inbound arrival date). Only days that exist are used. When
 * anything is off, the whole block is placed again: the first day's run at
 * the end of that day when the block spans days (else where it was), each
 * later day's run at the start of its day. Returns the ids of moved items.
 */
export async function rehomeFlightBlock(
	tx: Tx,
	tripId: string,
	ix: GraphIndex,
	anyItemId: string,
): Promise<string[]> {
	const block = ix.blockOf(anyItemId);
	if (!block || block.length < 2) return [];
	const flightOf = (a: string, b: string): FlightDetails | null => {
		const leg = ix.legByPair.get(`${a}>${b}`);
		const d = leg ? ix.legDetails(leg) : null;
		return d?.kind === "flight" ? d.flight : null;
	};
	const targets = block.map((id, k) => {
		const f =
			k === 0
				? flightOf(id, block[1] as string)
				: flightOf(block[k - 1] as string, id);
		const d = f
			? k === 0
				? dayOn(ix, depMs(f), f.from.tz)
				: dayOn(ix, arrMs(f), f.to.tz)
			: undefined;
		return d?.id ?? ix.item(id)?.dayId ?? null;
	});
	if (targets.some((t) => !t)) return [];
	const spans = new Set(targets).size > 1;
	const firstDay = targets[0] as string;
	const others = (dayId: string) =>
		(ix.itemsByDay.get(dayId) ?? []).filter((i) => !block.includes(i.id));
	const inPlace =
		block.every((id, k) => ix.item(id)?.dayId === targets[k]) &&
		(!spans ||
			others(firstDay).every(
				(i) => ix.orderOf(i.id) < ix.orderOf(block[0] as string),
			));
	if (inPlace) return [];
	let prevId: string | undefined;
	let prevDay: string | undefined;
	for (const [k, id] of block.entries()) {
		const dayId = targets[k] as string;
		let where: { afterId?: string; beforeId?: string };
		if (prevDay === dayId) where = { afterId: prevId };
		else if (k === 0) {
			const rest = others(dayId);
			const was = ix.item(id);
			const before =
				was?.dayId === dayId && !spans
					? rest.filter((i) => ix.orderOf(i.id) < ix.orderOf(id)).at(-1)
					: rest.at(-1);
			where = before
				? { afterId: before.id }
				: rest[0]
					? { beforeId: rest[0].id }
					: {};
		} else {
			const first = others(dayId)[0];
			where = first ? { beforeId: first.id } : {};
		}
		const [position] = await positionsFor(
			tx,
			{ table: "items", tripId, dayId },
			1,
			{ ...where, exclude: [...block] },
		);
		await tx.execute(
			sql`update items set day_id = ${dayId}, position = ${position as string}, updated_at = now()
			     where id = ${id} and trip_id = ${tripId}`,
		);
		prevId = id;
		prevDay = dayId;
	}
	return [...block];
}

/** `leg_assignees` default to the seats' members when the leg has none (§7.9). */
export async function defaultAssigneesFromSeats(
	tx: Tx,
	tripId: string,
	legId: string,
	seats: FlightDetails["seats"],
): Promise<boolean> {
	const memberIds = [
		...new Set(seats.flatMap((s) => (s.memberId ? [s.memberId] : []))),
	];
	if (!memberIds.length) return false;
	const existing = await tx.execute(
		sql`select 1 from leg_assignees where leg_id = ${legId} limit 1`,
	);
	if (existing.rows.length) return false;
	await tx
		.insert(legAssignees)
		.values(memberIds.map((memberId) => ({ tripId, legId, memberId })));
	return true;
}

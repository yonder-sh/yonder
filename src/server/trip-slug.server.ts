/**
 * Allocating trip addresses (`src/lib/trip-slug.ts`): `<readable>-<tail>`.
 * Every app flow that makes or changes an address goes through here, so
 * each one ends up with a tail: create, duplicate, the sheet import, editing
 * the address, turning the link on for a tail-less (seeded) trip, and
 * "Reset link".
 */
import { sql } from "drizzle-orm";
import {
	cleanSlugBase,
	newSlugTail,
	splitTripSlug,
	withSlugTail,
} from "@/lib/trip-slug";
import type { SqlExec } from "./graph.server";

export type TripSlugColumns = { slug: string; slugTail: string };

/**
 * `base-<new tail>`, free among live trips (a clash is astronomically rare,
 * but a unique violation would fail the whole transaction, so check).
 */
export async function freshTripSlug(
	exec: SqlExec,
	base: string,
	exceptTripId?: string,
): Promise<TripSlugColumns> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const slugTail = newSlugTail();
		const slug = withSlugTail(base, slugTail);
		const res = await exec.execute(sql`
			select 1 from trips
			 where slug = ${slug} and deleted_at is null
			   ${exceptTripId ? sql`and id <> ${exceptTripId}` : sql``}
			 limit 1`);
		if (!res.rows.length) return { slug, slugTail };
	}
	throw new Error("freshTripSlug: no free address");
}

/** The trip's address and tail (null for a deleted or unknown trip). */
export async function readTripSlug(
	exec: SqlExec,
	tripId: string,
): Promise<{ slug: string; slugTail: string | null } | null> {
	const res = await exec.execute(sql`
		select slug, slug_tail as "slugTail" from trips
		 where id = ${tripId} and deleted_at is null`);
	return (
		(res.rows[0] as { slug: string; slugTail: string | null } | undefined) ??
		null
	);
}

/**
 * A new tail for the trip, keeping its readable part: "Reset link" (the old
 * address stops working) and turning the link on for a tail-less trip.
 * Returns the new address.
 */
export async function giveTripNewTail(
	exec: SqlExec,
	tripId: string,
): Promise<string> {
	const cur = await readTripSlug(exec, tripId);
	if (!cur) throw new Error("giveTripNewTail: no such trip");
	// A seed's tail-less slug can be up to 100 characters: fit the tail in.
	const base =
		cleanSlugBase(splitTripSlug(cur.slug, cur.slugTail).base) || "trip";
	const next = await freshTripSlug(exec, base, tripId);
	await exec.execute(sql`
		update trips set slug = ${next.slug}, slug_tail = ${next.slugTail}, updated_at = now()
		 where id = ${tripId}`);
	return next.slug;
}

/** Gives a tail-less (seeded) trip a tail; the address when it already has one. */
export async function ensureTripTail(
	exec: SqlExec,
	tripId: string,
): Promise<string> {
	const cur = await readTripSlug(exec, tripId);
	if (!cur) throw new Error("ensureTripTail: no such trip");
	return cur.slugTail ? cur.slug : giveTripNewTail(exec, tripId);
}

/**
 * WP-Insights server functions (EXTENSIONS §4.4, §6). `setOpeningHours` is
 * proposable (`node.hours`; core in `server/proposable.server.ts`),
 * `fetchOpeningHours` is edit-only (Google key only; 60/min per trip; Redis
 * 24 h), `getClimate` is a read (V; 30/h per user, 2,000/day global, counted
 * only when a cell has to be fetched).
 */
import { createServerFn } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { nodes } from "@/db/schema";
import { fromGooglePeriods } from "@/lib/engine/hours-parse";
import { NodeDetails } from "@/lib/schemas/nodes";
import { requireTripRole } from "@/server/authz/access.server";
import { withNamedUser, withUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import {
	cacheGet,
	cacheSet,
	rateLimit,
	rateLimitPer,
} from "@/server/cache.server";
import { getEnv } from "@/server/env.server";
import {
	proposable,
	requireEditOnly,
} from "@/server/proposals/proposable.server";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import {
	CLIMATE_ATTRIBUTION,
	CLIMATE_YEARS,
	climateCell,
	climateForCell,
	readClimateCells,
} from "./server/climate.server";
import { SetOpeningHoursInput } from "./server/proposable.server";

/** `node.hours`: manual hours (null removes them). Keys: graph. */
export const setOpeningHours = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SetOpeningHoursInput))
	.handler(proposable.run("node.hours"));

/** Google refreshes at most every 30 days (SPEC §14.1). */
const REFRESH_MS = 30 * 24 * 3600 * 1000;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

type GooglePeriod = {
	open: { day: number; hour: number; minute?: number };
	close?: { day: number; hour: number; minute?: number };
};

function isPeriods(v: unknown): v is GooglePeriod[] {
	const point = (p: unknown) =>
		!!p &&
		typeof p === "object" &&
		Number.isInteger((p as { day: unknown }).day) &&
		Number.isInteger((p as { hour: unknown }).hour);
	return (
		Array.isArray(v) &&
		v.length <= 40 &&
		v.every(
			(p) =>
				p &&
				typeof p === "object" &&
				point((p as GooglePeriod).open) &&
				((p as GooglePeriod).close === undefined ||
					point((p as GooglePeriod).close)),
		)
	);
}

/** Place Details (New) `regularOpeningHours.periods`, cached 24 h per place. */
async function googlePeriods(placeId: string): Promise<GooglePeriod[] | null> {
	const cached = await cacheGet<{ periods: GooglePeriod[] | null }>(
		"ghours",
		placeId,
	);
	if (cached) return cached.periods;
	const env = getEnv();
	const url = new URL(
		`/v1/places/${encodeURIComponent(placeId)}`,
		env.GOOGLE_PLACES_URL,
	);
	let res: Response;
	try {
		res = await fetch(url, {
			headers: {
				"X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY ?? "",
				"X-Goog-FieldMask": "regularOpeningHours",
			},
			signal: AbortSignal.timeout(8_000),
			redirect: "error",
		});
	} catch {
		return fail("PROVIDER", "Google didn't answer. Try again in a moment.");
	}
	if (res.status === 404) return null;
	if (!res.ok)
		return fail("PROVIDER", "Google didn't answer. Try again in a moment.");
	const body = (await res.json().catch(() => null)) as {
		regularOpeningHours?: { periods?: unknown };
	} | null;
	const periods = body?.regularOpeningHours?.periods;
	const out = isPeriods(periods) ? periods : null;
	await cacheSet(["ghours", placeId], { periods: out }, 24 * 3600);
	return out;
}

/** Google Place Details `regularOpeningHours` for up to 25 nodes (never over manual). Keys: graph. */
export const fetchOpeningHours = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({ tripId: z.uuid(), nodeIds: z.array(z.uuid()).min(1).max(25) })
			.strict(),
	)
	.handler(async ({ data, context }): Promise<{ updated: string[] }> => {
		const access = await requireEditOnly(
			"fetchOpeningHours",
			data.tripId,
			context.user,
		);
		const env = getEnv();
		if (!env.GOOGLE_MAPS_API_KEY)
			return fail("VALIDATION", "Fetching hours needs a Google Maps key.");
		const rows = await db
			.select({
				id: nodes.id,
				googlePlaceId: nodes.googlePlaceId,
				details: nodes.details,
			})
			.from(nodes)
			.where(
				and(
					eq(nodes.tripId, data.tripId),
					inArray(nodes.id, [...new Set(data.nodeIds)]),
					isNull(nodes.deletedAt),
				),
			);
		const now = Date.now();
		const due = rows.filter((r) => {
			const d = (r.details ?? {}) as NodeDetails;
			if (!r.googlePlaceId || !PLACE_ID_RE.test(r.googlePlaceId)) return false;
			if (d.openingHours?.source === "manual") return false;
			const at = d.openingHoursFetchedAt
				? Date.parse(d.openingHoursFetchedAt)
				: 0;
			return !(at > now - REFRESH_MS);
		});
		const found = new Map<string, ReturnType<typeof fromGooglePeriods>>();
		const fetchedAt = new Date().toISOString();
		for (const r of due) {
			await rateLimit(`hours:${data.tripId}`, 60);
			const periods = await googlePeriods(r.googlePlaceId as string);
			if (periods?.length)
				found.set(r.id, fromGooglePeriods(periods, fetchedAt));
		}
		if (!found.size) return { updated: [] };
		return withTripTx(
			data.tripId,
			async (_tx, out) => {
				const updated: string[] = [];
				for (const [id, hours] of found) {
					const [row] = await _tx
						.select({ details: nodes.details })
						.from(nodes)
						.where(and(eq(nodes.id, id), eq(nodes.tripId, data.tripId)))
						.for("update");
					const details = {
						...((row?.details ?? {}) as Record<string, unknown>),
					};
					// A person's hours always win, even if they were saved meanwhile (HRS-04).
					if (
						!row ||
						(details.openingHours as { source?: string } | undefined)
							?.source === "manual"
					)
						continue;
					details.openingHours = hours;
					details.openingHoursFetchedAt = fetchedAt;
					const checked = NodeDetails.safeParse(details);
					if (!checked.success) continue;
					await _tx
						.update(nodes)
						.set({ details: checked.data, updatedAt: new Date() })
						.where(and(eq(nodes.id, id), eq(nodes.tripId, data.tripId)));
					updated.push(id);
				}
				if (updated.length) out.emit({ entity: "node", ids: updated });
				return { updated };
			},
			mutationMeta(access, context.user),
		);
	});

export type ClimateMonth = {
	month: number;
	tMaxC: number;
	tMinC: number;
	precipMm: number;
	wetDays: number;
	sunHours: number | null;
};

/** Resets the response to 200 after a swallowed `fail()` (outside a request: no-op). */
function okStatus(): void {
	try {
		setResponseStatus(200);
	} catch {
		// Scripts and tests have no response.
	}
}

/** 10-year monthly normals for live city/area nodes (1–8). Other types: VALIDATION. */
export const getClimate = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(
		z
			.object({ tripId: z.uuid(), nodeIds: z.array(z.uuid()).min(1).max(8) })
			.strict(),
	)
	.handler(
		async ({
			data,
			context,
		}): Promise<{
			byNode: Record<string, ClimateMonth[]>;
			years: string;
			attribution: string;
			/** Nodes with no answer (no coordinates, fetch failed, or out of budget). */
			unavailable: string[];
		}> => {
			await requireTripRole(data.tripId, "viewer", context.user);
			const env = getEnv();
			if (!env.CLIMATE_ENABLED) return fail("NOT_FOUND", "climate");
			const ids = [...new Set(data.nodeIds)];
			const rows = await db
				.select({
					id: nodes.id,
					type: nodes.type,
					lat: nodes.lat,
					lng: nodes.lng,
				})
				.from(nodes)
				.where(
					and(
						eq(nodes.tripId, data.tripId),
						inArray(nodes.id, ids),
						isNull(nodes.deletedAt),
					),
				);
			if (rows.length !== ids.length) return fail("NOT_FOUND");
			if (rows.some((r) => r.type !== "city" && r.type !== "area"))
				return fail("VALIDATION", "Climate is only for cities and areas.");
			const cellOf = new Map<string, string>();
			const unavailable: string[] = [];
			for (const r of rows) {
				if (r.lat === null || r.lng === null) unavailable.push(r.id);
				else cellOf.set(r.id, climateCell(r.lat, r.lng));
			}
			const cells = await readClimateCells([...cellOf.values()]);
			for (const cell of new Set(cellOf.values())) {
				if (cells.has(cell)) continue;
				try {
					// The budget counts archive requests only (a DB hit is free).
					await rateLimitPer(`climate:u:${context.user.id}`, 30, 3600);
					await rateLimitPer("climate:all", 2000, 86_400);
					cells.set(cell, await climateForCell(cell));
				} catch {
					// Out of budget or the archive failed: those nodes say so.
					// `fail()` already set that error's 429/502 on the response;
					// this answer is a normal one (the browser logged it as failed).
					okStatus();
				}
			}
			const byNode: Record<string, ClimateMonth[]> = {};
			for (const [id, cell] of cellOf) {
				const months = cells.get(cell);
				if (months) byNode[id] = months;
				else unavailable.push(id);
			}
			return {
				byNode,
				years: CLIMATE_YEARS,
				attribution: CLIMATE_ATTRIBUTION,
				unavailable,
			};
		},
	);

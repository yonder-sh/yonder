/**
 * Climate normals (EXTENSIONS §6), WP-Insights: one Open-Meteo ERA5 archive
 * request per 0.25° cell, ever (`climate_normals`), under a Redis lock per
 * cell, fixed host, native fetch with an 8 s timeout.
 *
 * The daily series 2016–2025 is reduced to 12 monthly rows: mean daily max
 * and min temperature, mean monthly precipitation, mean wet days (≥ 1 mm)
 * and mean daily sunshine hours.
 */
import { inArray } from "drizzle-orm";
import { db } from "@/db/db.server";
import { climateNormals } from "@/db/schema";
import { fail } from "@/server/authz/session.server";
import { getEnv } from "@/server/env.server";
import { key, redis } from "@/server/live/redis.server";
import type { ClimateMonth } from "../insights.functions";

export const CLIMATE_YEARS = "2016–2025";
const START = "2016-01-01";
const END = "2025-12-31";
const YEAR_COUNT = 10;
export const CLIMATE_ATTRIBUTION =
	"Weather data by Open-Meteo.com (CC BY 4.0) · ERA5, Copernicus";
/** The archive answer for 10 years of 4 daily series is ~200 KB. */
const MAX_BODY = 2_000_000;

/** "35.75,139.75" for a coordinate (snapped to 0.25°). */
export function climateCell(lat: number, lng: number): string {
	const snap = (v: number) => (Math.round(v * 4) / 4).toFixed(2);
	return `${snap(lat)},${snap(lng)}`;
}

const CELL_RE = /^-?\d{1,2}\.\d{2},-?\d{1,3}\.\d{2}$/;

type Daily = {
	time: string[];
	temperature_2m_max: (number | null)[];
	temperature_2m_min: (number | null)[];
	precipitation_sum: (number | null)[];
	sunshine_duration: (number | null)[];
};

/** Reduces the archive's daily series to 12 monthly normals. Pure. */
export function monthlyNormals(daily: Daily): ClimateMonth[] {
	const acc = Array.from({ length: 12 }, () => ({
		tMax: 0,
		tMaxN: 0,
		tMin: 0,
		tMinN: 0,
		precip: 0,
		wet: 0,
		sun: 0,
		sunN: 0,
		years: new Set<string>(),
	}));
	daily.time.forEach((date, i) => {
		const m = Number(date.slice(5, 7)) - 1;
		const a = acc[m];
		if (!a) return;
		a.years.add(date.slice(0, 4));
		const hi = daily.temperature_2m_max[i];
		const lo = daily.temperature_2m_min[i];
		const p = daily.precipitation_sum[i];
		const s = daily.sunshine_duration[i];
		if (typeof hi === "number") {
			a.tMax += hi;
			a.tMaxN++;
		}
		if (typeof lo === "number") {
			a.tMin += lo;
			a.tMinN++;
		}
		if (typeof p === "number") {
			a.precip += p;
			if (p >= 1) a.wet++;
		}
		if (typeof s === "number") {
			a.sun += s;
			a.sunN++;
		}
	});
	const r1 = (v: number) => Math.round(v * 10) / 10;
	return acc.map((a, i) => {
		const years = Math.max(1, a.years.size || YEAR_COUNT);
		return {
			month: i + 1,
			tMaxC: r1(a.tMaxN ? a.tMax / a.tMaxN : 0),
			tMinC: r1(a.tMinN ? a.tMin / a.tMinN : 0),
			precipMm: Math.round(a.precip / years),
			wetDays: r1(a.wet / years),
			sunHours: a.sunN ? r1(a.sun / a.sunN / 3600) : null,
		};
	});
}

/** The cells already in `climate_normals` (12 rows each). */
export async function readClimateCells(
	cells: readonly string[],
): Promise<Map<string, ClimateMonth[]>> {
	const out = new Map<string, ClimateMonth[]>();
	if (!cells.length) return out;
	const rows = await db
		.select()
		.from(climateNormals)
		.where(inArray(climateNormals.cell, [...new Set(cells)]));
	for (const r of rows) {
		const list = out.get(r.cell) ?? [];
		list.push({
			month: r.month,
			tMaxC: r.tMaxC,
			tMinC: r.tMinC,
			precipMm: r.precipMm,
			wetDays: r.wetDays,
			sunHours: r.sunHours,
		});
		out.set(r.cell, list);
	}
	for (const [cell, list] of out) {
		if (list.length !== 12) out.delete(cell);
		else list.sort((a, b) => a.month - b.month);
	}
	return out;
}

function isSeries(v: unknown, n: number): v is (number | null)[] {
	return (
		Array.isArray(v) &&
		v.length === n &&
		v.every((x) => x === null || typeof x === "number")
	);
}

/** One archive request for a cell (no cache, no lock). */
async function requestCell(cell: string): Promise<ClimateMonth[]> {
	const env = getEnv();
	const [lat, lng] = cell.split(",");
	const url = new URL("/v1/archive", env.OPEN_METEO_ARCHIVE_URL);
	url.search = new URLSearchParams({
		latitude: lat ?? "",
		longitude: lng ?? "",
		start_date: START,
		end_date: END,
		daily:
			"temperature_2m_max,temperature_2m_min,precipitation_sum,sunshine_duration",
		timezone: "auto",
		...(env.OPEN_METEO_API_KEY ? { apikey: env.OPEN_METEO_API_KEY } : {}),
	}).toString();
	let res: Response;
	try {
		res = await fetch(url, {
			signal: AbortSignal.timeout(8_000),
			redirect: "error",
			headers: { accept: "application/json" },
		});
	} catch {
		return fail("PROVIDER", "Climate unavailable right now.");
	}
	if (!res.ok) return fail("PROVIDER", "Climate unavailable right now.");
	const text = await res.text();
	if (text.length > MAX_BODY)
		return fail("PROVIDER", "Climate unavailable right now.");
	let body: { daily?: Partial<Daily> };
	try {
		body = JSON.parse(text) as { daily?: Partial<Daily> };
	} catch {
		return fail("PROVIDER", "Climate unavailable right now.");
	}
	const d = body.daily;
	const n = Array.isArray(d?.time) ? d.time.length : 0;
	if (
		!d ||
		n < 300 ||
		!d.time?.every(
			(t) => typeof t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t),
		) ||
		!isSeries(d.temperature_2m_max, n) ||
		!isSeries(d.temperature_2m_min, n) ||
		!isSeries(d.precipitation_sum, n) ||
		!isSeries(d.sunshine_duration, n)
	)
		return fail("PROVIDER", "Climate unavailable right now.");
	return monthlyNormals(d as Daily);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The normals of one cell: from the table, else ONE archive request (a Redis
 * lock makes concurrent callers wait for the first one's rows). Throws
 * PROVIDER when the archive can't answer.
 */
export async function climateForCell(cell: string): Promise<ClimateMonth[]> {
	if (!CELL_RE.test(cell)) return fail("VALIDATION", "bad cell");
	const hit = (await readClimateCells([cell])).get(cell);
	if (hit) return hit;
	const lock = key("lock", "climate", cell);
	const got = await redis()
		.set(lock, "1", "PX", 20_000, "NX")
		.catch(() => "OK");
	if (got !== "OK") {
		// Someone else is fetching this cell: wait for their rows.
		for (let i = 0; i < 20; i++) {
			await sleep(500);
			const rows = (await readClimateCells([cell])).get(cell);
			if (rows) return rows;
		}
		return fail("PROVIDER", "Climate unavailable right now.");
	}
	try {
		const months = await requestCell(cell);
		await db
			.insert(climateNormals)
			.values(
				months.map((m) => ({
					cell,
					month: m.month,
					tMaxC: m.tMaxC,
					tMinC: m.tMinC,
					precipMm: m.precipMm,
					wetDays: m.wetDays,
					sunHours: m.sunHours,
					years: CLIMATE_YEARS,
				})),
			)
			.onConflictDoNothing();
		return months;
	} finally {
		await redis()
			.del(lock)
			.catch(() => 0);
	}
}

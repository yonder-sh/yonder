#!/usr/bin/env node
// Open-Meteo archive stub: the climate lines fetch daily history per cell, and
// every e2e run used up the free tier's daily quota. `pnpm e2e:fast` starts it
// and points OPEN_METEO_ARCHIVE_URL here; it can also run on its own:
//
//   node e2e/stubs/weather-stub.mjs [--port 7099]
//   OPEN_METEO_ARCHIVE_URL=http://127.0.0.1:7099 pnpm dev
//
// GET /v1/archive?latitude&longitude&start_date&end_date: every day in the
//   range, made up but plausible: warmer towards the equator, summer in July
//   north of it and January south, a few wet days a month.
// GET /__stub/calls → { total }
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const DAY_MS = 86_400_000;

/** The made-up history of one place: Open-Meteo's `daily` shape. */
export function archiveDaily(lat, startDate, endDate) {
	const start = Date.parse(`${startDate}T00:00:00Z`);
	const end = Date.parse(`${endDate}T00:00:00Z`);
	const abs = Math.min(70, Math.abs(lat));
	const base = 27 - 0.35 * abs;
	const amp = Math.min(14, 0.3 * abs);
	const daily = {
		time: [],
		temperature_2m_max: [],
		temperature_2m_min: [],
		precipitation_sum: [],
		sunshine_duration: [],
	};
	for (let t = start, i = 0; t <= end; t += DAY_MS, i++) {
		const d = new Date(t);
		const m = d.getUTCMonth() + 1;
		const season = Math.cos((2 * Math.PI * (m - 7)) / 12) * (lat < 0 ? -1 : 1);
		const mean = base + amp * season;
		const wetDays = 6 + Math.round(4 * season);
		const wet = (i * 7 + m) % 30 < wetDays;
		daily.time.push(d.toISOString().slice(0, 10));
		daily.temperature_2m_max.push(Math.round((mean + 4) * 10) / 10);
		daily.temperature_2m_min.push(Math.round((mean - 4) * 10) / 10);
		daily.precipitation_sum.push(wet ? 6.4 : 0);
		daily.sunshine_duration.push(Math.round((wet ? 2 : 7 + 2 * season) * 3600));
	}
	return daily;
}

/** Starts the stub; resolves once it listens. */
export function startWeatherStub(port) {
	let total = 0;
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stub");
		const json = (status, body) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (url.pathname === "/__stub/calls") return json(200, { total });
		if (req.method !== "GET" || url.pathname !== "/v1/archive")
			return json(404, { error: true, reason: "not found" });
		const q = url.searchParams;
		const lat = Number(q.get("latitude"));
		const from = q.get("start_date") ?? "";
		const to = q.get("end_date") ?? "";
		if (!Number.isFinite(lat) || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
			return json(400, { error: true, reason: "bad query" });
		total++;
		json(200, { latitude: lat, longitude: Number(q.get("longitude")), daily: archiveDaily(lat, from, to) });
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve(server));
	});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const i = process.argv.indexOf("--port");
	const port = Number(i > 0 ? process.argv[i + 1] : (process.env.WEATHER_STUB_PORT ?? 7099));
	await startWeatherStub(port);
	console.log(`[weather-stub] http://127.0.0.1:${port}`);
}

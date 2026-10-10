#!/usr/bin/env node
// Every outside service the app's server (and its browser map) asks, stubbed
// for e2e: runs never spend public services' quotas, never load them, and
// never depend on what they answer that day. `pnpm e2e:fast` starts it on
// :7099 and points each env here (scripts/lib/e2e-fast.ts overrides); it can
// also run on its own:
//
//   node e2e/stubs/services-stub.mjs [--port 7099] [--map-cache <dir>] [--record-map]
//
// GET /v1/archive?latitude&longitude&start_date&end_date (Open-Meteo,
//   OPEN_METEO_ARCHIVE_URL): every day in the range, made up but plausible:
//   warmer towards the equator, summer in July north of it and January south,
//   a few wet days a month.
// POST /api/interpreter (Overpass, OVERPASS_URL): no elements, so no place has
//   OSM hours and the hours sync changes nothing.
// GET /route/v1/foot/<lng>,<lat>;<lng>,<lat> (OSRM, OSRM_FOOT_URL): one walk,
//   the straight line × 1.3 at 1.25 m/s, drawn as a straight line (as
//   routes-stub.mjs).
// GET /fx@<YYYY-MM-DD|latest>/v1/currencies/usd.json (the currency-api,
//   FX_URL): fixed USD rates, one table before 2026-03-01 and one after (the
//   lira loses value between them, like the real one); a future date is a 404.
// GET /api/?q… and /reverse?lat&lon (Photon, PHOTON_URL): photon-stub.mjs.
// GET /__link?u=<url> (every page, oEmbed, image and short link the server
//   fetches, E2E_OUTBOUND_STUB): link-stub.mjs.
// GET /__map/… (the basemap's TileJSON, tiles, glyphs and imagery,
//   VITE_MAP_PROXY_URL): map-proxy.mjs, from .data/e2e-fast/map-cache.
// ANY /__deny/<service>/… (Google Places and Routes: e2e has no key, so
//   nothing should come): a 503, counted as a miss.
// GET /__stub/calls → { version, total, services: { <name>: { calls, misses,
//   missed: { <what>: n } } } }: e2e:fast prints the misses at the end.
// POST /__stub/quit: stops it (a newer runner replacing an older stub).
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLinks } from "./link-stub.mjs";
import { createMapProxy } from "./map-proxy.mjs";
import { loadPhoton } from "./photon-stub.mjs";

/** Bumped when the routes change: e2e:fast replaces an older stub still running. */
export const STUB_VERSION = 3;
const ROOT = new URL("../../", import.meta.url);
const DAY_MS = 86_400_000;

/** OSRM's answer for a walk between two points: the straight line × 1.3 at 1.25 m/s. */
export function osrmFoot(coords) {
	const pts = coords.split(";").map((p) => p.split(",").map(Number));
	if (pts.length !== 2 || pts.some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n)))) return null;
	const [[lng1, lat1], [lng2, lat2]] = pts;
	const rad = Math.PI / 180;
	const s =
		Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
		Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
	const distance = Math.round(2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(s))) * 1.3);
	return {
		code: "Ok",
		routes: [
			{
				distance,
				duration: Math.max(60, Math.round(distance / 1.25)),
				geometry: { type: "LineString", coordinates: [[lng1, lat1], [lng2, lat2]] },
			},
		],
	};
}

/** USD → quote before 2026-03-01 and from then on (lower-case codes, as the currency-api). */
const FX_BEFORE = { usd: 1, jpy: 146, krw: 1350, twd: 31.5, vnd: 24500, try: 34, cad: 1.36, eur: 0.92, gbp: 0.78, aud: 1.5, thb: 34.5 };
const FX_AFTER = { usd: 1, jpy: 150, krw: 1380, twd: 32, vnd: 25400, try: 45, cad: 1.38, eur: 0.9, gbp: 0.76, aud: 1.52, thb: 35 };

/** The currency-api's day file for `date` (`latest`: today), or null for a day that hasn't come. */
export function fxDay(date, today = new Date().toISOString().slice(0, 10)) {
	const d = date === "latest" ? today : date;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > today) return null;
	return { date: d, usd: d < "2026-03-01" ? FX_BEFORE : FX_AFTER };
}

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

/**
 * Starts the stub on 127.0.0.1 (and ::1, for the browser's `localhost`);
 * resolves once it listens. `mapCache`: the basemap cache directory;
 * `recordMap`: fetch basemap misses once (map-proxy.mjs).
 */
export async function startServicesStub(port, opts = {}) {
	const photon = loadPhoton(ROOT);
	const link = loadLinks(ROOT);
	const recordMap = !!opts.recordMap;
	const map = createMapProxy({
		cacheDir: opts.mapCache ?? fileURLToPath(new URL(".data/e2e-fast/map-cache", ROOT)),
		record: recordMap,
		log: (m) => console.log(`[services-stub] ${m}`),
	});
	const stats = { version: STUB_VERSION, recordMap, total: 0, services: {} };
	/** One call to `service`; a miss is kept by what was asked (at most 300 kinds). */
	const count = (service, hit = true, what = "") => {
		stats.total++;
		const s = (stats.services[service] ??= { calls: 0, misses: 0, missed: {} });
		s.calls++;
		if (hit) return;
		s.misses++;
		if (what in s.missed || Object.keys(s.missed).length < 300) s.missed[what] = (s.missed[what] ?? 0) + 1;
	};
	const servers = [];
	const handler = async (req, res) => {
		const url = new URL(req.url ?? "/", "http://stub");
		const send = (status, headers, body) => {
			res.writeHead(status, headers);
			res.end(body);
		};
		const json = (status, body) => send(status, { "content-type": "application/json" }, JSON.stringify(body));
		if (url.pathname === "/__stub/calls") return json(200, stats);
		if (url.pathname === "/__stub/quit" && req.method === "POST") {
			json(200, { bye: true });
			for (const s of servers) s.close();
			setTimeout(() => process.exit(0), 50).unref();
			return;
		}
		if (url.pathname.startsWith("/__map/")) {
			const r = await map(url.pathname, `http://${req.headers.host ?? `localhost:${port}`}`);
			count("map", r.hit, r.key);
			return send(r.res.status, r.res.headers, r.res.body);
		}
		if (url.pathname === "/__link") {
			const r = link(url.searchParams.get("u") ?? "", String(req.headers.accept ?? "*/*"));
			count("link", r.hit, r.key);
			return send(r.res.status, r.res.headers, r.res.body);
		}
		const deny = /^\/__deny\/([\w-]+)(\/.*)?$/.exec(url.pathname);
		if (deny) {
			req.resume();
			count(deny[1], false, `${req.method} ${deny[2] ?? "/"}`);
			return json(503, { error: { code: 503, message: "e2e: no outside services" } });
		}
		if (req.method === "GET" && url.pathname === "/api/") {
			const r = photon.search(url.searchParams);
			count("photon", r.hit, `search ${r.key}`);
			return json(200, r.body);
		}
		if (req.method === "GET" && url.pathname === "/reverse") {
			const r = photon.reverse(url.searchParams);
			count("photon", r.hit, `reverse ${r.key}`);
			return json(200, r.body);
		}
		if (req.method === "GET" && url.pathname.startsWith("/route/v1/foot/")) {
			count("osrm");
			const r = osrmFoot(decodeURIComponent(url.pathname.slice("/route/v1/foot/".length)));
			return r ? json(200, r) : json(400, { code: "InvalidQuery" });
		}
		const fx = /^\/fx@([\w-]+)\/v1\/currencies\/usd\.json$/.exec(url.pathname);
		if (req.method === "GET" && fx) {
			count("fx");
			const day = fxDay(fx[1]);
			return day ? json(200, day) : json(404, { error: "not found" });
		}
		if (req.method === "POST" && url.pathname === "/api/interpreter") {
			count("overpass");
			req.resume();
			return json(200, { version: 0.6, elements: [] });
		}
		if (req.method === "GET" && url.pathname === "/v1/archive") {
			const q = url.searchParams;
			const lat = Number(q.get("latitude"));
			const from = q.get("start_date") ?? "";
			const to = q.get("end_date") ?? "";
			if (!Number.isFinite(lat) || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
				count("open-meteo", false, "bad query");
				return json(400, { error: true, reason: "bad query" });
			}
			count("open-meteo");
			return json(200, { latitude: lat, longitude: Number(q.get("longitude")), daily: archiveDaily(lat, from, to) });
		}
		req.resume();
		count("unknown", false, `${req.method} ${url.pathname}`);
		json(404, { error: true, reason: "not found" });
	};
	const listen = (host) =>
		new Promise((resolve, reject) => {
			const server = createServer((req, res) =>
				handler(req, res).catch((e) => {
					console.error("[services-stub]", e);
					if (!res.headersSent) res.writeHead(500);
					res.end();
				}),
			);
			server.once("error", reject);
			server.listen(port, host, () => {
				servers.push(server);
				resolve(server);
			});
		});
	const main = await listen("127.0.0.1");
	await listen("::1").catch(() => {}); // no IPv6 loopback: 127.0.0.1 alone
	return main;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const arg = (name) => {
		const i = process.argv.indexOf(name);
		return i > 0 ? process.argv[i + 1] : undefined;
	};
	const port = Number(arg("--port") ?? process.env.SERVICES_STUB_PORT ?? 7099);
	const recordMap = process.argv.includes("--record-map");
	await startServicesStub(port, { mapCache: arg("--map-cache"), recordMap });
	console.log(`[services-stub] http://127.0.0.1:${port}${recordMap ? " (recording the basemap)" : ""}`);
}

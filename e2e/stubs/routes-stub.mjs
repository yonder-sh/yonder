#!/usr/bin/env node
// Google Routes stub (QA TI-4; SPEC §18.3 WP-Transit): the app's server calls
// Routes, so page.route() can't intercept it — point GOOGLE_ROUTES_URL here.
//
//   node e2e/stubs/routes-stub.mjs [--port 5153]      (5103 + 10n per agent)
//   GOOGLE_MAPS_API_KEY=stub GOOGLE_ROUTES_URL=http://127.0.0.1:5153 pnpm dev
//
// POST /directions/v2:computeRoutes
//   WALK:    one route, haversine × 1.3 at 4.8 km/h (min 1 min), a straight line.
//   TRANSIT: three canned routes relative to `departureTime` — JR Chuo Rapid
//            15 min door to door, JR Chuo-Sobu Local 19, Kanto Bus 30 (QA
//            TR-03) — returned slowest first so the app must rank them.
// GET /route/v1/foot/<lng>,<lat>;<lng>,<lat>  (OSRM foot, for OSRM_FOOT_URL):
//   one route, haversine × `osrm.factor` (1.3) at 1.25 m/s — or a detour set
//   with POST /__stub/osrm (a lake in the way: QA MT-06 Oishi Park → Lake
//   Kawaguchiko is 5.9 km / 78 min on foot, 28 min by the straight line).
// Control:
//   GET  /__stub/calls   → { total, walk, transit, osrm, requests: [{ mode, body, at }] }
//   POST /__stub/reset   → clears counters, queued failures and the OSRM factor
//   POST /__stub/next    { status?: 429|500, empty?: true, times?: n } → the next
//                        n calls fail with that status or return no routes
//   POST /__stub/osrm    { factor?, detours?: [{ lat, lng, radiusM, factor }] } →
//                        OSRM walk distance = straight line × factor, or × a
//                        detour's factor when either end lies within its radius
// Every Google request must carry X-Goog-Api-Key and X-Goog-FieldMask (else 400).
import { createServer } from "node:http";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const port = Number(arg("port", process.env.ROUTES_STUB_PORT ?? "5153"));

const state = { total: 0, walk: 0, transit: 0, osrm: 0, factor: 1.3, detours: [], requests: [], queue: [] };

const R = 6_371_008.8;
const rad = Math.PI / 180;
function haversineM(a, b) {
	const dLat = (b.latitude - a.latitude) * rad;
	const dLng = (b.longitude - a.longitude) * rad;
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const line = (a, b) => ({
	geoJsonLinestring: {
		type: "LineString",
		coordinates: [
			[a.longitude, a.latitude],
			[b.longitude, b.latitude],
		],
	},
});

function walkRoute(o, d) {
	const m = haversineM(o, d) * 1.3;
	const sec = Math.max(60, Math.round(m / (4800 / 3600)));
	return { routes: [{ duration: `${sec}s`, distanceMeters: Math.round(m), polyline: line(o, d) }] };
}

function transitRoutes(o, d, departureTime) {
	const t0 = Date.parse(departureTime ?? new Date().toISOString());
	const iso = (min) => new Date(t0 + min * 60_000).toISOString();
	const mk = ({ walkBefore, ride, walkAfter, name, short, color, vehicle, agency }) => {
		const dep = walkBefore;
		const arr = walkBefore + ride;
		return {
			duration: `${(walkBefore + ride + walkAfter) * 60}s`,
			distanceMeters: 7000,
			polyline: line(o, d),
			travelAdvisory: { transitFare: { currencyCode: "JPY", units: "210" } },
			legs: [
				{
					steps: [
						{ travelMode: "WALK", staticDuration: `${walkBefore * 60}s`, distanceMeters: 300, polyline: line(o, o) },
						{
							travelMode: "TRANSIT",
							staticDuration: `${ride * 60}s`,
							distanceMeters: 6400,
							polyline: line(o, d),
							transitDetails: {
								stopDetails: {
									departureStop: { name: "Ogikubo", location: { latLng: o } },
									arrivalStop: { name: "Nakano", location: { latLng: d } },
									departureTime: iso(dep),
									arrivalTime: iso(arr),
								},
								headsign: "Tokyo",
								stopCount: 2,
								transitLine: {
									name,
									nameShort: short,
									color,
									textColor: "#ffffff",
									agencies: [{ name: agency }],
									vehicle: { type: vehicle },
								},
							},
						},
						{ travelMode: "WALK", staticDuration: `${walkAfter * 60}s`, distanceMeters: 300, polyline: line(d, d) },
					],
				},
			],
		};
	};
	return {
		routes: [
			mk({ walkBefore: 3, ride: 24, walkAfter: 3, name: "Kanto Bus", short: "Kanto", color: "#1c73c5", vehicle: "BUS", agency: "Kanto Bus" }),
			mk({ walkBefore: 3, ride: 13, walkAfter: 3, name: "JR Chuo-Sobu Line (Local)", short: "Chuo-Sobu", color: "#ffd400", vehicle: "HEAVY_RAIL", agency: "JR East" }),
			mk({ walkBefore: 3, ride: 9, walkAfter: 3, name: "JR Chuo Line (Rapid)", short: "Chuo Rapid", color: "#f15a22", vehicle: "HEAVY_RAIL", agency: "JR East" }),
		],
	};
}

/** OSRM foot: `lng,lat;lng,lat` → one route along the straight line, detoured by `factor`. */
function osrmFoot(coords) {
	const pts = coords.split(";").map((p) => p.split(",").map(Number));
	const [a, b] = pts;
	if (pts.length !== 2 || !a || !b || [...a, ...b].some((x) => !Number.isFinite(x))) return null;
	const o = { longitude: a[0], latitude: a[1] };
	const d = { longitude: b[0], latitude: b[1] };
	const near = (p) => (x) => haversineM(p, { latitude: x.lat, longitude: x.lng }) <= x.radiusM;
	const detour = state.detours.find((x) => near(o)(x) || near(d)(x));
	const distance = Math.round(haversineM(o, d) * (detour?.factor ?? state.factor));
	return {
		code: "Ok",
		routes: [
			{
				distance,
				duration: Math.max(60, Math.round(distance / 1.25)),
				geometry: { type: "LineString", coordinates: [a, b] },
			},
		],
	};
}

const json = (res, status, body) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};

const readBody = (req) =>
	new Promise((resolve) => {
		let s = "";
		req.on("data", (c) => {
			s += c;
		});
		req.on("end", () => resolve(s));
	});

createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://stub");
	if (req.method === "GET" && url.pathname === "/__stub/calls")
		return json(res, 200, { total: state.total, walk: state.walk, transit: state.transit, osrm: state.osrm, requests: state.requests });
	if (req.method === "POST" && url.pathname === "/__stub/reset") {
		Object.assign(state, { total: 0, walk: 0, transit: 0, osrm: 0, factor: 1.3, detours: [], requests: [], queue: [] });
		return json(res, 200, { ok: true });
	}
	if (req.method === "POST" && url.pathname === "/__stub/osrm") {
		const b = JSON.parse((await readBody(req)) || "{}");
		if (typeof b.factor === "number" && b.factor >= 1) state.factor = b.factor;
		if (Array.isArray(b.detours)) state.detours = b.detours;
		return json(res, 200, { factor: state.factor, detours: state.detours });
	}
	if (req.method === "GET" && url.pathname.startsWith("/route/v1/foot/")) {
		state.osrm++;
		const r = osrmFoot(decodeURIComponent(url.pathname.slice("/route/v1/foot/".length)));
		return r ? json(res, 200, r) : json(res, 400, { code: "InvalidQuery" });
	}
	if (req.method === "POST" && url.pathname === "/__stub/next") {
		const b = JSON.parse((await readBody(req)) || "{}");
		for (let i = 0; i < (b.times ?? 1); i++) state.queue.push({ status: b.status, empty: b.empty });
		return json(res, 200, { queued: state.queue.length });
	}
	if (req.method === "POST" && url.pathname === "/directions/v2:computeRoutes") {
		const raw = await readBody(req);
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			return json(res, 400, { error: { message: "bad json" } });
		}
		if (!req.headers["x-goog-api-key"] || !req.headers["x-goog-fieldmask"])
			return json(res, 400, { error: { message: "missing key or field mask" } });
		const mode = body.travelMode;
		state.total++;
		if (mode === "WALK") state.walk++;
		if (mode === "TRANSIT") state.transit++;
		state.requests.push({ mode, body, at: new Date().toISOString() });
		if (state.requests.length > 100) state.requests.shift();
		const next = state.queue.shift();
		if (next?.status) return json(res, next.status, { error: { code: next.status } });
		if (next?.empty) return json(res, 200, {});
		const o = body.origin?.location?.latLng;
		const d = body.destination?.location?.latLng;
		if (!o || !d) return json(res, 400, { error: { message: "origin/destination" } });
		return json(res, 200, mode === "WALK" ? walkRoute(o, d) : transitRoutes(o, d, body.departureTime));
	}
	json(res, 404, { error: "not found" });
}).listen(port, "127.0.0.1", () => {
	console.log(`[routes-stub] listening on http://127.0.0.1:${port}`);
});

// The basemap for e2e, served by services-stub.mjs under /__map/ from an
// on-disk cache (.data/e2e-fast/map-cache, gitignored), never from the internet. The
// app points its styles here when VITE_MAP_PROXY_URL is set
// (src/features/map/styles/proxy.ts):
//   /__map/ofm/planet                      OpenFreeMap's TileJSON, its tiles
//                                          pointed back here at one pinned
//                                          version (`_`, like src/sw.ts)
//   /__map/ofm/planet/<v>/<z>/<x>/<y>.pbf  vector tiles (any <v> is `_`)
//   /__map/ofm/fonts/<stack>/<range>.pbf   glyphs
//   /__map/arcgis/…/tile/<z>/<y>/<x>       Esri World Imagery (Satellite)
// A miss is never an error (the map's tile-health chip counts errors): an
// empty 200 for tiles and glyphs (a blank tile, no labels), a transparent PNG
// for imagery, a TileJSON made up here; each is counted.
//
// Record mode (`pnpm e2e:tiles:warm`, services-stub --record-map) fetches a
// miss from the real host once and stores it: one request at a time, at most
// 4 a second, with a User-Agent that says what it is. Only what the suite
// browses is fetched (OpenFreeMap's terms forbid bulk prefetching).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { solidPng } from "./link-stub.mjs";

const UPSTREAM = { ofm: "https://tiles.openfreemap.org", arcgis: "https://server.arcgisonline.com" };
const TRANSPARENT = solidPng(1, 1, [0, 0, 0, 0]);
const UA = `Yonder-e2e/1.0 (tile cache warm for a local test suite; +${process.env.OSM_CONTACT || "dev"})`;

/** `/planet/20260913_164504_pt/5/28/12.pbf` → `/planet/_/5/28/12.pbf`. */
const pinned = (p) => p.replace(/^\/planet\/[^/]+\//, "/planet/_/");

export function createMapProxy({ cacheDir, record = false, log = () => {} }) {
	let queue = Promise.resolve();
	let last = 0;
	/** One upstream request at a time, 250 ms apart at least. */
	const upstream = (url) => {
		const run = queue.then(async () => {
			const wait = last + 250 - Date.now();
			if (wait > 0) await new Promise((r) => setTimeout(r, wait));
			last = Date.now();
			const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
			if (!res.ok) throw new Error(`${url} → ${res.status}`);
			return { type: res.headers.get("content-type") ?? "", body: Buffer.from(await res.arrayBuffer()) };
		});
		queue = run.catch(() => {});
		return run;
	};
	const file = (key, p) => path.join(cacheDir, key, p.replace(/\.\.+/g, "_"));
	const read = (f) => (existsSync(f) ? readFileSync(f) : null);
	const store = (f, body) => {
		mkdirSync(path.dirname(f), { recursive: true });
		writeFileSync(f, body);
	};

	/** Record mode: one upstream fetch per file, however many ask at once. */
	const inflight = new Map();
	const fetchOnce = (f, url) => {
		if (!inflight.has(f))
			inflight.set(
				f,
				upstream(url)
					.then(({ body }) => {
						store(f, body);
						return body;
					})
					.finally(() => inflight.delete(f)),
			);
		return inflight.get(f);
	};

	let tj = null;
	/** The upstream TileJSON (cached, or fetched in record mode), or null. */
	async function tilejson() {
		if (tj) return tj;
		const f = file("ofm", "planet.tilejson");
		const body = read(f) ?? (record ? await fetchOnce(f, `${UPSTREAM.ofm}/planet`) : null);
		tj = body ? JSON.parse(body.toString("utf8")) : null;
		return tj;
	}

	/** Serves `/__map/<key>/<path>`; resolves to { hit, key, res }. */
	return async function answer(pathname, origin) {
		const m = /^\/__map\/(ofm|arcgis)(\/.*)$/.exec(pathname);
		if (!m) return { hit: false, key: pathname, res: { status: 404, headers: {}, body: "" } };
		const [, key, rest] = m;
		const id = `${key}${pinned(rest)}`;
		const cors = { "access-control-allow-origin": "*", "cache-control": "public, max-age=86400" };
		const ok = (type, body) => ({ status: 200, headers: { ...cors, "content-type": type }, body });
		try {
			if (key === "ofm" && rest === "/planet") {
				const tj = await tilejson();
				const tiles = [`${origin}/__map/ofm/planet/_/{z}/{x}/{y}.pbf`];
				if (tj) return { hit: true, key: id, res: ok("application/json", JSON.stringify({ ...tj, tiles })) };
				const made = { tilejson: "3.0.0", tiles, minzoom: 0, maxzoom: 14, bounds: [-180, -85.0511, 180, 85.0511], attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>', vector_layers: [] };
				return { hit: false, key: id, res: ok("application/json", JSON.stringify(made)) };
			}
			const isPbf = rest.endsWith(".pbf");
			const f = file(key, isPbf ? pinned(rest) : `${rest}.img`);
			const type = isPbf ? "application/x-protobuf" : "image/jpeg";
			const have = read(f);
			if (have) return { hit: true, key: id, res: ok(have[0] === 0x89 ? "image/png" : type, have) };
			if (record) {
				let url = `${UPSTREAM[key]}${rest}`;
				if (key === "ofm" && rest.startsWith("/planet/")) {
					const tj = await tilejson();
					const t = /^\/planet\/[^/]+\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(rest);
					if (tj?.tiles?.[0] && t) url = tj.tiles[0].replace("{z}", t[1]).replace("{x}", t[2]).replace("{y}", t[3]);
				}
				try {
					const body = await fetchOnce(f, url);
					log(`recorded ${id} (${body.length} B)`);
					return { hit: true, key: id, res: ok(body[0] === 0x89 ? "image/png" : type, body) };
				} catch (e) {
					log(`record failed ${id}: ${e instanceof Error ? e.message : e}`);
				}
			}
			return { hit: false, key: id, res: isPbf ? ok(type, Buffer.alloc(0)) : ok("image/png", TRANSPARENT) };
		} catch (e) {
			log(`map proxy ${id}: ${e instanceof Error ? e.message : e}`);
			return { hit: false, key: id, res: ok("application/octet-stream", Buffer.alloc(0)) };
		}
	};
}

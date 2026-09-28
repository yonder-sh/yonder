// Photon (photon.komoot.io) for e2e, served by services-stub.mjs: place
// search (GET /api/) and reverse geocoding (GET /reverse), shaped like
// Photon's GeoJSON. Answers come from, in order:
//   1. e2e/stubs/fixtures/photon.json `search` / `reverse`: real answers,
//      recorded once by scripts/e2e-record-photon.ts, keyed by the normalised
//      query and its layers ("itoya ginza|", "tokyo|city,county") or by the
//      point to 4 decimals ("35.6941,139.7045");
//   2. its `empty` patterns: queries that find nothing on purpose (a spec's
//      random name);
//   3. a gazetteer of the seed's countries, cities, areas and places
//      (seed/data/geocode-hints.json): the importer's fallback
//      ("Nishiki Market, Kyoto, Japan") and any trip place by name; a point
//      within 150 m of one of them for reverse.
// Anything else is an empty FeatureCollection, counted as a miss.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
/** Folded for matching: no accents, apostrophes or punctuation. */
const fold = (s) =>
	norm(s)
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/['’`.]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

export const searchKey = (q, layers = []) => `${norm(q)}|${[...layers].sort().join(",")}`;
export const reverseKey = (lat, lon) => `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;

const metres = (a, b) => {
	const rad = Math.PI / 180;
	const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
	const y = (b[1] - a[1]) * rad;
	return Math.hypot(x, y) * 6_371_000;
};

/** A stable fake OSM node id (15 digits at most) for a gazetteer entry. */
const fakeId = (key) => 900_000_000_000_000 + (Number.parseInt(createHash("sha1").update(key).digest("hex").slice(0, 12), 16) % 99_999_999_999_999);

const CATEGORY = {
	Neighborhood: ["place", "suburb", "district"],
	Shopping: ["shop", "mall", "house"],
	Food: ["amenity", "restaurant", "house"],
	Restaurant: ["amenity", "restaurant", "house"],
	Bar: ["amenity", "bar", "house"],
	Cafe: ["amenity", "cafe", "house"],
	Temple: ["amenity", "place_of_worship", "house"],
	Shrine: ["amenity", "place_of_worship", "house"],
	Museum: ["tourism", "museum", "house"],
	Park: ["leisure", "park", "house"],
	Hotel: ["tourism", "hotel", "house"],
};

/** Photon features for the seed's hints (countries, cities, areas, places, stations). */
export function gazetteer(hints) {
	const cc = Object.fromEntries((hints.countries ?? []).map((c) => [c.country, c.iso2]));
	const feature = (key, name, at, props) => ({
		type: "Feature",
		geometry: { type: "Point", coordinates: [at.lng, at.lat] },
		properties: { osm_type: "N", osm_id: fakeId(key), name, ...props },
	});
	const out = [];
	for (const c of hints.countries ?? [])
		out.push(feature(c.key, c.country, c, { osm_key: "place", osm_value: "country", type: "country", country: c.country, countrycode: c.iso2 }));
	for (const c of hints.cities ?? [])
		out.push(feature(c.key, c.city, c, { osm_key: "place", osm_value: "city", type: "city", country: c.country, countrycode: cc[c.country] }));
	for (const a of hints.areas ?? [])
		out.push(feature(a.key, a.area, a, { osm_key: "place", osm_value: "suburb", type: "district", city: a.city, country: a.country, countrycode: cc[a.country] }));
	for (const p of hints.places ?? []) {
		if (p.is_area_row) continue;
		const [osm_key, osm_value, type] = CATEGORY[p.category] ?? ["tourism", "attraction", "house"];
		out.push(
			feature(p.key, p.place, p, { osm_key, osm_value, type, district: p.area ?? undefined, city: p.city, country: p.country, countrycode: cc[p.country] }),
		);
	}
	for (const t of hints.transit_points ?? [])
		out.push(feature(`transit|${t.name}`, t.name, t, { osm_key: "railway", osm_value: "station", type: "house" }));
	return out;
}

const LAYER_TYPES = { country: ["country"], state: ["state"], city: ["city"], county: ["county", "city"], district: ["district"], locality: ["locality", "district"] };

export function createPhoton({ fixture, hints }) {
	const places = gazetteer(hints ?? {});
	const empty = (fixture.empty ?? []).map((p) => new RegExp(p, "i"));
	const fc = (features) => ({ type: "FeatureCollection", features });

	function fromGazetteer(q, layers, bias) {
		const [name, ...within] = q.split(",").map(fold);
		if (!name) return [];
		const types = layers.flatMap((l) => LAYER_TYPES[l] ?? []);
		const words = name.split(" ");
		const hits = places.filter((f) => {
			const p = f.properties;
			if (types.length && !types.includes(p.type)) return false;
			// Every word of the name ("kiyomizu dera" finds "Kiyomizu-dera Temple").
			const own = fold(p.name).split(" ");
			if (!words.every((w) => own.includes(w))) return false;
			// "Nishiki Market, Kyoto, Japan": every other part names where it is.
			const where = [p.city, p.district, p.country].map(fold);
			return within.every((w) => !w || where.includes(w));
		});
		// The exact name first, then the nearest to the bias.
		const rank = (f) => (fold(f.properties.name) === name ? 0 : 1);
		hits.sort(
			(a, b) =>
				rank(a) - rank(b) || (bias ? metres(a.geometry.coordinates, bias) - metres(b.geometry.coordinates, bias) : 0),
		);
		return hits;
	}

	return {
		/** GET /api/?q&limit&lang&lat&lon&layer… */
		search(params) {
			const q = params.get("q") ?? "";
			const layers = params.getAll("layer");
			const limit = Math.max(1, Math.min(50, Number(params.get("limit") ?? 12) || 12));
			const key = searchKey(q, layers);
			const lat = Number(params.get("lat"));
			const lon = Number(params.get("lon"));
			const bias = params.has("lat") && Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null;
			const rec = fixture.search?.[key];
			if (rec) return { hit: true, key, body: fc(rec.features.slice(0, limit)) };
			if (empty.some((re) => re.test(norm(q)))) return { hit: true, key, body: fc([]) };
			const found = fromGazetteer(q, layers, bias);
			return { hit: found.length > 0, key, body: fc(found.slice(0, limit)) };
		},
		/** GET /reverse?lat&lon */
		reverse(params) {
			const lat = Number(params.get("lat"));
			const lon = Number(params.get("lon"));
			const key = reverseKey(lat, lon);
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { hit: false, key, body: fc([]) };
			const rec = fixture.reverse?.[key];
			if (rec) return { hit: true, key, body: fc(rec.features.slice(0, 1)) };
			let best = null;
			let bestM = 150;
			for (const f of places) {
				if (f.properties.type !== "house") continue;
				const m = metres(f.geometry.coordinates, [lon, lat]);
				if (m <= bestM) [best, bestM] = [f, m];
			}
			return { hit: !!best, key, body: fc(best ? [best] : []) };
		},
	};
}

/** The stub's Photon from the fixture and the seed's hints (paths from the repo root). */
export function loadPhoton(root) {
	const read = (p) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
	return createPhoton({ fixture: read("e2e/stubs/fixtures/photon.json"), hints: read("seed/data/geocode-hints.json") });
}

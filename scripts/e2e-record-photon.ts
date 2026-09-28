/**
 * `pnpm e2e:photon:record [--force] [--dry-run]`: records the Photon answers
 * the e2e specs need into e2e/stubs/fixtures/photon.json, which the services
 * stub replays (e2e/stubs/photon-stub.mjs). Tests never ask Photon; run this
 * by hand when a spec starts searching for something new (add it below).
 *
 * Polite: only the entries the fixture lacks (--force: all of them), one
 * request at a time at most one a second, with the app's User-Agent, and the
 * same query string the app sends (providers.server.ts: q lower-cased,
 * limit 12, lang en, the bias rounded to 2 decimals, layers).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve(
	import.meta.dirname,
	"../e2e/stubs/fixtures/photon.json",
);
const PHOTON = "https://photon.komoot.io";
const UA = `${process.env.APP_NAME || "Yonder"}/1.0 (+${process.env.OSM_CONTACT || "dev"}; e2e fixture recording)`;

// Bias points (the palette's scope node, rounded like the app).
const TOKYO: Bias = [35.68, 139.65]; // demo trip's Tokyo
const TOKYO_QA: Bias = [35.68, 139.77]; // QA seed's Tokyo
const KYOTO: Bias = [35.01, 135.77];
const GOLDEN_GAI: Bias = [35.69, 139.7];
const GINZA_LINK: Bias = [35.67, 139.77]; // the shared Itoya Maps links

type Bias = [lat: number, lng: number];
type Search = { q: string; layers?: string[]; bias?: Bias; why: string };

/** Every place search a spec (or the seed importer) makes. */
const SEARCHES: Search[] = [
	{
		q: "itoya ginza",
		bias: TOKYO,
		why: "places-search: filed Japan › Tokyo › Ginza",
	},
	{
		q: "tokyo tower",
		bias: TOKYO,
		why: "places-search, qa-visual-r3 (> 4 options)",
	},
	{ q: "nishiki market", bias: KYOTO, why: "places-search: Set location" },
	{ q: "senso-ji", bias: TOKYO, why: "places-search (phone)" },
	{
		q: "tokyo",
		layers: ["country"],
		why: "integration-journeys: Where to first?",
	},
	{
		q: "tokyo",
		layers: ["city", "county"],
		why: "integration-journeys: Where to first?",
	},
	{
		q: "shibuya sky",
		bias: [35.68, 139.76],
		why: "integration-journeys: Japan › Tokyo",
	},
	{ q: "bar kuro", bias: GOLDEN_GAI, why: "Set location on the QA Bar Kuro" },
	{ q: "shinjuku", bias: TOKYO_QA, why: "places-qa-fixes, qa-plan-r2/r3" },
	{ q: "fuji excursion", why: "places-qa-fixes" },
	{ q: "golden gai", why: "places-qa-fixes, qa-security-authz2" },
	{ q: "daan", why: "qa-plan-regressions, qa-content-35" },
	{ q: "rate", bias: TOKYO_QA, why: "places-fb-r4, shell-feedback-r1" },
	{
		q: "itoya",
		bias: GINZA_LINK,
		why: "shared Itoya Maps links (SHR-07, E8, share target)",
	},
	{ q: "g.itoya", bias: GINZA_LINK, why: "qa-security-r2-shr07" },
];

/** Every reverse geocode (dropped pins, pasted coordinates, Maps links without a match). */
const REVERSES: { at: Bias; why: string }[] = [
	{ at: [35.6941, 139.7045], why: "pasted coordinates at Golden Gai" },
	{ at: [35.0037, 135.7788], why: "home-share-target's Kissa link: in Kyoto" },
	{ at: [35.6739, 139.7676], why: "the Itoya links, if their search misses" },
	{ at: [35.6729, 139.7678], why: "the Itoya links, if their search misses" },
];

export type PhotonFixture = {
	about: string;
	search: Record<
		string,
		{
			q: string;
			layers: string[];
			bias: Bias | null;
			recordedAt: string;
			features: unknown[];
		}
	>;
	reverse: Record<
		string,
		{ lat: number; lon: number; recordedAt: string; features: unknown[] }
	>;
	/** Queries that find nothing on purpose (random names): not misses. */
	empty: string[];
};

export const searchKey = (q: string, layers: readonly string[] = []) =>
	`${q.trim().toLowerCase().replace(/\s+/g, " ")}|${[...layers].sort().join(",")}`;
export const reverseKey = (lat: number, lon: number) =>
	`${lat.toFixed(4)},${lon.toFixed(4)}`;

function load(): PhotonFixture {
	try {
		return JSON.parse(readFileSync(FIXTURE, "utf8")) as PhotonFixture;
	} catch {
		return {
			about: "",
			search: {},
			reverse: {},
			empty: [],
		};
	}
}

let last = 0;
async function get(url: URL): Promise<unknown[]> {
	const wait = last + 1100 - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	last = Date.now();
	const res = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`${url} → ${res.status}`);
	const body = (await res.json()) as { features?: unknown[] };
	return body.features ?? [];
}

async function main() {
	const force = process.argv.includes("--force");
	const dry = process.argv.includes("--dry-run");
	const fx = load();
	fx.about =
		"Photon answers for the e2e specs, replayed by e2e/stubs/photon-stub.mjs. Recorded by scripts/e2e-record-photon.ts (pnpm e2e:photon:record); OSM data © OpenStreetMap contributors (ODbL).";
	fx.empty = fx.empty?.length
		? fx.empty
		: ["^zzqxwv qqpl$", "^omakase[0-9a-f]{6}x$", "^kissa [0-9a-f]{4}$"];
	const todo: { key: string; url: URL; save: (f: unknown[]) => void }[] = [];
	const now = new Date().toISOString();
	for (const s of SEARCHES) {
		const key = searchKey(s.q, s.layers);
		if (fx.search[key] && !force) continue;
		const url = new URL("/api/", PHOTON);
		url.searchParams.set("q", s.q);
		url.searchParams.set("limit", "12");
		url.searchParams.set("lang", "en");
		if (s.bias) {
			url.searchParams.set("lat", String(s.bias[0]));
			url.searchParams.set("lon", String(s.bias[1]));
		}
		for (const l of s.layers ?? []) url.searchParams.append("layer", l);
		todo.push({
			key,
			url,
			save: (features) => {
				fx.search[key] = {
					q: s.q,
					layers: s.layers ?? [],
					bias: s.bias ?? null,
					recordedAt: now,
					features,
				};
			},
		});
	}
	for (const r of REVERSES) {
		const key = reverseKey(r.at[0], r.at[1]);
		if (fx.reverse[key] && !force) continue;
		const url = new URL("/reverse", PHOTON);
		url.searchParams.set("lat", String(r.at[0]));
		url.searchParams.set("lon", String(r.at[1]));
		url.searchParams.set("lang", "en");
		url.searchParams.set("limit", "1");
		todo.push({
			key,
			url,
			save: (features) => {
				fx.reverse[key] = {
					lat: r.at[0],
					lon: r.at[1],
					recordedAt: now,
					features,
				};
			},
		});
	}
	console.log(
		`[photon:record] ${todo.length} request(s) to ${PHOTON} as "${UA}"`,
	);
	if (todo.length > 200)
		throw new Error("more than 200 requests: record in smaller batches");
	for (const t of todo) {
		if (dry) {
			console.log(`  would ask ${t.url}`);
			continue;
		}
		const features = await get(t.url);
		t.save(features);
		console.log(`  ${t.key}: ${features.length} feature(s)`);
	}
	if (dry) return;
	const sorted = (o: Record<string, unknown>) =>
		Object.fromEntries(
			Object.entries(o).sort(([a], [b]) => a.localeCompare(b)),
		);
	fx.search = sorted(fx.search) as PhotonFixture["search"];
	fx.reverse = sorted(fx.reverse) as PhotonFixture["reverse"];
	writeFileSync(FIXTURE, `${JSON.stringify(fx, null, "\t")}\n`);
	console.log(`[photon:record] wrote ${path.relative(process.cwd(), FIXTURE)}`);
}

if (process.argv[1]?.endsWith("e2e-record-photon.ts"))
	main().catch((e) => {
		console.error("[photon:record]", e instanceof Error ? e.message : e);
		process.exitCode = 1;
	});

/**
 * `pnpm data:jp` (ADDENDUM §5, docs/JAPAN_TRANSIT.md §4): builds
 * `src/data/jp-rail/{graph.json,names-en.json,manifest.json}` from MLIT N02
 * (国土数値情報 鉄道データ, CC BY 4.0 — redistribution allowed, so the outputs
 * are committed).
 *
 * 1. The N02 zip is downloaded once into `.cache/jp-rail/` (or copied from the
 *    spike's raw folder when present) and checked against the pinned SHA-256.
 *    `--allow-new-hash` accepts a new edition (update PIN below afterwards).
 * 2. The UTF-8 GeoJSON pair is extracted next to it (the real-data tests read it).
 * 3. The graph is built with the estimate engine's `buildGraph` (~130 ms).
 * 4. English station names are a committed Wikidata (CC0) snapshot: the
 *    existing `names-en.json` is kept; `--names <file>` converts a fresh export
 *    in the spike's format (`spikes/japan-transit/n02/names.py`).
 * 5. `manifest.json` records sources, licences, hashes and the build id.
 *
 * Re-run once a year when MLIT publishes a new edition (about each April).
 */
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { buildGraph } from "../src/features/transit/server/jp/build.server";
import type {
	NamesEnFile,
	RailManifest,
} from "../src/features/transit/server/jp/load.server";
import type { N02Collection } from "../src/features/transit/server/jp/types.server";

const EDITION = "25";
const DATASET = `N02-${EDITION}`;
const URL = `https://nlftp.mlit.go.jp/ksj/gml/data/N02/${DATASET}/${DATASET}_GML.zip`;
const PAGE = "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html";
/** SHA-256 of N02-25_GML.zip (14.9 MB), checked 2026-09-23. */
const PIN = "aaf76af133b2e771e538fabc4646d2e443dc1d5a67b221382a28d744e706cc9f";
const DATA_DATE = "2025-12-31";

const ROOT = process.cwd();
const CACHE = path.join(ROOT, ".cache", "jp-rail");
const OUT = path.resolve(ROOT, process.env.JP_RAIL_DIR || "src/data/jp-rail");
const SPIKE_ZIP = path.join(
	ROOT,
	"spikes/japan-transit/estimate/data/raw",
	`${DATASET}_GML.zip`,
);
const SPIKE_NAMES = path.join(
	ROOT,
	"spikes/japan-transit/n02/n02-names-en.json",
);

const arg = (k: string): string | undefined => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (k: string) => process.argv.includes(`--${k}`);
const sha256 = (b: Uint8Array | string) =>
	createHash("sha256").update(b).digest("hex");

async function zipBytes(): Promise<Uint8Array> {
	mkdirSync(CACHE, { recursive: true });
	const file = path.join(CACHE, `${DATASET}_GML.zip`);
	if (!existsSync(file)) {
		if (existsSync(SPIKE_ZIP)) {
			console.log(`copy ${path.relative(ROOT, SPIKE_ZIP)}`);
			copyFileSync(SPIKE_ZIP, file);
		} else {
			console.log(`GET ${URL}`);
			const res = await fetch(URL, {
				headers: { "user-agent": "yonder (data:jp)" },
			});
			if (!res.ok) throw new Error(`N02 download: HTTP ${res.status}`);
			writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
		}
	}
	const bytes = new Uint8Array(readFileSync(file));
	const hash = sha256(bytes);
	if (hash !== PIN && !flag("allow-new-hash"))
		throw new Error(
			`N02 zip hash ${hash} ≠ pinned ${PIN}. A new edition? Re-run with --allow-new-hash and update PIN.`,
		);
	return bytes;
}

/** The spike's names export (`{code: [en, qid, kana, "codes"]}`) → `names-en.json`. */
function convertNames(file: string): NamesEnFile {
	const raw = JSON.parse(readFileSync(file, "utf8")) as Record<
		string,
		[string, ...unknown[]] | string
	>;
	const out: NamesEnFile = {};
	for (const code of Object.keys(raw).sort()) {
		const v = raw[code];
		const en = Array.isArray(v) ? v[0] : v;
		if (typeof en !== "string" || !en) continue;
		const codes = Array.isArray(v) && typeof v[3] === "string" ? v[3] : "";
		const numbers = codes
			.split("|")
			.filter((c) => /^[A-Z]{1,3}\d{1,3}$/.test(c));
		out[code] = numbers.length ? { en, no: numbers.join(" ") } : { en };
	}
	return out;
}

async function main() {
	const t0 = performance.now();
	const zip = await zipBytes();
	const files = unzipSync(zip, {
		filter: (f) => /UTF-8\/.*\.geojson$/.test(f.name),
	});
	const pick = (re: RegExp): string => {
		const k = Object.keys(files).find((n) => re.test(n));
		if (!k) throw new Error(`missing ${re} in the N02 zip`);
		const text = strFromU8(files[k] as Uint8Array);
		writeFileSync(path.join(CACHE, path.basename(k)), text);
		return text;
	};
	const sections = JSON.parse(
		pick(/RailroadSection\.geojson$/),
	) as N02Collection;
	const stations = JSON.parse(
		pick(/(?<!RailroadSection)Station\.geojson$/),
	) as N02Collection;
	const graph = buildGraph(sections, stations, {
		simplifyM: 25,
		dataset: DATASET,
		url: PAGE,
	});
	mkdirSync(OUT, { recursive: true });
	const graphJson = JSON.stringify(graph);
	writeFileSync(path.join(OUT, "graph.json"), graphJson);

	const namesFile = path.join(OUT, "names-en.json");
	const namesArg = arg("names");
	let names: NamesEnFile;
	if (namesArg) names = convertNames(namesArg);
	else if (existsSync(namesFile))
		names = JSON.parse(readFileSync(namesFile, "utf8")) as NamesEnFile;
	else if (existsSync(SPIKE_NAMES)) names = convertNames(SPIKE_NAMES);
	else {
		console.warn("no English names snapshot: station names stay Japanese");
		names = {};
	}
	const namesJson = `${JSON.stringify(names, null, "\t")}\n`;
	writeFileSync(namesFile, namesJson);

	// The build id ignores the build time: the same data gives the same id.
	const graphSha = sha256(
		JSON.stringify({ ...graph, source: { ...graph.source, builtAt: "" } }),
	);
	const manifest: RailManifest = {
		format: "yonder-jp-rail@1",
		build: `${DATASET}.${graphSha.slice(0, 10)}`,
		dataset: DATASET,
		dataDate: DATA_DATE,
		builtAt: new Date().toISOString(),
		sourceUrl: URL,
		sourceSha256: sha256(zip),
		datasetPage: PAGE,
		license: "CC BY 4.0",
		attributionJa: "「国土数値情報（鉄道データ）」（国土交通省）を加工して作成",
		attributionEn: `Rail network processed from MLIT National Land Numerical Information (Railway, ${DATASET}, as of ${DATA_DATE}), CC BY 4.0`,
		namesSource: "English station names: Wikidata (CC0)",
		graphSha256: sha256(graphJson),
		namesSha256: sha256(namesJson),
		lines: graph.lines.length,
		stations: graph.stats.stations ?? 0,
		edges: graph.edges.length,
	};
	writeFileSync(
		path.join(OUT, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	console.log(
		`jp-rail ${manifest.build}: ${manifest.lines} lines, ${manifest.stations} stations, ${manifest.edges} edges, graph ${(graphJson.length / 1e6).toFixed(2)} MB, ${Object.keys(names).length} English names · ${(performance.now() - t0).toFixed(0)} ms → ${path.relative(ROOT, OUT)}`,
	);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exitCode = 1;
});

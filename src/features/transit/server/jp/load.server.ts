/**
 * Loading the Japan rail data (ADDENDUM §5, JAPAN_TRANSIT §3–§4): the N02
 * graph, the English station names and the manifest written by
 * `pnpm data:jp` (`scripts/build-jp-rail.ts`) into `src/data/jp-rail/`
 * (`JP_RAIL_DIR`).
 *
 * The graph is read lazily, once per process (app and worker), with
 * `fs.readFile` — never a bundled import (2.5 MB). Loading takes ~100 ms.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { JP_RAIL_DIR } from "@/server/jp-rail.server";
import { type Graph, type PrepareOptions, prepareGraph } from "./graph.server";
import type { GraphData } from "./types.server";

/** `names-en.json`: N02 station code → English name (+ station numbering). */
export type NamesEnFile = Record<string, { en: string; no?: string }>;

/** `manifest.json` (flat: the app reads attribution and "data as of" from it). */
export type RailManifest = {
	format: "yonder-jp-rail@1";
	/** The build id every estimate route carries as `dataBuild`. */
	build: string;
	dataset: string;
	/** "as of" date of the dataset, `YYYY-MM-DD`. */
	dataDate: string;
	builtAt: string;
	sourceUrl: string;
	sourceSha256: string;
	datasetPage: string;
	license: string;
	attributionJa: string;
	attributionEn: string;
	namesSource: string;
	graphSha256: string;
	namesSha256: string;
	lines: number;
	stations: number;
	edges: number;
};

export const GRAPH_FILE = "graph.json";
export const NAMES_FILE = "names-en.json";
export const MANIFEST_FILE = "manifest.json";

function namesOptions(
	names: NamesEnFile | undefined,
): Pick<PrepareOptions, "namesEn" | "numbering"> {
	if (!names) return {};
	const namesEn: Record<string, string> = {};
	const numbering: Record<string, string> = {};
	for (const [code, v] of Object.entries(names)) {
		if (v.en) namesEn[code] = v.en;
		if (v.no) numbering[code] = v.no;
	}
	return { namesEn, numbering };
}

/** Parses a graph file (+ optional names) into the runtime graph. */
export function parseGraph(
	graphJson: string,
	names?: NamesEnFile,
	opts: PrepareOptions = {},
): Graph {
	const data = JSON.parse(graphJson) as GraphData;
	if (data.format !== "yonder-n02-graph@1")
		throw new Error(`unexpected graph format ${data.format}`);
	return prepareGraph(data, { ...namesOptions(names), ...opts });
}

/** Synchronous load for scripts and tests (`dir` defaults to JP_RAIL_DIR). */
export function loadGraphSync(
	dir: string = JP_RAIL_DIR,
	opts: PrepareOptions = {},
): Graph {
	let names: NamesEnFile | undefined;
	try {
		names = JSON.parse(
			readFileSync(path.join(dir, NAMES_FILE), "utf8"),
		) as NamesEnFile;
	} catch {
		names = undefined;
	}
	return parseGraph(
		readFileSync(path.join(dir, GRAPH_FILE), "utf8"),
		names,
		opts,
	);
}

export type JpRail = { graph: Graph; manifest: RailManifest };

let memo: Promise<JpRail | null> | undefined;

/**
 * The graph and manifest, loaded once per process; null when the data isn't
 * installed (`pnpm data:jp` not run). A failed load is retried next call.
 */
export function jpRail(): Promise<JpRail | null> {
	memo ??= (async () => {
		try {
			const [graphJson, namesJson, manifestJson] = await Promise.all([
				readFile(path.join(JP_RAIL_DIR, GRAPH_FILE), "utf8"),
				readFile(path.join(JP_RAIL_DIR, NAMES_FILE), "utf8").catch(() => null),
				readFile(path.join(JP_RAIL_DIR, MANIFEST_FILE), "utf8"),
			]);
			const names = namesJson
				? (JSON.parse(namesJson) as NamesEnFile)
				: undefined;
			return {
				graph: parseGraph(graphJson, names),
				manifest: JSON.parse(manifestJson) as RailManifest,
			};
		} catch (e) {
			const code = (e as { code?: string }).code;
			if (code !== "ENOENT")
				console.error(
					"[jp-rail] load failed:",
					e instanceof Error ? e.message : e,
				);
			memo = undefined;
			return null;
		}
	})();
	return memo;
}

/** Tests: forget the loaded graph. */
export function resetJpRail(): void {
	memo = undefined;
}

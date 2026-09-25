import { existsSync, readFileSync } from "node:fs";
import path, { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../build.server";
import type { GraphData, N02Collection } from "../types.server";
import { fc, sec, sta, straightLine } from "./fixtures";

describe("buildGraph (synthetic)", () => {
	const l = straightLine({
		op: "Op",
		line: "L1",
		names: ["A", "B", "C", "D"],
		lng0: 139,
		spacingKm: 1,
		codePrefix: "a",
	});
	const g = buildGraph(fc(l.sections), fc(l.stations), { simplifyM: 0 });

	it("one node per station, junction-free chain contracted to station-to-station edges", () => {
		expect(g.lines).toHaveLength(1);
		expect(g.nodes.filter((n) => n.n)).toHaveLength(4);
		expect(g.stats.junctions).toBe(0);
		expect(g.edges).toHaveLength(3);
	});
	it("edge lengths ≈ station spacing (half platforms included, curve bump adds a little)", () => {
		for (const e of g.edges) {
			expect(e.m).toBeGreaterThan(990);
			expect(e.m).toBeLessThan(1030);
		}
	});
	it("stations duplicated as sections are not double counted", () => {
		const total = g.edges.reduce((t, e) => t + e.m, 0);
		expect(total).toBeGreaterThan(2990);
		expect(total).toBeLessThan(3090);
	});

	it("merges parallel-track platforms that share a station code", () => {
		// two tracks between X and Y; both stations drawn once per track with the same code
		const t1 = straightLine({
			op: "Op",
			line: "Q",
			names: ["X", "Y"],
			lng0: 139,
			spacingKm: 2,
			codePrefix: "q",
		});
		const t2 = straightLine({
			op: "Op",
			line: "Q",
			names: ["X", "Y"],
			lng0: 139,
			lat: 35.0002,
			spacingKm: 2,
			codePrefix: "q",
		});
		const gg = buildGraph(
			fc([...t1.sections, ...t2.sections]),
			fc([...t1.stations, ...t2.stations]),
			{ simplifyM: 0 },
		);
		expect(gg.nodes.filter((n) => n.n)).toHaveLength(2);
		expect(gg.edges).toHaveLength(1); // parallel edges collapse to the shorter one
	});

	it("keeps a junction where a branch leaves between stations", () => {
		const j: [number, number] = [139.005, 35];
		const secs = [
			sec("Op", "B", [[139.0, 35], j]),
			sec("Op", "B", [j, [139.01, 35]]),
			sec("Op", "B", [j, [139.005, 35.01]]),
		];
		const sts = [
			sta("Op", "B", "W", "w1", [
				[138.999, 35],
				[139.0, 35],
			]),
			sta("Op", "B", "E", "e1", [
				[139.01, 35],
				[139.011, 35],
			]),
			sta("Op", "B", "N", "n1", [
				[139.005, 35.01],
				[139.005, 35.011],
			]),
		];
		const gg = buildGraph(
			fc([
				...secs,
				...sts.map((s) => ({ ...s, properties: { ...s.properties } })),
			]),
			fc(sts),
			{
				simplifyM: 0,
			},
		);
		expect(gg.stats.junctions).toBe(1);
		expect(gg.edges).toHaveLength(3);
	});

	it("attaches a station whose platform does not touch the track (≤ 300 m)", () => {
		const secs = [
			sec("Op", "G", [
				[139.0, 35],
				[139.02, 35],
			]),
		];
		const sts = [
			sta("Op", "G", "Gap", "g1", [
				[139.0, 35.001],
				[139.0005, 35.001],
			]),
		];
		const gg = buildGraph(fc(secs), fc(sts), { simplifyM: 0 });
		expect(gg.stats.isolatedStations).toBe(1);
		expect(gg.stats.attachedStations).toBe(1);
	});
});

// `pnpm data:jp` extracts the N02 GeoJSON pair here.
const RAW = path.resolve(process.cwd(), ".cache", "jp-rail");
const hasRaw = existsSync(join(RAW, "N02-25_RailroadSection.geojson"));

describe.skipIf(!hasRaw)("buildGraph (N02-25, real data)", () => {
	const load = (f: string) =>
		JSON.parse(readFileSync(join(RAW, f), "utf8")) as N02Collection;
	// Vitest still runs a skipped suite's body to collect its tests, so the
	// real data is only read once a test in this suite actually runs.
	let graph: GraphData | undefined;
	const data = (): GraphData => {
		graph ??= buildGraph(
			load("N02-25_RailroadSection.geojson"),
			load("N02-25_Station.geojson"),
			{ simplifyM: 0 },
		);
		return graph;
	};
	const lineKm = (op: string, name: string) => {
		const g = data();
		const li = g.lines.findIndex((l) => l.operator === op && l.name === name);
		return (
			g.edges
				.filter((e) => g.nodes[e.a]?.l === li)
				.reduce((t, e) => t + e.m, 0) / 1000
		);
	};
	it("covers all 597 lines and ~10k stations", () => {
		const g = data();
		expect(g.lines).toHaveLength(597);
		expect(g.stats.stations).toBeGreaterThan(10_000);
	});
	it("track lengths match reality (Tokaido Shinkansen ~515 km actual track, Fujikyu 26.6 km, Linimo 8.9 km)", () => {
		expect(lineKm("東海旅客鉄道", "東海道新幹線")).toBeGreaterThan(505);
		expect(lineKm("東海旅客鉄道", "東海道新幹線")).toBeLessThan(525);
		const fujikyu =
			lineKm("富士山麓電気鉄道", "大月線") +
			lineKm("富士山麓電気鉄道", "河口湖線");
		expect(fujikyu).toBeGreaterThan(26);
		expect(fujikyu).toBeLessThan(27.2);
		expect(lineKm("愛知高速交通", "東部丘陵線")).toBeCloseTo(8.9, 0);
	});
});

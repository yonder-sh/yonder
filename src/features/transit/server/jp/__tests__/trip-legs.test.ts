// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from spikes/japan-transit/estimate (typed arrays, bounds checked by construction).
// Integration tests over the real N02-25 graph: accuracy against known times for the trip legs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { JP_RAIL_DIR } from "@/server/jp-rail.server";
import { runAccuracy } from "../accuracy.server";
import { BENCHMARKS, HOLDOUT } from "../benchmarks.server";
import { estimateRoutes, estimateStations } from "../estimate.server";
import type { Graph, RuntimeLine } from "../graph.server";
import { LINE_NAMES_EN, OPERATOR_NAMES_EN } from "../line-names.server";
import { GRAPH_FILE, loadGraphSync, NAMES_FILE } from "../load.server";
import { LINE_OVERRIDES, THROUGH_RUNNING } from "../profiles.server";
import { toTransitRoute } from "../transit-route.server";

// `pnpm data:jp` writes the graph (committed under src/data/jp-rail).
const available = existsSync(join(JP_RAIL_DIR, GRAPH_FILE));

describe.skipIf(!available)("N02-25 trip legs", () => {
	let g: Graph;
	beforeAll(() => {
		const t0 = performance.now();
		g = loadGraphSync();
		expect(performance.now() - t0).toBeLessThan(2000);
	});

	it("every LINE_OVERRIDES key names a real N02 line", () => {
		const keys = new Set(g.lines.map((l) => l.key));
		expect(Object.keys(LINE_OVERRIDES).filter((k) => !keys.has(k))).toEqual([]);
	});

	it("every English line and operator name belongs to a real N02 line (QA MT-06)", () => {
		const keys = new Set(g.lines.map((l) => l.key));
		const ops = new Set(g.lines.map((l) => l.operator));
		expect(Object.keys(LINE_NAMES_EN).filter((k) => !keys.has(k))).toEqual([]);
		expect(Object.keys(OPERATOR_NAMES_EN).filter((k) => !ops.has(k))).toEqual(
			[],
		);
		// Every JR line has an English name.
		const jr = g.lines.filter((l) => l.operator.endsWith("旅客鉄道"));
		expect(jr.filter((l) => !l.profile.en).map((l) => l.key)).toEqual([]);
	});

	it("QA MT-06: Shinjuku → Kawaguchiko options read in English (no 高尾線 / 南武線 chips)", () => {
		const r = estimateRoutes(
			g,
			{ lat: 35.6896, lng: 139.7006 },
			{ lat: 35.4983, lng: 138.7689 },
		);
		const routes = r.routes.map((x) => toTransitRoute(x));
		expect(routes.length).toBeGreaterThanOrEqual(2);
		const japanese = /[\u3040-\u30ff\u4e00-\u9fff]/u;
		for (const t of routes) {
			expect(t.label).not.toMatch(japanese);
			for (const seg of t.segments.filter((x) => x.mode !== "walk")) {
				expect(seg.lineShort).not.toMatch(japanese);
				expect(seg.agency).not.toMatch(japanese);
			}
		}
	});

	it("QA MT-06: Kappabashi → Nihonbashi never offers a 1-minute Shinkansen hop", () => {
		const r = estimateRoutes(
			g,
			{ lat: 35.7132, lng: 139.7887 },
			{ lat: 35.6829, lng: 139.7735 },
		);
		expect(r.routes.length).toBeGreaterThanOrEqual(1);
		for (const x of r.routes)
			expect(
				x.segments.some((s) => s.kind === "ride" && s.cls === "shinkansen"),
			).toBe(false);
		// Long Shinkansen rides are untouched: Tokyo → Shin-Yokohama (28.8 km).
		const y = estimateStations(g, "東京", "新横浜", {
			fromLine: "東海道新幹線",
			toLine: "東海道新幹線",
		});
		expect(y.routes[0]?.signature).toContain("東海道新幹線");
	});

	it("QA MT-06: Oishi Park → Lake Kawaguchiko — walking wins, so the best option is walk-only", () => {
		const r = estimateRoutes(
			g,
			{ lat: 35.5237, lng: 138.742 },
			{ lat: 35.514, lng: 138.755 },
		);
		expect(r.routes[0]?.segments.every((s) => s.kind === "walk")).toBe(true);
	});

	it("every THROUGH_RUNNING entry resolves to a real through link", () => {
		const bad = THROUGH_RUNNING.filter((t) => {
			const onLine = (key: string) =>
				(g.byName.get(t.at) ?? []).some(
					(i) => (g.lines[g.line[i]!] as RuntimeLine).key === key,
				);
			return !onLine(t.a) || !onLine(t.b);
		});
		expect(bad).toEqual([]);
	});

	for (const b of BENCHMARKS) {
		const tol = b.primary
			? Math.max(4, b.refMin * 0.1)
			: Math.max(5, b.refMin * 0.25);
		it(`${b.primary ? "[primary] " : ""}${b.id}: ${b.service} ≈ ${b.refMin} min (±${tol.toFixed(0)})`, () => {
			const r = estimateStations(g, b.from, b.to, {
				fromLine: b.fromLine,
				toLine: b.toLine,
			});
			const best = r.routes[0];
			expect(best, "a route").toBeDefined();
			expect(Math.abs(best!.durationMin - b.refMin)).toBeLessThanOrEqual(tol);
			expect(best!.signature).toContain(b.via);
		});
	}

	it("trip-set accuracy: MAE ≤ 3 min, ≥ 85 % within 15 %", () => {
		const { summary } = runAccuracy(g);
		expect(summary.maeMin).toBeLessThanOrEqual(3);
		expect(summary.within15pct / summary.cases).toBeGreaterThanOrEqual(0.85);
	});

	it("hold-out (untuned) accuracy is reported, and looser: MAE ≤ 10 min", () => {
		const { summary } = runAccuracy(g, HOLDOUT);
		expect(summary.maeMin).toBeLessThanOrEqual(10);
	});

	it("Kyoto → Uji returns 2–3 distinct alternatives, fastest first (JR Nara Line first)", () => {
		const r = estimateStations(g, "京都", "宇治", { toLine: "奈良線" });
		expect(r.routes.length).toBeGreaterThanOrEqual(2);
		expect(r.routes.length).toBeLessThanOrEqual(3);
		const d = r.routes.map((x) => x.durationMin);
		expect([...d].sort((a, b) => a - b)).toEqual(d);
		expect(r.routes[0]?.signature).toBe("西日本旅客鉄道|奈良線");
	});

	it("door to door: Haneda T3 → Anamori Inari shrine uses the Keikyu Airport Line with short walks", () => {
		const r = estimateRoutes(
			g,
			{ lat: 35.5444, lng: 139.7667, name: "HND T3" },
			{ lat: 35.5497, lng: 139.7456, name: "Anamori Inari Jinja" },
		);
		const best = r.routes[0]!;
		expect(best.signature).toContain("京浜急行電鉄|空港線");
		expect(best.durationMin).toBeLessThan(20);
		expect(best.segments[0]?.kind).toBe("walk");
	});

	it("door to door: Haneda T3 → JAL maintenance hangar uses the Tokyo Monorail to 新整備場", () => {
		const r = estimateRoutes(
			g,
			{ lat: 35.5444, lng: 139.7667 },
			{ lat: 35.5437, lng: 139.7875 },
		);
		const ride = r.routes[0]!.segments.find((s) => s.kind === "ride");
		expect(ride && ride.kind === "ride" && ride.lineKey).toBe(
			"東京モノレール|東京モノレール羽田空港線",
		);
		expect(ride && ride.kind === "ride" && ride.to.name).toBe("新整備場");
	});

	it("Kawaguchiko → Mishima: rail-only is a big detour, so the result says a bus is likely better", () => {
		const r = estimateRoutes(
			g,
			{ lat: 35.4983, lng: 138.769 },
			{ lat: 35.1265, lng: 138.911 },
		);
		expect(r.notes).toContain("rail-detour-bus-likely");
		expect(r.googleMapsUrl).toBe(
			"https://www.google.com/maps/dir/?api=1&origin=35.4983,138.769&destination=35.1265,138.911&travelmode=transit",
		);
	});

	it("is fast: 28 station queries + 3 coordinate queries under 1.5 s", () => {
		const t0 = performance.now();
		for (const b of BENCHMARKS)
			estimateStations(g, b.from, b.to, {
				fromLine: b.fromLine,
				toLine: b.toLine,
			});
		estimateRoutes(
			g,
			{ lat: 35.6896, lng: 139.7006 },
			{ lat: 35.4983, lng: 138.77 },
		);
		estimateRoutes(
			g,
			{ lat: 34.9858, lng: 135.7588 },
			{ lat: 34.8893, lng: 135.8077 },
		);
		estimateRoutes(
			g,
			{ lat: 34.6655, lng: 135.5013 },
			{ lat: 34.4347, lng: 135.244 },
		);
		expect(performance.now() - t0).toBeLessThan(1500);
	});

	it("English station names come from the sibling n02 names table when present", () => {
		const r = estimateStations(g, "名古屋", "愛・地球博記念公園", {
			fromLine: "東山線",
		});
		const ride = r.routes[0]!.segments.find((s) => s.kind === "ride");
		if (existsSync(join(JP_RAIL_DIR, NAMES_FILE)))
			expect(ride && ride.kind === "ride" && ride.from.nameEn).toBe("Nagoya");
	});
});

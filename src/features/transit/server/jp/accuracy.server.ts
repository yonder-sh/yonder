// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from spikes/japan-transit/estimate (typed arrays, bounds checked by construction).
// Runs the benchmark legs through the estimator and scores them.

import { railEstimateMin } from "./baseline.server";
import { BENCHMARKS, type Benchmark } from "./benchmarks.server";
import { estimateStations } from "./estimate.server";
import { haversineM } from "./geo.server";
import type { Graph } from "./graph.server";
import type { EstimateRoute } from "./router.server";

export interface AccuracyRow {
	id: string;
	service: string;
	primary: boolean;
	basis: Benchmark["basis"];
	refMin: number;
	refRange: [number, number];
	estMin: number | null;
	/** SPEC §9.3 distance-only fallback on the straight line between the two stations */
	baselineMin: number;
	errMin: number | null;
	errPct: number | null;
	inRange: boolean;
	viaOk: boolean;
	best: string;
	alternatives: string[];
}

export interface AccuracySummary {
	cases: number;
	maeMin: number;
	medianAbsPct: number;
	maxAbsPct: number;
	within15pct: number;
	inRefRange: number;
	viaOk: number;
	primaryMaeMin: number;
	primaryInRange: number;
	/** same MAE for the SPEC §9.3 distance-only fallback (includes access walk + wait by design) */
	baselineMaeMin: number;
}

export function runAccuracy(
	g: Graph,
	list: Benchmark[] = BENCHMARKS,
): { rows: AccuracyRow[]; summary: AccuracySummary } {
	const rows: AccuracyRow[] = list.map((b) => {
		const r = estimateStations(g, b.from, b.to, {
			fromLine: b.fromLine,
			toLine: b.toLine,
		});
		const best: EstimateRoute | undefined = r.routes[0];
		const est = best?.durationMin ?? null;
		const err = est === null ? null : est - b.refMin;
		const straightKm = best
			? haversineM(
					best.segments[0]!.from.lat,
					best.segments[0]!.from.lng,
					best.segments.at(-1)!.to.lat,
					best.segments.at(-1)!.to.lng,
				) / 1000
			: 0;
		return {
			baselineMin: railEstimateMin(straightKm),
			id: b.id,
			service: b.service,
			primary: !!b.primary,
			basis: b.basis,
			refMin: b.refMin,
			refRange: b.refRange,
			estMin: est,
			errMin: err,
			errPct: err === null ? null : Math.round((err / b.refMin) * 1000) / 10,
			inRange: est !== null && est >= b.refRange[0] && est <= b.refRange[1],
			viaOk: !!best?.signature.includes(b.via),
			best: best ? `${best.label} (${best.transfers}x)` : "—",
			alternatives: r.routes
				.slice(1)
				.map((x) => `${x.durationMin}m ${x.label}`),
		};
	});
	const ok = rows.filter((r) => r.errMin !== null);
	const abs = ok.map((r) => Math.abs(r.errMin as number));
	const pct = ok.map((r) => Math.abs(r.errPct as number)).sort((a, b) => a - b);
	const prim = ok.filter((r) => r.primary);
	const summary: AccuracySummary = {
		cases: rows.length,
		maeMin: round1(abs.reduce((a, b) => a + b, 0) / Math.max(1, abs.length)),
		medianAbsPct: pct[Math.floor(pct.length / 2)] ?? 0,
		maxAbsPct: pct[pct.length - 1] ?? 0,
		within15pct: ok.filter((r) => Math.abs(r.errPct as number) <= 15).length,
		inRefRange: rows.filter((r) => r.inRange).length,
		viaOk: rows.filter((r) => r.viaOk).length,
		primaryMaeMin: round1(
			prim.reduce((a, r) => a + Math.abs(r.errMin as number), 0) /
				Math.max(1, prim.length),
		),
		primaryInRange: prim.filter((r) => r.inRange).length,
		baselineMaeMin: round1(
			rows.reduce((a, r) => a + Math.abs(r.baselineMin - r.refMin), 0) /
				Math.max(1, rows.length),
		),
	};
	return { rows, summary };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function markdownTable(rows: AccuracyRow[]): string {
	const head =
		"| leg | service | ref (range) | N02 est | err | in range | expected line | §9.3 fallback | basis |\n|---|---|---|---|---|---|---|---|---|";
	const body = rows
		.map(
			(r) =>
				`| ${r.primary ? `**${r.id}**` : r.id} | ${r.service} | ${r.refMin} (${r.refRange[0]}–${r.refRange[1]}) | ${r.estMin ?? "—"} | ${
					r.errMin === null
						? "—"
						: `${r.errMin > 0 ? "+" : ""}${r.errMin} (${r.errPct}%)`
				} | ${r.inRange ? "yes" : "no"} | ${r.viaOk ? "yes" : "NO"} | ${r.baselineMin} | ${r.basis} |`,
		)
		.join("\n");
	return `${head}\n${body}`;
}

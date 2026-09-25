/**
 * The F1e perf check (SPEC §18.2): `buildModel` plus `rollup` per lens change
 * in under 50 ms, on `seed/import/asia-2027.graph.json` when the importer has
 * written it, else on a synthetic 300-node trip.
 */
import "./__fixtures__/host-tz";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { N, scenario, uuid } from "./__fixtures__/demo";
import { indexGraph } from "./graph-index";
import { LENSES } from "./lens";
import { rollup } from "./rollup";
import { computeSchedule } from "./schedule";
import type { TripGraph } from "./types";
import { buildModel } from "./visits";

const BUDGET_MS = 50;
const IMPORTED = "seed/import/asia-2027.graph.json";

/** 3 cities × 3 areas × ~30 places ≈ 300 nodes and 40 days of 6 items. */
function syntheticTrip(): TripGraph {
	const nodes: Parameters<typeof scenario>[0]["nodes"] = [];
	const places: string[] = [];
	for (let c = 0; c < 3; c++) {
		nodes.push({
			key: `c${c}`,
			parent: "japan",
			type: "city",
			name: `City ${c}`,
			at: [34 + c, 135 + c],
		});
		for (let a = 0; a < 3; a++) {
			nodes.push({
				key: `c${c}a${a}`,
				parent: `c${c}`,
				type: "area",
				name: `Area ${c}.${a}`,
				at: [34 + c + a * 0.05, 135 + c],
			});
			for (let p = 0; p < 31; p++) {
				const key = `c${c}a${a}p${p}`;
				places.push(key);
				nodes.push({
					key,
					parent: `c${c}a${a}`,
					type: "place",
					category: "sight",
					name: `Place ${key}`,
					at: [34 + c + a * 0.05 + p * 0.001, 135 + c + p * 0.001],
				});
			}
		}
	}
	const days = Array.from({ length: 40 }, (_, d) => ({
		items: Array.from({ length: 6 }, (_, i) =>
			i === 3
				? { k: `d${d}i${i}`, title: "Lunch" }
				: {
						k: `d${d}i${i}`,
						node: places[(d * 7 + i * 13) % places.length] as string,
					},
		),
	}));
	return scenario({ nodes, days }).graph;
}

const median = (xs: number[]) =>
	[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

describe("engine performance", () => {
	const graph: TripGraph = existsSync(IMPORTED)
		? (JSON.parse(readFileSync(IMPORTED, "utf8")) as TripGraph)
		: syntheticTrip();
	const ix = indexGraph(graph);
	const entries = graph.nodes.map((n) => ({ nodeId: n.id }));

	it(`buildModel + rollup per lens change stays under ${BUDGET_MS} ms (${existsSync(IMPORTED) ? "imported" : "synthetic"} trip)`, () => {
		expect(graph.nodes.length).toBeGreaterThanOrEqual(
			existsSync(IMPORTED) ? 1 : 300,
		);
		for (const scopeId of [
			null,
			N.japan as string,
			graph.nodes.find((n) => n.type === "city")?.id ?? null,
		]) {
			for (const lens of LENSES) {
				const times: number[] = [];
				for (let run = 0; run < 5; run++) {
					const t0 = performance.now();
					const model = buildModel(ix, scopeId, lens);
					rollup(ix, { scopeId, lens, model }, entries);
					times.push(performance.now() - t0);
				}
				expect(median(times), `${scopeId ?? "root"} @ ${lens}`).toBeLessThan(
					BUDGET_MS,
				);
			}
		}
	});

	it("indexes and schedules the whole trip quickly", () => {
		const times: number[] = [];
		for (let run = 0; run < 5; run++) {
			const t0 = performance.now();
			computeSchedule(indexGraph(graph));
			times.push(performance.now() - t0);
		}
		expect(median(times)).toBeLessThan(200);
		expect(uuid(1)).toMatch(/^[0-9a-f-]{36}$/);
	});
});

import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import type { TripGraph } from "@/lib/engine/types";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { cityDayTable, cityRowNodes, formatDays, parseDays } from "../lib/days";
import {
	openListCounts,
	placeCounts,
	stayNightsOf,
	travelOf,
	visitsOf,
} from "../lib/node-facts";

function planned(g: TripGraph, days: Record<string, number>): TripGraph {
	return {
		...g,
		nodes: g.nodes.map((n) =>
			days[n.id] !== undefined
				? { ...n, details: { ...n.details, plannedDays: days[n.id] } }
				: n,
		),
	};
}

describe("days per city (ADDENDUM §10)", () => {
	it("gives each trip day to the row holding most of its minutes", () => {
		const ix = indexGraph(demoGraph);
		const t = cityDayTable(ix, computeSchedule(ix));
		const byName = Object.fromEntries(t.rows.map((r) => [r.name, r.scheduled]));
		// Day 1–2 Tokyo; day 3 Kawaguchiko (the Mt. Fuji region stands in for a
		// city); day 4 Kyoto (90 min) beats the ryokan breakfast (60); day 5 Osaka
		// (KIX 120) beats Seoul (ICN 60).
		expect(byName).toMatchObject({
			Tokyo: 2,
			"Mt. Fuji": 1,
			Kyoto: 1,
			Osaka: 1,
			Seoul: 0,
		});
		expect(t.tripDays).toBe(5);
		expect(t.scheduledTotal).toBe(5);
		expect(t.unassignedDayIds).toEqual([]);
		expect(t.rows.map((r) => r.name)).not.toContain("Kawaguchiko");
	});
	it("sums planned days and reports the unallocated rest", () => {
		const g = planned(demoGraph, {
			[N.tokyo as string]: 2,
			[N.kyoto as string]: 1.5,
			[N.osaka as string]: 0.5,
		});
		const ix = indexGraph(g);
		const t = cityDayTable(ix, computeSchedule(ix));
		expect(t.plannedTotal).toBe(4);
		expect(t.unallocated).toBe(1);
		const over = cityDayTable(
			indexGraph(planned(demoGraph, { [N.tokyo as string]: 7 })),
			null,
		);
		expect(over.unallocated).toBe(-2);
	});
	it("narrows to a country, keeping the whole trip's day count", () => {
		const ix = indexGraph(demoGraph);
		const t = cityDayTable(ix, null, N.japan ?? null);
		expect(t.rows.map((r) => r.name)).toEqual([
			"Tokyo",
			"Mt. Fuji",
			"Kyoto",
			"Osaka",
		]);
		expect(t.rows.every((r) => r.countryId === N.japan)).toBe(true);
	});
	it("a planned area outside any city is its own row", () => {
		const g = planned(demoGraph, { [N.kawaguchiko as string]: 1 });
		const rows = cityRowNodes(indexGraph(g)).map((r) => r.name);
		// Mt. Fuji is on the plan, so it (the outermost) stands in; not both.
		expect(rows).toContain("Mt. Fuji");
		expect(rows).not.toContain("Kawaguchiko");
	});
	it("formats and parses day counts", () => {
		expect(formatDays(2)).toBe("2");
		expect(formatDays(2.5)).toBe("2.5");
		expect(formatDays(null)).toBe("–");
		expect(parseDays("")).toBeNull();
		expect(parseDays("3")).toBe(3);
		expect(parseDays("2,5")).toBe(2.5);
		expect(parseDays("2.4")).toBe(2.5);
		expect(parseDays("-1")).toBe("invalid");
		expect(parseDays("abc")).toBe("invalid");
	});
});

describe("node facts (DESIGN §4.4)", () => {
	const ix = indexGraph(demoGraph);
	it("groups a city's days into visits with stops and nights", () => {
		const v = visitsOf(ix, N.tokyo as string);
		expect(v).toHaveLength(1);
		expect(v[0]?.days.map((d) => d.date)).toEqual(["2027-10-03", "2027-10-04"]);
		// Day 1's unlocated "Lunch" isn't a stop in Tokyo: 4 + 3.
		expect(v[0]?.stops).toBe(7);
		const fuji = visitsOf(ix, N.mtFuji as string);
		expect(fuji[0]?.nights).toBe(1);
		expect(fuji[0]?.days).toHaveLength(2);
	});
	it("counts places and ideas", () => {
		expect(placeCounts(ix, N.tokyo ?? null)).toEqual({
			places: 7,
			ideas: 0,
			scheduled: 7,
		});
	});
	it("finds stay nights and travel in and out", () => {
		expect(stayNightsOf(ix, N.ryokan as string)).toHaveLength(1);
		const itoya = ix.ordered.find((i) => i.nodeId === N.itoya);
		const hops = travelOf(ix, computeSchedule(ix), itoya?.id as string);
		expect(hops.map((h) => h.dir)).toEqual(["in"]);
		expect(ix.node(hops[0]?.otherNodeId)?.name).toBe("Kama-asa (knives)");
	});
	it("sums open list counts inside a node", () => {
		const counts = {
			byNode: { [N.sensoji as string]: { todoOpen: 2, shopOpen: 1 } },
			byItem: {},
		};
		expect(openListCounts(ix, counts, N.tokyo as string)).toEqual({
			todo: 2,
			shop: 1,
		});
		expect(openListCounts(ix, counts, N.kyoto as string)).toEqual({
			todo: 0,
			shop: 0,
		});
	});
});

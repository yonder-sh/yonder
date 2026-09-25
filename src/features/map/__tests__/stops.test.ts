/**
 * QA A11Y-03: the map's "Stops" list has the same content as the numbered
 * pins and the edges between them, in visit order, with names such as
 * "Pin 6, Golden Gai, 21:05".
 */
import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import { buildModel } from "@/lib/engine/visits";
import { demo, demoGraph, N } from "@/lib/fixtures/demo";
import { buildStops } from "../stops";

const I = demo.I;

function stopsFor(
	scopeId: string | null,
	lens: "place" | "city",
	days: { from: string; to: string } | null = null,
) {
	const ix = indexGraph(demoGraph);
	const model = buildModel(ix, scopeId, lens, days);
	return { stops: buildStops(model, ix, computeSchedule(ix)), model };
}

describe("buildStops", () => {
	it("lists one day's stops in order, named like the pins, with the legs between", () => {
		const { stops, model } = stopsFor(null, "place", {
			from: "2027-10-03",
			to: "2027-10-03",
		});
		expect(stops.map((s) => s.number)).toEqual(
			model.visits.map((v) => v.pinNumber),
		);
		expect(stops[0]?.label).toBe("Pin 1, Hands Shibuya, 09:00");
		expect(stops[1]?.label).toMatch(/^Pin 2, Shibuya Loft, \d\d:\d\d$/);
		// Hands → Loft is a 3 min walk; the edge selects its pair leg.
		expect(stops[0]?.next?.label).toBe("Walk · 3m to Shibuya Loft");
		expect(stops[0]?.next?.sel).toEqual({
			kind: "leg",
			target: { kind: "pair", fromItemId: I.hands, toItemId: I.loft },
		});
		// An unset leg says so; the last stop has no onward leg.
		expect(stops[1]?.next?.label).toBe("Travel to Meiji Jingu not set");
		expect(stops.at(-1)?.next).toBeNull();
	});

	it("adds the date when the stops span several days, and marks overnight moves", () => {
		const { stops } = stopsFor(N.tokyo as string, "place");
		expect(stops[0]?.label).toBe("Pin 1, Hands Shibuya, Sun 3 Oct 09:00");
		const overnight = stops.find((s) => s.repId === N.shibuyaSky)?.next;
		expect(overnight?.label).toBe("Overnight, then to Senso-ji");
	});

	it("follows the lens: one stop per city visit at the city lens", () => {
		const { stops } = stopsFor(null, "city");
		expect(stops[0]?.label).toMatch(/^Pin 1, Tokyo, /);
		expect(stops.map((s) => s.name)).toContain("Kyoto");
	});
});

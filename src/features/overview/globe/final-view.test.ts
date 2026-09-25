/**
 * The Overview globe's whole-route view: framed on the stays, with the trip's
 * start and end when they're on the same side of the planet.
 */
import { describe, expect, it } from "vitest";
import type { LngLat } from "@/lib/engine/geo";
import type {
	RouteHop,
	RoutePlace,
	RouteStay,
	TripRoute,
} from "../lib/trip-route";
import { finalView } from "./OverviewGlobe";

const place = (id: string, coord: LngLat): RoutePlace => ({
	id,
	name: id,
	countryKey: "X",
	countryCode: null,
	countryName: null,
	coord,
});
const stay = (id: string, coord: LngLat): RouteStay => ({
	...place(id, coord),
	firstDayId: "d1",
	firstDate: "2027-10-01",
	lastDate: "2027-10-03",
	nights: 3,
	transitNights: 0,
	modeIn: "flight",
	color: "#fff",
});
const hop = (from: RoutePlace, to: RoutePlace): RouteHop => ({
	from,
	to,
	mode: "flight",
	date: "2027-10-01",
});

const PHL = place("phl", [-75.16, 39.95]);
const NYC = place("nyc", [-74.0, 40.71]);
const SF = stay("sf", [-122.42, 37.77]);
const TOKYO = stay("tokyo", [139.69, 35.69]);
const KYOTO = stay("kyoto", [135.77, 35.01]);

function route(
	stays: RouteStay[],
	home: RoutePlace | null,
	hops: RouteHop[],
): TripRoute {
	return {
		start: home ?? stays[0] ?? null,
		end: home ?? stays.at(-1) ?? null,
		stays,
		hops,
		view: { kind: "globe", center: [0, 20], spreadDeg: 0 },
	} as unknown as TripRoute;
}

const view = (r: TripRoute) => finalView(r, [], 800, 600);

describe("the Overview globe's whole-route view", () => {
	it("counts a home on the stays' side of the planet: PHL → SFO shows the US, not the Bay Area", () => {
		const alone = view(route([SF], null, []));
		const fromPhl = view(route([SF], PHL, [hop(PHL, SF), hop(SF, PHL)]));
		expect(fromPhl.zoom).toBeLessThan(alone.zoom - 1);
		// Turned to face the whole route, east of San Francisco.
		expect(fromPhl.center[0]).toBeGreaterThan(SF.coord?.[0] ?? 0);
	});

	it("leaves a home over the horizon out: New York → Tokyo frames Japan", () => {
		const alone = view(route([TOKYO, KYOTO], null, [hop(TOKYO, KYOTO)]));
		const fromNyc = view(
			route([TOKYO, KYOTO], NYC, [
				hop(NYC, TOKYO),
				hop(TOKYO, KYOTO),
				hop(KYOTO, NYC),
			]),
		);
		expect(fromNyc).toEqual(alone);
	});
});

import { describe, expect, it } from "vitest";
import { scenario as buildScenario } from "@/lib/engine/__fixtures__/demo";
import { indexGraph } from "@/lib/engine/graph-index";
import {
	countryLabel,
	ROUTE_PALETTE,
	routeView,
	tripRoute,
} from "./trip-route";

// New York → Tokyo (2) → Mt. Fuji (1) → Kyoto (1) → Seoul (1) → night bus →
// Busan (1) → Taipei (1) → Istanbul → Newark.
const s = buildScenario({
	nodes: [
		{
			key: "nyc",
			parent: "usa",
			type: "city",
			name: "New York",
			at: [40.71, -74.0],
		},
		{
			key: "jfk",
			parent: "nyc",
			type: "place",
			category: "airport",
			name: "JFK",
			at: [40.64, -73.78],
		},
		{
			key: "hnd",
			parent: "tokyo",
			type: "place",
			category: "airport",
			name: "Haneda",
			at: [35.55, 139.78],
		},
		{
			key: "tokyoHotel",
			parent: "shibuya",
			type: "place",
			category: "lodging",
			name: "Tokyo hotel",
			at: [35.66, 139.7],
		},
		{
			key: "kyotoHotel",
			parent: "kyoto",
			type: "place",
			category: "lodging",
			name: "Kyoto hotel",
			at: [35.0, 135.76],
		},
		{
			key: "seoulHotel",
			parent: "seoul",
			type: "place",
			category: "lodging",
			name: "Seoul hotel",
			at: [37.55, 126.97],
		},
		{
			key: "busan",
			parent: "southKorea",
			type: "city",
			name: "Busan",
			at: [35.18, 129.08],
		},
		{
			key: "busanHotel",
			parent: "busan",
			type: "place",
			category: "lodging",
			name: "Busan hotel",
			at: [35.16, 129.16],
		},
		{
			key: "taipeiHotel",
			parent: "taipei",
			type: "place",
			category: "lodging",
			name: "Taipei hotel",
			at: [25.03, 121.54],
		},
	],
	days: [
		{ items: [{ k: "jfk", node: "jfk" }] },
		{
			night: "tokyoHotel",
			items: [
				{ k: "hnd", node: "hnd" },
				{ k: "sensoji", node: "sensoji" },
			],
		},
		{ night: "tokyoHotel", items: [{ k: "meiji", node: "meijiJingu" }] },
		{ night: "ryokan", items: [{ k: "ryokan", node: "ryokan" }] },
		{ night: "kyotoHotel", items: [{ k: "kiyomizu", node: "kiyomizu" }] },
		{
			night: "seoulHotel",
			items: [
				{ k: "kix", node: "kix" },
				{ k: "icn", node: "icn" },
			],
		},
		{ items: [{ k: "seoulHotel", node: "seoulHotel" }] },
		{ night: "busanHotel", items: [{ k: "busanHotel", node: "busanHotel" }] },
		{
			night: "taipeiHotel",
			items: [{ k: "taipeiHotel", node: "taipeiHotel" }],
		},
		{
			items: [
				{ k: "tpe", node: "tpe" },
				{ k: "ist", node: "ist" },
			],
		},
		{ items: [{ k: "ewr", node: "ewr" }] },
	],
	legs: [
		{ from: "jfk", to: "hnd", mode: "flight" },
		{ from: "meiji", to: "ryokan", mode: "transit" },
		{ from: "ryokan", to: "kiyomizu", mode: "transit" },
		{ from: "kix", to: "icn", mode: "flight" },
		{ from: "seoulHotel", to: "busanHotel", mode: "transit" },
		{ from: "busanHotel", to: "taipeiHotel", mode: "flight" },
		{ from: "tpe", to: "ist", mode: "flight" },
		{ from: "ist", to: "ewr", mode: "flight" },
	],
});
const route = tripRoute(indexGraph(s.graph));

describe("tripRoute", () => {
	it("folds nights into stays at city level (region when there's no city)", () => {
		expect(route.stays.map((x) => [x.name, x.nights, x.transitNights])).toEqual(
			[
				["Tokyo", 2, 0],
				["Mt. Fuji", 1, 0],
				["Kyoto", 1, 0],
				["Seoul", 1, 0],
				["Busan", 1, 1],
				["Taipei", 1, 0],
			],
		);
	});

	it("rows are consecutive stays per country; a night bus inside a country counts, red-eyes don't", () => {
		expect(
			route.rows.map((r) => [r.countryCode, r.nights, r.cities.join(" · ")]),
		).toEqual([
			["JP", 4, "Tokyo · Mt. Fuji · Kyoto"],
			["KR", 3, "Seoul · Busan"],
			["TW", 1, "Taipei"],
		]);
	});

	it("labels long country names short", () => {
		expect(route.rows.map(countryLabel)).toEqual(["Japan", "Korea", "Taiwan"]);
	});

	it("colours countries in order of first appearance", () => {
		expect(route.colors).toEqual({
			JP: ROUTE_PALETTE[0],
			KR: ROUTE_PALETTE[1],
			TW: ROUTE_PALETTE[2],
		});
		expect(route.rows.map((r) => r.color)).toEqual(ROUTE_PALETTE.slice(0, 3));
	});

	it("knows how each stay was reached", () => {
		expect(route.stays.map((x) => x.modeIn)).toEqual([
			"flight",
			"transit",
			"transit",
			"flight",
			"transit",
			"flight",
		]);
		expect(route.modeOut).toBe("flight");
	});

	it("starts in New York and ends home via Istanbul", () => {
		expect(route.start?.name).toBe("New York");
		expect(route.end?.name).toBe("Newark");
		expect(route.endsHome).toBe(true);
		expect(route.via).toEqual(["Istanbul"]);
		expect(route.viaPlaces.map((v) => [v.name, v.countryCode])).toEqual([
			["Istanbul", "TR"],
		]);
		expect(route.viaPlaces[0]?.coord).not.toBeNull();
	});

	it("the way home lists only the stops inside the last flight chain", () => {
		// Sparse plan: no nights after Tokyo, then a ground trip and a flight home.
		const sparse = buildScenario({
			nodes: [
				{
					key: "nyc",
					parent: "usa",
					type: "city",
					name: "New York",
					at: [40.71, -74.0],
				},
				{
					key: "jfk",
					parent: "nyc",
					type: "place",
					category: "airport",
					name: "JFK",
					at: [40.64, -73.78],
				},
				{
					key: "tokyoHotel",
					parent: "shibuya",
					type: "place",
					category: "lodging",
					name: "Tokyo hotel",
					at: [35.66, 139.7],
				},
			],
			days: [
				{ items: [{ k: "jfk", node: "jfk" }] },
				{ night: "tokyoHotel", items: [{ k: "sensoji", node: "sensoji" }] },
				{
					items: [
						{ k: "icn", node: "icn" },
						{ k: "tpe", node: "tpe" },
					],
				},
				{
					items: [
						{ k: "ist", node: "ist" },
						{ k: "ewr", node: "ewr" },
					],
				},
			],
			legs: [
				{ from: "icn", to: "tpe", mode: "transit" },
				{ from: "tpe", to: "ist", mode: "flight" },
				{ from: "ist", to: "ewr", mode: "flight" },
			],
		});
		const r = tripRoute(indexGraph(sparse.graph));
		expect(r.via).toEqual(["Istanbul"]);
	});

	it("counts days, places, flights and distance", () => {
		expect(route.stats).toMatchObject({
			days: 11,
			countries: 3,
			cities: 6,
			flights: 5,
		});
		// Sensō-ji, Meiji Jingu and Kiyomizu-dera; hotels and airports don't count.
		expect(route.stats.placesPlanned).toBe(3);
		expect(route.stats.km).toBeGreaterThan(25_000);
	});

	it("an East Asia trip fits the globe", () => {
		expect(route.view.kind).toBe("globe");
	});

	it("hops from city to city in trip order, with each leg's mode and arrival day", () => {
		expect(route.hops.map((h) => [h.from.name, h.to.name, h.mode])).toEqual([
			["New York", "Tokyo", "flight"],
			["Tokyo", "Mt. Fuji", "transit"],
			["Mt. Fuji", "Kyoto", "transit"],
			// KIX sits in Osaka: the transfer to the airport has no leg.
			["Kyoto", "Osaka", "unset"],
			["Osaka", "Seoul", "flight"],
			["Seoul", "Busan", "transit"],
			["Busan", "Taipei", "flight"],
			["Taipei", "Istanbul", "flight"],
			["Istanbul", "Newark", "flight"],
		]);
		const dates = route.hops.map((h) => h.date);
		expect(dates).toEqual([...dates].sort());
		expect(route.hops[0]?.date).toBe(s.graph.days[1]?.date);
	});
});

describe("a trip with a flight and no stays yet", () => {
	const flight = buildScenario({
		nodes: [
			{
				key: "phlCity",
				parent: "usa",
				type: "city",
				name: "Philadelphia",
				at: [39.95, -75.17],
			},
			{
				key: "phl",
				parent: "phlCity",
				type: "place",
				category: "airport",
				name: "PHL",
				at: [39.87, -75.24],
			},
			{
				key: "sfoCity",
				parent: "usa",
				type: "city",
				name: "San Francisco",
				at: [37.77, -122.42],
			},
			{
				key: "sfo",
				parent: "sfoCity",
				type: "place",
				category: "airport",
				name: "SFO",
				at: [37.62, -122.38],
			},
		],
		days: [
			{
				items: [
					{ k: "phl", node: "phl" },
					{ k: "sfo", node: "sfo" },
				],
			},
		],
		legs: [{ from: "phl", to: "sfo", mode: "flight" }],
	});
	const r = tripRoute(indexGraph(flight.graph));

	it("colours, counts and frames the cities it visits", () => {
		expect(r.stays).toEqual([]);
		expect(r.colors).toEqual({ US: ROUTE_PALETTE[0] });
		expect(r.stats).toMatchObject({ countries: 1, cities: 2, flights: 1 });
		expect(r.view.kind).toBe("globe");
		if (r.view.kind === "globe") expect(r.view.center[0]).toBeLessThan(-80);
	});

	it("ends in San Francisco, not home", () => {
		expect(r.endsHome).toBe(false);
		expect(r.end?.name).toBe("San Francisco");
	});
});

describe("routeView", () => {
	it("uses a flat map when the stays are spread across the world, seam in the widest gap", () => {
		const v = routeView([
			[-21.94, 64.15], // Reykjavik
			[18.42, -33.92], // Cape Town
			[139.76, 35.68], // Tokyo
			[-71.97, -13.53], // Cusco
		]);
		expect(v.kind).toBe("flat");
		// The widest gap is the Pacific (Tokyo → Cusco): the map centres near Africa.
		if (v.kind === "flat") expect(v.centerLng).toBeGreaterThan(20);
		if (v.kind === "flat") expect(v.centerLng).toBeLessThan(50);
	});

	it("keeps the globe for a regional trip and centres it on the stays", () => {
		const v = routeView([
			[2.35, 48.86], // Paris
			[12.5, 41.9], // Rome
			[28.98, 41.01], // Istanbul
		]);
		expect(v.kind).toBe("globe");
		if (v.kind === "globe") expect(v.spreadDeg).toBeLessThan(20);
	});
});

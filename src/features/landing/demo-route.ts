/**
 * The landing page's demo trip: four countries in East Asia, in the order
 * they're visited, flying out of New York and back. The hero globe draws it
 * (New York is over the horizon), the route strip under the hero
 * lists it, and the showcase trip the product screenshots are taken of
 * (`scripts/landing/showcase.ts`) follows the same route, so the page shows
 * one trip throughout. Invented, like everything in the screenshots.
 *
 * Colours are the Overview's country accents (`ROUTE_PALETTE`) in order of
 * first appearance, exactly as the app assigns them.
 */

import { ROUTE_PALETTE } from "@/features/overview/lib/trip-route";
import type { LngLat } from "@/lib/engine/geo";

export type DemoCountry = {
	key: string;
	name: string;
	color: string;
};

export type DemoStay = {
	id: string;
	name: string;
	country: string;
	/** `[lng, lat]`. */
	at: LngLat;
	nights: number;
	/** How you arrive from the stay before (the first: from home). */
	modeIn: "ground" | "flight";
	/** Where the globe puts the label. */
	label: "right" | "left" | "above" | "below";
	/** Hidden on narrow screens (it would crowd its neighbour). */
	minor?: boolean;
};

export const DEMO_COUNTRIES: readonly DemoCountry[] = [
	{ key: "JP", name: "Japan", color: ROUTE_PALETTE[0] },
	{ key: "KR", name: "South Korea", color: ROUTE_PALETTE[1] },
	{ key: "TW", name: "Taiwan", color: ROUTE_PALETTE[2] },
	{ key: "VN", name: "Vietnam", color: ROUTE_PALETTE[3] },
];

export const DEMO_STAYS: readonly DemoStay[] = [
	{
		id: "tokyo",
		name: "Tokyo",
		country: "JP",
		at: [139.6917, 35.6895],
		nights: 5,
		modeIn: "flight",
		label: "right",
	},
	{
		id: "kyoto",
		name: "Kyoto",
		country: "JP",
		at: [135.7681, 35.0116],
		nights: 4,
		modeIn: "ground",
		label: "below",
	},
	{
		id: "seoul",
		name: "Seoul",
		country: "KR",
		at: [126.978, 37.5665],
		nights: 4,
		modeIn: "flight",
		label: "above",
	},
	{
		id: "busan",
		name: "Busan",
		country: "KR",
		at: [129.0756, 35.1796],
		nights: 2,
		modeIn: "ground",
		label: "left",
		minor: true,
	},
	{
		id: "taipei",
		name: "Taipei",
		country: "TW",
		at: [121.5654, 25.033],
		nights: 3,
		modeIn: "flight",
		label: "right",
	},
	{
		id: "hanoi",
		name: "Hanoi",
		country: "VN",
		at: [105.8342, 21.0278],
		nights: 3,
		modeIn: "flight",
		label: "left",
	},
	{
		id: "hoian",
		name: "Hội An",
		country: "VN",
		at: [108.338, 15.8801],
		nights: 3,
		modeIn: "ground",
		label: "right",
	},
	{
		id: "saigon",
		name: "Saigon",
		country: "VN",
		at: [106.7009, 10.7769],
		nights: 2,
		modeIn: "ground",
		label: "left",
	},
];

/** Where the trip starts and ends: flights out and back. */
export const DEMO_HOME = {
	id: "home",
	name: "New York",
	at: [-73.9857, 40.7484] as LngLat,
} as const;

export const DEMO_TRIP = {
	name: "East Asia in autumn",
	nights: DEMO_STAYS.reduce((n, s) => n + s.nights, 0),
	countries: DEMO_COUNTRIES.length,
	cities: DEMO_STAYS.length,
} as const;

export const countryOf = (key: string): DemoCountry =>
	DEMO_COUNTRIES.find((c) => c.key === key) ?? {
		key,
		name: key,
		color: "#a3a3a3",
	};

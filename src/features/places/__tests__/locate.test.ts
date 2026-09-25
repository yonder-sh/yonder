/**
 * "Set location" (QA HIER-12, PLAN-R2-01/02): the search looks around the
 * node's parent, and pasted coordinates set only the spot — the node never
 * takes the nearest business's OSM ref, Google id or name.
 */
import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { locateBiasNode, locationPatch, pinKeepsIdentity } from "../lib/locate";
import type { PlacePreview } from "../lib/providers";

const KURO = "00000000-0000-7000-8000-00000000bb01";
const GAI = "00000000-0000-7000-8000-00000000bb02";
const base = demoGraph.nodes.find((n) => n.id === N.shibuya) as GraphNode;
// Golden Gai (no coordinates) › Bar Kuro (no coordinates), in Shibuya.
const graph: TripGraph = {
	...demoGraph,
	nodes: [
		...demoGraph.nodes,
		{
			...base,
			id: GAI,
			parentId: N.shibuya as string,
			type: "area",
			name: "Golden Gai",
			slug: "golden-gai",
			lat: null,
			lng: null,
			position: "z0",
		},
		{
			...base,
			id: KURO,
			parentId: GAI,
			type: "place",
			category: "nightlife",
			name: "Bar Kuro",
			slug: "bar-kuro",
			lat: null,
			lng: null,
			address: null,
			position: "z1",
		},
	],
};

/** What Photon's reverse geocode returns next to 35.6941, 139.7045. */
const blueDragon: PlacePreview = {
	provider: "photon",
	ref: "N14144934501",
	osmRef: "N14144934501",
	name: "Blue Dragon",
	address: "Akarui Hanazono Third Street, Kabukicho, Shinjuku, Tokyo, Japan",
	category: "nightlife",
	lat: 35.6941,
	lng: 139.7045,
	countryCode: "JP",
	photos: [],
	level: "place",
	filing: { existing: [], create: [] },
};

describe("locateBiasNode", () => {
	it("looks around the nearest ancestor with a position", () => {
		const ix = indexGraph(graph);
		// Golden Gai has none of its own (nor located children): Shibuya.
		expect(locateBiasNode(ix, KURO)).toBe(N.shibuya);
		expect(locateBiasNode(ix, GAI)).toBe(N.shibuya);
		expect(locateBiasNode(ix, N.japan)).toBeNull();
		expect(locateBiasNode(ix, undefined)).toBeNull();
	});
});

describe("locationPatch", () => {
	const kuro = { type: "place" as const, address: null };
	const pin = { lat: 35.6941, lng: 139.7045 };

	it("a pin sets the spot, never the nearest place's identity", () => {
		const patch = locationPatch(kuro, blueDragon, pin);
		expect(patch).toEqual({
			lat: 35.6941,
			lng: 139.7045,
			address: blueDragon.address,
		});
		expect(patch).not.toHaveProperty("osmRef");
		expect(patch).not.toHaveProperty("googlePlaceId");
		expect(patch).not.toHaveProperty("name");
	});
	it("a pin keeps the node's own address", () => {
		expect(
			locationPatch({ ...kuro, address: "1-1-8 Kabukicho" }, blueDragon, pin),
		).toEqual({ lat: 35.6941, lng: 139.7045 });
	});
	it("a pin uses the pasted spot, not the preview's", () => {
		expect(
			locationPatch(
				kuro,
				{ ...blueDragon, lat: 35.69412, lng: 139.70461 },
				pin,
			),
		).toMatchObject({ lat: 35.6941, lng: 139.7045 });
	});
	it("a picked search result is that place: its refs come along", () => {
		expect(locationPatch(kuro, blueDragon, null)).toEqual({
			lat: 35.6941,
			lng: 139.7045,
			address: blueDragon.address,
			osmRef: "N14144934501",
		});
		expect(
			locationPatch(
				kuro,
				{
					...blueDragon,
					provider: "google",
					ref: "ChIJxyz",
					osmRef: undefined,
				},
				null,
			),
		).toMatchObject({ googlePlaceId: "ChIJxyz" });
	});
});

describe("pinKeepsIdentity", () => {
	it("only while the new place keeps the nearest place's name", () => {
		expect(pinKeepsIdentity(blueDragon, "Blue Dragon")).toBe(true);
		expect(pinKeepsIdentity(blueDragon, "  ")).toBe(true);
		expect(pinKeepsIdentity(blueDragon, "Bar Kuro")).toBe(false);
	});
});

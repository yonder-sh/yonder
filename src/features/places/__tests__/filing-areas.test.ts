/** Auto-created areas are neighbourhoods: never a street, a mall or a station (backlog 5). */
import { describe, expect, it } from "vitest";
import { demoGraph } from "@/lib/fixtures/demo";
import {
	type AddressParts,
	cleanNewName,
	type FilingNode,
	isAreaName,
	normName,
	suggestFiling,
} from "../lib/filing";
import {
	type GooglePlace,
	googleParts,
	photonNeedsNeighbourhood,
	photonNeighbourhood,
	photonParts,
} from "../lib/providers";
import {
	DOTONBORI_STREET_PHOTON,
	KYOTO_STATION_PHOTON,
	SENSOJI_HALL_AREAS,
	SENSOJI_HALL_PHOTON,
	SENSOJI_PHOTON,
	SHIBUYA_SKY_PHOTON,
	SHINJUKU_GYOEN_PHOTON,
	YASAKA_PHOTON,
} from "./photon-fixtures";

/** A fresh trip: Japan › Tokyo, Kyoto, Osaka, no areas yet. */
const bare: FilingNode[] = [
	{
		id: "jp",
		parentId: null,
		type: "country",
		name: "Japan",
		countryCode: "JP",
	},
	{ id: "tk", parentId: "jp", type: "city", name: "Tokyo" },
	{ id: "ky", parentId: "jp", type: "city", name: "Kyoto" },
	{ id: "os", parentId: "jp", type: "city", name: "Osaka" },
];
const demo: FilingNode[] = demoGraph.nodes.map((n) => ({
	id: n.id,
	parentId: n.parentId,
	type: n.type,
	name: n.name,
	countryCode: n.countryCode,
}));

function filed(nodes: FilingNode[], parts: AddressParts) {
	const f = suggestFiling(nodes, parts, "place");
	const names = new Map(nodes.map((n) => [n.id, n.name]));
	return [
		...f.existing.map((id) => names.get(id)),
		...f.create.map((c) => `${c.name} (new)`),
	].join(" › ");
}

/** Places API (New) `addressComponents`, as Google returns them for Japan. */
const comp = (longText: string, ...types: string[]) => ({
	longText,
	shortText: longText,
	types,
	languageCode: "en",
});
const JAPAN = comp("Japan", "country", "political");
JAPAN.shortText = "JP";

const SENSOJI_GOOGLE: GooglePlace = {
	displayName: { text: "Sensō-ji" },
	addressComponents: [
		comp("1", "premise"),
		comp("3", "sublocality_level_4", "sublocality", "political"),
		comp("2-chōme", "sublocality_level_2", "sublocality", "political"),
		comp("Asakusa", "sublocality_level_1", "sublocality", "political"),
		comp("Taito City", "locality", "political"),
		comp("Tokyo", "administrative_area_level_1", "political"),
		JAPAN,
		comp("111-0032", "postal_code"),
	],
};

const GION_GOOGLE: GooglePlace = {
	displayName: { text: "Gion Kinana" },
	addressComponents: [
		comp("570-119", "premise"),
		comp(
			"Gionmachi Minamigawa",
			"sublocality_level_2",
			"sublocality",
			"political",
		),
		comp("Higashiyama Ward", "sublocality_level_1", "sublocality", "political"),
		comp("Kyoto", "locality", "political"),
		comp("Kyoto", "administrative_area_level_1", "political"),
		JAPAN,
		comp("605-0074", "postal_code"),
	],
};

describe("isAreaName", () => {
	it("rejects streets, shopping streets, buildings, stations and parks", () => {
		for (const s of [
			"Nakamise Shopping Street",
			"Nakamise Street",
			"Takeshita Street",
			"Omotesando-dori",
			"Chūō-dōri",
			"Shijō Road",
			"Teramachi Arcade",
			"Nishiki Market",
			"Shibuya Station",
			"Roppongi Hills Mall",
			"Mori Building",
			"Ueno Park",
			"Shibuya Crossing",
			"仲見世商店街",
			"京都駅",
			"2-chōme",
			"3",
		])
			expect(isAreaName(s), s).toBe(false);
	});
	it("keeps neighbourhoods, wards and chō", () => {
		for (const s of [
			"Asakusa 2",
			"Ginza",
			"Shibuya",
			"Dōgenzaka 2",
			"Rinka-cho",
			"Giommachi-Kitagawa",
			"Higashiyama Ward",
			"Shinsaibashisuji 2",
			"Shibakoen",
			"浅草二丁目",
		])
			expect(isAreaName(s), s).toBe(true);
	});
	it("never the place's own name", () => {
		expect(isAreaName("Dotonbori", "Dōtonbori")).toBe(false);
		expect(isAreaName("Dotonbori 2-chome", "Dotonbori")).toBe(true);
	});
});

describe("folding chō and chōme", () => {
	it("kanji chōme and Kyoto's north/south sides fold to the neighbourhood", () => {
		expect(normName("浅草二丁目")).toBe(normName("浅草"));
		expect(cleanNewName("浅草二丁目")).toBe("浅草");
		expect(cleanNewName("Ginza 2-chōme")).toBe("Ginza");
		expect(cleanNewName("Giommachi-Kitagawa")).toBe("Gion");
		expect(cleanNewName("Gionmachi Minamigawa")).toBe("Gion");
		expect(normName("Giommachi-Kitagawa")).toBe("gion");
		expect(cleanNewName("Rinka-cho")).toBe("Rinka-cho");
	});
});

describe("Photon: the neighbourhood, not the shopping street", () => {
	it("Senso-ji Main Hall drops Nakamise Shopping Street and asks for the neighbourhood", () => {
		const p = SENSOJI_HALL_PHOTON.properties;
		expect(photonParts(p).locality).toBeUndefined();
		expect(photonNeedsNeighbourhood(p)).toBe(true);
		expect(photonNeighbourhood(SENSOJI_HALL_AREAS)).toBe("Asakusa 2");
		const parts = { ...photonParts(p), locality: "Asakusa 2" };
		expect(filed(bare, parts)).toBe("Japan › Tokyo › Asakusa (new)");
		expect(filed(demo, parts)).toBe("Japan › Tokyo › Asakusa");
	});
	it("without that answer it falls back to the ward, never the street", () => {
		const parts = photonParts(SENSOJI_HALL_PHOTON.properties);
		expect(filed(bare, parts)).toBe("Japan › Tokyo › Taito (new)");
	});
	it("a layered reverse skips landuse, squares and place=locality", () => {
		const [asakusa, ...rest] = SENSOJI_HALL_AREAS;
		expect(photonNeighbourhood([...rest].reverse())).toBe("Hanakawado");
		expect(
			photonNeighbourhood(
				rest.filter((f) => f.properties.osm_value !== "quarter"),
			),
		).toBeUndefined();
		expect(asakusa).toBeDefined();
	});
	it("a good locality needs no lookup", () => {
		for (const f of [
			SENSOJI_PHOTON,
			SHIBUYA_SKY_PHOTON,
			YASAKA_PHOTON,
			KYOTO_STATION_PHOTON,
		])
			expect(photonNeedsNeighbourhood(f.properties), f.properties.name).toBe(
				false,
			);
	});
	it("Shibuya Sky → Tokyo › Shibuya", () => {
		const parts = photonParts(SHIBUYA_SKY_PHOTON.properties);
		expect(filed(bare, parts)).toBe("Japan › Tokyo › Shibuya (new)");
		expect(filed(demo, parts)).toBe("Japan › Tokyo › Shibuya");
	});
	it("Yasaka Shrine (Giommachi-Kitagawa) → Kyoto › Gion", () => {
		const parts = photonParts(YASAKA_PHOTON.properties);
		expect(filed(bare, parts)).toBe("Japan › Kyoto › Gion (new)");
		const withGion = [
			...bare,
			{ id: "gi", parentId: "ky", type: "area" as const, name: "Gion" },
		];
		expect(filed(withGion, parts)).toBe("Japan › Kyoto › Gion");
	});
	it("a ward-only address (a park) → the ward", () => {
		const parts = photonParts(SHINJUKU_GYOEN_PHOTON.properties);
		expect(filed(bare, parts)).toBe("Japan › Tokyo › Shinjuku (new)");
	});
	it("a street is a place in its neighbourhood, chōme folded", () => {
		const parts = photonParts(DOTONBORI_STREET_PHOTON.properties);
		expect(filed(bare, parts)).toBe("Japan › Osaka › Dotonbori (new)");
	});
	it("a street-only address files under the city", () => {
		const parts: AddressParts = {
			country: "Japan",
			countryCode: "JP",
			city: "Tokyo",
			locality: "Takeshita Street",
		};
		expect(filed(bare, parts)).toBe("Japan › Tokyo");
	});
});

describe("Google: address types, Japan's nesting", () => {
	it("Senso-ji → Tokyo › Asakusa (the ward is no city)", () => {
		const parts = googleParts(SENSOJI_GOOGLE);
		expect(parts).toMatchObject({
			city: "Tokyo",
			district: "Taito City",
			locality: "Asakusa",
		});
		expect(filed(bare, parts)).toBe("Japan › Tokyo › Asakusa (new)");
		expect(filed(demo, parts)).toBe("Japan › Tokyo › Asakusa");
		// A trip without Tokyo gets Tokyo, not "Taito".
		expect(filed(bare.slice(0, 1), parts)).toBe(
			"Japan › Tokyo (new) › Asakusa (new)",
		);
	});
	it("Kyoto: the neighbourhood under the ward wins (Gion)", () => {
		const parts = googleParts(GION_GOOGLE);
		expect(parts).toMatchObject({
			city: "Kyoto",
			district: "Higashiyama Ward",
			locality: "Gionmachi Minamigawa",
		});
		expect(filed(bare, parts)).toBe("Japan › Kyoto › Gion (new)");
	});
	it("a ward-only address → the ward", () => {
		const parts = googleParts({
			displayName: { text: "Kyoto Tower" },
			addressComponents: [
				comp("721-1", "premise"),
				comp(
					"Shimogyo Ward",
					"sublocality_level_1",
					"sublocality",
					"political",
				),
				comp("Kyoto", "locality", "political"),
				comp("Kyoto", "administrative_area_level_1", "political"),
				JAPAN,
			],
		});
		expect(parts.locality).toBeUndefined();
		expect(filed(bare, parts)).toBe("Japan › Kyoto › Shimogyo (new)");
	});
	it("route, premise and a street-named neighbourhood never make an area", () => {
		const parts = googleParts({
			displayName: { text: "Some Bar" },
			addressComponents: [
				comp("5", "street_number"),
				comp("Nakamise Street", "route"),
				comp("Nakamise Shopping Street", "neighborhood", "political"),
				comp("Tokyo", "locality", "political"),
				comp("Tokyo", "administrative_area_level_1", "political"),
				JAPAN,
			],
		});
		expect(parts.locality).toBeUndefined();
		expect(filed(bare, parts)).toBe("Japan › Tokyo");
	});
});

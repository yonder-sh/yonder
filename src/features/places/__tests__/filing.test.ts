import { describe, expect, it } from "vitest";
import { demoGraph, N } from "@/lib/fixtures/demo";
import {
	cleanNewName,
	type FilingNode,
	findDuplicate,
	normName,
	suggestFiling,
} from "../lib/filing";
import { photonParts, photonPreview } from "../lib/providers";
import { ITOYA_PHOTON, SENSOJI_PHOTON } from "./photon-fixtures";

const nodes: FilingNode[] = demoGraph.nodes.map((n) => ({
	id: n.id,
	parentId: n.parentId,
	type: n.type,
	name: n.name,
	localName: n.localName,
	countryCode: n.countryCode,
	status: n.status,
	googlePlaceId: n.googlePlaceId,
	lat: n.lat,
	lng: n.lng,
}));
const name = (id: string) => nodes.find((n) => n.id === id)?.name;

describe("normName", () => {
	it("folds accents, case, admin suffixes and chōme numbers", () => {
		expect(normName("Chūō")).toBe("chuo");
		expect(normName("Chuo City")).toBe("chuo");
		expect(normName("Shibuya-ku")).toBe("shibuya");
		expect(normName("Ginza 2")).toBe("ginza");
		expect(normName("Ginza 2-chome")).toBe("ginza");
		expect(normName("Kyoto Prefecture")).toBe("kyoto");
		expect(normName("Tōkyō")).toBe("tokyo");
		expect(normName("Mt. Fuji")).toBe("mtfuji");
		expect(normName("渋谷区")).toBe("渋谷");
		expect(normName(null)).toBe("");
	});
	it("cleans new names for display", () => {
		expect(cleanNewName("Ginza 2")).toBe("Ginza");
		expect(cleanNewName("Chuo City")).toBe("Chuo");
		expect(cleanNewName("Harajuku")).toBe("Harajuku");
	});
});

describe("suggestFiling (SPEC §14.4)", () => {
	it("Itoya Ginza through Photon → Japan › Tokyo › Ginza (new)", () => {
		const p = photonPreview(ITOYA_PHOTON);
		expect(p).not.toBeNull();
		const f = suggestFiling(nodes, p?.parts ?? {}, "place");
		expect(f.existing.map(name)).toEqual(["Japan", "Tokyo"]);
		expect(f.create).toEqual([{ type: "area", name: "Ginza" }]);
	});

	it("Senso-ji lands in the existing Asakusa area", () => {
		const parts = photonParts(SENSOJI_PHOTON.properties);
		const f = suggestFiling(nodes, parts, "place");
		expect(f.existing.map(name)).toEqual(["Japan", "Tokyo", "Asakusa"]);
		expect(f.create).toEqual([]);
	});

	it("Google's Tokyo wards (`locality`) become areas of the existing city", () => {
		const f = suggestFiling(
			nodes,
			{
				country: "Japan",
				countryCode: "JP",
				region: "Tokyo",
				city: "Shibuya City",
				district: undefined,
				locality: undefined,
			},
			"place",
		);
		expect(f.existing.map(name)).toEqual(["Japan", "Tokyo", "Shibuya"]);
		expect(f.create).toEqual([]);
	});

	it("a Google ward with a neighbourhood creates the neighbourhood", () => {
		const f = suggestFiling(
			nodes,
			{
				countryCode: "JP",
				country: "Japan",
				region: "Tokyo",
				city: "Chuo City",
				district: "Ginza",
			},
			"place",
		);
		expect(f.existing.map(name)).toEqual(["Japan", "Tokyo"]);
		expect(f.create).toEqual([{ type: "area", name: "Ginza" }]);
	});

	it("matches the country by ISO code even when the name differs", () => {
		const f = suggestFiling(
			nodes,
			{ countryCode: "KR", country: "Republic of Korea", city: "Seoul" },
			"place",
		);
		expect(f.existing.map(name)).toEqual(["South Korea", "Seoul"]);
		expect(f.create).toEqual([]);
	});

	it("creates the missing country and city (never a region)", () => {
		const f = suggestFiling(
			nodes,
			{
				country: "Vietnam",
				countryCode: "VN",
				region: "Quảng Nam",
				city: "Hội An",
				locality: "Minh An",
			},
			"place",
		);
		expect(f.existing).toEqual([]);
		expect(f.create).toEqual([
			{ type: "country", name: "Vietnam" },
			{ type: "city", name: "Hội An" },
			{ type: "area", name: "Minh An" },
		]);
	});

	it("a city result is filed under its country; a country at the top", () => {
		expect(
			suggestFiling(nodes, { countryCode: "JP", country: "Japan" }, "city"),
		).toEqual({ existing: [N.japan], create: [] });
		expect(
			suggestFiling(nodes, { countryCode: "JP", country: "Japan" }, "country"),
		).toEqual({ existing: [], create: [] });
		expect(
			suggestFiling(nodes, { countryCode: "IT", country: "Italy" }, "city"),
		).toEqual({ existing: [], create: [{ type: "country", name: "Italy" }] });
	});

	it("an area result is filed under its city", () => {
		const f = suggestFiling(
			nodes,
			{ countryCode: "JP", country: "Japan", city: "Kyoto", locality: "Gion" },
			"area",
		);
		expect(f.existing.map(name)).toEqual(["Japan", "Kyoto"]);
		expect(f.create).toEqual([]);
	});

	it("a region named like the city (Tokyo the metropolis) hosts the place", () => {
		const own: FilingNode[] = [
			{
				id: "jp",
				parentId: null,
				type: "country",
				name: "Japan",
				countryCode: "JP",
			},
			{
				id: "tk",
				parentId: "jp",
				type: "region",
				name: "Tokyo",
				countryCode: "JP",
			},
		];
		const f = suggestFiling(
			own,
			{
				country: "Japan",
				countryCode: "JP",
				region: "東京都",
				city: "Tokyo",
				district: "Shibuya",
				locality: "Shibuya 2",
			},
			"place",
		);
		expect(f.existing).toEqual(["jp", "tk"]);
		expect(f.create).toEqual([{ type: "area", name: "Shibuya" }]);
	});

	it("skips dropped nodes", () => {
		const dropped = nodes.map((n) =>
			n.id === N.asakusa ? { ...n, status: "dropped" as const } : n,
		);
		const parts = photonParts(SENSOJI_PHOTON.properties);
		const f = suggestFiling(dropped, parts, "place");
		expect(f.existing.map(name)).toEqual(["Japan", "Tokyo"]);
		expect(f.create).toEqual([{ type: "area", name: "Asakusa" }]);
	});
});

describe("findDuplicate (E8)", () => {
	it("matches a similar name within 100 m", () => {
		const hit = findDuplicate(nodes, {
			name: "Itoya",
			lat: 35.6725,
			lng: 139.7674,
		});
		expect(hit?.id).toBe(N.itoya);
	});
	it("ignores the same name far away and different names nearby", () => {
		expect(
			findDuplicate(nodes, { name: "Itoya", lat: 38.5693, lng: 140.5317 }),
		).toBeUndefined();
		expect(
			findDuplicate(nodes, { name: "Mitsukoshi", lat: 35.6725, lng: 139.7674 }),
		).toBeUndefined();
	});
	it("SHR-07: the same name ~110 m off still matches (geocoded seed pins are coarse)", () => {
		// The imported "Itoya (G.Itoya)" vs Photon's osm:W608331102 "Itoya".
		const seeded: FilingNode[] = [
			...nodes.filter((n) => n.id !== N.itoya),
			{
				id: "itoya-seed",
				parentId: N.tokyo as string,
				type: "place",
				name: "Itoya (G.Itoya)",
				lat: 35.6739,
				lng: 139.7676,
			},
		];
		const hit = findDuplicate(seeded, {
			osmRef: "W608331102",
			name: "Itoya",
			lat: 35.67293,
			lng: 139.76783,
		});
		expect(hit?.id).toBe("itoya-seed");
		// The shared link's own spot counts too, even when the provider's
		// match is further away than the same-name radius.
		const viaLink = findDuplicate(seeded, {
			name: "伊東屋",
			lat: 35.6705,
			lng: 139.7699,
			also: { lat: 35.6739, lng: 139.7676, name: "Itoya" },
		});
		expect(viaLink?.id).toBe("itoya-seed");
		// A containing name is held to 100 m, and the nearest match wins.
		expect(
			findDuplicate(seeded, {
				name: "Itoya Store",
				lat: 35.67293,
				lng: 139.76783,
			}),
		).toBeUndefined();
		expect(
			findDuplicate([...seeded, ...nodes], {
				name: "Itoya",
				lat: 35.6725,
				lng: 139.7673,
			})?.id,
		).toBe(N.itoya);
	});
	it("matches by Google place id or OSM ref first", () => {
		const withIds = nodes.map((n) =>
			n.id === N.sensoji
				? { ...n, googlePlaceId: "ChIJ8T1GpMGOGGARDYGSgpooDWw", osmRef: "W123" }
				: n,
		);
		expect(
			findDuplicate(withIds, {
				googlePlaceId: "ChIJ8T1GpMGOGGARDYGSgpooDWw",
				name: "x",
			})?.id,
		).toBe(N.sensoji);
		expect(findDuplicate(withIds, { osmRef: "W123", name: "x" })?.id).toBe(
			N.sensoji,
		);
	});
});

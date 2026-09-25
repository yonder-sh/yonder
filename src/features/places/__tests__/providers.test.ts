import { describe, expect, it } from "vitest";
import {
	googlePrimaryTypes,
	photonLayers,
	resultKind,
} from "../lib/categorize";
import {
	dedupeResults,
	GOOGLE_PHOTO_NAME_RE,
	googleMapsLink,
	googleParts,
	googlePhotos,
	googlePreview,
	googleResult,
	photonPreview,
	photonRef,
	photonResult,
} from "../lib/providers";
import {
	GINZA_QUARTER_PHOTON,
	ITOYA_PHOTON,
	JAPAN_PHOTON,
	KYOTO_CITY_PHOTON,
	KYOTO_STATION_PHOTON,
	SENSOJI_PHOTON,
} from "./photon-fixtures";

describe("resultKind", () => {
	it("maps OSM key=value to a category", () => {
		expect(resultKind(["osm:shop=stationery", "photon:house"])).toEqual({
			level: "place",
			category: "shopping",
		});
		expect(resultKind(["osm:amenity=place_of_worship"])).toEqual({
			level: "place",
			category: "temple_shrine",
		});
		expect(resultKind(["osm:railway=station"]).category).toBe("station");
		expect(resultKind(["osm:tourism=viewpoint"]).category).toBe("viewpoint");
		expect(resultKind(["osm:amenity=bar"]).category).toBe("bar");
		expect(resultKind(["osm:amenity=cafe"]).category).toBe("cafe");
		expect(resultKind(["osm:amenity=bench"]).category).toBeUndefined();
	});
	it("maps OSM places and Photon layers to levels", () => {
		expect(resultKind(["osm:place=country", "photon:country"]).level).toBe(
			"country",
		);
		expect(resultKind(["osm:place=city", "photon:city"]).level).toBe("city");
		expect(resultKind(["osm:place=quarter", "photon:locality"]).level).toBe(
			"area",
		);
		expect(
			resultKind(["osm:boundary=administrative", "photon:district"]).level,
		).toBe("area");
	});
	it("maps Google types (levels first, then categories)", () => {
		expect(resultKind(["locality", "political"]).level).toBe("city");
		expect(resultKind(["country", "political"]).level).toBe("country");
		expect(resultKind(["sublocality_level_1", "political"]).level).toBe("area");
		expect(resultKind(["buddhist_temple", "tourist_attraction"])).toEqual({
			level: "place",
			category: "temple_shrine",
		});
		expect(resultKind(["book_store", "store"]).category).toBe("shopping");
		expect(
			resultKind(["ramen_restaurant", "restaurant", "food"]).category,
		).toBe("restaurant");
		expect(resultKind(["something_new"])).toEqual({ level: "place" });
	});
	it("gives Google and Photon level filters", () => {
		expect(googlePrimaryTypes("city")).toEqual(["(cities)"]);
		expect(googlePrimaryTypes("place")).toEqual([]);
		expect(photonLayers("area")).toEqual(["district", "locality"]);
		expect(photonLayers(undefined)).toEqual([]);
	});
});

describe("Photon mapping", () => {
	it("keeps a stable OSM ref", () => {
		expect(photonRef(ITOYA_PHOTON.properties)).toBe("osm:W608331102");
		expect(photonRef({ osm_type: "X", osm_id: 1 })).toBeNull();
	});
	it("builds a result and a preview", () => {
		const r = photonResult(ITOYA_PHOTON);
		expect(r).toMatchObject({
			ref: "osm:W608331102",
			title: "Itoya",
			lat: 35.6729335,
			lng: 139.7678324,
		});
		expect(r?.subtitle).toBe("15 7, Ginza 2, Chuo, Tokyo, 東京都, Japan");
		const p = photonPreview(ITOYA_PHOTON);
		expect(p).toMatchObject({
			provider: "photon",
			name: "Itoya",
			countryCode: "JP",
			level: "place",
			category: "shopping",
			photos: [],
		});
		expect(p?.bbox).toBeUndefined();
		expect(p?.parts).toMatchObject({
			country: "Japan",
			city: "Tokyo",
			district: "Chuo",
			locality: "Ginza 2",
		});
	});
	it("coarse results carry a bbox and name themselves in the parts", () => {
		const city = photonPreview(KYOTO_CITY_PHOTON);
		expect(city?.level).toBe("city");
		expect(city?.bbox).toEqual([135.559006, 34.874916, 135.878442, 35.3212207]);
		expect(city?.parts.city).toBe("Kyoto");
		const quarter = photonPreview(GINZA_QUARTER_PHOTON);
		expect(quarter?.level).toBe("area");
		expect(quarter?.parts.locality).toBe("Ginza");
		expect(photonPreview(JAPAN_PHOTON)?.level).toBe("country");
		expect(photonPreview(KYOTO_STATION_PHOTON)).toMatchObject({
			level: "place",
			category: "station",
		});
		expect(photonPreview(SENSOJI_PHOTON)?.category).toBe("temple_shrine");
	});
	it("drops near-identical duplicates", () => {
		const a = photonResult(ITOYA_PHOTON);
		const b = { ...(a as NonNullable<typeof a>), ref: "osm:W1", lng: 139.7675 };
		const far = { ...(a as NonNullable<typeof a>), ref: "osm:W2", lat: 38.5 };
		expect(
			dedupeResults([a as NonNullable<typeof a>, b, far]).map((r) => r.ref),
		).toEqual(["osm:W608331102", "osm:W2"]);
	});
});

describe("Google mapping", () => {
	it("reads autocomplete suggestions", () => {
		expect(
			googleResult({
				placePrediction: {
					placeId: "ChIJ8T1GpMGOGGARDYGSgpooDWw",
					structuredFormat: {
						mainText: { text: "Itoya" },
						secondaryText: { text: "Ginza, Chuo City, Tokyo, Japan" },
					},
					types: ["book_store", "store"],
				},
			}),
		).toEqual({
			ref: "ChIJ8T1GpMGOGGARDYGSgpooDWw",
			title: "Itoya",
			subtitle: "Ginza, Chuo City, Tokyo, Japan",
			types: ["book_store", "store"],
		});
		expect(googleResult({})).toBeNull();
	});
	it("builds a preview without photo names", () => {
		const g = {
			id: "ChIJ8T1GpMGOGGARDYGSgpooDWw",
			displayName: { text: "Itoya", languageCode: "en" },
			formattedAddress: "2-chōme-7-15 Ginza, Chuo City, Tokyo 104-0061, Japan",
			location: { latitude: 35.6729, longitude: 139.7678 },
			types: ["book_store", "store"],
			primaryType: "book_store",
			addressComponents: [
				{
					longText: "Ginza",
					shortText: "Ginza",
					types: ["sublocality_level_1", "sublocality"],
				},
				{
					longText: "Chuo City",
					shortText: "Chuo City",
					types: ["locality", "political"],
				},
				{
					longText: "Tokyo",
					shortText: "Tokyo",
					types: ["administrative_area_level_1"],
				},
				{ longText: "Japan", shortText: "JP", types: ["country", "political"] },
			],
			photos: [
				{
					name: "places/ChIJ8T1GpMGOGGARDYGSgpooDWw/photos/AbC_123",
					widthPx: 4032,
					heightPx: 3024,
					authorAttributions: [
						{
							displayName: "A. Photographer",
							uri: "https://maps.google.com/maps/contrib/1",
						},
					],
				},
			],
			googleMapsUri: "https://maps.google.com/?cid=123",
		};
		const p = googlePreview(g);
		expect(p).toMatchObject({
			provider: "google",
			ref: "ChIJ8T1GpMGOGGARDYGSgpooDWw",
			name: "Itoya",
			level: "place",
			category: "shopping",
			countryCode: "JP",
		});
		expect(JSON.stringify(p)).not.toContain("photos/AbC_123");
		expect(googlePhotos(g)).toEqual([
			{
				idx: 0,
				width: 4032,
				height: 3024,
				attributions: [
					{
						name: "A. Photographer",
						uri: "https://maps.google.com/maps/contrib/1",
					},
				],
			},
		]);
		expect(googleParts(g)).toMatchObject({
			country: "Japan",
			countryCode: "JP",
			region: "Tokyo",
			city: "Chuo City",
			district: "Ginza",
		});
	});
	it("validates photo names strictly", () => {
		expect(GOOGLE_PHOTO_NAME_RE.test("places/abc/photos/def")).toBe(true);
		expect(GOOGLE_PHOTO_NAME_RE.test("places/abc/photos/../../x")).toBe(false);
		expect(GOOGLE_PHOTO_NAME_RE.test("https://evil/places/a/photos/b")).toBe(
			false,
		);
	});
	it("links to Google Maps by place id or coordinates", () => {
		expect(
			googleMapsLink({
				name: "x",
				lat: 35.1,
				lng: 139.2,
				googlePlaceId: "ChIJabc",
			}),
		).toBe(
			"https://www.google.com/maps/search/?api=1&query=35.1%2C139.2&query_place_id=ChIJabc",
		);
		expect(googleMapsLink({ name: "x", lat: null, lng: null })).toBeNull();
		expect(
			googleMapsLink({
				name: "x",
				lat: 1,
				lng: 2,
				googleMapsUri: "javascript:alert(1)",
			}),
		).toBe("https://www.google.com/maps/search/?api=1&query=1%2C2");
	});
});

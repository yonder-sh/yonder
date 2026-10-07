import { describe, expect, it } from "vitest";
import type { PlaceSearchResult } from "../lib/providers";
import {
	inTripCountry,
	newCountryOf,
	queryNamesCity,
	rankInTripCountries,
	tripCountries,
} from "../lib/trip-countries";

const r = (
	ref: string,
	subtitle: string,
	extra: Partial<PlaceSearchResult> = {},
): PlaceSearchResult => ({ ref, title: ref, subtitle, types: [], ...extra });

const JAPAN = tripCountries([
	{ type: "country", name: "Japan", localName: "日本", countryCode: "jp" },
	{ type: "city", name: "Tokyo", countryCode: null },
	{ type: "country", name: "Belgium", countryCode: "BE", status: "dropped" },
]);

describe("tripCountries", () => {
	it("keeps live countries, codes upper-cased", () => {
		expect(JAPAN).toEqual([{ name: "Japan", localName: "日本", code: "JP" }]);
	});
});

describe("inTripCountry", () => {
	it("matches by code, else by the address's last part", () => {
		expect(
			inTripCountry(r("a", "Ghent, Belgium", { countryCode: "JP" }), JAPAN),
		).toBe(true);
		expect(
			inTripCountry(r("a", "Shinjuku, Japan", { countryCode: "BE" }), JAPAN),
		).toBe(false);
		expect(inTripCountry(r("a", "Shinjuku City, Tokyo, Japan"), JAPAN)).toBe(
			true,
		);
		expect(inTripCountry(r("a", "新宿区, 東京都, 日本"), JAPAN)).toBe(true);
		expect(inTripCountry(r("a", "Ghent, Belgium"), JAPAN)).toBe(false);
		expect(inTripCountry(r("a", ""), JAPAN)).toBe(false);
	});
});

describe("rankInTripCountries", () => {
	it("puts the trip's countries first, the order kept otherwise", () => {
		const results = [
			r("ghent", "Ghent, Belgium", { countryCode: "BE" }),
			r("ham", "Ham, Belgium"),
			r("gai1", "Shinjuku, Tokyo, Japan", { countryCode: "JP" }),
			r("gai2", "Kabukicho, Japan"),
		];
		expect(rankInTripCountries(results, JAPAN).map((x) => x.ref)).toEqual([
			"gai1",
			"gai2",
			"ghent",
			"ham",
		]);
	});

	it("changes nothing on a trip with no country", () => {
		const results = [r("ghent", "Ghent, Belgium"), r("gai", "Tokyo, Japan")];
		expect(rankInTripCountries(results, []).map((x) => x.ref)).toEqual([
			"ghent",
			"gai",
		]);
	});
});

describe("newCountryOf", () => {
	const belgium = {
		create: [
			{ type: "country", name: "Belgium" },
			{ type: "city", name: "Ghent" },
		],
	};
	it("names the country a save would add", () => {
		expect(newCountryOf(belgium, JAPAN)).toBe("Belgium");
	});
	it("is null for the trip's first country, or no new country", () => {
		expect(newCountryOf(belgium, [])).toBeNull();
		expect(
			newCountryOf({ create: [{ type: "city", name: "Nara" }] }, JAPAN),
		).toBeNull();
	});
});

describe("queryNamesCity", () => {
	const kyoto = r("kyoto", "Japan", {
		title: "Kyoto",
		types: ["osm:place=city", "photon:city"],
	});
	const station = r("st", "Kyoto, Japan", {
		title: "Kyoto Station",
		types: ["osm:railway=station"],
	});
	it("is true when a city result starts with the query", () => {
		expect(queryNamesCity("kyoto", [station, kyoto])).toBe(true);
		expect(queryNamesCity("Kyo", [kyoto])).toBe(true);
	});
	it("is false otherwise", () => {
		expect(queryNamesCity("Kyoto", [station])).toBe(false);
		expect(queryNamesCity("Narnia", [kyoto])).toBe(false);
		expect(queryNamesCity(" ", [kyoto])).toBe(false);
	});
});

/** Saved by place: the Where chips, the grid's groups and order, the trip label, the Saver's area default. */
import { describe, expect, it } from "vitest";
import { whereParent } from "@/features/home/share-classify";
import type { SavedLink, SavedWhere } from "../types";
import {
	choiceKey,
	gridOrder,
	groupSaved,
	inTripsLabel,
	matchCountries,
	suggestedWhere,
	whereChips,
	whereLabel,
} from "../where";

const at = (
	countryCode: string,
	city: string | null,
	when: number,
): SavedWhere => ({
	countryCode,
	city,
	cityKey: city ? city.toLowerCase() : null,
	lat: null,
	lng: null,
	at: when,
});

const item = (
	id: string,
	where: SavedWhere | null,
	createdAt = 0,
	trips: SavedLink["trips"] = [],
) => ({ id, where, createdAt, trips }) as unknown as SavedLink;

describe("the Where chips", () => {
	it("most recent first, a city then its country, no repeats", () => {
		const chips = whereChips([
			item("a", at("JP", "Kyoto", 3)),
			item("b", at("KR", "Seoul", 5)),
			item("c", at("JP", "Tokyo", 1)),
			item("d", at("JP", "Kyoto", 2)),
			item("e", null),
		]);
		expect(chips.map((c) => whereLabel(c))).toEqual([
			"Seoul, South Korea",
			"South Korea",
			"Kyoto, Japan",
			"Japan",
			"Tokyo, Japan",
		]);
	});

	it("nothing filed yet: my trips' cities and countries", () => {
		const chips = whereChips(
			[],
			[
				{
					countryCodes: ["JP", "KR"],
					cities: [
						{ name: "Tokyo", countryCode: "JP", lat: 35.7, lng: 139.7 },
						{ name: "Seoul", countryCode: "KR", lat: 37.5, lng: 127 },
					],
				},
				{ countryCodes: ["JP", "TW"], cities: [] },
			],
		);
		expect(chips.map(choiceKey)).toEqual([
			"JP|tokyo",
			"KR|seoul",
			"JP|",
			"KR|",
			"TW|",
		]);
		expect(chips[0]?.city).toEqual({ name: "Tokyo", lat: 35.7, lng: 139.7 });
	});

	it("a Maps link's real place is suggested; a guess never is", () => {
		const place = {
			name: "Kissa Mado",
			lat: 35,
			lng: 135.77,
			countryCode: "JP",
			city: "Kyoto",
		};
		expect(
			suggestedWhere({ place: { ...place, exact: true }, where: null }),
		).toEqual({
			countryCode: "JP",
			city: { name: "Kyoto", lat: null, lng: null },
		});
		expect(suggestedWhere({ place, where: null })).toBeNull();
		expect(
			suggestedWhere({
				place: { ...place, exact: true },
				where: at("JP", "Osaka", 1),
			}),
		).toBeNull();
	});

	it("search finds countries on the device", () => {
		expect(matchCountries("jap").map((c) => c.code)).toEqual(["JP"]);
		expect(matchCountries("korea").map((c) => c.code)).toContain("KR");
		expect(matchCountries("")).toEqual([]);
	});
});

describe("the grid by place", () => {
	it("countries, then cities (the no-city ones last), then Unsorted; the feed follows", () => {
		const groups = groupSaved([
			item("u1", null, 100),
			item("k1", at("JP", "Kyoto", 50), 90),
			item("s1", at("KR", "Seoul", 80), 80),
			item("j1", at("JP", null, 70), 70),
			item("t1", at("JP", "Tokyo", 10), 60),
			item("k2", at("JP", "Kyoto", 5), 5),
		]);
		expect(
			groups.map((g) => [
				g.label,
				g.count,
				g.cities.map((c) => [c.label, c.items.map((l) => l.id)]),
			]),
		).toEqual([
			[
				"Japan",
				4,
				[
					["Kyoto", ["k1", "k2"]],
					["Tokyo", ["t1"]],
					["Japan (no city)", ["j1"]],
				],
			],
			["South Korea", 1, [["Seoul", ["s1"]]]],
			["Unsorted", 1, [["Unsorted", ["u1"]]]],
		]);
		expect(gridOrder(groups)).toEqual(["k1", "k2", "t1", "j1", "s1", "u1"]);
	});

	it("says which trips it went into", () => {
		expect(inTripsLabel([])).toBeNull();
		expect(inTripsLabel([{ id: "1", name: "Japan 2027", slug: "j" }])).toBe(
			"In Japan 2027",
		);
		expect(
			inTripsLabel([
				{ id: "1", name: "Japan 2027", slug: "j" },
				{ id: "2", name: "Korea", slug: "k" },
			]),
		).toBe("In 2 trips");
	});
});

describe("the Saver's area for a filed item", () => {
	const nodes = [
		{
			id: "jp",
			parentId: null,
			type: "country",
			name: "Japan",
			lat: null,
			lng: null,
			countryCode: "JP",
		},
		{
			id: "kyo",
			parentId: "jp",
			type: "city",
			name: "Kyōto",
			lat: 35,
			lng: 135.7,
		},
		{
			id: "kr",
			parentId: null,
			type: "country",
			name: "Korea",
			lat: null,
			lng: null,
			countryCode: "KR",
		},
	];
	it("the trip's city, else its country (creating the city), else nothing", () => {
		expect(whereParent(nodes, { countryCode: "JP", city: "Kyoto" })).toEqual({
			parentId: "kyo",
			create: [],
		});
		expect(whereParent(nodes, { countryCode: "JP", city: "Osaka" })).toEqual({
			parentId: "jp",
			create: [{ type: "city", name: "Osaka" }],
		});
		expect(whereParent(nodes, { countryCode: "KR", city: null })).toEqual({
			parentId: "kr",
			create: [],
		});
		expect(
			whereParent(nodes, { countryCode: "TW", city: "Taipei" }),
		).toBeNull();
		expect(whereParent(nodes, null)).toBeNull();
	});
});

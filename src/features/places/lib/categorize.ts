/**
 * Provider place types → our node level and place category (SPEC §7.1–§7.2).
 * Pure and isomorphic: the server uses it to build previews, the palette to
 * pick a glyph for a search result before any preview is fetched.
 *
 * Google types (Places API (New) "Table A/B") and OSM `key=value` pairs
 * (Photon's `osm_key`/`osm_value`) both map onto the 22 categories. Anything
 * unknown is a plain `place` with no category (the category chips let the
 * user choose), never an error.
 */
import type { NodeType, PlaceCategory } from "@/lib/schemas/enums";

export type ResultKind = { level: NodeType; category?: PlaceCategory };

/** Google type → category, most specific first (the first hit wins). */
const GOOGLE_CATEGORY: [string, PlaceCategory][] = [
	["airport", "airport"],
	["international_airport", "airport"],
	["train_station", "station"],
	["subway_station", "station"],
	["light_rail_station", "station"],
	["transit_station", "station"],
	["bus_station", "station"],
	["ferry_terminal", "port"],
	["hotel", "lodging"],
	["lodging", "lodging"],
	["ryokan", "lodging"],
	["hostel", "lodging"],
	["japanese_inn", "lodging"],
	["bed_and_breakfast", "lodging"],
	["resort_hotel", "lodging"],
	["hot_spring", "onsen"],
	["public_bath", "onsen"],
	["spa", "onsen"],
	["sauna", "onsen"],
	["buddhist_temple", "temple_shrine"],
	["shinto_shrine", "temple_shrine"],
	["hindu_temple", "temple_shrine"],
	["church", "temple_shrine"],
	["mosque", "temple_shrine"],
	["synagogue", "temple_shrine"],
	["place_of_worship", "temple_shrine"],
	["museum", "museum"],
	["art_gallery", "museum"],
	["observation_deck", "viewpoint"],
	["scenic_spot", "viewpoint"],
	["beach", "beach"],
	["national_park", "nature"],
	["hiking_area", "nature"],
	["state_park", "nature"],
	["botanical_garden", "park"],
	["garden", "park"],
	["park", "park"],
	["amusement_park", "activity"],
	["aquarium", "activity"],
	["zoo", "activity"],
	["tourist_attraction", "sight"],
	["historical_landmark", "sight"],
	["historical_place", "sight"],
	["monument", "sight"],
	["cultural_landmark", "sight"],
	["castle", "sight"],
	["market", "market"],
	["farmers_market", "market"],
	["food_market", "market"],
	["bar", "bar"],
	["pub", "bar"],
	["wine_bar", "bar"],
	["cocktail_bar", "bar"],
	["night_club", "nightlife"],
	["karaoke", "nightlife"],
	["cafe", "cafe"],
	["coffee_shop", "cafe"],
	["tea_house", "cafe"],
	["bakery", "cafe"],
	["dessert_shop", "cafe"],
	["restaurant", "restaurant"],
	["food", "food_drink"],
	["meal_takeaway", "food_drink"],
	["shopping_mall", "shopping"],
	["department_store", "shopping"],
	["book_store", "shopping"],
	["clothing_store", "shopping"],
	["gift_shop", "shopping"],
	["store", "shopping"],
	["event_venue", "event"],
	["stadium", "event"],
	["concert_hall", "event"],
	["performing_arts_theater", "event"],
	["movie_theater", "activity"],
	["tourist_information_center", "sight"],
];

/** Google types that name administrative levels. */
function googleLevel(types: readonly string[]): NodeType | null {
	const t = new Set(types);
	if (t.has("country")) return "country";
	if (t.has("administrative_area_level_1")) return "region";
	if (t.has("locality") || t.has("postal_town")) return "city";
	if (
		t.has("sublocality") ||
		t.has("sublocality_level_1") ||
		t.has("sublocality_level_2") ||
		t.has("neighborhood") ||
		t.has("administrative_area_level_2") ||
		t.has("administrative_area_level_3")
	)
		return "area";
	return null;
}

/** OSM `key=value` → category. Values checked before keys. */
const OSM_VALUE: Record<string, PlaceCategory> = {
	aerodrome: "airport",
	terminal: "airport",
	station: "station",
	halt: "station",
	subway_entrance: "station",
	tram_stop: "station",
	bus_station: "station",
	ferry_terminal: "port",
	hotel: "lodging",
	hostel: "lodging",
	guest_house: "lodging",
	motel: "lodging",
	apartment: "lodging",
	onsen: "onsen",
	public_bath: "onsen",
	spa: "onsen",
	sauna: "onsen",
	place_of_worship: "temple_shrine",
	temple: "temple_shrine",
	shrine: "temple_shrine",
	museum: "museum",
	gallery: "museum",
	arts_centre: "museum",
	viewpoint: "viewpoint",
	beach: "beach",
	peak: "nature",
	volcano: "nature",
	waterfall: "nature",
	nature_reserve: "nature",
	national_park: "nature",
	wood: "nature",
	park: "park",
	garden: "park",
	theme_park: "activity",
	zoo: "activity",
	aquarium: "activity",
	water_park: "activity",
	escape_game: "activity",
	attraction: "sight",
	castle: "sight",
	monument: "sight",
	memorial: "sight",
	ruins: "sight",
	tower: "sight",
	marketplace: "market",
	bar: "bar",
	pub: "bar",
	biergarten: "bar",
	nightclub: "nightlife",
	karaoke_box: "nightlife",
	cafe: "cafe",
	tea: "cafe",
	coffee: "cafe",
	bakery: "cafe",
	confectionery: "cafe",
	ice_cream: "cafe",
	restaurant: "restaurant",
	fast_food: "food_drink",
	food_court: "food_drink",
	theatre: "event",
	stadium: "event",
	cinema: "activity",
};

/** Photon `type` (its layer) → level. */
const PHOTON_LAYER: Record<string, NodeType> = {
	country: "country",
	state: "region",
	city: "city",
	county: "city",
	district: "area",
	locality: "area",
};

/** OSM place=* values that name settlements and neighbourhoods. */
const OSM_PLACE_LEVEL: Record<string, NodeType> = {
	country: "country",
	state: "region",
	province: "region",
	region: "region",
	city: "city",
	town: "city",
	village: "city",
	municipality: "city",
	suburb: "area",
	quarter: "area",
	neighbourhood: "area",
	borough: "area",
	city_block: "area",
	hamlet: "area",
};

function osmCategory(key: string, value: string): PlaceCategory | undefined {
	const byValue = OSM_VALUE[value];
	if (byValue) return byValue;
	switch (key) {
		case "shop":
			return value === "supermarket" || value === "convenience"
				? "food_drink"
				: "shopping";
		case "amenity":
			return undefined;
		case "tourism":
			return "sight";
		case "historic":
			return "sight";
		case "leisure":
			return "activity";
		case "natural":
			return "nature";
		case "railway":
			return "station";
		case "aeroway":
			return "airport";
		default:
			return undefined;
	}
}

/**
 * The level and category a search result stands for, from its `types`:
 * Google place types, or `osm:<key>=<value>` plus `photon:<layer>`.
 */
export function resultKind(types: readonly string[]): ResultKind {
	const osm = types.find((t) => t.startsWith("osm:"));
	if (osm) {
		const [key = "", value = ""] = osm.slice(4).split("=", 2);
		const layer = types
			.find((t) => t.startsWith("photon:"))
			?.slice("photon:".length);
		if (key === "place") {
			const level = OSM_PLACE_LEVEL[value];
			if (level) return { level };
		}
		const layerLevel = layer ? PHOTON_LAYER[layer] : undefined;
		if ((key === "boundary" || key === "place") && layerLevel)
			return { level: layerLevel };
		return { level: "place", category: osmCategory(key, value) };
	}
	const level = googleLevel(types);
	if (level) return { level };
	for (const [t, c] of GOOGLE_CATEGORY)
		if (types.includes(t)) return { level: "place", category: c };
	return { level: "place" };
}

/** The Google `includedPrimaryTypes` for a palette level (SPEC §14.1). */
export function googlePrimaryTypes(level: NodeType | undefined): string[] {
	switch (level) {
		case "country":
			return ["country"];
		case "city":
			return ["(cities)"];
		case "area":
		case "region":
			return ["(regions)"];
		default:
			return [];
	}
}

/** Photon `layer` filters for a palette level. */
export function photonLayers(level: NodeType | undefined): string[] {
	switch (level) {
		case "country":
			return ["country"];
		case "region":
			return ["state"];
		case "city":
			return ["city", "county"];
		case "area":
			return ["district", "locality"];
		default:
			return [];
	}
}

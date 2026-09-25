/** Recorded Photon features (photon.komoot.io, 2026-09-23), trimmed. */
import type { PhotonFeature } from "../lib/providers";

export const ITOYA_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "W",
		osm_id: 608331102,
		osm_key: "shop",
		osm_value: "stationery",
		type: "house",
		housenumber: "15",
		name: "Itoya",
		street: "7",
		locality: "Ginza 2",
		district: "Chuo",
		city: "Tokyo",
		state: "東京都",
		country: "Japan",
		postcode: "104-0061",
		countrycode: "JP",
		extent: [139.7677284, 35.673013, 139.7679363, 35.672854],
	},
	geometry: { type: "Point", coordinates: [139.7678324, 35.6729335] },
};

export const SENSOJI_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "W",
		osm_id: 173154847,
		osm_key: "amenity",
		osm_value: "place_of_worship",
		type: "house",
		housenumber: "1",
		name: "Sensō-ji",
		street: "3",
		locality: "Asakusa 2",
		district: "Taito",
		city: "Tokyo",
		country: "Japan",
		postcode: "111-0032",
		countrycode: "JP",
		extent: [139.7942244, 35.7159424, 139.7976804, 35.7109656],
	},
	geometry: { type: "Point", coordinates: [139.7955265, 35.7134032] },
};

export const KYOTO_STATION_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "N",
		osm_id: 3628707764,
		osm_key: "railway",
		osm_value: "station",
		type: "house",
		name: "Kyoto",
		street: "North-South Free Passage",
		locality: "Higashikujo-Kamitonodacho",
		district: "Minami Ward",
		city: "Kyoto",
		state: "Kyoto Prefecture",
		country: "Japan",
		postcode: "601-8002",
		countrycode: "JP",
	},
	geometry: { type: "Point", coordinates: [135.7584303, 34.9846076] },
};

export const KYOTO_CITY_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "R",
		osm_id: 357794,
		osm_key: "place",
		osm_value: "city",
		type: "city",
		name: "Kyoto",
		state: "Kyoto Prefecture",
		country: "Japan",
		countrycode: "JP",
		extent: [135.559006, 35.3212207, 135.878442, 34.874916],
	},
	geometry: { type: "Point", coordinates: [135.7681441, 35.0115754] },
};

export const GINZA_QUARTER_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "R",
		osm_id: 4859036,
		osm_key: "place",
		osm_value: "quarter",
		type: "locality",
		name: "Ginza",
		district: "Chuo",
		city: "Tokyo",
		country: "Japan",
		postcode: "104-0061",
		countrycode: "JP",
		extent: [139.758555, 35.6759278, 139.7724498, 35.663084],
	},
	geometry: { type: "Point", coordinates: [139.7647202, 35.6720135] },
};

export const JAPAN_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "R",
		osm_id: 382313,
		osm_key: "place",
		osm_value: "country",
		type: "country",
		name: "Japan",
		country: "Japan",
		countrycode: "JP",
		extent: [122.7141754, 45.7112046, 154.205541, 20.2145811],
	},
	geometry: { type: "Point", coordinates: [139.2394179, 36.5748441] },
};

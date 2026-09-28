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

/** Reverse results in local script (`/reverse?lang=default`, photon.komoot.io, 2026-09-28). */
export const LOCAL_NAKANO_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "N",
		osm_id: 6794467587,
		osm_key: "shop",
		osm_value: "tobacco",
		type: "house",
		housenumber: "15",
		name: "beyond",
		street: "52",
		locality: "中野五丁目",
		district: "中野区",
		city: "中野区",
		state: "東京都",
		country: "日本",
		postcode: "165-0001",
		countrycode: "JP",
	},
	geometry: { type: "Point", coordinates: [139.6655816, 35.708962] },
};

export const LOCAL_ITOYA_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "W",
		osm_id: 608331102,
		osm_key: "shop",
		osm_value: "stationery",
		type: "house",
		housenumber: "15",
		name: "伊東屋",
		street: "7",
		locality: "2丁目",
		district: "中央区",
		city: "中央区",
		state: "東京都",
		country: "日本",
		postcode: "104-0061",
		countrycode: "JP",
		extent: [139.7677284, 35.673013, 139.7679363, 35.672854],
	},
	geometry: { type: "Point", coordinates: [139.7678324, 35.6729335] },
};

export const LOCAL_SENSOJI_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "W",
		osm_id: 173154847,
		osm_key: "amenity",
		osm_value: "place_of_worship",
		type: "house",
		housenumber: "1",
		name: "Храм Сенсодзи 金龍山 浅草寺",
		street: "3",
		locality: "浅草二丁目",
		district: "台東区",
		city: "台東区",
		country: "日本",
		postcode: "111-0032",
		countrycode: "JP",
		extent: [139.7942244, 35.7159424, 139.7976804, 35.7109656],
	},
	geometry: { type: "Point", coordinates: [139.7955265, 35.7134032] },
};

export const LOCAL_KIYOMIZU_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "W",
		osm_id: 102164590,
		osm_key: "building",
		osm_value: "shrine",
		type: "house",
		name: "本堂",
		street: "常盤橋",
		locality: "清水一丁目",
		district: "東山区",
		city: "京都市",
		state: "京都府",
		country: "日本",
		postcode: "605-0862",
		countrycode: "JP",
		extent: [135.7847298, 34.9950157, 135.7852386, 34.9946407],
	},
	geometry: { type: "Point", coordinates: [135.7850005, 34.9948421] },
};

export const LOCAL_SEOUL_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "R",
		osm_id: 10757525,
		osm_key: "amenity",
		osm_value: "library",
		type: "house",
		housenumber: "110",
		name: "서울도서관",
		street: "세종대로",
		locality: "태평로1가",
		district: "명동",
		city: "서울특별시",
		country: "대한민국",
		postcode: "04524",
		countrycode: "KR",
		extent: [126.9774192, 37.5665527, 126.9783334, 37.5661771],
	},
	geometry: { type: "Point", coordinates: [126.9778834, 37.5663541] },
};

export const LOCAL_TAIPEI_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "N",
		osm_id: 7004289010,
		osm_key: "amenity",
		osm_value: "restaurant",
		type: "house",
		name: "滿藝廚房",
		street: "人行空橋",
		locality: "台北世界貿易中心",
		district: "信義區",
		city: "臺北市",
		country: "臺灣",
		postcode: "11049",
		countrycode: "TW",
	},
	geometry: { type: "Point", coordinates: [121.5644985, 25.0338992] },
};

export const LOCAL_HANOI_PHOTON: PhotonFeature = {
	type: "Feature",
	properties: {
		osm_type: "N",
		osm_id: 13583967658,
		osm_key: "office",
		osm_value: "government",
		type: "house",
		housenumber: "17",
		name: "Hội đồng nhân dân Thành phố Hà Nội",
		street: "Phố Trần Nguyên Hãn",
		locality: "Khu phố cổ",
		district: "Hoàn Kiếm",
		city: "Hà Nội",
		country: "Việt Nam",
		postcode: "11024",
		countrycode: "VN",
	},
	geometry: { type: "Point", coordinates: [105.8542902, 21.0286211] },
};

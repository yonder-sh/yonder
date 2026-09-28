import { describe, expect, it } from "vitest";
import {
	arabicChome,
	isExactResult,
	localAddressOf,
} from "../lib/local-address";
import {
	LOCAL_HANOI_PHOTON,
	LOCAL_ITOYA_PHOTON,
	LOCAL_KIYOMIZU_PHOTON,
	LOCAL_NAKANO_PHOTON,
	LOCAL_SENSOJI_PHOTON,
	LOCAL_SEOUL_PHOTON,
	LOCAL_TAIPEI_PHOTON,
} from "./photon-fixtures";

const exact = { exact: true };

describe("localAddressOf (recorded Photon, lang=default)", () => {
	it("writes a Japanese address large to small, the block and number as 52-15", () => {
		expect(localAddressOf(LOCAL_NAKANO_PHOTON.properties, exact)).toBe(
			"東京都中野区中野5丁目52-15",
		);
		expect(localAddressOf(LOCAL_ITOYA_PHOTON.properties, exact)).toBe(
			"東京都中央区2丁目7-15",
		);
	});

	it("puts Tokyo back in front of a ward that came without its prefecture", () => {
		expect(localAddressOf(LOCAL_SENSOJI_PHOTON.properties, exact)).toBe(
			"東京都台東区浅草2丁目3-1",
		);
	});

	it("leaves out a street name, which Japanese addresses don't use", () => {
		expect(localAddressOf(LOCAL_KIYOMIZU_PHOTON.properties, exact)).toBe(
			"京都府京都市東山区清水1丁目",
		);
	});

	it("a neighbour's result keeps the area, not its house number", () => {
		expect(
			localAddressOf(LOCAL_NAKANO_PHOTON.properties, { exact: false }),
		).toBe("東京都中野区中野5丁目");
		expect(
			localAddressOf(LOCAL_HANOI_PHOTON.properties, { exact: false }),
		).toBe("Khu phố cổ, Hoàn Kiếm, Hà Nội");
	});

	it("writes a Korean road-name address with spaces, without the 동", () => {
		expect(localAddressOf(LOCAL_SEOUL_PHOTON.properties, exact)).toBe(
			"서울특별시 세종대로 110",
		);
	});

	it("writes a Taiwanese address large to small; without a number, the locality", () => {
		expect(localAddressOf(LOCAL_TAIPEI_PHOTON.properties, exact)).toBe(
			"臺北市信義區台北世界貿易中心",
		);
		expect(
			localAddressOf(
				{
					...LOCAL_TAIPEI_PHOTON.properties,
					street: "市府路",
					housenumber: "1",
				},
				exact,
			),
		).toBe("臺北市信義區市府路1號");
	});

	it("elsewhere runs small to large", () => {
		expect(localAddressOf(LOCAL_HANOI_PHOTON.properties, exact)).toBe(
			"17 Phố Trần Nguyên Hãn, Khu phố cổ, Hoàn Kiếm, Hà Nội",
		);
	});

	it("is null when Photon knows nothing", () => {
		expect(localAddressOf({ countrycode: "JP" }, exact)).toBeNull();
		expect(localAddressOf({}, exact)).toBeNull();
	});
});

describe("arabicChome", () => {
	it("writes the chōme number in digits", () => {
		expect(arabicChome("中野五丁目")).toBe("中野5丁目");
		expect(arabicChome("銀座十丁目")).toBe("銀座10丁目");
		expect(arabicChome("十二丁目")).toBe("12丁目");
		expect(arabicChome("二十三丁目")).toBe("23丁目");
		expect(arabicChome("2丁目")).toBe("2丁目");
		expect(arabicChome("一番町")).toBe("一番町");
	});
});

describe("isExactResult", () => {
	it("the same OSM object, however the ref is stored", () => {
		const far = { lat: 0, lng: 0 };
		expect(
			isExactResult(LOCAL_SENSOJI_PHOTON, { ...far, osmRef: "W173154847" }),
		).toBe(true);
		expect(
			isExactResult(LOCAL_SENSOJI_PHOTON, {
				...far,
				osmRef: "osm:W173154847",
			}),
		).toBe(true);
		expect(isExactResult(LOCAL_SENSOJI_PHOTON, far)).toBe(false);
	});

	it("a shape that covers the place, or a point within 60 m", () => {
		// Senso-ji's main hall, inside the temple grounds' extent.
		expect(
			isExactResult(LOCAL_SENSOJI_PHOTON, { lat: 35.7148, lng: 139.7967 }),
		).toBe(true);
		// Nakano Broadway, 10 m from the shop inside it.
		expect(
			isExactResult(LOCAL_NAKANO_PHOTON, { lat: 35.709, lng: 139.6655 }),
		).toBe(true);
		// 300 m away: a neighbour.
		expect(
			isExactResult(LOCAL_NAKANO_PHOTON, { lat: 35.7117, lng: 139.6655 }),
		).toBe(false);
	});
});

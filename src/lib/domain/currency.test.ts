import { describe, expect, it } from "vitest";
import { currencyForCountry } from "./currency";

describe("currencyForCountry", () => {
	it("maps the trip's countries and falls back to home", () => {
		expect(currencyForCountry("JP", "USD")).toBe("JPY");
		expect(currencyForCountry("kr", "USD")).toBe("KRW");
		expect(currencyForCountry("VN", "USD")).toBe("VND");
		expect(currencyForCountry("TW", "USD")).toBe("TWD");
		expect(currencyForCountry("TR", "USD")).toBe("TRY");
		expect(currencyForCountry("ZZ", "CAD")).toBe("CAD");
		expect(currencyForCountry(null, "CAD")).toBe("CAD");
	});
});

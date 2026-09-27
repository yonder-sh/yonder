/**
 * The phone's Now/Next row: a next stop that isn't today says which day, so
 * "Next 09:30 Cha no Ikedaya" at 22:00 isn't read as tonight.
 */
import { describe, expect, it } from "vitest";
import { nextDay } from "../NowNext";

const TZ = "Asia/Tokyo";
const at = Date.parse("2027-10-04T13:00:00Z"); // Mon 4 Oct, 22:00 JST

describe("the next stop's day", () => {
	it("says nothing for today or for the stop you're at", () => {
		expect(nextDay(new Date("2027-10-04T14:00:00Z"), at, TZ, false)).toBe("");
		expect(nextDay(new Date("2027-10-05T00:30:00Z"), at, TZ, true)).toBe("");
	});

	it("says Tomorrow, or the date further out", () => {
		expect(nextDay(new Date("2027-10-05T00:30:00Z"), at, TZ, false)).toBe(
			"Tomorrow ",
		);
		expect(nextDay(new Date("2027-10-07T00:30:00Z"), at, TZ, false)).toMatch(
			/7 Oct · $/,
		);
	});
});

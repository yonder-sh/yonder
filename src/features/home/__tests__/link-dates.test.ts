/**
 * FB-13a: the trip link's "Created …" / "Works until …" show the viewer's local
 * calendar date of the instant, not the UTC date sliced off the ISO string.
 * (This project runs with TZ=Pacific/Kiritimati, UTC+14.)
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatLocalDay } from "../link-dates";

describe("formatLocalDay (FB-13a)", () => {
	it("Los Angeles, Wed 23 Sep 17:15 PDT: created today, not Thu 24 Sep", () => {
		const created = "2026-09-24T00:15:00.000Z";
		const expires = "2026-12-23T00:15:00.000Z"; // + 90 days
		expect(formatLocalDay(created, "America/Los_Angeles")).toBe("Wed 23 Sep");
		expect(formatLocalDay(expires, "America/Los_Angeles")).toBe("Tue 22 Dec");
	});

	it("New York at 20:00 EDT on 23 Sep reads Wed 23 Sep", () => {
		expect(formatLocalDay("2026-09-24T00:00:00.000Z", "America/New_York")).toBe(
			"Wed 23 Sep",
		);
		expect(formatLocalDay("2026-09-23T03:59:59.000Z", "America/New_York")).toBe(
			"Tue 22 Sep",
		);
	});

	it("zones east of UTC get the later local date", () => {
		expect(formatLocalDay("2026-09-23T16:00:00.000Z", "Asia/Tokyo")).toBe(
			"Thu 24 Sep",
		);
		expect(formatLocalDay("2026-09-23T16:00:00.000Z", "UTC")).toBe(
			"Wed 23 Sep",
		);
	});

	it("defaults to the viewer's (host's) zone", () => {
		// 11:00 UTC is 01:00 the next day in Kiritimati (UTC+14).
		expect(formatLocalDay("2026-09-23T11:00:00.000Z")).toBe("Thu 24 Sep");
	});

	it("falls back to the viewer's zone for a bad zone, and echoes bad input", () => {
		expect(formatLocalDay("2026-09-23T11:00:00.000Z", "Not/AZone")).toBe(
			"Thu 24 Sep",
		);
		expect(formatLocalDay("not a date")).toBe("not a date");
	});

	it("the share dialog no longer slices the UTC date off link timestamps", () => {
		const src = readFileSync(
			new URL("../ShareDialog.tsx", import.meta.url),
			"utf8",
		);
		expect(src).not.toMatch(/(createdAt|expiresAt)\??\.slice\(0,\s*10\)/);
		expect(src).toContain("formatLocalDay(link.createdAt)");
		expect(src).toContain("formatLocalDay(link.expiresAt)");
	});
});

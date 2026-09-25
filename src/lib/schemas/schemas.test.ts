import { describe, expect, it } from "vitest";
import {
	BundleTarget,
	bundleTargetColumns,
	bundleTargetOf,
	HHmm,
	HttpUrl,
	LegDetails,
	NodeDetails,
	PLACE_CATEGORY_VALUES,
	PRIORITY_VALUES,
	readLegDetails,
	TripSettings,
	Tz,
} from "./index";
import { NodeDetailsPatch } from "./nodes";
import { TripSettingsPatch } from "./trips";

const ID = "0199f0f2-6a1e-7c3a-9d2b-2f4c5e6a7b8c";

describe("common", () => {
	it("Tz accepts IANA zones and rejects typos", () => {
		expect(Tz.safeParse("Asia/Tokyo").success).toBe(true);
		expect(Tz.safeParse("Asia/Tokio").success).toBe(false);
		expect(Tz.safeParse("").success).toBe(false);
	});

	it("HHmm is 00:00–23:59", () => {
		for (const ok of ["00:00", "09:30", "23:59"]) {
			expect(HHmm.safeParse(ok).success).toBe(true);
		}
		for (const bad of ["24:00", "9:30", "12:60", "12:3"]) {
			expect(HHmm.safeParse(bad).success).toBe(false);
		}
	});

	it("HttpUrl allows only http(s)", () => {
		expect(HttpUrl.safeParse("https://example.com/a").success).toBe(true);
		expect(HttpUrl.safeParse("javascript:alert(1)").success).toBe(false);
		expect(HttpUrl.safeParse("data:text/html,x").success).toBe(false);
	});
});

describe("targets", () => {
	it("round-trips every bundle target through the row columns", () => {
		const targets: BundleTarget[] = [
			{ kind: "trip" },
			{ kind: "node", nodeId: ID },
			{ kind: "leg", legId: ID },
			{ kind: "item", itemId: ID },
			{ kind: "day", dayId: ID },
		];
		for (const target of targets) {
			const cols = bundleTargetColumns(BundleTarget.parse(target));
			expect(Object.values(cols).filter(Boolean).length).toBeLessThanOrEqual(1);
			expect(bundleTargetOf(cols)).toEqual(target);
		}
	});
});

describe("legs", () => {
	it("reads the column default {} as kind none", () => {
		expect(readLegDetails({})).toEqual({ kind: "none" });
	});

	it("parses a flight with defaults applied", () => {
		const airport = {
			iata: "KIX",
			name: "Kansai",
			tz: "Asia/Tokyo",
			lat: 34.43,
			lng: 135.23,
		};
		const parsed = LegDetails.parse({
			kind: "flight",
			flight: {
				from: airport,
				to: { ...airport, iata: "ICN", tz: "Asia/Seoul" },
				depLocal: "2027-10-20T10:05",
				arrLocal: "2027-10-20T12:10",
			},
		});
		expect(parsed.kind).toBe("flight");
		if (parsed.kind === "flight") {
			expect(parsed.flight.seats).toEqual([]);
		}
	});

	it("rejects a fixed transit time with a bad zone", () => {
		const result = LegDetails.safeParse({
			kind: "transit",
			fixed: {
				departLocal: "2027-10-08T08:10",
				arriveLocal: "2027-10-08T10:05",
				fromTz: "Asia/Tokyo",
				toTz: "Japan/Fuji",
			},
		});
		expect(result.success).toBe(false);
	});
});

describe("nodes and trips", () => {
	it("keeps unknown provider keys in NodeDetails", () => {
		const parsed = NodeDetails.parse({ iata: "HND", extra: 1 });
		expect(parsed).toMatchObject({ iata: "HND", extra: 1 });
	});

	it("TripSettings accepts an empty object (the DB default)", () => {
		expect(TripSettings.safeParse({}).success).toBe(true);
	});

	it("TripSettingsPatch fills in no defaults (only the keys sent are written)", () => {
		expect(TripSettingsPatch.parse({ holidays: [] })).toEqual({ holidays: [] });
		expect(TripSettingsPatch.safeParse({ currency: "usd" }).success).toBe(
			false,
		);
	});

	it("NodeDetailsPatch accepts null to clear a known key", () => {
		expect(NodeDetailsPatch.parse({ plannedDays: null })).toEqual({
			plannedDays: null,
		});
		expect(NodeDetailsPatch.safeParse({ plannedDays: -1 }).success).toBe(false);
	});
});

describe("enums", () => {
	it("match spikes/research/CATEGORIES.md (D22)", () => {
		expect(PLACE_CATEGORY_VALUES).toHaveLength(22);
		expect(PLACE_CATEGORY_VALUES).toContain("temple_shrine");
		expect(PRIORITY_VALUES).toEqual([
			"must",
			"really_want",
			"want",
			"sure_why_not",
			"meh",
			"nah",
		]);
	});
});

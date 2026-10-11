/**
 * Where a day is (`dayWhere`): the night decides; a travel day reads "Tokyo →
 * Kyoto", the last day "Kyoto · fly home"; a day with no night yet goes by
 * its stops, else where the day before ended.
 */
import { describe, expect, it } from "vitest";
import { N, scenario } from "@/lib/fixtures/demo";
import { dayWhere, dayWhereText, nightsByPlace, offDayText } from "./day-place";
import { indexGraph } from "./graph-index";

const texts = (days: Parameters<typeof scenario>[0]["days"]) => {
	const ix = indexGraph(scenario({ days }).graph);
	return ix.days.map((d) => dayWhereText(ix, dayWhere(ix, d.id)));
};

describe("dayWhere", () => {
	it("the night decides; the move day reads from → to; the last day flies home", () => {
		expect(
			texts([
				{ night: "tokyo", items: [{ k: "sky", node: "shibuyaSky" }] },
				// A day in Kyoto, but the night is still Tokyo's: a Tokyo day.
				{ night: "tokyo", items: [{ k: "kiyo", node: "kiyomizu" }] },
				{ night: "ryokan", items: [] },
				{ night: "kyoto", items: [] },
				{ items: [{ k: "out", node: "kix" }] },
			]),
		).toEqual([
			"Tokyo",
			"Tokyo",
			"Tokyo → Mt. Fuji",
			"Mt. Fuji → Kyoto",
			"Kyoto · fly home",
		]);
	});

	it("a night not placed yet has no city, never the one before it", () => {
		expect(
			texts([{ night: "kyoto", items: [] }, { items: [] }, { items: [] }]),
		).toEqual(["Kyoto", null, null]);
	});

	it("a last day with no flight is going home", () => {
		expect(texts([{ night: "kyoto", items: [] }, { items: [] }])).toEqual([
			"Kyoto",
			"Kyoto · going home",
		]);
	});

	it("no night yet: where its stops go, else where the day before ended; nothing: unknown", () => {
		expect(
			texts([
				{ items: [{ k: "sky", node: "shibuyaSky" }] },
				{ items: [] },
				{ items: [{ k: "kiyo", node: "kiyomizu" }] },
				{ items: [] },
			]),
		).toEqual(["Tokyo", "Tokyo", "Kyoto", "Kyoto"]);
		expect(texts([{ items: [] }, { items: [] }])).toEqual([null, null]);
	});
});

describe("nightsByPlace", () => {
	it("counts each place's nights in route order, within a scope when given", () => {
		const ix = indexGraph(
			scenario({
				days: [
					{ night: "tokyo", items: [] },
					{ night: "tokyo", items: [] },
					{ night: "kyoto", items: [] },
					{ items: [] },
				],
			}).graph,
		);
		const named = (scope: string | null) =>
			nightsByPlace(ix, scope).map(
				(r) => `${ix.node(r.placeId)?.name} ${r.nights}`,
			);
		expect(named(null)).toEqual(["Tokyo 2", "Kyoto 1"]);
		expect(named(N.kyoto ?? null)).toEqual(["Kyoto 1"]);
	});
});

describe("offDayText", () => {
	const ix = indexGraph(
		scenario({
			days: [
				{ night: "tokyo", items: [] },
				{ night: "kyoto", items: [] },
				{ items: [] },
				{ items: [] },
			],
		}).graph,
	);
	const [d1, d2, d3] = ix.days.map((d) => d.id) as [string, string, string];
	it("names a place on a day spent in another city", () => {
		expect(offDayText(ix, d1, N.kiyomizu)).toBe(
			"Kiyomizu-dera is in Kyoto — this day is in Tokyo",
		);
		expect(offDayText(ix, d1, N.kyoto)).toBe("Kyoto — this day is in Tokyo");
	});
	it("is quiet in the day's city, on a travel day's morning, for airports and the country", () => {
		expect(offDayText(ix, d1, N.sensoji)).toBeNull();
		expect(offDayText(ix, d2, N.sensoji)).toBeNull();
		expect(offDayText(ix, d1, N.kix)).toBeNull();
		expect(offDayText(ix, d1, N.japan)).toBeNull();
	});
	it("a day without a night says nothing, except the last day (where the last night was)", () => {
		expect(offDayText(ix, d3, N.sensoji)).toBeNull();
		const two = indexGraph(
			scenario({ days: [{ night: "tokyo", items: [] }, { items: [] }] }).graph,
		);
		expect(offDayText(two, two.days[1]?.id, N.kiyomizu)).toBe(
			"Kiyomizu-dera is in Kyoto — this day is in Tokyo",
		);
	});
});

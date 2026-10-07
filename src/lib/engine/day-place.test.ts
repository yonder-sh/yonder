/**
 * Where a day is (`dayWhere`): the night decides; a travel day reads "Tokyo →
 * Kyoto", the last day "Kyoto · fly home"; a day with no night yet goes by
 * its stops, else where the day before ended.
 */
import { describe, expect, it } from "vitest";
import { N, scenario } from "@/lib/fixtures/demo";
import { dayWhere, dayWhereText, nightsByPlace } from "./day-place";
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

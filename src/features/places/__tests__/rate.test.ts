import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N } from "@/lib/fixtures/demo";
import { RatingComment } from "@/lib/schemas/nodes";
import { EMPTY_FILTER, parseFilter } from "@/lib/workspace/filter";
import {
	backTarget,
	commentLength,
	commentVisibleText,
	compareRank,
	filterContextOf,
	isRateable,
	matchesFilter,
	nextCard,
	ownFilter,
	priorityForKey,
	progressOf,
	rankKey,
	rateableNodes,
	raters,
	tierOf,
} from "../lib/rate";

const D = DEMO_MEMBERS.dennis;
const A = DEMO_MEMBERS.audrey;

function withRatings(
	g: TripGraph,
	r: Record<string, Record<string, GraphNode["priorities"][string]>>,
): TripGraph {
	return {
		...g,
		nodes: g.nodes.map((n) =>
			r[n.id] ? { ...n, priorities: r[n.id] ?? {} } : n,
		),
	};
}

const node = (p: GraphNode["priorities"], name = "x") =>
	({ name, priorities: p }) as Pick<GraphNode, "name" | "priorities">;

describe("ranking (the owner's rule: max, then sum)", () => {
	it("ranks by the highest rating, then the sum, then the name", () => {
		const a = node({ [D]: "must" }, "a");
		const b = node({ [D]: "really_want", [A]: "really_want" }, "b");
		const c = node({ [D]: "must", [A]: "meh" }, "c");
		const unrated = node({}, "u");
		const nah = node({ [D]: "nah" }, "n");
		const sorted = [unrated, a, b, nah, c].sort((x, y) => compareRank(x, y));
		expect(sorted.map((x) => x.name)).toEqual(["c", "a", "b", "n", "u"]);
		expect(rankKey(c)).toEqual([5, 6]);
		expect(rankKey(unrated)).toEqual([-1, -1]);
		expect(tierOf(b)).toBe("really_want");
		expect(tierOf(unrated)).toBeNull();
		expect(tierOf(nah)).toBe("nah");
	});
	it("can rank by a subset of members", () => {
		const a = node({ [D]: "meh", [A]: "must" }, "a");
		const b = node({ [D]: "want" }, "b");
		expect(
			[a, b].sort((x, y) => compareRank(x, y, [D])).map((x) => x.name),
		).toEqual(["b", "a"]);
	});
});

describe("rateable nodes", () => {
	const ix = indexGraph(demoGraph);
	it("rates places, never airports, stations or stays", () => {
		const names = rateableNodes(ix, null).map((n) => n.name);
		expect(names).toContain("Senso-ji");
		expect(names).not.toContain("Kansai Airport (KIX)");
		expect(names).not.toContain("Kawaguchiko Ryokan");
		expect(names).not.toContain("Tokyo");
		expect(isRateable(ix.node(N.kix) as GraphNode)).toBe(false);
	});
	it("PLAN-I2-07: rates neighbourhoods, not the wards that only hold places", () => {
		const shibuya = ix.node(N.shibuya) as GraphNode;
		// A bare area (the importer's or the filing's structure) is no card.
		expect(isRateable(shibuya)).toBe(false);
		expect(rateableNodes(ix, null).map((n) => n.name)).not.toContain("Shibuya");
		// The sheet's Neighborhood rows, or an area someone described, timed,
		// rated or commented on, are.
		expect(
			isRateable({ ...shibuya, details: { sheetCategory: "Neighborhood" } }),
		).toBe(true);
		expect(isRateable({ ...shibuya, description: "Scramble, neon" })).toBe(
			true,
		);
		expect(isRateable({ ...shibuya, description: "  " })).toBe(false);
		expect(isRateable({ ...shibuya, timeNeededMin: 240 })).toBe(true);
		expect(isRateable({ ...shibuya, priorities: { [A]: "want" } })).toBe(true);
		const g: TripGraph = {
			...demoGraph,
			nodes: demoGraph.nodes.map((n) =>
				n.id === N.shibuya ? { ...n, description: "Scramble, neon" } : n,
			),
		};
		expect(rateableNodes(indexGraph(g), null).map((n) => n.name)).toContain(
			"Shibuya",
		);
	});
	it("PLAN-I2-06: leaves out proposal ghosts when given the live ids", () => {
		const ghost: GraphNode = {
			...(ix.node(N.kiyomizu) as GraphNode),
			id: "00000000-0000-7000-8000-00000000abcd",
			name: "Tōfuku-ji",
			slug: "tofuku-ji",
		};
		const withGhost = indexGraph({
			...demoGraph,
			nodes: [...demoGraph.nodes, ghost],
		});
		const live = new Set(demoGraph.nodes.map((n) => n.id));
		expect(
			rateableNodes(withGhost, N.kyoto ?? null).map((n) => n.name),
		).toContain("Tōfuku-ji");
		expect(
			rateableNodes(withGhost, N.kyoto ?? null, { liveIds: live }).map(
				(n) => n.name,
			),
		).toEqual(["Kiyomizu-dera"]);
	});
	it("narrows to a scope", () => {
		const names = rateableNodes(ix, N.kyoto ?? null).map((n) => n.name);
		expect(names).toEqual(["Kiyomizu-dera"]);
	});
	it("leaves dropped nodes out unless asked", () => {
		const g: TripGraph = {
			...demoGraph,
			nodes: demoGraph.nodes.map((n) =>
				n.id === N.kiyomizu ? { ...n, status: "dropped" } : n,
			),
		};
		const ix2 = indexGraph(g);
		expect(rateableNodes(ix2, N.kyoto ?? null)).toEqual([]);
		expect(
			rateableNodes(ix2, N.kyoto ?? null, { includeDropped: true }),
		).toHaveLength(1);
	});
});

describe("the shared filter on the rate screen", () => {
	const g = withRatings(demoGraph, {
		[N.sensoji as string]: { [D]: "must", [A]: "want" },
		[N.itoya as string]: { [A]: "meh" },
		[N.kiyomizu as string]: { [D]: "sure_why_not" },
	});
	const ix = indexGraph(g);
	const ctx = filterContextOf(ix, D);
	const pick = (raw: string) =>
		rateableNodes(ix, null)
			.filter((n) => matchesFilter(n, parseFilter(raw), ctx))
			.map((n) => n.name);

	it("empty filter keeps everything", () => {
		expect(
			rateableNodes(ix, null).every((n) => matchesFilter(n, EMPTY_FILTER, ctx)),
		).toBe(true);
	});
	it("category groups", () => {
		expect(pick("g:temple_shrine")).toEqual([
			"Meiji Jingu",
			"Senso-ji",
			"Kiyomizu-dera",
		]);
	});
	it("minimum priority by max of all, or by one member", () => {
		expect(pick("p:want")).toEqual(["Senso-ji"]);
		expect(pick(`p:want;by:${A}`)).toEqual(["Senso-ji"]);
		expect(pick(`p:meh;by:${A}`)).toEqual(["Senso-ji", "Itoya Ginza"]);
		expect(pick("p:sure_why_not")).toEqual(["Senso-ji", "Kiyomizu-dera"]);
	});
	it("unrated by me / by a member", () => {
		expect(pick("u:me")).not.toContain("Senso-ji");
		expect(pick("u:me")).toContain("Itoya Ginza");
		expect(pick(`u:${A}`)).toContain("Kiyomizu-dera");
		expect(pick(`u:${A}`)).not.toContain("Itoya Ginza");
	});
	it("guests: `u:me` filters nothing", () => {
		const all = rateableNodes(ix, null);
		expect(
			all.filter((n) =>
				matchesFilter(n, parseFilter("u:me"), { ...ctx, meMemberId: null }),
			),
		).toHaveLength(all.length);
	});
	it("not scheduled", () => {
		const names = pick("ns");
		expect(names).not.toContain("Senso-ji");
		expect(names).not.toContain("Itoya Ginza");
	});
});

describe("progress and card order", () => {
	const g = withRatings(demoGraph, {
		[N.sensoji as string]: { [D]: "must" },
		[N.itoya as string]: { [A]: "meh", [D]: "want" },
	});
	const ix = indexGraph(g);
	const list = rateableNodes(ix, null);
	it("counts each member's ratings over the same set", () => {
		expect(progressOf(list, [{ id: D }, { id: A }])).toEqual([
			{ memberId: D, rated: 2, total: list.length },
			{ memberId: A, rated: 1, total: list.length },
		]);
		expect(raters(g.members, list).map((m) => m.id)).toEqual([D, A]);
	});
	it("moves on to the next place I haven't rated, wrapping around", () => {
		const iSenso = list.findIndex((n) => n.id === N.sensoji);
		const next = nextCard(list, N.sensoji ?? null, D);
		const expected = [...list.slice(iSenso + 1), ...list.slice(0, iSenso)].find(
			(n) => n.priorities[D] === undefined,
		);
		expect(next).toBe(expected?.id);
		expect(nextCard([], null, D)).toBeNull();
	});
	it("with everything rated, simply the next card (or null at the end)", () => {
		const allRated = list.map((n) => ({
			...n,
			priorities: { [D]: "want" as const },
		}));
		expect(nextCard(allRated, allRated[0]?.id ?? null, D)).toBe(
			allRated[1]?.id,
		);
		expect(nextCard(allRated, allRated.at(-1)?.id ?? null, D)).toBeNull();
	});
	it("maps keys 1–6 to Must…Nah", () => {
		expect(priorityForKey("1")).toBe("must");
		expect(priorityForKey("6")).toBe("nah");
		expect(priorityForKey("7")).toBeNull();
		expect(priorityForKey("a")).toBeNull();
	});
});

describe("← on the rate screen (PLAN-R2-06)", () => {
	const all = new Set(["c1", "c2", "c12", "c13"]);
	it("goes back to the card you came from, like history", () => {
		// → from card 1 to 2, rate 2 (jumps to 13): ← is card 2, then card 1.
		expect(backTarget(["c1", "c2"], "c13", all)).toEqual({ id: "c2", at: 1 });
		expect(backTarget(["c1"], "c2", all)).toEqual({ id: "c1", at: 0 });
	});
	it("skips the card in view and cards no longer here", () => {
		expect(backTarget(["c1", "gone", "c13"], "c13", all)).toEqual({
			id: "c1",
			at: 0,
		});
	});
	it("an empty trail leaves ← to the previous card in the deck", () => {
		expect(backTarget([], "c2", all)).toBeNull();
		expect(backTarget(["c2"], "c2", all)).toBeNull();
	});
});

describe("rating comment length (PLAN-R2-07)", () => {
	const uuid = "00000000-0000-7000-8000-000000000052";
	it("counts a mention as the @Name you see", () => {
		const md = `ask [@Audrey Tester](mention:${uuid})`;
		expect(commentVisibleText(md)).toBe("ask @Audrey Tester");
		expect(commentLength(md)).toEqual({ shown: 18, over: null });
		expect(commentLength(`ask [@Kenji](mention:${uuid})`).shown).toBe(10);
		expect(commentVisibleText(`[@A \\[b\\]](mention:${uuid})`)).toBe("@A [b]");
		// Not a token (no uuid): counted as typed.
		expect(commentLength("[@x](mention:1)").shown).toBe(15);
	});
	it("only the 280 you see limit it, however many mentions (PLAN-R3-03)", () => {
		expect(commentLength("x".repeat(280)).over).toBeNull();
		expect(commentLength("x".repeat(281)).over).toEqual({ by: 1 });
		// 245 shown, 293 stored: fine (it used to need "cut 13 characters").
		const heavy = `${"x".repeat(230)} [@Audrey Tester](mention:${uuid})`;
		expect(heavy.length).toBeGreaterThan(280);
		expect(commentLength(heavy)).toEqual({ shown: 245, over: null });
		// 280 shown with ten mentions (760 stored) is fine; 281 is not.
		const ten = Array.from(
			{ length: 10 },
			() => `[@Audrey Tester](mention:${uuid}) `,
		).join("");
		const full = `${ten}${"y".repeat(280 - 150)}`;
		expect(commentLength(full)).toEqual({ shown: 280, over: null });
		expect(commentLength(`${full}y`).over).toEqual({ by: 1 });
		// Surrounding spaces are trimmed away on save, so they don't count.
		expect(commentLength(`  ${"x".repeat(280)}  `).over).toBeNull();
	});
	it("the server's rule is the same one (RatingComment)", () => {
		const ten = Array.from(
			{ length: 10 },
			() => `[@Audrey Tester](mention:${uuid}) `,
		).join("");
		const full = `${ten}${"y".repeat(280 - 150)}`;
		expect(RatingComment.safeParse(full).success).toBe(true);
		expect(RatingComment.safeParse(`${full}y`).success).toBe(false);
		expect(RatingComment.safeParse("x".repeat(281)).success).toBe(false);
		expect(RatingComment.safeParse(`  ${"x".repeat(280)}  `).data).toBe(
			"x".repeat(280),
		);
	});
});

describe("a filter from a link (FB-05)", () => {
	it("'unrated by <my member id>' is 'unrated by me'; others are kept", () => {
		const me = DEMO_MEMBERS.dennis;
		expect(ownFilter(parseFilter(`u:${me}`), me)).toEqual({
			...EMPTY_FILTER,
			unratedBy: "me",
		});
		const audrey = parseFilter(`u:${DEMO_MEMBERS.audrey};p:want`);
		expect(ownFilter(audrey, me)).toBe(audrey);
		// Signed out (a link guest): nothing to map it to.
		const f = parseFilter(`u:${me}`);
		expect(ownFilter(f, null)).toBe(f);
	});
});

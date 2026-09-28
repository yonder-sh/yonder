/**
 * D10 "Add · paste a link": where a pasted link can go, in order (the places
 * its caption names, the open place, a few nearby), the search over every
 * place, and the words each row and New place show.
 */
import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { formatDayDate } from "@/lib/format";
import {
	fallbackName,
	filedUnder,
	linkKind,
	linkParent,
	linkTargets,
	targetMeta,
} from "../lib/link-targets";

const ix = indexGraph(demoGraph);
const day1 = demoGraph.days[0]?.id as string;
type Opts = Parameters<typeof linkTargets>[1];
const none: Opts = {
	text: null,
	openId: null,
	dayId: null,
	scopeId: null,
	query: "",
};
const order = (opts: Partial<Opts>) =>
	linkTargets(ix, { ...none, ...opts }).map((t) => [
		ix.node(t.node.id)?.name,
		t.why,
	]);

describe("where a pasted link can go", () => {
	it("the places its caption names, then the open place, then nearby", () => {
		expect(
			order({
				text: "Matcha by Meiji Jingu, then sunset at Shibuya Sky",
				openId: N.loft,
			}),
		).toEqual([
			["Meiji Jingu", "named"],
			["Shibuya Sky", "named"],
			["Shibuya Loft", "open"],
			["Hands Shibuya", "nearby"],
		]);
	});

	it("lists a place once: the open place named in the caption stays named", () => {
		expect(
			order({ text: "Stationery haul at Shibuya Loft", openId: N.loft }),
		).toEqual([
			["Shibuya Loft", "named"],
			["Hands Shibuya", "nearby"],
			["Shibuya Sky", "nearby"],
			["Meiji Jingu", "nearby"],
		]);
	});

	it("without an open place, nearby is the day in view's stops", () => {
		expect(order({ dayId: day1 })).toEqual([
			["Hands Shibuya", "nearby"],
			["Shibuya Loft", "nearby"],
			["Shibuya Sky", "nearby"],
			["Meiji Jingu", "nearby"],
		]);
	});

	it("keeps nearby near (2 km), and small scopes count as in view", () => {
		expect(order({ openId: N.kiyomizu })).toEqual([["Kiyomizu-dera", "open"]]);
		expect(order({ scopeId: N.asakusa })).toEqual([
			["Senso-ji", "nearby"],
			["Kama-asa (knives)", "nearby"],
		]);
		// A city is too big to be "near".
		expect(order({ scopeId: N.tokyo })).toEqual([]);
	});

	it("leaves Not going places out of nearby", () => {
		const g = {
			...demoGraph,
			nodes: demoGraph.nodes.map((n) =>
				n.id === N.hands ? { ...n, ideaStatus: "dropped" as const } : n,
			),
		};
		const t = linkTargets(indexGraph(g), {
			...none,
			openId: N.loft as string,
		});
		expect(t.map((x) => x.node.id)).not.toContain(N.hands);
	});

	it("a search looks at every place and area, and nothing else", () => {
		expect(
			order({ query: "senso", text: "Shibuya Sky", openId: N.loft }),
		).toEqual([["Senso-ji", "match"]]);
		expect(order({ query: "harajuku" })).toEqual([["Harajuku", "match"]]);
	});
});

describe("the words on a row and on New place", () => {
	it("says where a place is and its first day", () => {
		const d1 = formatDayDate(demoGraph.days[0]?.date as string);
		const d2 = formatDayDate(demoGraph.days[1]?.date as string);
		expect(targetMeta(ix, N.loft as string)).toBe(`Tokyo › Shibuya · on ${d1}`);
		expect(targetMeta(ix, N.itoya as string)).toBe(`Tokyo · on ${d2}`);
		expect(targetMeta(ix, N.tpe as string)).toBe("Taipei");
	});

	it("files a new place under the scope, or a place's own parent", () => {
		expect(linkParent(ix, N.loft as string)).toBe(N.shibuya);
		expect(linkParent(ix, N.shibuya as string)).toBe(N.shibuya);
		expect(linkParent(ix, null)).toBeNull();
		expect(filedUnder(ix, N.shibuya as string)).toBe("Tokyo › Shibuya");
		expect(filedUnder(ix, null)).toBe(demoGraph.trip.name);
	});

	it("files it beside the open place (its area or city) before the scope", () => {
		expect(linkParent(ix, N.asakusa as string, N.loft as string)).toBe(
			N.shibuya,
		);
		expect(linkParent(ix, N.asakusa as string, N.itoya as string)).toBe(
			N.tokyo,
		);
		expect(linkParent(ix, N.tokyo as string, N.harajuku as string)).toBe(
			N.harajuku,
		);
		// Nothing open, or a city: the scope.
		expect(linkParent(ix, N.asakusa as string, null)).toBe(N.asakusa);
		expect(linkParent(ix, N.asakusa as string, N.kyoto as string)).toBe(
			N.asakusa,
		);
	});

	it("names the kind of link, and a new place when it has no title", () => {
		const tiktok = "https://www.tiktok.com/@cafes/video/7430912345678901234";
		expect(linkKind(tiktok)).toEqual({ label: "TikTok video", social: true });
		expect(linkKind("https://www.instagram.com/reel/C9abc123/").label).toBe(
			"Instagram reel",
		);
		expect(linkKind("https://www.instagram.com/p/C9abc123/").label).toBe(
			"Instagram post",
		);
		expect(linkKind("https://youtu.be/dQw4w9WgXcQ").label).toBe(
			"YouTube video",
		);
		expect(linkKind("https://www.japan-guide.com/e/e3007.html")).toEqual({
			label: "Web page",
			social: false,
		});
		expect(fallbackName(tiktok)).toBe("TikTok video");
		expect(fallbackName("https://www.japan-guide.com/e/e3007.html")).toBe(
			"japan-guide.com",
		);
	});
});

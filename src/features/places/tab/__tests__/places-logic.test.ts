/**
 * The Places tab's pure logic (docs/PLACES.md §1–§3): the group score and
 * Split, the shortlist rule, grouping with fallbacks and split by area, the
 * feed's order (stable shuffle, city runs) and its session.
 */
import { describe, expect, it } from "vitest";
import { lifecycleSet } from "@/lib/domain/places-lifecycle";
import { indexGraph } from "@/lib/engine/graph-index";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N } from "@/lib/fixtures/demo";
import { EMPTY_FILTER } from "@/lib/workspace/filter";
import { filterContextOf } from "@/lib/workspace/filter-match";
import { placesFromRate } from "../entry";
import {
	type FeedPlace,
	feedItems,
	feedOrder,
	hashSeed,
	isMatch,
	joinPile,
	leftCount,
	matchesOf,
	reachEnd,
	recordRating,
	startSession,
} from "../feed";
import { groupPlaces, levelGroupOf, SPLIT_AT, splitByArea } from "../grouping";
import { placeStatus, toggleShortlist } from "../lifecycle";
import {
	buildRows,
	countRows,
	filterRows,
	formatDayNumbers,
	placesInScope,
} from "../model";
import {
	allNah,
	compareByScore,
	formatScore,
	groupScore,
	isSplit,
	scoreTier,
	topRating,
} from "../score";

const D = DEMO_MEMBERS.dennis;
const A = DEMO_MEMBERS.audrey;
const Y = "00000000-0000-7000-8000-0000000000aa";

describe("group score (owner, 2026-09-24)", () => {
	it("sums Must +3 … Nah −2, unrated counting as 0", () => {
		expect(groupScore({ [D]: "must", [A]: "must" })).toBe(6);
		expect(groupScore({ [D]: "must" })).toBe(3);
		expect(groupScore({ [D]: "must", [A]: "nah" })).toBe(1);
		expect(groupScore({ [D]: "really_want", [A]: "want" })).toBe(3);
		expect(groupScore({ [D]: "sure_why_not", [A]: "meh" })).toBe(-1);
		expect(groupScore({})).toBe(0);
	});
	it("counts only the members who rate (a former member's rating drops out)", () => {
		expect(groupScore({ [D]: "must", [Y]: "must" }, [D, A])).toBe(3);
	});
	it("the top single rating, or null when nobody rated", () => {
		expect(topRating({ [D]: "want", [A]: "nah" })).toBe(1);
		expect(topRating({})).toBeNull();
	});
	it("Split: someone keen AND someone against", () => {
		expect(isSplit({ [D]: "must", [A]: "nah" })).toBe(true);
		expect(isSplit({ [D]: "really_want", [A]: "meh" })).toBe(true);
		expect(isSplit({ [D]: "want", [A]: "nah" })).toBe(false);
		expect(isSplit({ [D]: "must", [A]: "sure_why_not" })).toBe(false);
		expect(isSplit({ [D]: "must" })).toBe(false);
	});
	it("everyone Nah is an automatic drop (not when someone hasn't rated)", () => {
		expect(allNah({ [D]: "nah", [A]: "nah" }, [D, A])).toBe(true);
		expect(allNah({ [D]: "nah" }, [D, A])).toBe(false);
		expect(allNah({}, [])).toBe(false);
	});
	it("chip bands: ≥+5 must, +3..+4 really want, +1..+2 want, 0 sure, −1 meh, ≤−2 nah", () => {
		expect([7, 5, 4, 3, 2, 1, 0, -1, -2, -6].map(scoreTier)).toEqual([
			"must",
			"must",
			"really_want",
			"really_want",
			"want",
			"want",
			"sure_why_not",
			"meh",
			"nah",
			"nah",
		]);
		expect([6, 0, -2].map(formatScore)).toEqual(["+6", "0", "−2"]);
	});
	it("priority order: score, then the highest single rating, then name", () => {
		const rows = [
			{ name: "B", score: 1, top: 3 }, // Must + Nah
			{ name: "A", score: 1, top: 1 }, // one Want
			{ name: "C", score: 3, top: 3 },
			{ name: "E", score: 0, top: null }, // unrated
			{ name: "D", score: 0, top: 0 }, // Sure
			{ name: "Aa", score: 1, top: 1 },
		];
		expect([...rows].sort(compareByScore).map((r) => r.name)).toEqual([
			"C",
			"B",
			"A",
			"Aa",
			"D",
			"E",
		]);
	});
});

describe("lifecycle (docs/PLACES.md §3)", () => {
	const base = {
		dropped: false,
		scheduled: false,
		pin: "auto" as const,
		score: 0,
		threshold: 3,
		allNah: false,
	};
	it("suggests the shortlist at the bar (bar.ts)", () => {
		expect(placeStatus({ ...base, score: 2 }).status).toBe("idea");
		const s = placeStatus({ ...base, score: 3 });
		expect(s).toMatchObject({ status: "shortlist", suggested: true });
		expect(placeStatus({ ...base, score: 4, threshold: 5 }).status).toBe(
			"idea",
		);
	});
	it("a pin stays whatever the ratings; an unpin stays off", () => {
		expect(placeStatus({ ...base, pin: "pinned", score: -3 })).toMatchObject({
			status: "shortlist",
			pinned: true,
		});
		expect(placeStatus({ ...base, pin: "unpinned", score: 6 })).toMatchObject({
			status: "idea",
			unpinned: true,
		});
	});
	it("scheduled is derived; dropped by hand wins; all Nah drops unless pinned", () => {
		expect(placeStatus({ ...base, scheduled: true, score: 6 }).status).toBe(
			"scheduled",
		);
		expect(
			placeStatus({ ...base, scheduled: true, dropped: true }).status,
		).toBe("dropped");
		expect(placeStatus({ ...base, allNah: true })).toMatchObject({
			status: "dropped",
			autoDropped: true,
		});
		expect(placeStatus({ ...base, allNah: true, pin: "pinned" }).status).toBe(
			"shortlist",
		);
	});
	it("S hands the decision back to the ratings when they agree", () => {
		const t = (s: Parameters<typeof toggleShortlist>[0]) =>
			toggleShortlist(s).shortlistPin;
		const off = {
			status: "idea" as const,
			pinned: false,
			suggested: false,
			unpinned: false,
			threshold: 3,
		};
		expect(t({ ...off, score: 0 })).toBe("pinned");
		expect(t({ ...off, unpinned: true, score: 4 })).toBe("auto");
		const on = {
			status: "shortlist" as const,
			pinned: false,
			suggested: true,
			unpinned: false,
			threshold: 3,
		};
		expect(t({ ...on, score: 4 })).toBe("unpinned");
		expect(t({ ...on, pinned: true, suggested: false, score: 0 })).toBe("auto");
		expect(t({ ...on, pinned: true, suggested: false, score: 5 })).toBe(
			"unpinned",
		);
	});
	it("the stored columns stay in step (drop ⇔ status dropped, pin ⇔ shortlist)", () => {
		const active = { status: "active" as const, shortlistPin: "auto" as const };
		expect(lifecycleSet(active, { name: "x" } as never)).toEqual({});
		expect(lifecycleSet(active, { shortlistPin: "pinned" })).toEqual({
			shortlistPin: "pinned",
			ideaStatus: "shortlist",
		});
		expect(lifecycleSet(active, { status: "dropped" })).toEqual({
			status: "dropped",
			ideaStatus: "dropped",
		});
		expect(lifecycleSet(active, { ideaStatus: "dropped" })).toEqual({
			status: "dropped",
			ideaStatus: "dropped",
		});
		const dropped = {
			status: "dropped" as const,
			shortlistPin: "pinned" as const,
		};
		// Pinning a dropped place keeps it dropped; bringing it back restores the pin.
		expect(lifecycleSet(dropped, { shortlistPin: "unpinned" })).toMatchObject({
			status: "dropped",
			ideaStatus: "dropped",
		});
		expect(lifecycleSet(dropped, { status: "active" })).toEqual({
			status: "active",
			ideaStatus: "shortlist",
		});
		expect(lifecycleSet(active, { ideaStatus: "shortlist" })).toEqual({
			shortlistPin: "pinned",
			ideaStatus: "shortlist",
		});
	});
});

/** The demo graph plus a few extra places (and ratings) for grouping. */
function graphWith(
	extra: {
		id: string;
		parent: string;
		name: string;
		type?: GraphNode["type"];
	}[],
	ratings: Record<string, GraphNode["priorities"]> = {},
): TripGraph {
	const nodes = demoGraph.nodes.map((n) =>
		ratings[n.id]
			? { ...n, priorities: ratings[n.id] as GraphNode["priorities"] }
			: n,
	);
	for (const [i, e] of extra.entries()) {
		const base = demoGraph.nodes.find((n) => n.id === N.itoya) as GraphNode;
		nodes.push({
			...base,
			id: e.id,
			parentId: e.parent,
			type: e.type ?? "place",
			category: (e.type ?? "place") === "place" ? "sight" : null,
			name: e.name,
			slug: `x-${i}`,
			position: `z${String(i).padStart(4, "0")}`,
			priorities: ratings[e.id] ?? {},
		});
	}
	return { ...demoGraph, nodes };
}

describe("grouping (nearest ancestor, falling back a level up)", () => {
	const ix = indexGraph(demoGraph);
	it("a place's city, area and country", () => {
		expect(levelGroupOf(ix, N.sensoji as string, "city").node?.name).toBe(
			"Tokyo",
		);
		expect(levelGroupOf(ix, N.knifeShop as string, "area")).toMatchObject({
			fallback: false,
			node: { name: "Kappabashi" },
		});
		expect(levelGroupOf(ix, N.itoya as string, "country").node?.name).toBe(
			"Japan",
		);
	});
	it("no area: the city; no city (Mt. Fuji): the region; nothing: none", () => {
		expect(levelGroupOf(ix, N.itoya as string, "area")).toMatchObject({
			fallback: true,
			node: { name: "Tokyo" },
		});
		expect(levelGroupOf(ix, N.ryokan as string, "city")).toMatchObject({
			fallback: true,
			node: { name: "Mt. Fuji" },
		});
		expect(levelGroupOf(ix, N.japan as string, "city")).toEqual({
			node: null,
			fallback: true,
		});
	});
	it("groups by city in trip order, each sorted by priority", () => {
		const rows = [
			{ id: N.kiyomizu as string, name: "Kiyomizu-dera", score: 0, top: null },
			{ id: N.sensoji as string, name: "Senso-ji", score: 1, top: 1 },
			{ id: N.itoya as string, name: "Itoya Ginza", score: 3, top: 3 },
			{
				id: N.ryokan as string,
				name: "Kawaguchiko Ryokan",
				score: 0,
				top: null,
			},
		].map((r) => ({
			...r,
			status: "idea" as const,
			must: r.top === 3,
			tripOrder: null,
		}));
		const visit = (id: string) =>
			id === N.kyoto ? 1 : id === N.tokyo ? 5 : null;
		const groups = groupPlaces(rows, {
			by: "city",
			sort: "priority",
			ix,
			groupVisit: visit,
		});
		expect(groups.map((g) => [g.label, g.note])).toEqual([
			["Kyoto", null],
			["Tokyo", null],
			["Mt. Fuji", "region-wide"],
		]);
		expect(groups[1]?.rows.map((r) => r.name)).toEqual([
			"Itoya Ginza",
			"Senso-ji",
		]);
		expect(groups[1]?.summary).toEqual({ count: 2, musts: 1, scheduled: 0 });
	});
	it("by status in lifecycle order; by none, one group", () => {
		const rows = (["idea", "scheduled", "shortlist", "idea"] as const).map(
			(status, i) => ({
				id: `p${i}`,
				name: `P${i}`,
				score: i,
				top: null,
				status,
				must: false,
				tripOrder: null,
			}),
		);
		expect(
			groupPlaces(rows, { by: "status", sort: "name", ix }).map((g) => g.label),
		).toEqual(["Shortlist", "Ideas", "Scheduled"]);
		expect(groupPlaces(rows, { by: "none", sort: "name", ix })).toHaveLength(1);
	});
	it(`a city of ${SPLIT_AT}+ places offers "Split by area"; split, it groups by area`, () => {
		const extra = Array.from({ length: SPLIT_AT }, (_, i) => ({
			id: `00000000-0000-7000-8000-00000000f${String(i).padStart(3, "0")}`,
			parent: (i % 3 === 0
				? N.tokyo
				: i % 3 === 1
					? N.shibuya
					: N.kappabashi) as string,
			name: `Spot ${i}`,
		}));
		const g = indexGraph(graphWith(extra));
		const rows = extra.map((e) => ({
			id: e.id,
			name: e.name,
			score: 0,
			top: null,
			status: "idea" as const,
			must: false,
			tripOrder: null,
		}));
		const [tokyo] = groupPlaces(rows, { by: "city", sort: "name", ix: g });
		expect(tokyo).toMatchObject({
			label: "Tokyo",
			canSplit: true,
			split: false,
			subgroups: null,
		});
		const [split] = groupPlaces(rows, {
			by: "city",
			sort: "name",
			ix: g,
			split: new Set([N.tokyo as string]),
		});
		// Kappabashi rolls up into Asakusa (the outermost area in the city).
		expect(split?.subgroups?.map((s) => [s.label, s.rows.length])).toEqual([
			["Asakusa", 5],
			["City-wide", 5],
			["Shibuya", 5],
		]);
		expect(
			groupPlaces(rows.slice(0, SPLIT_AT - 1), {
				by: "city",
				sort: "name",
				ix: g,
			})[0]?.canSplit,
		).toBe(false);
		expect(splitByArea(g, N.tokyo as string, [])).toEqual([]);
	});
});

describe("rows (status, when, time needed, filters)", () => {
	it("scores, statuses and counts from the graph; filters shared by every view", () => {
		const fushimi = "00000000-0000-7000-8000-00000000e001";
		const nijo = "00000000-0000-7000-8000-00000000e002";
		const nishiki = "00000000-0000-7000-8000-00000000e003";
		const g = graphWith(
			[
				{ id: fushimi, parent: N.kyoto as string, name: "Fushimi Inari" },
				{ id: nijo, parent: N.kyoto as string, name: "Nijo Castle" },
				{ id: nishiki, parent: N.kyoto as string, name: "Nishiki Market" },
			],
			{
				[fushimi]: { [D]: "must", [A]: "must" },
				[nijo]: { [D]: "must", [A]: "nah" },
				[nishiki]: { [D]: "nah", [A]: "nah" },
			},
		);
		const ix = indexGraph(g);
		const nodes = placesInScope(ix, null);
		const rows = buildRows(ix, nodes, { memberIds: [D, A], threshold: 3 });
		const by = (id: string) => rows.find((r) => r.id === id);
		expect(by(fushimi)).toMatchObject({
			score: 6,
			split: false,
			status: "shortlist",
			where: "Kyoto",
		});
		expect(by(fushimi)?.info.suggested).toBe(true);
		expect(by(nijo)).toMatchObject({ score: 1, split: true, status: "idea" });
		expect(by(nishiki)?.info).toMatchObject({
			status: "dropped",
			autoDropped: true,
		});
		// On a day: scheduled, with its day and its planned stop's duration.
		const senso = by(N.sensoji as string);
		expect(senso?.status).toBe("scheduled");
		expect(senso?.when).toMatch(/^Day \d+ · /);
		expect(senso?.timeSource).toBe("planned");
		// Airports and stays aren't places to decide on.
		expect(by(N.kix as string)).toBeUndefined();
		expect(by(N.ryokan as string)).toBeUndefined();
		const counts = countRows(rows);
		expect(counts.dropped).toBe(1);
		expect(counts.talk).toBe(1);
		expect(counts.toDecide).toBe(2);
		const ctx = filterContextOf(ix, D);
		const f = { talk: false, filter: EMPTY_FILTER, ctx };
		const all = filterRows(rows, { ...f, status: null });
		expect(all.some((r) => r.id === nishiki)).toBe(false);
		const talk = filterRows(rows, { ...f, status: null, talk: true });
		expect(talk.map((r) => r.id)).toEqual([nijo]);
		const dropped = filterRows(rows, { ...f, status: "dropped" });
		expect(dropped.map((r) => r.id)).toEqual([nishiki]);
		const shortlist = filterRows(rows, { ...f, status: "shortlist" });
		expect(shortlist.map((r) => r.id)).toEqual([fushimi]);
		const q = filterRows(rows, { ...f, status: null, q: "nijo" });
		expect(q.map((r) => r.id)).toEqual([nijo]);
	});
	it("day numbers read as ranges", () => {
		expect(formatDayNumbers([2, 3, 4, 5])).toBe("Days 2–5");
		expect(formatDayNumbers([5])).toBe("Day 5");
		expect(formatDayNumbers([7, 2, 4, 8])).toBe("Days 2, 4, 7–8");
		expect(formatDayNumbers([])).toBe("");
	});
});

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

function places(
	cities: Record<string, number>,
	media: (id: string) => number = () => 0,
): FeedPlace[] {
	const out: FeedPlace[] = [];
	let o = 0;
	for (const [city, n] of Object.entries(cities))
		for (let i = 0; i < n; i++) {
			const id = `${city}-${i}`;
			out.push({ id, city, media: media(id), outline: o++ });
		}
	return out;
}

describe("feed order (shuffled city runs, stable per person)", () => {
	const set = places({ tokyo: 11, kyoto: 8, osaka: 6, nara: 2 });
	it("the same person always gets the same order; another person another one", () => {
		const a = feedOrder(set, { seed: "trip:dennis" }).map((e) => e.id);
		expect(
			feedOrder([...set].reverse(), { seed: "trip:dennis" }).map((e) => e.id),
		).toEqual(a);
		expect(
			feedOrder(set, { seed: "trip:audrey" }).map((e) => e.id),
		).not.toEqual(a);
		expect(new Set(a).size).toBe(set.length);
		expect(hashSeed("x")).toBe(hashSeed("x"));
	});
	it("runs of 3–5 from one city, then another city", () => {
		for (const seed of ["a", "b", "c", "d", "e"]) {
			const entries = feedOrder(set, { seed });
			const runs = new Map<number, { city: string; n: number }>();
			for (const e of entries) {
				const r = runs.get(e.run) ?? { city: e.city, n: 0 };
				expect(r.city).toBe(e.city);
				r.n += 1;
				runs.set(e.run, r);
				expect(e.len).toBeGreaterThanOrEqual(1);
			}
			const list = [...runs.values()];
			for (const [i, r] of list.entries()) {
				if (r.city !== "nara") expect(r.n).toBeGreaterThanOrEqual(3);
				expect(r.n).toBeLessThanOrEqual(5);
				// A different city each time while other cities remain.
				const next = list[i + 1];
				const othersLeft = list.slice(i + 1).some((x) => x.city !== r.city);
				if (next && othersLeft) expect(next.city).not.toBe(r.city);
			}
		}
	});
	it("a place added later doesn't reshuffle the rest of its city", () => {
		const before = feedOrder(places({ tokyo: 3 }), {
			seed: "s",
			order: "random",
		}).map((e) => e.id);
		const after = feedOrder(places({ tokyo: 4 }), {
			seed: "s",
			order: "random",
		})
			.map((e) => e.id)
			.filter((id) => id !== "tokyo-3");
		expect(after).toEqual(before);
	});
	it("By city: each city whole, in outline order; Random: one shuffled pile", () => {
		const byCity = feedOrder(set, { seed: "x", order: "city" });
		expect([...new Set(byCity.map((e) => e.city))]).toEqual([
			"tokyo",
			"kyoto",
			"osaka",
			"nara",
		]);
		const random = feedOrder(set, { seed: "x", order: "random" });
		expect(random.map((e) => e.id).sort()).toEqual(set.map((p) => p.id).sort());
	});
	it("media-rich places come a little earlier on average", () => {
		const withMedia = (id: string) => (id.endsWith("-0") ? 2 : 0);
		const pile = places({ tokyo: 10 }, withMedia);
		let sum = 0;
		const runs = 400;
		for (let i = 0; i < runs; i++)
			sum += feedOrder(pile, { seed: `seed-${i}`, order: "random" }).findIndex(
				(e) => e.id === "tokyo-0",
			);
		// Uniform would average 4.5.
		expect(sum / runs).toBeLessThan(4.1);
	});
});

describe("feed session", () => {
	const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
	it("a milestone every 10 first ratings, after the card that made it", () => {
		let s = startSession(ids);
		for (const id of ids.slice(0, 10)) s = recordRating(s, id, id);
		expect(s.milestones).toEqual([{ n: 1, after: "p9" }]);
		// Changing a rating doesn't count again.
		s = recordRating(s, "p3", "p3");
		expect(s.rated).toHaveLength(10);
		const items = feedItems(s);
		const at = items.findIndex((it) => it.key === "p9");
		expect(items[at + 1]).toMatchObject({ kind: "milestone", n: 1 });
	});
	it("skipped places come back once at the end, then 'all caught up'", () => {
		let s = startSession(["a", "b", "c", "d"]);
		const rated = new Set(["a", "c"]);
		const isRated = (id: string) => rated.has(id);
		expect(leftCount(s, isRated)).toBe(2);
		s = reachEnd(s, isRated);
		expect(s.skipped).toEqual(["b", "d"]);
		expect(reachEnd(s, () => false).skipped).toEqual(["b", "d"]);
		expect(feedItems(s).map((it) => it.key)).toEqual([
			"a",
			"b",
			"c",
			"d",
			"skipped",
			"b#2",
			"d#2",
			"end",
		]);
		// Nothing skipped: straight to the end.
		expect(
			feedItems(reachEnd(startSession(["a"]), () => true)).map((it) => it.kind),
		).toEqual(["place", "end"]);
	});
	it("new places join the end of the pile", () => {
		const s = joinPile(startSession(["a", "b"]), ["b", "c"]);
		expect(s.pile).toEqual(["a", "b", "c"]);
		expect(joinPile(s, ["a"])).toBe(s);
	});
	it("a match: the same rating, or both keen", () => {
		expect(isMatch("must", "really_want")).toBe(true);
		expect(isMatch("want", "want")).toBe(true);
		expect(isMatch("must", "want")).toBe(false);
		expect(
			matchesOf({ [D]: "must", [A]: "must", [Y]: "nah" }, D, [A, Y]),
		).toEqual([A]);
		expect(matchesOf({ [A]: "must" }, D, [A])).toEqual([]);
	});
});

describe("/t/<trip>/rate → the Places tab", () => {
	const node = (id: string, type: string, parentId: string | null) => ({
		id,
		type,
		parentId,
	});
	const tree = new Map([
		["city", node("city", "city", null)],
		["place", node("place", "place", "city")],
	]);
	const parentOf = (id: string) => tree.get(id);
	it("keeps the scope and filter, in the Rate view", () => {
		expect(placesFromRate({ f: "u:me", in: "city" }, parentOf)).toEqual({
			scopeId: "city",
			search: { tab: "places", pv: "rate", f: "u:me" },
		});
	});
	it("table / compare open the table; n and a place's own link open on it", () => {
		expect(placesFromRate({ view: "compare" }, parentOf).search).toEqual({
			tab: "places",
			pv: "table",
		});
		expect(placesFromRate({ in: "place" }, parentOf)).toEqual({
			scopeId: "city",
			search: { tab: "places", pv: "rate", sel: "n.place" },
		});
	});
	it("'Rate ideas →' is the Ideas pill", () => {
		expect(
			placesFromRate({ set: "ideas", f: "ns;u:me" }, parentOf).search,
		).toEqual({
			tab: "places",
			pv: "rate",
			f: "u:me",
			pst: "idea",
		});
	});
});

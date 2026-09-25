import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { N, scenario } from "./__fixtures__/demo";
import { indexGraph } from "./graph-index";
import { type RollupEntryRef, rollup } from "./rollup";

type Entry = RollupEntryRef & { id: string };

const s = scenario({
	days: [
		{
			items: [
				{ k: "hands", node: "hands" },
				{ k: "lunch", title: "Lunch" },
				{ k: "meiji", node: "meijiJingu" },
			],
		},
		{ items: [{ k: "kyoto", node: "kiyomizu" }] },
		{
			items: [
				{ k: "sensoji", node: "sensoji" },
				{ k: "knives", node: "knifeShop" },
			],
		},
	],
	nodes: [
		{
			key: "closed",
			parent: "shibuya",
			type: "place",
			name: "Closed",
			at: [35.66, 139.7],
			status: "dropped",
		},
	],
	legs: [
		{ k: "toKyoto", from: "meiji", to: "kyoto", mode: "transit", min: 150 },
		{
			k: "broken",
			from: "hands",
			to: "sensoji",
			mode: "transit",
			min: 30,
			isEdited: true,
		},
	],
});
const ix = indexGraph(s.graph);
const e = (
	id: string,
	target: Omit<RollupEntryRef, "extraNodeIds">,
	extra?: string[],
): Entry => ({ id, ...target, ...(extra ? { extraNodeIds: extra } : {}) });
const data: Entry[] = [
	e("trip-todo", {}),
	e("tokyo-ic", { nodeId: N.tokyo }),
	e("hands-shop", { nodeId: N.hands }),
	e("shibuya-note", { nodeId: N.shibuya }),
	e("knife", { nodeId: N.knifeShop }),
	e("closed", { nodeId: s.N.closed }),
	e("itoya-idea", { nodeId: N.itoya }),
	e("lunch-photo", { itemId: s.I.lunch }),
	e("meiji-ticket", { itemId: s.I.meiji }),
	e("jr-pass", { legId: s.L.toKyoto }),
	e("broken-note", { legId: s.L.broken }),
	e("day1", { dayId: s.D.d1 }),
	e("day2", { dayId: s.D.d2 }),
	e("kyoto-temple", { nodeId: N.kiyomizu }),
	e("either-shop", { nodeId: N.kiyomizu }, [N.itoya as string]),
];
const ids = (entries: readonly Entry[]) => entries.map((x) => x.id);

describe("rollup (§8.4)", () => {
	it("at the root: the trip group, then visited reps in pin order, then never-visited, days, unlinked", () => {
		const groups = rollup(ix, { scopeId: null, lens: "city" }, data);
		expect(groups.map((g) => [g.kind, g.repId, g.pinNumber])).toEqual([
			["scope", null, null],
			["rep", N.tokyo, 1],
			["rep", N.kyoto, 2],
			["day", null, null],
			["day", null, null],
		]);
		expect(ids(groups[0]?.subgroups.flatMap((x) => x.entries) ?? [])).toEqual([
			"trip-todo",
		]);
		const tokyo = groups[1];
		expect(tokyo?.subgroups.map((x) => x.kind)).toEqual([
			"node",
			"node",
			"node",
			"node",
			"node",
			"visit",
			"visit",
			"transit",
		]);
		expect(ids(tokyo?.subgroups.flatMap((x) => x.entries) ?? [])).not.toContain(
			"closed",
		); // dropped
		expect(
			tokyo?.subgroups.find((x) => x.nodeId === N.knifeShop)?.caption,
		).toEqual([N.tokyo, N.asakusa, N.kappabashi, N.knifeShop]);
		expect(tokyo?.subgroups.find((x) => x.legId === s.L.toKyoto)).toMatchObject(
			{ kind: "transit", fromRepId: N.tokyo, toRepId: N.kyoto },
		);
		// The detached leg's entries sit in its from-item's day, under "Unlinked transit".
		const day1 = groups.find((g) => g.kind === "day" && g.dayId === s.D.d1);
		expect(day1?.subgroups.map((x) => [x.kind, ids(x.entries)])).toEqual([
			["day", ["day1"]],
			["unlinked", ["broken-note"]],
		]);
		const total = groups.reduce((n, g) => n + g.count, 0);
		expect(total).toBe(data.length - 1); // everything but the dropped node
		expect(
			rollup(
				ix,
				{ scopeId: null, lens: "city", showDropped: true },
				data,
			).reduce((n, g) => n + g.count, 0),
		).toBe(data.length);
	});

	it("inside Tokyo: its own group first, then areas; legs touching the scope; days with in-scope items", () => {
		const groups = rollup(
			ix,
			{ scopeId: N.tokyo as string, lens: "area" },
			data,
		);
		expect(groups[0]).toMatchObject({ kind: "scope", repId: N.tokyo });
		expect(ids(groups[0]?.subgroups.flatMap((x) => x.entries) ?? [])).toEqual([
			"tokyo-ic",
		]);
		const reps = groups
			.filter((g) => g.kind === "rep")
			.map((g) => [g.repId, g.pinNumber]);
		expect(reps).toEqual([
			[N.shibuya, 1],
			[N.harajuku, 2],
			[N.asakusa, 3],
			[N.itoya, null], // never visited: after the visited ones
		]);
		const all = groups.flatMap((g) =>
			g.subgroups.flatMap((x) => ids(x.entries)),
		);
		expect(all).toContain("jr-pass"); // one endpoint in Tokyo
		expect(all).toContain("either-shop"); // matched through its extra target Itoya
		expect(all).not.toContain("kyoto-temple");
		expect(all).not.toContain("trip-todo");
		expect(all).not.toContain("day2"); // Day 2 is all Kyoto
		expect(all).toContain("day1");
		const itoya = groups.find((g) => g.repId === N.itoya);
		expect(ids(itoya?.subgroups.flatMap((x) => x.entries) ?? [])).toEqual([
			"itoya-idea",
			"either-shop",
		]);
		const shibuya = groups.find((g) => g.repId === N.shibuya);
		expect(
			shibuya?.subgroups.find((x) => x.itemId === s.I.lunch),
		).toMatchObject({
			kind: "visit",
			dayId: s.D.d1,
			caption: [N.shibuya, N.hands],
		});
	});

	it("only the scope's own target with includeDescendants = false", () => {
		const groups = rollup(
			ix,
			{ scopeId: N.tokyo as string, lens: "area", includeDescendants: false },
			data,
		);
		expect(groups.map((g) => g.kind)).toEqual(["scope"]);
		expect(ids(groups[0]?.subgroups[0]?.entries ?? [])).toEqual(["tokyo-ic"]);
		const root = rollup(
			ix,
			{ scopeId: null, lens: "area", includeDescendants: false },
			data,
		);
		expect(
			ids(root.flatMap((g) => g.subgroups.flatMap((x) => x.entries))),
		).toEqual(["trip-todo"]);
	});

	it("with a day range: that day's items, their nodes, legs and the day", () => {
		const d3 = s.graph.days[2]?.date as string;
		const groups = rollup(
			ix,
			{ scopeId: null, lens: "place", dayRange: { from: d3, to: d3 } },
			data,
		);
		const all = groups.flatMap((g) =>
			g.subgroups.flatMap((x) => ids(x.entries)),
		);
		expect(all.sort()).toEqual(["broken-note", "knife"].sort());
	});
});

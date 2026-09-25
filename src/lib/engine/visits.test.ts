import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { demo, N, scenario } from "./__fixtures__/demo";
import { indexGraph } from "./graph-index";
import { lensOptions, repAt } from "./lens";
import { computeSchedule } from "./schedule";
import type { Lens, WorkspaceModel } from "./types";
import { buildModel } from "./visits";

const reps = (m: WorkspaceModel) => m.visits.map((v) => v.repId);
const nodeName = (id: string) =>
	demo.graph.nodes.find((n) => n.id === id)?.name ?? id;

describe("SPEC §8.6 required engine tests", () => {
	it("1. at area lens, Itoya (filed directly under Tokyo) is its own rep, `finer`", () => {
		const ix = indexGraph(demo.graph);
		expect(repAt(ix, N.itoya as string, "area", null)).toEqual({
			id: N.itoya,
			mode: "finer",
		});
	});

	it("2. Hands, Loft, Harajuku, Shibuya → Shibuya(2), Harajuku, Shibuya; occurrence 2, one curved edge, pins 1 and 2", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "hands", node: "hands" },
						{ k: "loft", node: "loft" },
						{ k: "meiji", node: "meijiJingu" },
						{ k: "sky", node: "shibuyaSky" },
					],
				},
			],
		});
		const m = buildModel(indexGraph(s.graph), null, "area");
		expect(reps(m).map(nodeName)).toEqual(["Shibuya", "Harajuku", "Shibuya"]);
		expect(m.visits[0]?.itemIds).toEqual([s.I.hands, s.I.loft]);
		expect(m.visits.map((v) => [v.pinNumber, v.occurrence])).toEqual([
			[1, 1],
			[2, 1],
			[1, 2],
		]);
		expect(m.transitions).toHaveLength(2);
		expect(m.edges.map((e) => e.key).sort()).toEqual(
			[`${N.harajuku}>${N.shibuya}`, `${N.shibuya}>${N.harajuku}`].sort(),
		);
		expect(m.edges.filter((e) => e.curved)).toHaveLength(1);
		const shibuyaPin = m.pins.find((p) => p.repId === N.shibuya);
		expect(shibuyaPin).toMatchObject({
			number: 1,
			visits: 2,
			hollow: false,
			minutes: 180,
		});
		expect(m.pins.find((p) => p.repId === N.harajuku)?.number).toBe(2);
	});

	it("3. scope Tokyo with a Kyoto day trip in the middle: ghosts, a stretch fold, no transition across the gap", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "hands", node: "hands" },
						{ k: "kiyomizu", node: "kiyomizu", min: 120 },
						{ k: "sensoji", node: "sensoji" },
					],
				},
			],
			legs: [
				{
					k: "toKyoto",
					from: "hands",
					to: "kiyomizu",
					mode: "transit",
					min: 150,
				},
			],
		});
		const m = buildModel(indexGraph(s.graph), N.tokyo as string, "area");
		expect(reps(m)).toEqual([N.shibuya, N.asakusa]);
		expect(m.transitions).toEqual([]);
		expect(m.ghosts).toEqual([
			expect.objectContaining({
				dir: "out",
				reason: "scope",
				insideItemId: s.I.hands,
				outsideItemId: s.I.kiyomizu,
				outsideRepId: N.kyoto,
			}),
			expect.objectContaining({
				dir: "in",
				reason: "scope",
				insideItemId: s.I.sensoji,
				outsideItemId: s.I.kiyomizu,
				outsideRepId: N.kyoto,
			}),
		]);
		expect(m.ghosts[0]?.leg?.id).toBe(s.L.toKyoto);
		expect(m.ghosts[0]?.pairKey).toBe(`${s.I.hands}>${s.I.kiyomizu}`);
		expect(m.ghosts[1]?.leg).toBeNull(); // no row for kiyomizu → sensoji yet
		expect(m.folds).toEqual([
			{
				kind: "stretch",
				dayId: s.D.d1,
				itemIds: [s.I.kiyomizu],
				labelNodeId: N.kyoto,
			},
		]);
		expect(m.edges).toEqual([]);
	});

	it("4. at city lens, Tokyo › Kyoto › Tokyo: one Tokyo pin with 2 visits, edges tokyo>kyoto and kyoto>tokyo (curved)", () => {
		const s = scenario({
			days: [
				{ items: [{ k: "hands", node: "hands" }] },
				{ items: [{ k: "kiyomizu", node: "kiyomizu" }] },
				{ items: [{ k: "sensoji", node: "sensoji" }] },
			],
			legs: [
				{ k: "out", from: "hands", to: "kiyomizu", mode: "transit", min: 140 },
				{
					k: "back",
					from: "kiyomizu",
					to: "sensoji",
					mode: "transit",
					min: 150,
				},
			],
		});
		const m = buildModel(indexGraph(s.graph), null, "city");
		const tokyo = m.pins.find((p) => p.repId === N.tokyo);
		expect(tokyo).toMatchObject({ visits: 2, number: 1 });
		const there = m.edges.find((e) => e.key === `${N.tokyo}>${N.kyoto}`);
		const back = m.edges.find((e) => e.key === `${N.kyoto}>${N.tokyo}`);
		expect(there).toMatchObject({
			kind: "travel",
			curved: false,
			mode: "transit",
			count: 1,
			estimate: false,
			legIds: [s.L.out],
		});
		expect(back).toMatchObject({
			kind: "travel",
			curved: true,
			legIds: [s.L.back],
		});
		// Coarser lens: one straight feature per edge, pin to pin.
		expect(there?.features).toHaveLength(1);
		expect(there?.features[0]).toMatchObject({
			fid: there?.key,
			approx: false,
			pairKey: null,
		});
	});

	it("5. an unlocated Lunch between two Shibuya items stays in the Shibuya visit", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "hands", node: "hands" },
						{ k: "lunch", title: "Lunch" },
						{ k: "loft", node: "loft" },
					],
				},
			],
		});
		const m = buildModel(indexGraph(s.graph), null, "area");
		expect(m.visits).toHaveLength(1);
		expect(m.visits[0]?.itemIds).toEqual([s.I.hands, s.I.lunch, s.I.loft]);
		expect(m.visitOfItem[s.I.lunch as string]).toBe(m.visits[0]?.key);
	});

	it("6. Day 2 = [Breakfast, Kyoto temple] after a Tokyo Day 1 with no stay: Breakfast is in the Tokyo visit", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "hands", node: "hands" },
						{ k: "sensoji", node: "sensoji" },
					],
				},
				{
					items: [
						{ k: "breakfast", title: "Breakfast", min: 30 },
						{ k: "temple", node: "kiyomizu" },
					],
				},
			],
		});
		const ix = indexGraph(s.graph);
		expect(ix.effectiveNodeId(s.I.breakfast as string)).toBe(N.sensoji);
		const m = buildModel(ix, null, "city");
		expect(reps(m)).toEqual([N.tokyo, N.kyoto]);
		expect(m.visits[0]?.itemIds).toContain(s.I.breakfast);
		expect(m.transitions).toEqual([
			expect.objectContaining({
				fromItemId: s.I.sensoji,
				toItemId: s.I.temple,
				via: "overnight",
				leg: null,
			}),
		]);
		expect(m.edges.map((e) => [e.key, e.kind])).toEqual([
			[`${N.tokyo}>${N.kyoto}#overnight`, "overnight"],
		]);
	});

	describe("7. a stay at Kawaguchiko Ryokan on Day 5's night", () => {
		const build = (withStay: boolean) =>
			scenario({
				days: [
					{ items: [] },
					{ items: [] },
					{ items: [] },
					{ items: [] },
					{
						night: withStay ? "ryokan" : undefined,
						items: [{ k: "itoya", node: "itoya" }],
					},
					{
						items: [
							{ k: "breakfast", title: "Breakfast (ryokan)", min: 60 },
							{ k: "temple", node: "kiyomizu" },
						],
					},
				],
			});

		it("makes the ryokan Day 6's leading Breakfast's effective node, with a stay_start leg", () => {
			const s = build(true);
			const ix = indexGraph(s.graph);
			expect(ix.effectiveNodeId(s.I.breakfast as string)).toBe(N.ryokan);
			expect(ix.morningStay(s.D.d6 as string)).toMatchObject({
				stayNodeId: N.ryokan,
				anchorItemId: s.I.temple,
				end: "start",
			});
			expect(ix.boundaryKind(s.I.itoya as string, s.I.temple as string)).toBe(
				"stay",
			);
			const sched = computeSchedule(ix);
			expect(sched.legs[`stay:${s.D.d6}:start`]).toMatchObject({
				kind: "stay",
				unset: true,
				estimate: true,
			});
			expect(sched.legs[`${s.I.itoya}>${s.I.temple}`]).toMatchObject({
				kind: "overnight",
				minutes: 0,
			});
			const m = buildModel(ix, null, "place");
			expect(m.transitions[0]).toMatchObject({
				via: "stay",
				fromItemId: s.I.itoya,
				toItemId: s.I.temple,
			});
			// Stay edges: Itoya → ryokan (evening), ryokan → Kiyomizu (morning); the ryokan gets a bed pin.
			expect(
				m.edges
					.filter((e) => e.kind === "stay")
					.map((e) => [e.fromRepId, e.toRepId]),
			).toEqual([
				[N.itoya, N.ryokan],
				[N.ryokan, N.kiyomizu],
			]);
			expect(m.pins.find((p) => p.repId === N.ryokan)).toMatchObject({
				stay: true,
				number: null,
				hollow: false,
			});
		});

		it("without the stay, the Day 5 → 6 boundary is overnight with 0 minutes", () => {
			const s = build(false);
			const ix = indexGraph(s.graph);
			expect(ix.effectiveNodeId(s.I.breakfast as string)).toBe(N.itoya);
			expect(ix.boundaryKind(s.I.itoya as string, s.I.temple as string)).toBe(
				"overnight",
			);
			const sched = computeSchedule(ix);
			expect(sched.legs[`${s.I.itoya}>${s.I.temple}`]).toMatchObject({
				kind: "overnight",
				minutes: 0,
			});
			expect(sched.legs[`stay:${s.D.d6}:start`]).toBeUndefined();
		});
	});

	it("8. scope Asakusa at area lens: Kappabashi is enabled and the rep of the knife shop; Senso-ji is a finer rep of itself", () => {
		const ix = indexGraph(demo.graph);
		const asakusa = N.asakusa as string;
		expect(lensOptions(ix, asakusa).find((o) => o.lens === "area")).toEqual({
			lens: "area",
			enabled: true,
			visible: true,
		});
		expect(repAt(ix, N.knifeShop as string, "area", asakusa)).toEqual({
			id: N.kappabashi,
			mode: "exact",
		});
		expect(repAt(ix, N.sensoji as string, "area", asakusa)).toEqual({
			id: N.sensoji,
			mode: "finer",
		});
	});

	it("9. a day range limited to Day 3 gives `days` ghosts at both ends and pins only for Day 3's reps", () => {
		const s = scenario({
			days: [
				{ items: [{ k: "hands", node: "hands" }] },
				{ items: [{ k: "meiji", node: "meijiJingu" }] },
				{
					items: [
						{ k: "sensoji", node: "sensoji" },
						{ k: "knives", node: "knifeShop" },
					],
				},
				{ items: [{ k: "itoya", node: "itoya" }] },
			],
		});
		const d3 = s.graph.days[2]?.date as string;
		const m = buildModel(indexGraph(s.graph), null, "place", {
			from: d3,
			to: d3,
		});
		expect(m.ghosts).toEqual([
			expect.objectContaining({
				dir: "in",
				reason: "days",
				outsideItemId: s.I.meiji,
				insideItemId: s.I.sensoji,
			}),
			expect.objectContaining({
				dir: "out",
				reason: "days",
				insideItemId: s.I.knives,
				outsideItemId: s.I.itoya,
			}),
		]);
		expect(m.pins.map((p) => p.repId)).toEqual([N.sensoji, N.knifeShop]);
		expect(m.pins.every((p) => !p.hollow)).toBe(true);
		expect(m.folds).toEqual([]);
	});

	it("10. at place lens, a duration-only custom route still produces an edge feature with approx: true", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "hands", node: "hands" },
						{ k: "meiji", node: "meijiJingu" },
					],
				},
			],
			legs: [
				{
					k: "custom",
					from: "hands",
					to: "meiji",
					mode: "transit",
					min: 20,
					details: {
						kind: "transit",
						route: {
							id: "r1",
							source: "manual",
							durationMin: 20,
							walkMin: 0,
							transfers: 0,
							segments: [],
							label: "JR Yamanote",
						},
					},
				},
			],
		});
		const m = buildModel(indexGraph(s.graph), null, "place");
		const edge = m.edges.find((e) => e.kind === "travel");
		expect(edge?.features).toHaveLength(1);
		expect(edge?.features[0]).toMatchObject({
			approx: true,
			mode: "transit",
			legId: s.L.custom,
			pairKey: `${s.I.hands}>${s.I.meiji}`,
		});
		expect(edge?.features[0]?.geometry.coordinates).toEqual([
			[139.6989, 35.6617],
			[139.6993, 35.6764],
		]);
	});

	it("11. moving Kawaguchiko's arrival item breaks the Fuji Excursion pair: the leg is detached, with its from-item's day", () => {
		const legs = [
			{
				k: "fuji",
				from: "breakfast",
				to: "dropBags",
				mode: "transit" as const,
				min: 116,
				isEdited: true,
			},
		];
		const before = scenario({
			days: [
				{
					items: [
						{ k: "breakfast", node: "itoya" },
						{ k: "dropBags", node: "ryokan" },
						{ k: "oishi", node: "kawaguchiko" },
					],
				},
			],
			legs,
		});
		expect(indexGraph(before.graph).detachedLegs).toEqual([]);
		const after = scenario({
			days: [
				{
					items: [
						{ k: "breakfast", node: "itoya" },
						{ k: "oishi", node: "kawaguchiko" },
						{ k: "dropBags", node: "ryokan" },
					],
				},
			],
			legs,
		});
		const ix = indexGraph(after.graph);
		const expected = {
			legId: after.L.fuji,
			dayId: after.D.d1,
			fromItemId: after.I.breakfast,
			toItemId: after.I.dropBags,
		};
		expect(ix.detachedLegs).toEqual([expected]);
		expect(buildModel(ix, null, "place").detachedLegs).toEqual([expected]);
		expect(buildModel(ix, N.kyoto as string, "place").detachedLegs).toEqual([]); // not in scope
	});

	it("12. the schedule tests live in schedule.test.ts (§9.4)", () => {
		expect(typeof computeSchedule).toBe("function");
	});
});

describe("buildModel details", () => {
	it("hollow pins: unscheduled live nodes in scope, one per rep; dropped nodes are hidden", () => {
		const s = scenario({
			days: [{ items: [{ k: "hands", node: "hands" }] }],
			nodes: [
				{
					key: "gone",
					parent: "shibuya",
					type: "place",
					category: "bar",
					name: "Closed bar",
					at: [35.66, 139.7],
					status: "dropped",
				},
			],
		});
		const ix = indexGraph(s.graph);
		const m = buildModel(ix, N.tokyo as string, "area");
		const hollow = m.pins.filter((p) => p.hollow).map((p) => p.repId);
		expect(hollow).toEqual([N.harajuku, N.asakusa, N.itoya]);
		expect(m.pins[0]).toMatchObject({
			repId: N.shibuya,
			number: 1,
			hollow: false,
		});
		const place = buildModel(ix, N.shibuya as string, "place");
		expect(place.pins.map((p) => p.repId)).not.toContain(s.N.gone);
	});

	it("folds whole days with nothing in scope, and lists unscheduled items in scope", () => {
		const s = scenario({
			days: [
				{ items: [{ k: "hands", node: "hands" }] },
				{ items: [{ k: "kyoto1", node: "kiyomizu" }] },
				{ items: [] },
				{ items: [{ k: "sensoji", node: "sensoji" }] },
			],
			unscheduled: [
				{ k: "maybeItoya", node: "itoya" },
				{ k: "maybeKix", node: "kix" },
				{ k: "note", title: "Something" },
			],
		});
		const ix = indexGraph(s.graph);
		const m = buildModel(ix, N.tokyo as string, "area");
		expect(m.folds).toEqual([{ kind: "days", dayIds: [s.D.d2, s.D.d3] }]);
		expect(m.unscheduled).toEqual([s.I.maybeItoya]);
		expect(buildModel(ix, null, "country").unscheduled).toEqual([
			s.I.maybeItoya,
			s.I.maybeKix,
			s.I.note,
		]);
		expect(buildModel(ix, null, "country").folds).toEqual([]);
	});

	it("draws flights as one great-circle LineString, unwrapped across the antimeridian", () => {
		const s = scenario({
			days: [
				{ items: [{ k: "ewr", node: "ewr", min: 0 }] },
				{ items: [{ k: "hnd", node: "tokyo", min: 0 }] },
			],
			legs: [
				{
					k: "nh9",
					from: "ewr",
					to: "hnd",
					mode: "flight",
					dep: ["2027-10-02T02:00", "America/New_York"],
					arr: ["2027-10-03T05:00", "Asia/Tokyo"],
				},
			],
		});
		const m = buildModel(indexGraph(s.graph), null, "place");
		const f = m.edges[0]?.features[0];
		expect(m.edges[0]).toMatchObject({ mode: "flight", estimate: false });
		expect(f?.approx).toBe(false);
		expect(f?.geometry.type).toBe("LineString");
		const lngs = (f?.geometry.coordinates ?? []).map((c) => c[0] as number);
		expect(lngs.length).toBeGreaterThan(16);
		for (let i = 1; i < lngs.length; i++)
			expect(
				Math.abs((lngs[i] as number) - (lngs[i - 1] as number)),
			).toBeLessThan(180);
	});

	it("marks unset legs as `unset` edges with estimates", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "a", node: "hands" },
						{ k: "b", node: "sensoji" },
					],
				},
			],
		});
		const m = buildModel(indexGraph(s.graph), null, "place");
		expect(m.edges[0]).toMatchObject({
			mode: "unset",
			estimate: true,
			legIds: [],
		});
		expect(m.edges[0]?.features[0]).toMatchObject({
			mode: "unset",
			approx: true,
			legId: null,
		});
	});

	it("appends unlocated items to the open visit even when their effective node is a stay elsewhere (§8.3 step 2)", () => {
		const s = scenario({
			days: [
				{ night: "ryokan", items: [{ k: "kix", node: "kix" }] },
				{
					items: [
						{ k: "breakfast", title: "Breakfast" },
						{ k: "hands", node: "hands" },
					],
				},
			],
		});
		const ix = indexGraph(s.graph);
		expect(ix.effectiveNodeId(s.I.breakfast as string)).toBe(N.ryokan);
		const m = buildModel(ix, N.japan as string, "city");
		// Unlocated items never open a visit: Breakfast joins the open Osaka visit.
		expect(reps(m)).toEqual([N.osaka, N.tokyo]);
		expect(m.visits[0]?.itemIds).toEqual([s.I.kix, s.I.breakfast]);
		expect(m.transitions[0]).toMatchObject({
			via: "stay",
			fromItemId: s.I.kix,
			toItemId: s.I.hands,
		});
		// The stay night draws stay edges through the ryokan's rep (Kawaguchiko, a finer rep: no city on its path).
		expect(
			m.edges
				.filter((e) => e.kind === "stay")
				.map((e) => [e.fromRepId, e.toRepId]),
		).toEqual([
			[N.osaka, N.kawaguchiko],
			[N.kawaguchiko, N.tokyo],
		]);
	});

	it("ghosts an unlocated in-scope item after a gap into the next visit", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "hands", node: "hands" },
						{ k: "kyoto", node: "kiyomizu" },
					],
				},
				{ night: "itoya", items: [{ k: "kyoto2", node: "kiyomizu" }] },
				{
					items: [
						{ k: "breakfast", title: "Breakfast" },
						{ k: "sensoji", node: "sensoji" },
					],
				},
			],
		});
		const m = buildModel(indexGraph(s.graph), N.tokyo as string, "area");
		expect(reps(m)).toEqual([N.shibuya, N.asakusa]);
		expect(m.visits[1]?.itemIds).toEqual([s.I.breakfast, s.I.sensoji]);
		expect(
			m.ghosts.map((g) => [g.dir, g.insideItemId, g.outsideItemId]),
		).toEqual([
			["out", s.I.hands, s.I.kyoto],
			["in", s.I.sensoji, s.I.kyoto2],
		]);
	});

	it("QA GRAN-07: a visit with no coordinates is pinned on its nearest located ancestor and its lines still draw (approx)", () => {
		const s = scenario({
			nodes: [
				{ key: "barKuro", parent: "shibuya", type: "place", name: "Bar Kuro" },
			],
			days: [
				{
					items: [
						{ k: "hands", node: "hands" },
						{ k: "bar", node: "barKuro" },
						{ k: "meiji", node: "meijiJingu" },
					],
				},
			],
		});
		const ix = indexGraph(s.graph);
		const m = buildModel(ix, null, "place");
		const bar = s.graph.nodes.find((n) => n.name === "Bar Kuro");
		const pin = m.pins.find((p) => p.repId === bar?.id);
		const shibuya = ix.coordOf(N.shibuya);
		expect(pin).toBeDefined();
		expect([pin?.lng, pin?.lat]).toEqual(shibuya);
		const touching = m.edges.filter(
			(e) => e.fromRepId === bar?.id || e.toRepId === bar?.id,
		);
		expect(touching).toHaveLength(2);
		for (const e of touching)
			expect(e.features.every((f) => f.approx)).toBe(true);
	});

	it("is deterministic and JSON-safe", () => {
		const ix = indexGraph(demo.graph);
		for (const lens of [
			"country",
			"region",
			"city",
			"area",
			"place",
		] as Lens[]) {
			const a = buildModel(ix, null, lens);
			expect(JSON.parse(JSON.stringify(a))).toEqual(a);
			expect(buildModel(indexGraph(demo.graph), null, lens)).toEqual(a);
			// Bookkeeping: every visited item belongs to exactly one visit.
			const seen = a.visits.flatMap((v) => v.itemIds);
			expect(new Set(seen).size).toBe(seen.length);
			expect(a.edges.every((e) => e.fromRepId !== e.toRepId)).toBe(true);
		}
	});
});

/**
 * The Asia 2027 import on the REAL sheet export, without a database: the plan
 * the importer writes is checked against qa/SCENARIOS §27 (SEED-01…09, 11, 12)
 * as SPEC §17.3 and ADDENDUM §8/§10 amend them, and the schedule the engine
 * computes on it matches the sheet's day totals.
 */
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import { loadSheetData, type SheetData } from "./lib/data";
import { planToGraph } from "./lib/graph";
import {
	buildPlan,
	type ImportPlan,
	type PlanNode,
	type Target,
} from "./lib/plan";

let data: SheetData;
let plan: ImportPlan;
let byId: Map<string, PlanNode>;

const opts = {
	slug: "asia-2027",
	name: "Asia 2027",
	start: "2027-10-02",
	day1: "2027-10-03",
	end: "2027-11-07",
	actionTimeline: true,
	flightRows: true,
};

beforeAll(() => {
	data = loadSheetData({
		dataDir: "seed/data",
		mediaDir: "seed/media",
		overridesFile: null,
	});
	plan = buildPlan(data, opts);
	byId = new Map(plan.nodes.map((n) => [n.id, n]));
});

const node = (path: string): PlanNode => {
	let parent: PlanNode | null = null;
	for (const name of path.split(" › ")) {
		const next = plan.nodes.find(
			(n) => n.parentId === (parent?.id ?? null) && n.name === name,
		);
		if (!next) throw new Error(`no ${path}`);
		parent = next;
	}
	return parent as PlanNode;
};
const childrenOf = (n: PlanNode) =>
	plan.nodes.filter((c) => c.parentId === n.id);
const targetName = (t: Target) =>
	t.kind === "root"
		? "ROOT"
		: t.kind === "node"
			? byId.get(t.nodeId)?.name
			: t.kind;
const itemName = (id: string) => {
	const it = plan.items.find((i) => i.id === id);
	return it?.title ?? (it?.nodeId ? byId.get(it.nodeId)?.name : null) ?? "?";
};

describe("SEED-01/02/04/08: the place tree", () => {
	it("has 4 countries and every Cities row (8 dropped), plus the 5 Places-only cities", () => {
		expect(
			plan.nodes.filter((n) => n.type === "country").map((n) => n.name),
		).toEqual(["Japan", "South Korea", "Vietnam", "Taiwan"]);
		const cities = plan.nodes.filter(
			(n) => n.type === "city" || n.type === "region",
		);
		expect(cities).toHaveLength(26 + 5);
		expect(cities.filter((c) => c.status === "dropped")).toHaveLength(8);
		for (const name of ["Ikeda", "Ikoma", "Minoh", "Miyazu", "Urayasu"])
			expect(node(`Japan › ${name}`).details.notInCitiesTab).toBe(true);
		expect(node("Japan › Mt. Fuji").type).toBe("region");
		expect(node("Vietnam › Ha Long Bay")).toMatchObject({
			type: "region",
			status: "dropped",
		});
		expect(node("Japan › Hiroshima").status).toBe("dropped");
	});

	it("keeps separate towns as separate cities with their Days (SEED-02)", () => {
		expect(node("Vietnam › Hoi An").type).toBe("city");
		expect(node("Vietnam › Hoi An").details.plannedDays).toBeUndefined();
		expect(node("Vietnam › Da Nang").details.plannedDays).toBe(3);
		expect(node("Japan › Kyoto").details.plannedDays).toBe(2.75);
		expect(node("Japan › Uji").details.plannedDays).toBe(0.15);
		for (const p of ["Taiwan › Jiufen", "Taiwan › Shifen", "Japan › Nara"])
			expect(node(p).type).toBe("city");
	});

	it("has all 125 Places rows as nodes, neighbourhood rows merged into their wards (SEED-01, SEED-04)", () => {
		const sheetPlaces = data.places.rows.length;
		expect(sheetPlaces).toBe(125);
		const fromPlaces = plan.nodes.filter((n) =>
			n.source.startsWith("Places!D"),
		);
		expect(fromPlaces).toHaveLength(125);
		const tokyo = node("Japan › Tokyo");
		const wards = childrenOf(tokyo)
			.filter((n) => n.type === "area")
			.map((n) => n.name);
		for (const w of [
			"Asakusa",
			"Azabu-Juban",
			"Ginza",
			"Haneda",
			"Harajuku",
			"Minami-Aoyama",
			"Mitaka",
			"Nakano",
			"Nihonbashi",
			"Omotesando",
			"Setagaya",
			"Shibuya",
			"Shinjuku",
			"Toyosu",
		])
			expect(wards).toContain(w);
		// No ward twice; the Neighborhood row carries its description and link.
		expect(new Set(wards).size).toBe(wards.length);
		const shinjuku = node("Japan › Tokyo › Shinjuku");
		expect(shinjuku.details.sheetCategory).toBe("Neighborhood");
		expect(
			plan.attachments.some(
				(a) =>
					a.target.kind === "node" &&
					a.target.nodeId === shinjuku.id &&
					a.url?.includes("japan-guide.com/e/e3011"),
			),
		).toBe(true);
		// A Neighborhood row with an Area nests inside it.
		expect(node("Japan › Tokyo › Shinjuku › Kabukicho").type).toBe("area");
		// Rows with no Area hang off their city.
		expect(node("Japan › Nara › Todai-ji").type).toBe("place");
	});

	it("keeps the place fields (SEED-08, SEED-11)", () => {
		const gai = node("Japan › Tokyo › Shinjuku › Golden Gai");
		expect(gai).toMatchObject({
			type: "place",
			category: "bar",
			timeNeededMin: 150,
		});
		expect(gai.priorities).toEqual({ owner: "want", audrey: "want" });
		const kappa = node("Japan › Tokyo › Asakusa › Kappabashi Street");
		expect(kappa).toMatchObject({ category: "shopping", timeNeededMin: 150 });
		expect(kappa.details.sheetCategory).toBe("Shopping");
		expect(kappa.note).toContain(
			"[Knife shopping guide ↗](https://tokyocheapo.com/shopping-2/kappabashi-knife-shopping-tokyo/)",
		);
		const towel = node(
			"Japan › Tokyo › Minami-Aoyama › Imabari Towel (Minami-Aoyama)",
		);
		expect(towel.details.openHoursText).toBe("10:30–19:00; closed 2nd Tue");
		expect(node("Japan › Tokyo › Omotesando › glänta (Omotesando)").name).toBe(
			"glänta (Omotesando)",
		);
		expect(node("Taiwan › Taipei › Da'an District").type).toBe("area");
	});

	it("geocodes every node from the hints (0 fallbacks), with zones", () => {
		expect(plan.report.geocode.misses).toEqual([]);
		expect(
			plan.nodes.every((n) => n.lat !== null && n.lng !== null && n.tz),
		).toBe(true);
		expect(node("Vietnam › Hanoi").tz).toBe("Asia/Ho_Chi_Minh");
	});

	it("gives siblings unique slugs and ordered positions", () => {
		const groups = new Map<string | null, PlanNode[]>();
		for (const n of plan.nodes)
			groups.set(n.parentId, [...(groups.get(n.parentId) ?? []), n]);
		for (const sibs of groups.values()) {
			expect(new Set(sibs.map((s) => s.slug)).size).toBe(sibs.length);
			expect(new Set(sibs.map((s) => s.position)).size).toBe(sibs.length);
		}
		// Parents come before their children.
		const seen = new Set<string>();
		for (const n of plan.nodes) {
			if (n.parentId) expect(seen.has(n.parentId)).toBe(true);
			seen.add(n.id);
		}
	});
});

describe("SEED-03/05/09 and TL-10: the itinerary", () => {
	it("has 54 scheduled items + 3 legs over Sun 3 – Fri 8 Oct, and 8 Unscheduled backups", () => {
		const scheduled = plan.items.filter((i) => i.dayId);
		expect(scheduled).toHaveLength(54);
		expect(plan.legs).toHaveLength(3);
		const dates = new Set(
			scheduled.map((i) => plan.days.find((d) => d.id === i.dayId)?.date),
		);
		expect([...dates].sort()).toEqual([
			"2027-10-03",
			"2027-10-04",
			"2027-10-05",
			"2027-10-06",
			"2027-10-07",
			"2027-10-08",
		]);
		const backup = plan.items
			.filter((i) => !i.dayId)
			.sort((a, b) => (a.position < b.position ? -1 : 1));
		expect(backup.map((i) => itemName(i.id))).toEqual([
			"Ginza Tsutaya Books",
			"Camera Town",
			"Omoide Yokocho",
			"Don Quijote",
			"Love Hotel Hill",
			"teamLab Planets",
			"Ghibli Museum",
			"Akihabara",
		]);
	});

	it("spans Oct 2 – Nov 7 with Day 1 on Sun 3 Oct and the sheet's titles", () => {
		expect(plan.days).toHaveLength(37);
		expect(plan.trip).toMatchObject({
			startDate: "2027-10-02",
			endDate: "2027-11-07",
			defaultTz: "Asia/Tokyo",
		});
		const tue = plan.days.find((d) => d.date === "2027-10-05");
		expect(tue?.title).toBe("Tokyo · Nakano + Shinjuku");
		expect(plan.days.find((d) => d.date === "2027-10-08")?.title).toBe(
			"Mt. Fuji → Nagoya",
		);
		expect(plan.trip.settings).toEqual({
			currency: "USD",
			dayCapacityMin: 750,
		});
	});

	it("matches the sheet's day totals, Travel rows counted as their legs", () => {
		const totals = plan.days.slice(1, 7).map((d) => {
			const its = plan.items.filter((i) => i.dayId === d.id);
			const ids = new Set(its.map((i) => i.id));
			const legs = plan.legs.filter((l) => ids.has(l.toItemId));
			return (
				(its.reduce((s, i) => s + i.durationMin, 0) +
					legs.reduce((s, l) => s + (l.durationMin ?? 0), 0)) /
				60
			);
		});
		expect(totals).toEqual([11, 15, 13, 11, 10.5, 9.75]);
	});

	it("links items to the Places nodes, never duplicating them (SEED-04)", () => {
		const gaiNode = node("Japan › Tokyo › Shinjuku › Golden Gai");
		const gai = plan.items.find((i) => i.nodeId === gaiNode.id);
		expect(gai?.title).toBeNull();
		const chureito = plan.items.find(
			(i) => i.title === "Chureito Pagoda (sunrise)",
		);
		expect(chureito?.nodeId).toBe(
			node("Japan › Mt. Fuji › Fujiyoshida › Chureito Pagoda").id,
		);
		const aki = plan.items.find(
			(i) => !i.dayId && i.nodeId === node("Japan › Tokyo › Akihabara").id,
		);
		expect(aki).toBeDefined();
		const d1 = plan.days.find((d) => d.date === "2027-10-03");
		const meals = plan.items.filter(
			(i) =>
				i.dayId === d1?.id &&
				["Breakfast", "Lunch", "Dinner"].includes(i.title ?? ""),
		);
		expect(meals).toHaveLength(3);
		expect(meals.every((m) => m.nodeId === null)).toBe(true);
		// No new place was invented for an itinerary row.
		expect(plan.report.created.filter((c) => c.includes("new place"))).toEqual(
			[],
		);
	});

	it("turns Travel rows into legs and Hotel rows into items at the ryokan (SEED-05)", () => {
		const legs = plan.legs.map((l) => ({
			label: l.label,
			mode: l.mode,
			min: l.durationMin,
			from: itemName(l.fromItemId),
			to: itemName(l.toItemId),
		}));
		expect(legs).toEqual([
			{
				label: "Fuji Excursion (Shinjuku → Kawaguchiko)",
				mode: "transit",
				min: 120,
				from: "Breakfast",
				to: "Drop bags at ryokan",
			},
			{
				label: "Bus → Shiraito Falls",
				mode: "other",
				min: 75,
				from: "Breakfast (ryokan)",
				to: "Shiraito Falls",
			},
			{
				label: "Shiraito → Shin-Fuji → Nagoya",
				mode: "transit",
				min: 150,
				from: "Lunch",
				to: "Dinner",
			},
		]);
		const fuji = plan.legs[0]?.details;
		expect(fuji?.kind === "transit" && fuji.route?.segments).toEqual([
			expect.objectContaining({
				mode: "rail",
				lineName: "Fuji Excursion",
				durationMin: 120,
				from: expect.objectContaining({ name: "Shinjuku Station" }),
				to: expect.objectContaining({ name: "Kawaguchiko Station" }),
			}),
		]);
		const bus = plan.notes.find(
			(n) => n.target.kind === "leg" && n.target.legId === plan.legs[1]?.id,
		);
		expect(bus?.markdown).toContain("Fujikyu bus, only \\~3/day");
		const ryokan = node("Japan › Mt. Fuji › Kawaguchiko › Kawaguchiko Ryokan");
		expect(ryokan.category).toBe("lodging");
		const bags = plan.items.find((i) => i.title === "Drop bags at ryokan");
		expect(bags?.nodeId).toBe(ryokan.id);
		expect(bags?.note).toContain("Check-in usually \\~15:00");
		expect(plan.days.find((d) => d.date === "2027-10-07")?.nightNodeId).toBe(
			ryokan.id,
		);
	});

	it("adds the 11 open Book ahead todos (SEED-09)", () => {
		const todos = plan.listItems.filter((l) => l.text === "Book ahead");
		expect(todos).toHaveLength(11);
		const names = todos.map((t) =>
			t.target.kind === "item"
				? itemName(t.target.itemId)
				: t.target.kind === "leg"
					? "leg"
					: "?",
		);
		expect(names.sort()).toEqual(
			[
				"JAL Sky Museum",
				"Shibuya Sky",
				"Nihonbashi Nishikawa",
				"Bar Centifolia",
				"Bar Benfiddich",
				"Samoyed Cafe Moffu",
				"glänta (Omotesando)",
				"leg",
				"Drop bags at ryokan",
				"teamLab Planets",
				"Ghibli Museum",
			].sort(),
		);
		expect(todos.every((t) => t.status === "open")).toBe(true);
	});

	it("runs through the engine schedule with the sheet's hours", () => {
		const g = planToGraph(plan);
		const s = computeSchedule(indexGraph(g));
		const d3 = plan.days.find((d) => d.date === "2027-10-05") as { id: string };
		expect(s.days[d3.id]?.activitiesMin).toBe(13 * 60);
		const backup = plan.items.filter((i) => !i.dayId);
		for (const b of backup) expect(s.items[b.id]).toBeUndefined();
	});

	it("takes the few clock times the sheet states in words (times.ts)", () => {
		const day = (date: string) =>
			plan.days.find((d) => d.date === date) as {
				id: string;
				startTime: string;
			};
		expect(
			["2027-10-03", "2027-10-04", "2027-10-07", "2027-10-08"].map(
				(d) => day(d).startTime,
			),
		).toEqual(["07:30", "09:00", "08:00", "05:30"]);
		const at = (date: string, name: string) =>
			plan.items.find(
				(i) =>
					i.dayId === day(date).id &&
					(i.title ?? byId.get(i.nodeId ?? "")?.name) === name,
			);
		// "Earliest tour 9:30 (reserve)": pinned, and NOT booked (EXTENSIONS D4).
		expect(at("2027-10-03", "JAL Sky Museum")).toMatchObject({
			pinnedStart: "09:30",
			fixedDate: false,
		});
		expect(at("2027-10-07", "Mt. Fuji Panoramic Ropeway")?.pinnedStart).toBe(
			"15:30",
		);
		expect(plan.items.filter((i) => i.pinnedStart)).toHaveLength(2);
		expect(plan.report.times.every((t) => t.applied)).toBe(true);
		expect(plan.report.times).toHaveLength(5);

		// The engine turns them into the sheet's day: sunrise at the pagoda,
		// the ~08:30 train, the ropeway before sunset, no late pins.
		const s = computeSchedule(indexGraph(planToGraph(plan)));
		const hm = (id: string | undefined, end = false) => {
			const r = id ? s.items[id] : undefined;
			if (!r) return null;
			return new Intl.DateTimeFormat("en-GB", {
				hour: "2-digit",
				minute: "2-digit",
				hourCycle: "h23",
				timeZone: r.tz,
			}).format(end ? r.end : r.start);
		};
		expect(hm(at("2027-10-03", "JAL Sky Museum")?.id)).toBe("09:30");
		expect(hm(at("2027-10-07", "Breakfast")?.id, true)).toBe("08:30");
		expect(hm(at("2027-10-07", "Mt. Fuji Panoramic Ropeway")?.id)).toBe(
			"15:30",
		);
		const pagoda = hm(at("2027-10-08", "Chureito Pagoda (sunrise)")?.id);
		expect(pagoda && pagoda >= "05:30" && pagoda < "06:00").toBe(true);
		for (const id of Object.keys(s.items))
			expect(s.items[id]?.late ?? 0, id).toBeFalsy();
		expect(plan.days.map((d) => s.days[d.id]?.conflicts ?? 0)).toEqual(
			plan.days.map(() => 0),
		);
	});

	it("skips a stated time when the row no longer says it", () => {
		const copy = structuredClone(data);
		const row = copy.itinerary.rows.find(
			(r) => r.Place === "Chureito Pagoda (sunrise)",
		);
		if (row) row.Notes = "Taxi at dawn";
		const p = buildPlan(copy, opts);
		expect(p.days.find((d) => d.date === "2027-10-08")?.startTime).toBe(
			"09:00",
		);
		expect(p.report.times.filter((t) => !t.applied)).toEqual([
			expect.objectContaining({ at: "05:30", quote: "Taxi ~15 min at ~5:30" }),
		]);
	});
});

describe("SEED-06: the shopping list", () => {
	it("imports 27 items for Dennis/Audrey and attaches them per A-16", () => {
		const shop = plan.listItems.filter((l) => l.list === "shopping");
		expect(shop).toHaveLength(27);
		expect(shop.every((s) => s.status === "open")).toBe(true);
		const who = shop.map((s) => s.assignees.slice().sort().join("+"));
		expect(who.filter((w) => w === "owner")).toHaveLength(19);
		expect(who.filter((w) => w === "audrey")).toHaveLength(3);
		expect(who.filter((w) => w === "audrey+owner")).toHaveLength(5);
		const at = (text: string) => shop.find((s) => s.text === text);
		expect(
			shop.filter((s) => targetName(s.target) === "Kappabashi Street"),
		).toHaveLength(6);
		expect(targetName(at("Custom pillow")?.target as Target)).toBe("Japan");
		expect(targetName(at("Matcha / tea")?.target as Target)).toBe("Japan");
		expect(targetName(at("Wallet")?.target as Target)).toBe("ROOT");
		expect(targetName(at("Purses")?.target as Target)).toBe("ROOT");
		expect(targetName(at("Suit")?.target as Target)).toBe("Hoi An");
		expect(at("Suit")?.note).toContain("Where: Hoi An tailors (Old Town)");
		expect(at("Custom pillow")).toMatchObject({
			priceText: "~¥30,000",
			priceAmount: 30000,
			priceCurrency: "JPY",
		});
		const nails = at("Nail clippers");
		expect(targetName(nails?.target as Target)).toBe("Hands Shibuya");
		expect(nails?.extraTargets.map((id) => byId.get(id)?.name)).toEqual([
			"Shibuya Loft",
		]);
		// ROLL-01: 19 items live inside Tokyo.
		const tokyo = node("Japan › Tokyo");
		const inTokyo = (id: string): boolean => {
			for (
				let n = byId.get(id);
				n;
				n = n.parentId ? byId.get(n.parentId) : undefined
			)
				if (n.id === tokyo.id) return true;
			return false;
		};
		expect(
			shop.filter((s) => s.target.kind === "node" && inTokyo(s.target.nodeId)),
		).toHaveLength(19);
	});
});

describe("SEED-07: links", () => {
	it("imports 39 links: 21 Cities, 8 Places, 10 Shopping sources", () => {
		const links = plan.attachments.filter((a) => a.kind === "link");
		const bySource = (p: string) =>
			links.filter((l) => l.source.startsWith(p)).length;
		expect(bySource("Cities!")).toBe(21);
		expect(bySource("Places!")).toBe(8);
		const shopUrls = plan.listItems.filter((l) => l.url).length;
		expect(bySource("Shopping List!") + shopUrls).toBe(10);
		expect(links.length + shopUrls).toBe(39);
		const kappa = node("Japan › Tokyo › Asakusa › Kappabashi Street");
		const k = links.find(
			(l) => l.target.kind === "node" && l.target.nodeId === kappa.id,
		);
		expect(k?.title).toBe("japan-guide.com: Kappabashi Street");
		const tokyoGuide = links.find((l) => l.source === "Cities!F2");
		expect(tokyoGuide?.title).toBe("Tokyo guide");
		expect(
			links.every((l) => (l.meta as { fetch?: string }).fetch === "unfetched"),
		).toBe(true);
	});
});

describe("Action Timeline (ADDENDUM §8, §10)", () => {
	it("imports every row as a todo, relative where the sheet documents the window", () => {
		const todos = plan.listItems.filter((l) =>
			l.source.startsWith("Action Timeline"),
		);
		expect(todos).toHaveLength(21);
		const fuji = todos.find((t) => t.text.startsWith("Fuji Excursion train"));
		expect(fuji?.target.kind).toBe("leg");
		expect(fuji?.dueRule).toMatchObject({
			kind: "months",
			months: 1,
			time: "10:00",
			tz: "Asia/Tokyo",
		});
		expect(fuji).toMatchObject({
			dueKind: "opens",
			dueDate: "2027-09-07",
			dueTime: "10:00",
			dueTz: "Asia/Tokyo",
		});
		// Anchored on the item the ride leads to, so the rule reads "1 month
		// before Drop bags at ryokan", not "… before Breakfast".
		const anchorId = (fuji?.dueRule as { itemId: string } | null)?.itemId;
		const anchor = plan.items.find((i) => i.id === anchorId);
		expect(anchor?.title).toBe("Drop bags at ryokan");
		const museum = todos.find((t) => t.text === "Ghibli Museum tickets");
		expect(museum?.dueRule).toMatchObject({
			kind: "months",
			months: 1,
			dayOfMonth: 10,
		});
		expect(museum?.dueDate).toBeNull(); // anchored on an Unscheduled backup item: TBD until scheduled
		const park = todos.find((t) => t.text === "Ghibli Park tickets");
		expect(park).toMatchObject({ dueRule: null, dueDate: null });
		expect(targetName(park?.target as Target)).toBe("Ghibli Park");
		expect(
			targetName(
				todos.find((t) => t.text.startsWith("Universal Studios"))
					?.target as Target,
			),
		).toBe("Universal Studios");
		expect(
			targetName(
				todos.find((t) => t.text === "Hotels — Japan")?.target as Target,
			),
		).toBe("Japan");
		expect(
			todos.find((t) => t.text.startsWith("Hotels — Korea"))?.target.kind,
		).toBe("root");
		expect(
			targetName(
				todos.find((t) => t.text.startsWith("Mt. Fuji ryokan"))
					?.target as Target,
			),
		).toBe("Kawaguchiko Ryokan");
		expect(
			targetName(
				todos.find((t) => t.text.startsWith("Hanoi ↔ Lao Cai"))
					?.target as Target,
			),
		).toBe("Sa Pa");
		expect(
			todos.find((t) => t.text.startsWith("Hoi An tailors"))?.dueKind,
		).toBe("on");
		expect(plan.report.unmatched).toEqual([]);
	});

	it("imports the Flight and Points rows by default (ADDENDUM §8/§10), absolute without a flight", () => {
		const todos = plan.listItems.filter((l) =>
			l.source.startsWith("Action Timeline"),
		);
		const chase = todos.find((t) => t.text.startsWith("Chase"));
		expect(chase).toMatchObject({
			dueKind: "due",
			dueDate: "2026-09-30",
			dueTime: "23:59",
			dueTz: "America/New_York",
		});
		const ana = todos.find(
			(t) => t.text === "ANA JFK→HND award (depart Oct 2)",
		);
		// No flight item on the plan to anchor 355 days to: the sheet's absolute ET time.
		expect(ana).toMatchObject({
			dueKind: "opens",
			dueRule: null,
			dueDate: "2026-10-11",
			dueTime: "20:00",
			dueTz: "America/New_York",
		});
		expect(
			todos.find((t) => t.text.startsWith("Turkish TPE→EWR")),
		).toMatchObject({ dueDate: "2026-12-03", dueTime: null });
		expect(
			todos.find((t) => t.text.startsWith("Intra-Asia cash flights")),
		).toMatchObject({ dueDate: null, target: { kind: "root" } });
	});

	it("skips the Flight and Points rows with --no-flight-rows (SPEC §17.3 step 8)", () => {
		const p = buildPlan(data, { ...opts, flightRows: false });
		const todos = p.listItems.filter((l) =>
			l.source.startsWith("Action Timeline"),
		);
		expect(todos).toHaveLength(14);
		expect(
			todos.some((t) => /ANA|Aeroplan|Turkish|Intra-Asia/.test(t.text)),
		).toBe(false);
		expect(
			p.report.actionTimeline.filter((a) => a.target.startsWith("(skipped")),
		).toHaveLength(7);
	});

	it("skips the Action Timeline with --no-action-timeline, and never imports Random Notes", () => {
		const p = buildPlan(data, { ...opts, actionTimeline: false });
		expect(
			p.listItems.filter((l) => l.source.startsWith("Action Timeline")),
		).toHaveLength(0);
		const all = JSON.stringify(plan);
		expect(all).not.toContain("Random notes");
		expect(plan.notes.some((n) => n.target.kind === "root")).toBe(false);
	});
});

describe("photos", () => {
	it("attaches all 94 manifest photos with attribution, primary first, Tokyo as the cover", () => {
		const photos = plan.attachments.filter((a) => a.kind === "photo");
		expect(photos).toHaveLength(94);
		const cover = photos.find((p) => p.id === plan.trip.coverAttachmentId);
		expect(cover && targetName(cover.target)).toBe("Tokyo");
		const wiki = photos.find((p) => p.meta.source === "wikimedia");
		expect(wiki).toMatchObject({ siteName: "Wikimedia Commons" });
		expect(wiki?.meta.license).toBeTruthy();
		const fuji = node("Japan › Mt. Fuji");
		const fujiPhotos = photos
			.filter((p) => p.target.kind === "node" && p.target.nodeId === fuji.id)
			.sort((a, b) => (a.position < b.position ? -1 : 1));
		expect(fujiPhotos.map((p) => p.photo?.file)).toEqual([
			"city--mt-fuji--lake-kawaguchiko.jpg",
			"city--mt-fuji--chureito-pagoda.jpg",
		]);
	});
});

describe("SEED-13: bad input", () => {
	const copy = (edit: (dir: string) => void) => {
		const dir = mkdtempSync(path.join(tmpdir(), "sheet-"));
		cpSync("seed/data", dir, { recursive: true });
		edit(dir);
		return dir;
	};
	it("names the file and the column when a header was renamed", () => {
		const dir = copy((d) => {
			const f = path.join(d, "places.json");
			const bad = JSON.parse(readFileSync(f, "utf8"));
			bad.headers = bad.headers.map((h: string) => (h === "City" ? "Town" : h));
			writeFileSync(f, JSON.stringify(bad));
		});
		try {
			expect(() =>
				loadSheetData({ dataDir: dir, mediaDir: null, overridesFile: null }),
			).toThrow(/places\.json: .*missing column "City"/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("names the file when the JSON is truncated", () => {
		const dir = copy((d) => {
			const f = path.join(d, "itinerary.json");
			writeFileSync(f, readFileSync(f, "utf8").slice(0, 500));
		});
		try {
			expect(() =>
				loadSheetData({ dataDir: dir, mediaDir: null, overridesFile: null }),
			).toThrow(/itinerary\.json: not valid JSON .*truncated/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

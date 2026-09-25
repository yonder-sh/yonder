/**
 * The QA seed's fixtures (qa/SCENARIOS §1 F3/F4) on the imported plan, run
 * through the real engine schedule: the F4 clock times come out as the
 * scenarios state them (where SPEC §7.8's located-only legs allow; see the
 * F4-b note below).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import type { ScheduleResult } from "@/lib/engine/types";
import { loadSheetData } from "./lib/data";
import { resolveWindow } from "./lib/due";
import { planToGraph } from "./lib/graph";
import { buildPlan, type ImportPlan, type PlanItem } from "./lib/plan";
import {
	applyQaFixtures,
	loadAirports,
	QA_DATES,
	QA_SHARE_TOKENS,
	qaMoney,
	qaProposals,
} from "./lib/qa";

let plan: ImportPlan;
let s: ScheduleResult;

beforeAll(() => {
	const data = loadSheetData({
		dataDir: "seed/data",
		mediaDir: null,
		overridesFile: null,
	});
	plan = buildPlan(data, {
		slug: "asia-2027",
		name: "Asia 2027",
		...QA_DATES,
		actionTimeline: true,
		flightRows: true,
	});
	applyQaFixtures(plan, loadAirports("seed/airports/airports.json"));
	s = computeSchedule(indexGraph(planToGraph(plan, "Dennis Tester")));
});

const hm = (d: Date, tz: string) =>
	new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZone: tz,
	}).format(d);
function item(date: string, name: string): PlanItem {
	const dayId = plan.days.find((d) => d.date === date)?.id;
	const byId = new Map(plan.nodes.map((n) => [n.id, n]));
	const it = plan.items.find(
		(i) =>
			i.dayId === dayId && (i.title ?? byId.get(i.nodeId ?? "")?.name) === name,
	);
	if (!it) throw new Error(`no ${name} on ${date}`);
	return it;
}
function times(date: string, name: string): string {
	const r = s.items[item(date, name).id];
	if (!r) throw new Error(`${name} not scheduled`);
	return `${hm(r.start, r.tz)}–${hm(r.end, r.tz)}`;
}

describe("QA fixtures", () => {
	it("ends the trip on Fri 5 Nov (F2) and adds the F3 ★ nodes", () => {
		expect(plan.days.at(-1)?.date).toBe("2027-11-05");
		expect(plan.days).toHaveLength(35);
		const names = plan.nodes.map((n) => n.name);
		for (const n of [
			"HND Terminal 3",
			"Bar Kuro",
			"Lào Cai",
			"USA",
			"New York",
			"JFK Terminal 7",
			"Newark",
			"EWR",
			"Havertown, PA",
			"Home",
			"Türkiye",
			"Istanbul",
			"IST",
		])
			expect(names).toContain(n);
		const kuro = plan.nodes.find((n) => n.name === "Bar Kuro");
		expect(kuro).toMatchObject({ lat: null, lng: null, category: "bar" });
		expect(plan.nodes.find((n) => n.id === kuro?.parentId)?.name).toBe(
			"Golden Gai",
		);
	});

	it("F4-a: NH 9 lands 05:00 and the arrival morning flows to the 09:30 pin", () => {
		expect(times("2027-10-03", "Arrival formalities")).toBe("05:00–06:30");
		expect(times("2027-10-03", "Anamori Inari Shrine")).toBe("06:40–07:40");
		expect(times("2027-10-03", "Breakfast")).toBe("07:50–08:20");
		expect(times("2027-10-03", "JAL Sky Museum")).toBe("09:30–11:40");
		expect(
			s.items[item("2027-10-03", "JAL Sky Museum").id]?.freeBeforeMin,
		).toBe(55);
		const nh9 = plan.legs.find(
			(l) =>
				l.details.kind === "flight" && l.details.flight.flightNumber === "NH9",
		);
		expect(nh9).toMatchObject({
			depAt: "2027-10-02T06:00:00.000Z",
			arrAt: "2027-10-02T20:00:00.000Z",
		});
		expect(nh9?.assignees).toEqual(["owner", "audrey"]);
	});

	it("F4-b: Tue 5 Oct keeps 13 h of activities, the 20:00 pin and ends 23:35", () => {
		expect(times("2027-10-05", "Bar Benfiddich")).toBe("20:00–21:00");
		expect(times("2027-10-05", "Golden Gai")).toBe("21:05–23:35");
		const d = s.days[plan.days.find((x) => x.date === "2027-10-05")?.id ?? ""];
		expect(d?.activitiesMin).toBe(13 * 60);
		// SPEC §7.8 joins located items only, so the fixture's "walk 10" before
		// Cha no Ikedaya (after an unlocated breakfast) has no leg row; see
		// FOUNDATION_STATUS §4 "QA F4-b's Lunch/Dinner times".
		expect(times("2027-10-05", "Nakano Broadway")).toBe("10:15–12:45");
	});

	it("F4-c: Fuji Excursion 7 departs 08:30, bags dropped 10:36–11:06", () => {
		expect(times("2027-10-07", "Breakfast")).toBe("07:30–08:00");
		expect(times("2027-10-07", "Drop bags at ryokan")).toBe("10:36–11:06");
		const leg = plan.legs.find((l) => l.label.startsWith("Fuji Excursion"));
		expect(
			leg?.details.kind === "transit" && leg.details.booking,
		).toMatchObject({ ref: "E7K2Q9", car: "3" });
		// TR-07 "Walk · Fuji Excursion 7 · Taxi": the taxi step uses the
		// builder's vehicle code, which route-view names "Taxi" (not "ride").
		const steps =
			leg?.details.kind === "transit" ? leg.details.route?.segments : [];
		expect(steps?.at(-1)).toMatchObject({ mode: "other", vehicleType: "TAXI" });
	});

	it("F4-d/e/f: the night trains, VN 576 and the TK 25 → TK 11 connection", () => {
		expect(times("2027-10-27", "Breakfast in Sa Pa")).toBe("06:30–07:15");
		// TZ-05/TL-13: the day ends with that breakfast, before its 09:00 start.
		const sapa =
			s.days[plan.days.find((x) => x.date === "2027-10-27")?.id ?? ""];
		expect(sapa && hm(sapa.end, sapa.tz)).toBe("07:15");
		// PLAN-R2-03: a day that ends by boarding a night train or flight ends
		// at the departure, not at its day start.
		const endOf = (date: string, tz: string) => {
			const d = s.days[plan.days.find((x) => x.date === date)?.id ?? ""];
			return d && hm(d.end, tz);
		};
		expect(endOf("2027-10-26", "Asia/Ho_Chi_Minh")).toBe("21:35");
		expect(endOf("2027-10-28", "Asia/Ho_Chi_Minh")).toBe("21:10");
		expect(endOf("2027-11-04", "Asia/Taipei")).toBe("23:25");
		expect(endOf("2027-10-02", "America/New_York")).toBe("02:00");
		const vn = plan.legs.find(
			(l) =>
				l.details.kind === "flight" &&
				l.details.flight.flightNumber === "VN576",
		);
		expect(
			vn && (Date.parse(vn.arrAt ?? "") - Date.parse(vn.depAt ?? "")) / 60000,
		).toBe(155);
		const tk25 = plan.legs.find(
			(l) =>
				l.details.kind === "flight" && l.details.flight.flightNumber === "TK25",
		);
		const tk11 = plan.legs.find(
			(l) =>
				l.details.kind === "flight" && l.details.flight.flightNumber === "TK11",
		);
		expect(
			tk25 &&
				tk11 &&
				(Date.parse(tk11.depAt ?? "") - Date.parse(tk25.arrAt ?? "")) / 60000,
		).toBe(140);
		expect(
			tk25?.details.kind === "flight" && tk25.details.flight.connection,
		).toEqual({ nextLegId: tk11?.id });
		// TZ-06: the IST layover item spans the connection ("Layover 2h 20m").
		expect(item("2027-11-05", "Layover").durationMin).toBe(140);
		const flights = plan.legs
			.filter((l) => l.mode === "flight")
			.map((l) => l.details.kind === "flight" && l.details.flight.flightNumber);
		expect(flights.sort()).toEqual([
			"KE724",
			"NH9",
			"TK11",
			"TK25",
			"VJ981",
			"VN576",
		]);
		for (const l of plan.legs)
			expect(s.legs[`${l.fromItemId}>${l.toItemId}`]?.late).toBeUndefined();
	});

	it("DUE-09: the ANA award window is 355 days before NH 9's day at 09:00 JST", () => {
		const anas = plan.listItems.filter(
			(l) => l.text === "ANA JFK→HND award (depart Oct 2)",
		);
		// The sheet's row, made relative (not a second copy).
		expect(anas).toHaveLength(1);
		const ana = anas[0];
		expect(ana?.source).toBe("Action Timeline!A3");
		const jfk = item("2027-10-02", "Check in (JFK T7)");
		const nh9 = plan.legs.find(
			(l) =>
				l.details.kind === "flight" && l.details.flight.flightNumber === "NH9",
		);
		expect(ana).toMatchObject({
			list: "todo",
			dueKind: "opens",
			target: { kind: "leg", legId: nh9?.id },
			dueRule: { kind: "days", itemId: jfk.id, days: 355, time: "09:00" },
			// = 8 PM ET on Sun 11 Oct 2026, the sheet's absolute time.
			dueDate: "2026-10-12",
			dueTime: "09:00",
			dueTz: "Asia/Tokyo",
		});
		// Shifting the trip +1 day moves the window with it.
		expect(
			ana?.dueRule && resolveWindow(ana.dueRule, "2027-10-03").dueDate,
		).toBe("2026-10-13");
	});
});

describe("EXTENSIONS §2.1 additions", () => {
	it("builds three expenses, one private, split between Dennis and Audrey", () => {
		const m = qaMoney(plan, { createdBy: "user-dennis" });
		expect(
			m.expenses.map((e) => [e.title, e.amountMinor, e.isPrivate ?? false]),
		).toEqual([
			["Kawaguchiko Ryokan", 60_000, false],
			["Fuji Excursion 7 seats", 8_260, false],
			["Fountain pen (gift)", 18_000, true],
		]);
		const [ryokan, seats, pen] = m.expenses;
		// One target each, and they exist in the plan.
		const ryokanNode = plan.nodes.find((n) => n.name === "Kawaguchiko Ryokan");
		expect(ryokan?.nodeId).toBe(ryokanNode?.id);
		expect(plan.legs.some((l) => l.id === seats?.legId)).toBe(true);
		expect(plan.nodes.find((n) => n.id === pen?.nodeId)?.name).toBe(
			"Itoya (G.Itoya)",
		);
		// USD cents at the fixture rate; the private one has no split.
		expect(m.expenses.map((e) => e.homeAmountMinor)).toEqual([
			40_000, 5_507, 12_000,
		]);
		expect(m.shares.filter((x) => x.expenseId === pen?.id)).toEqual([]);
		expect(new Set(m.shares.map((x) => x.memberId))).toEqual(
			new Set(plan.members.map((x) => x.id)),
		);
		// Audrey's ¥10,000 deposit: the ryokan is partial.
		expect(m.payments).toHaveLength(1);
		expect(m.payments[0]).toMatchObject({
			expenseId: ryokan?.id,
			amountMinor: 10_000,
		});
		expect(m.payers).toEqual([
			expect.objectContaining({
				paymentId: m.payments[0]?.id,
				memberId: plan.members.find((x) => x.key === "audrey")?.id,
				amountMinor: 10_000,
			}),
		]);
	});

	it("builds Maya's two suggestions on real rows, none touching a day", () => {
		const [idea, shorter] = qaProposals(plan);
		const higashiyama = plan.nodes.find((n) => n.name === "Higashiyama");
		expect(idea).toMatchObject({
			op: "node.create",
			input: {
				tripId: plan.trip.id,
				parentId: higashiyama?.id,
				type: "place",
				name: "Tōfuku-ji",
			},
		});
		expect(plan.nodes.some((n) => n.name === "Tōfuku-ji")).toBe(false);
		const aki = plan.items.find(
			(i) =>
				i.id === (shorter?.input as { itemId: string } | undefined)?.itemId,
		);
		expect(aki).toMatchObject({ dayId: null, durationMin: 240 });
		expect(shorter?.input).toMatchObject({ patch: { durationMin: 180 } });
	});

	it("has a 22–128 character token per share role", () => {
		expect(Object.keys(QA_SHARE_TOKENS).sort()).toEqual([
			"editor",
			"suggester",
			"viewer",
		]);
		for (const t of Object.values(QA_SHARE_TOKENS))
			expect(t.length).toBeGreaterThanOrEqual(22);
	});
});

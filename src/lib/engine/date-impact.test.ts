import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import type { ListItemDto } from "@/features/lists/lists.functions";
import { flightDetails, scenario } from "./__fixtures__/demo";
import { dateChangeImpact, impactedIds, rangedGraph } from "./date-impact";
import { indexGraph } from "./graph-index";
import { effectiveHours } from "./hours";
import type { GraphItem, TripGraph } from "./types";

const EXTRA = [
	{
		key: "tour",
		parent: "tokyo",
		type: "place" as const,
		category: "museum" as const,
		name: "Ghibli Museum",
		at: [35.6962, 139.5704] as [number, number],
	},
	{
		key: "pinned",
		parent: "tokyo",
		type: "place" as const,
		category: "sight" as const,
		name: "Imperial Palace tour",
		at: [35.6852, 139.7528] as [number, number],
	},
];

/** Sun 3 Oct → Thu 7 Oct: a reserved Fuji Excursion, a ryokan night, a booked flight. */
function trip() {
	const s = scenario({
		firstDate: "2027-10-03",
		nodes: EXTRA,
		days: [
			{
				items: [
					{ k: "tour", node: "tour", min: 90 },
					{ k: "palace", node: "pinned", min: 60, pin: "09:30" },
				],
			},
			{ items: [{ k: "itoya", node: "itoya", min: 60 }] },
			{
				night: "ryokan",
				items: [
					{ k: "senso", node: "sensoji", min: 60 },
					{ k: "bags", node: "ryokan", min: 30 },
				],
			},
			{ items: [{ k: "kiyo", node: "kiyomizu", min: 60 }] },
			{
				items: [
					{ k: "kix", node: "kix", min: 120 },
					{ k: "icn", node: "icn", min: 60 },
				],
			},
		],
		legs: [
			{
				k: "fuji",
				from: "senso",
				to: "bags",
				mode: "transit",
				min: 116,
				dep: ["2027-10-05T08:30", "Asia/Tokyo"],
				arr: ["2027-10-05T10:26", "Asia/Tokyo"],
				details: {
					kind: "transit",
					route: {
						id: "r1",
						source: "manual",
						durationMin: 116,
						walkMin: 0,
						transfers: 0,
						segments: [],
						label: "Fuji Excursion 7",
					},
					fixed: {
						departLocal: "2027-10-05T08:30",
						arriveLocal: "2027-10-05T10:26",
						fromTz: "Asia/Tokyo",
						toTz: "Asia/Tokyo",
						accessMin: 10,
						egressMin: 0,
					},
					booking: { ref: "E7K2Q9", seats: [] },
				},
			},
			{
				k: "flight",
				from: "kix",
				to: "icn",
				mode: "flight",
				dep: ["2027-10-07T13:05", "Asia/Tokyo"],
				arr: ["2027-10-07T15:05", "Asia/Seoul"],
				details: {
					...flightDetails({
						number: "KE724",
						from: {
							iata: "KIX",
							tz: "Asia/Tokyo",
							country: "JP",
							at: [34.432, 135.2304],
						},
						to: {
							iata: "ICN",
							tz: "Asia/Seoul",
							country: "KR",
							at: [37.4602, 126.4407],
						},
						dep: "2027-10-07T13:05",
						arr: "2027-10-07T15:05",
					}),
				},
			},
		],
	});
	// The tour is booked for its date; the palace visit is only pinned.
	const tour = s.graph.items.find((i) => i.id === s.I.tour) as GraphItem;
	tour.fixedDate = true;
	return s;
}

const ctxOf = (
	g: TripGraph,
	extra: Partial<Parameters<typeof dateChangeImpact>[2]> = {},
) => {
	const ix = indexGraph(g);
	return {
		hoursOf: (id: string) => {
			const n = ix.node(id);
			return n ? effectiveHours(n, g.trip.settings) : null;
		},
		holidays: [],
		today: "2026-09-23",
		...extra,
	};
};

describe("dateChangeImpact", () => {
	it("+1 lists the booked tour and the reserved train under bookings, the pinned visit and the ref-less flight under timed (SHIFT-01)", () => {
		const s = trip();
		const impact = dateChangeImpact(s.graph, { deltaDays: 1 }, ctxOf(s.graph));
		expect(impact.range).toEqual({ from: "2027-10-04", to: "2027-10-08" });
		expect(impact.weekdays).toBe("Mon–Fri");
		expect(impact.bookings).toEqual([
			{
				kind: "item",
				id: s.I.tour,
				label: "Ghibli Museum",
				from: "2027-10-03",
				to: "2027-10-04",
			},
			{
				kind: "transit",
				id: s.L.fuji,
				label: "Fuji Excursion 7",
				from: "2027-10-05",
				to: "2027-10-06",
				ref: "E7K2Q9",
			},
		]);
		expect(impact.timed).toEqual([
			{
				kind: "item",
				id: s.I.palace,
				label: "Imperial Palace tour",
				from: "2027-10-03",
				to: "2027-10-04",
				reason: "pinned",
			},
			{
				kind: "flight",
				id: s.L.flight,
				label: "Flight KE 724",
				from: "2027-10-07",
				to: "2027-10-08",
				reason: "flight_no_ref",
			},
		]);
		const ids = impactedIds(impact);
		expect([...ids.items].sort()).toEqual([s.I.palace, s.I.tour].sort());
		expect([...ids.legs].sort()).toEqual([s.L.flight, s.L.fuji].sort());
	});

	it("puts a flight with a ref under bookings and a 'Mark booked' item there too", () => {
		const s = trip();
		const leg = s.graph.legs.find((l) => l.id === s.L.flight);
		if (leg?.details && "flight" in leg.details)
			leg.details.flight.bookingRef = "ZK4P7Q";
		// "Mark booked" = `updateItem({ fixedDate: true })`.
		const palace = s.graph.items.find((i) => i.id === s.I.palace) as GraphItem;
		palace.fixedDate = true;
		const impact = dateChangeImpact(s.graph, { deltaDays: -1 }, ctxOf(s.graph));
		expect(impact.bookings.map((b) => [b.kind, b.label, b.ref])).toEqual([
			["item", "Ghibli Museum", undefined],
			["item", "Imperial Palace tour", undefined],
			["transit", "Fuji Excursion 7", "E7K2Q9"],
			["flight", "Flight KE 724", "ZK4P7Q"],
		]);
		expect(impact.timed).toEqual([]);
	});

	it("shows a closure the new dates create and one they resolve (SHIFT-02)", () => {
		const s = trip();
		// Itoya is on Mon 4 Oct; it's closed on Tuesdays and Sundays.
		const itoya = s.graph.nodes.find((n) => n.id === s.N.itoya);
		if (itoya) itoya.details = { openHoursText: "10:00–20:00; closed Tue" };
		const kiyo = s.graph.nodes.find((n) => n.id === s.N.kiyomizu);
		if (kiyo) kiyo.details = { openHoursText: "06:00–18:00; closed Wed" };
		const impact = dateChangeImpact(s.graph, { deltaDays: 1 }, ctxOf(s.graph));
		expect(impact.closures.added).toEqual([
			{
				itemId: s.I.itoya,
				date: "2027-10-05",
				issue: {
					kind: "closed",
					severity: "warn",
					label: "Closed Tue",
					source: "sheet",
				},
			},
		]);
		expect(impact.closures.resolved).toEqual([
			{
				itemId: s.I.kiyo,
				issue: {
					kind: "closed",
					severity: "warn",
					label: "Closed Wed",
					source: "sheet",
				},
			},
		]);
		expect(impactedIds(impact).items.has(s.I.itoya ?? "")).toBe(true);
	});

	it("moves stays as runs of nights", () => {
		const s = trip();
		const impact = dateChangeImpact(s.graph, { deltaDays: 2 }, ctxOf(s.graph));
		expect(impact.stays).toEqual([
			{
				nodeId: s.N.ryokan,
				name: "Kawaguchiko Ryokan",
				from: ["2027-10-05", "2027-10-06"],
				to: ["2027-10-07", "2027-10-08"],
			},
		]);
	});

	it("is empty for 0 and says when the trip would start in the past", () => {
		const s = trip();
		const zero = dateChangeImpact(s.graph, { deltaDays: 0 }, ctxOf(s.graph));
		expect([
			zero.bookings,
			zero.timed,
			zero.stays,
			zero.deadlines,
			zero.holidays,
			zero.closures.added,
		]).toEqual([[], [], [], [], [], []]);
		expect(zero.startsInPast).toBe(false);
		expect(
			dateChangeImpact(s.graph, { deltaDays: -400 }, ctxOf(s.graph))
				.startsInPast,
		).toBe(true);
	});

	it("lists deadlines that end up on or after their target, and due days now in the past", () => {
		const s = trip();
		// `doneAt`/`mine` are WP-Lists' fields; the assertion keeps this valid
		// with and without them.
		const li = (over: Partial<ListItemDto>): ListItemDto =>
			({
				id: "li",
				target: { kind: "trip" },
				list: "todo",
				text: "Book it",
				note: null,
				url: null,
				status: "open",
				dueDayId: null,
				dueDate: null,
				dueTime: null,
				dueTz: null,
				dueKind: "due",
				dueRule: null,
				quantity: null,
				priceAmount: null,
				priceCurrency: null,
				position: "a0",
				isPrivate: false,
				assigneeIds: [],
				extraTargetNodeIds: [],
				createdAt: "2026-09-01T00:00:00.000Z",
				updatedAt: "2026-09-01T00:00:00.000Z",
				doneAt: null,
				mine: true,
				...over,
			}) as ListItemDto;
		const listItems = [
			li({
				id: "a",
				text: "Ghibli tickets",
				target: { kind: "item", itemId: s.I.tour ?? "" },
				dueDate: "2027-10-01",
			}),
			li({ id: "b", text: "Pack", dueDayId: s.D.d1 ?? "" }),
			li({
				id: "c",
				text: "Done already",
				status: "done",
				target: { kind: "item", itemId: s.I.tour ?? "" },
				dueDate: "2027-10-01",
			}),
		];
		const back = dateChangeImpact(
			s.graph,
			{ deltaDays: -3 },
			ctxOf(s.graph, { listItems }),
		);
		expect(back.deadlines).toEqual([
			{
				listItemId: "a",
				text: "Ghibli tickets",
				due: "2027-10-01",
				reason: "after_target",
			},
		]);
		const past = dateChangeImpact(
			s.graph,
			{ deltaDays: -1 },
			ctxOf(s.graph, { listItems, today: "2027-10-03" }),
		);
		expect(past.deadlines).toEqual([
			{ listItemId: "b", text: "Pack", due: "2027-10-02", reason: "now_past" },
		]);
	});

	it("lists the holidays inside the new range", () => {
		const s = trip();
		const holidays = [
			{ date: "2027-10-11", name: "Sports Day", countryCode: "JP" },
			{ date: "2027-10-09", name: "Hangul Day", countryCode: "KR" },
		];
		const impact = dateChangeImpact(
			s.graph,
			{ deltaDays: 5 },
			ctxOf(s.graph, { holidays }),
		);
		expect(impact.holidays).toEqual([
			{ date: "2027-10-09", name: "Hangul Day" },
			{ date: "2027-10-11", name: "Sports Day" },
		]);
	});

	it("a range change sends the removed days' items to Unscheduled and adds empty days", () => {
		const s = trip();
		const g = rangedGraph(s.graph, "2027-10-04", "2027-10-08");
		expect(g.days.map((d) => d.date)).toEqual([
			"2027-10-04",
			"2027-10-05",
			"2027-10-06",
			"2027-10-07",
			"2027-10-08",
		]);
		expect(
			g.items
				.filter((i) => i.dayId === null)
				.map((i) => i.id)
				.sort(),
		).toEqual([s.I.palace, s.I.tour].sort());
		const impact = dateChangeImpact(
			s.graph,
			{ startDate: "2027-10-04", endDate: "2027-10-08" },
			ctxOf(s.graph),
		);
		expect(impact.bookings).toEqual([
			{
				kind: "item",
				id: s.I.tour,
				label: "Ghibli Museum",
				from: "2027-10-03",
				to: "",
			},
		]);
	});
});

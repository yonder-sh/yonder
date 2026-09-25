/**
 * The QA fixtures of qa/SCENARIOS.md §1 on top of the imported plan (SPEC
 * §17.2): the F3 ★ nodes and the F4 timeline fixtures (NH 9, the Day 1
 * arrival, the Day 3 legs, Fuji Excursion 7, SP3/SP4, VN 576, TK 25 + TK 11,
 * KIX→ICN, PUS→SGN). Pure: it edits the plan; `scripts/seed-qa.ts` writes it.
 *
 * Flight and train numbers, seats and booking refs are FIXTURE values
 * (qa/SCENARIOS §1). KIX→ICN and PUS→SGN have no times in the scenarios; the
 * ones here are invented and only have to be plausible.
 *
 * The EXTENSIONS §2.1 additions live here too, as pure builders: Maya (a
 * suggester member), three expenses (one
 * private) and Maya's two suggestions, plus the ANA 355-day window on NH 9
 * (QA DUE-09).
 */
import { readFileSync } from "node:fs";
import { generateKeyBetween } from "fractional-indexing";
import { v7 as uuidv7 } from "uuid";
import type {
	expensePaymentPayers,
	expensePayments,
	expenseShares,
	expenses,
} from "@/db/schema";
import { localDateTimeToEpoch } from "@/lib/engine/time";
import { slugify, uniqueSlug } from "@/lib/engine/tree";
import type { PlaceCategory } from "@/lib/schemas/enums";
import type {
	Airport,
	FlightDetails,
	LegDetails,
	TransitSegment,
} from "@/lib/schemas/legs";
import { resolveWindow } from "./due";
import type {
	ImportPlan,
	MemberKey,
	PlanItem,
	PlanLeg,
	PlanListItem,
	PlanNode,
} from "./plan";
import { normName } from "./text";

export type AirportRow = {
	iata: string;
	name: string;
	city: string;
	country: string;
	lat: number;
	lng: number;
	tz: string;
};

/** `seed/airports/airports.json` by IATA code. */
export function loadAirports(file: string): Map<string, AirportRow> {
	const rows = JSON.parse(readFileSync(file, "utf8")) as AirportRow[];
	return new Map(rows.map((r) => [r.iata, r]));
}

export const QA_USERS = {
	dennis: {
		email: "dennis@asia2027.test",
		firstName: "Dennis",
		lastName: "Tester",
	},
	audrey: {
		email: "audrey@asia2027.test",
		firstName: "Audrey",
		lastName: "Tester",
	},
	kai: { email: "kai@asia2027.test", firstName: "Kai", lastName: "Viewer" },
	eve: { email: "eve@asia2027.test", firstName: "Eve", lastName: "Outsider" },
	/** EXTENSIONS §2.1: the suggester member (the "Maya" of QA SUG). */
	maya: {
		email: "maya@asia2027.test",
		firstName: "Maya",
		lastName: "Suggester",
	},
} as const;
export type QaHandle = keyof typeof QA_USERS;

/** qa/SCENARIOS F2: the trip runs Sat 2 Oct → Fri 5 Nov 2027 (35 days). */
export const QA_DATES = {
	start: "2027-10-02",
	day1: "2027-10-03",
	end: "2027-11-05",
} as const;

class Patch {
	readonly byId: Map<string, PlanNode>;
	constructor(
		readonly plan: ImportPlan,
		readonly airports: ReadonlyMap<string, AirportRow>,
		readonly newId: () => string,
	) {
		this.byId = new Map(plan.nodes.map((n) => [n.id, n]));
	}

	node(path: string): PlanNode {
		const parts = path.split(" › ");
		let parent: PlanNode | null = null;
		for (const name of parts) {
			const next: PlanNode | undefined = this.plan.nodes.find(
				(n) =>
					n.parentId === (parent?.id ?? null) &&
					normName(n.name) === normName(name),
			);
			if (!next)
				throw new Error(`QA fixture: no node "${path}" (stopped at "${name}")`);
			parent = next;
		}
		return parent as PlanNode;
	}

	add(
		parent: PlanNode | null,
		n: {
			name: string;
			type: PlanNode["type"];
			category?: PlaceCategory;
			at?: [number, number];
			tz?: string;
			countryCode?: string;
			iata?: string;
			description?: string;
		},
	): PlanNode {
		const sibs = this.plan.nodes.filter(
			(x) => x.parentId === (parent?.id ?? null),
		);
		const last =
			sibs
				.map((s) => s.position)
				.sort()
				.at(-1) ?? null;
		const id = this.newId();
		const node: PlanNode = {
			id,
			key: `${parent?.key ?? ""}|${n.name}`,
			parentId: parent?.id ?? null,
			type: n.type,
			category: n.type === "place" ? (n.category ?? "other") : null,
			status: "active",
			name: n.name,
			slug: uniqueSlug(slugify(n.name, id), [
				...sibs.map((s) => s.slug),
				...(parent ? [] : ["rate"]),
			]),
			description: n.description ?? null,
			position: generateKeyBetween(last, null),
			lat: n.at?.[0] ?? null,
			lng: n.at?.[1] ?? null,
			tz: n.tz ?? null,
			countryCode: n.countryCode ?? null,
			timeNeededMin: null,
			details: { ...(n.iata ? { iata: n.iata } : {}), qaFixture: true },
			priorities: {},
			note: null,
			geo: n.at ? "override" : "none",
			source: "qa fixture (F3)",
		};
		// Parents before children: insert right after the parent's subtree.
		const idx = parent
			? lastIndexInSubtree(this.plan.nodes, parent.id) + 1
			: this.plan.nodes.length;
		this.plan.nodes.splice(idx, 0, node);
		this.byId.set(id, node);
		return node;
	}

	airport(parent: PlanNode, iata: string, name = iata): PlanNode {
		const a = this.airports.get(iata);
		if (!a)
			throw new Error(`QA fixture: airport ${iata} missing from seed/airports`);
		return this.add(parent, {
			name,
			type: "place",
			category: "airport",
			at: [a.lat, a.lng],
			tz: a.tz,
			iata,
			description: a.name,
		});
	}

	day(date: string) {
		const d = this.plan.days.find((x) => x.date === date);
		if (!d) throw new Error(`QA fixture: no day ${date}`);
		return d;
	}

	item(
		date: string | null,
		it: Partial<PlanItem> & { nodeId: string | null; title?: string | null },
	): PlanItem {
		const item: PlanItem = {
			id: this.newId(),
			dayId: date ? this.day(date).id : null,
			nodeId: it.nodeId,
			title: it.title ?? null,
			note: it.note ?? null,
			position: "",
			durationMin: it.durationMin ?? 60,
			pinnedStart: it.pinnedStart ?? null,
			fixedDate: it.fixedDate ?? false,
			assignees: it.assignees ?? [],
			source: "qa fixture (F4)",
		};
		this.plan.items.push(item);
		return item;
	}

	/** Re-keys one day's items in this order (items not listed keep their order, after). */
	order(date: string, ids: readonly string[]): void {
		const dayId = this.day(date).id;
		const day = this.plan.items
			.filter((i) => i.dayId === dayId)
			.sort((a, b) =>
				a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
			);
		const listed = ids
			.map((id) => day.find((i) => i.id === id))
			.filter((i): i is PlanItem => !!i);
		const rest = day.filter((i) => !ids.includes(i.id));
		let prev: string | null = null;
		for (const it of [...listed, ...rest]) {
			it.position = generateKeyBetween(prev, null);
			prev = it.position;
		}
	}

	findItem(date: string | null, title: string): PlanItem {
		const dayId = date ? this.day(date).id : null;
		const it = this.plan.items.find(
			(i) =>
				i.dayId === dayId &&
				normName(i.title ?? this.byId.get(i.nodeId ?? "")?.name ?? "") ===
					normName(title),
		);
		if (!it)
			throw new Error(
				`QA fixture: no item "${title}" on ${date ?? "Unscheduled"}`,
			);
		return it;
	}

	leg(
		from: PlanItem,
		to: PlanItem,
		mode: PlanLeg["mode"],
		details: LegDetails,
		o: {
			durationMin?: number | null;
			label?: string;
			assignees?: MemberKey[];
			note?: string;
		} = {},
	): PlanLeg {
		const { depAt, arrAt } = timedAt(details);
		const existing = this.plan.legs.find(
			(l) => l.fromItemId === from.id && l.toItemId === to.id,
		);
		const leg: PlanLeg = {
			id: existing?.id ?? this.newId(),
			kind: "pair",
			fromItemId: from.id,
			toItemId: to.id,
			mode,
			durationMin:
				mode === "flight" || depAt
					? null
					: (o.durationMin ??
						(details.kind === "transit"
							? (details.route?.durationMin ?? null)
							: null)),
			details,
			depAt,
			arrAt,
			note: o.note ?? existing?.note ?? null,
			label: o.label ?? existing?.label ?? "",
			assignees: o.assignees ?? [],
			source: "qa fixture (F4)",
		};
		if (existing) Object.assign(existing, leg);
		else this.plan.legs.push(leg);
		return existing ?? leg;
	}

	airportRef(iata: string, terminal?: string): Airport {
		const a = this.airports.get(iata) as AirportRow;
		return {
			iata,
			name: a.name,
			city: a.city,
			country: a.country,
			tz: a.tz,
			lat: a.lat,
			lng: a.lng,
			...(terminal ? { terminal } : {}),
		};
	}

	memberId(k: MemberKey): string {
		return (this.plan.members.find((m) => m.key === k) as { id: string }).id;
	}
}

function lastIndexInSubtree(
	nodes: readonly PlanNode[],
	rootId: string,
): number {
	const inTree = new Set([rootId]);
	let last = nodes.findIndex((n) => n.id === rootId);
	for (let i = last + 1; i < nodes.length; i++) {
		const n = nodes[i] as PlanNode;
		if (n.parentId && inTree.has(n.parentId)) {
			inTree.add(n.id);
			last = i;
		}
	}
	return last;
}

const walk = (min: number, to?: string): TransitSegment => ({
	mode: "walk",
	durationMin: min,
	...(to ? { to: { name: to } } : {}),
});

/** A manual transit route ("Keikyu, 10 min"). */
function manual(
	label: string,
	min: number,
	mode: TransitSegment["mode"] = "train",
): LegDetails {
	return {
		kind: "transit",
		route: {
			id: "qa",
			source: "manual",
			durationMin: min,
			walkMin: 0,
			transfers: 0,
			segments: [{ mode, lineName: label, durationMin: min }],
			label,
		},
		chosenId: "qa",
	};
}

function flight(
	f: Omit<FlightDetails, "seats"> & Partial<Pick<FlightDetails, "seats">>,
): LegDetails {
	return {
		kind: "flight",
		flight: { seats: [], ...f },
	};
}

/** §9.2 timed instants (the same rule as `timedInstants` in legs.server, kept pure here). */
export function timedAt(details: LegDetails): {
	depAt: string | null;
	arrAt: string | null;
} {
	const pair = (dep: [string, string], arr: [string, string]) => {
		const d = localDateTimeToEpoch(dep[0], dep[1]);
		const a = localDateTimeToEpoch(arr[0], arr[1]);
		if (d === null || a === null || a <= d)
			throw new Error(`QA fixture: bad timed leg ${dep[0]} → ${arr[0]}`);
		return {
			depAt: new Date(d).toISOString(),
			arrAt: new Date(a).toISOString(),
		};
	};
	if (details.kind === "flight")
		return pair(
			[details.flight.depLocal ?? "", details.flight.from.tz],
			[details.flight.arrLocal ?? "", details.flight.to.tz],
		);
	if (details.kind === "transit" && details.fixed)
		return pair(
			[details.fixed.departLocal, details.fixed.fromTz],
			[details.fixed.arriveLocal, details.fixed.toTz],
		);
	return { depAt: null, arrAt: null };
}

export function applyQaFixtures(
	plan: ImportPlan,
	airports: ReadonlyMap<string, AirportRow>,
	newId: () => string = uuidv7,
): void {
	const p = new Patch(plan, airports, newId);
	const both: MemberKey[] = ["owner", "audrey"];
	const seatsFor = (a: string, b: string) => [
		{ memberId: p.memberId("owner"), seat: a },
		{ memberId: p.memberId("audrey"), seat: b },
	];

	// ---- F3 ★ nodes --------------------------------------------------------
	const haneda = p.node("Japan › Tokyo › Haneda");
	const hnd = p.add(haneda, {
		name: "HND Terminal 3",
		type: "place",
		category: "airport",
		at: [35.5443, 139.7686],
		tz: "Asia/Tokyo",
		iata: "HND",
		description: "Haneda Airport, international terminal",
	});
	p.add(p.node("Japan › Tokyo › Shinjuku › Golden Gai"), {
		name: "Bar Kuro",
		type: "place",
		category: "bar",
	});
	const vietnam = p.node("Vietnam");
	const laoCai = p.add(vietnam, {
		name: "Lào Cai",
		type: "city",
		at: [22.4856, 103.9707],
		tz: "Asia/Ho_Chi_Minh",
		description: "Train end-point for Sa Pa",
	});
	const hanoi = p.node("Vietnam › Hanoi");
	const hanoiStation = p.add(hanoi, {
		name: "Hà Nội Station",
		type: "place",
		category: "station",
		at: [21.0245, 105.8412],
		tz: "Asia/Ho_Chi_Minh",
	});
	const usa = p.add(null, {
		name: "USA",
		type: "country",
		at: [39.8283, -98.5795],
		countryCode: "US",
		tz: "America/New_York",
	});
	const nyc = p.add(usa, {
		name: "New York",
		type: "city",
		at: [40.7128, -74.006],
		tz: "America/New_York",
	});
	const jfk = p.add(nyc, {
		name: "JFK Terminal 7",
		type: "place",
		category: "airport",
		at: [40.6483, -73.7822],
		tz: "America/New_York",
		iata: "JFK",
		description: "John F. Kennedy International Airport, Terminal 7",
	});
	const newark = p.add(usa, {
		name: "Newark",
		type: "city",
		at: [40.7357, -74.1724],
		tz: "America/New_York",
	});
	const ewr = p.airport(newark, "EWR");
	const havertown = p.add(usa, {
		name: "Havertown, PA",
		type: "city",
		at: [39.9809, -75.308],
		tz: "America/New_York",
	});
	p.add(havertown, {
		name: "Home",
		type: "place",
		category: "other",
		at: [39.9809, -75.308],
		tz: "America/New_York",
	});
	const turkiye = p.add(null, {
		name: "Türkiye",
		type: "country",
		at: [38.9637, 35.2433],
		countryCode: "TR",
		tz: "Europe/Istanbul",
	});
	const istanbul = p.add(turkiye, {
		name: "Istanbul",
		type: "city",
		at: [41.0082, 28.9784],
		tz: "Europe/Istanbul",
	});
	const ist = p.airport(istanbul, "IST");
	const kix = p.airport(p.node("Japan › Osaka"), "KIX");
	const icn = p.airport(p.node("South Korea › Seoul"), "ICN");
	const pus = p.airport(p.node("South Korea › Busan"), "PUS");
	const sgn = p.airport(p.node("Vietnam › Ho Chi Minh City"), "SGN");
	const han = p.airport(hanoi, "HAN");
	const tpe = p.airport(p.node("Taiwan › Taipei"), "TPE");

	// ---- F4-a: NH 9 and the arrival (Sat 2 → Sun 3 Oct) ----------------------
	p.day("2027-10-02").startTime = "00:00";
	const jfkItem = p.item("2027-10-02", {
		nodeId: jfk.id,
		title: "Check in (JFK T7)",
		durationMin: 0,
		assignees: both,
	});
	const arrival = p.item("2027-10-03", {
		nodeId: hnd.id,
		title: "Arrival formalities",
		durationMin: 90,
		assignees: both,
	});
	const nh9 = p.leg(
		jfkItem,
		arrival,
		"flight",
		flight({
			airline: { iata: "NH", name: "ANA" },
			flightNumber: "NH9",
			from: p.airportRef("JFK", "7"),
			to: p.airportRef("HND", "3"),
			depLocal: "2027-10-02T02:00",
			arrLocal: "2027-10-03T05:00",
			aircraft: "Boeing 777-300ER",
			cabin: "business",
			seats: seatsFor("8D", "8G"),
			bookingRef: "ZK4P7Q",
		}),
		{ assignees: both, note: "Aeroplan award" },
	);
	// QA DUE-09: the sheet's ANA row becomes a RELATIVE window on this
	// flight's day (355 days before at 09:00 JST = 8 PM ET the evening before),
	// so it follows NH 9 when the trip shifts. (The real import has no flight
	// to anchor on and keeps the sheet's absolute ET time.)
	const anaRule = {
		kind: "days" as const,
		itemId: jfkItem.id,
		days: 355,
		time: "09:00",
		tz: "Asia/Tokyo",
	};
	const anaText = "ANA JFK→HND award (depart Oct 2)";
	const ana: PlanListItem = plan.listItems.find((l) => l.text === anaText) ?? {
		id: p.newId(),
		list: "todo",
		target: { kind: "root" },
		text: anaText,
		note: "ANA releases award seats 355 days out at 09:00 JST (8 PM ET the evening before).",
		url: null,
		status: "open",
		dueKind: "opens",
		dueRule: null,
		dueDate: null,
		dueTime: null,
		dueTz: null,
		priceAmount: null,
		priceCurrency: null,
		priceText: null,
		position: "",
		assignees: [],
		extraTargets: [],
		source: "qa fixture (DUE-09)",
	};
	if (!plan.listItems.includes(ana)) plan.listItems.push(ana);
	Object.assign(ana, {
		target: { kind: "leg", legId: nh9.id },
		dueKind: "opens",
		dueRule: anaRule,
		...resolveWindow(anaRule, "2027-10-02"),
		position: generateKeyBetween(null, null),
		assignees: ["owner"],
	});
	const anamori = p.findItem("2027-10-03", "Anamori Inari Shrine");
	const breakfast1 = p.findItem("2027-10-03", "Breakfast");
	breakfast1.nodeId = haneda.id;
	const jal = p.findItem("2027-10-03", "JAL Sky Museum");
	jal.pinnedStart = "09:30";
	jal.durationMin = 130;
	p.order("2027-10-03", [arrival.id, anamori.id, breakfast1.id, jal.id]);
	p.leg(arrival, anamori, "transit", manual("Keikyu", 10));
	p.leg(anamori, breakfast1, "transit", manual("Keikyu", 10));
	p.leg(breakfast1, jal, "transit", manual("Tokyo Monorail", 15, "tram"));

	// ---- F4-b: Tue 5 Oct (sheet Day 3), every leg manual ----------------------
	const d3 = "2027-10-05";
	p.day(d3).startTime = "09:00";
	const cha = p.findItem(d3, "Cha no Ikedaya");
	const nakano = p.findItem(d3, "Nakano Broadway");
	const yodo = p.findItem(d3, "Yodobashi Camera");
	const bic = p.findItem(d3, "Bic Camera");
	const benf = p.findItem(d3, "Bar Benfiddich");
	const gai = p.findItem(d3, "Golden Gai");
	benf.pinnedStart = "20:00";
	p.leg(cha, nakano, "transit", manual("JR Chuo Rapid", 15));
	p.leg(nakano, yodo, "transit", manual("JR Chuo Rapid", 20));
	p.leg(yodo, bic, "walk", { kind: "walk" }, { durationMin: 5 });
	p.leg(bic, benf, "walk", { kind: "walk" }, { durationMin: 10 });
	p.leg(benf, gai, "walk", { kind: "walk" }, { durationMin: 5 });

	// ---- F4-c: Thu 7 Oct, Fuji Excursion 7 ------------------------------------
	const d5 = "2027-10-07";
	p.day(d5).startTime = "07:30";
	const bf5 = p.findItem(d5, "Breakfast");
	const bags = p.findItem(d5, "Drop bags at ryokan");
	p.leg(
		bf5,
		bags,
		"transit",
		{
			kind: "transit",
			route: {
				id: "qa-fuji-excursion-7",
				source: "manual",
				durationMin: 136,
				walkMin: 10,
				transfers: 0,
				segments: [
					walk(10, "Shinjuku Station platform"),
					{
						mode: "rail",
						lineName: "Fuji Excursion",
						lineShort: "Fuji Excursion 7",
						agency: "JR East / Fuji Kyuko",
						from: { name: "Shinjuku", lat: 35.6896, lng: 139.7006 },
						to: { name: "Kawaguchiko", lat: 35.4983, lng: 138.7689 },
						departAt: "2027-10-07T08:30:00+09:00",
						arriveAt: "2027-10-07T10:26:00+09:00",
						durationMin: 116,
					},
					// The builder's code (route-view's "Taxi" chip), not a label.
					{ mode: "other", vehicleType: "TAXI", durationMin: 10 },
				],
				label: "Fuji Excursion 7",
			},
			chosenId: "qa-fuji-excursion-7",
			fixed: {
				departLocal: "2027-10-07T08:30",
				arriveLocal: "2027-10-07T10:26",
				fromTz: "Asia/Tokyo",
				toTz: "Asia/Tokyo",
				accessMin: 10,
				egressMin: 10,
			},
			booking: {
				ref: "E7K2Q9",
				trainNumber: "Fuji Excursion 7",
				car: "3",
				seats: seatsFor("5A", "5B"),
			},
		},
		{ assignees: both },
	);

	// ---- F4-d: Vietnam overnight trains (Asia/Ho_Chi_Minh) ---------------------
	const sapa = p.node("Vietnam › Sa Pa");
	const hn1 = p.item("2027-10-26", {
		nodeId: hanoiStation.id,
		title: "Board SP3",
		durationMin: 0,
		assignees: both,
	});
	const lc1 = p.item("2027-10-27", {
		nodeId: laoCai.id,
		title: "Lào Cai Station",
		durationMin: 0,
		assignees: both,
	});
	const sapaBf = p.item("2027-10-27", {
		nodeId: sapa.id,
		title: "Breakfast in Sa Pa",
		durationMin: 45,
		assignees: both,
	});
	const lc2 = p.item("2027-10-28", {
		nodeId: laoCai.id,
		title: "Board SP4",
		durationMin: 0,
		assignees: both,
	});
	const hn2 = p.item("2027-10-29", {
		nodeId: hanoiStation.id,
		title: null,
		durationMin: 0,
		assignees: both,
	});
	const vnTrain = (
		n: string,
		dep: string,
		arr: string,
		extra: {
			car?: string;
			seats?: { memberId: string; seat: string }[];
			ref?: string;
			cls?: string;
		},
	): LegDetails => ({
		kind: "transit",
		route: {
			id: `qa-${n.toLowerCase()}`,
			source: "manual",
			durationMin: Math.round(
				(Date.parse(`${arr}:00+07:00`) - Date.parse(`${dep}:00+07:00`)) / 60000,
			),
			walkMin: 0,
			transfers: 0,
			segments: [],
			label: n,
		},
		chosenId: `qa-${n.toLowerCase()}`,
		fixed: {
			departLocal: dep,
			arriveLocal: arr,
			fromTz: "Asia/Ho_Chi_Minh",
			toTz: "Asia/Ho_Chi_Minh",
			accessMin: 10,
			egressMin: 0,
		},
		booking: {
			trainNumber: n,
			...(extra.cls ? { class: extra.cls } : {}),
			...(extra.car ? { car: extra.car } : {}),
			...(extra.ref ? { ref: extra.ref } : {}),
			seats: extra.seats ?? [],
		},
	});
	p.leg(
		hn1,
		lc1,
		"transit",
		vnTrain("SP3", "2027-10-26T21:35", "2027-10-27T05:30", {
			cls: "Soft sleeper",
			car: "6",
			seats: seatsFor("1", "2"),
			ref: "VNR-26X8",
		}),
		{ assignees: both },
	);
	p.leg(
		lc1,
		sapaBf,
		"other",
		{ kind: "other", otherKind: "bus", label: "Bus to Sa Pa" },
		{ durationMin: 60 },
	);
	p.leg(
		lc2,
		hn2,
		"transit",
		vnTrain("SP4", "2027-10-28T21:10", "2027-10-29T05:15", {}),
		{ assignees: both },
	);

	// ---- F4-e: VN 576 HAN → TPE (Sun 31 Oct) -------------------------------
	const hanItem = p.item("2027-10-31", {
		nodeId: han.id,
		title: null,
		durationMin: 0,
		assignees: both,
	});
	const tpeItem = p.item("2027-10-31", {
		nodeId: tpe.id,
		title: null,
		durationMin: 0,
		assignees: both,
	});
	p.leg(
		hanItem,
		tpeItem,
		"flight",
		flight({
			airline: { iata: "VN", name: "Vietnam Airlines" },
			flightNumber: "VN576",
			from: p.airportRef("HAN"),
			to: p.airportRef("TPE"),
			depLocal: "2027-10-31T14:25",
			arrLocal: "2027-10-31T18:00",
			cabin: "economy",
		}),
		{ assignees: both },
	);

	// ---- F4-f: TK 25 + TK 11 via IST (Thu 4 → Fri 5 Nov) ------------------
	const tpe2 = p.item("2027-11-04", {
		nodeId: tpe.id,
		title: null,
		durationMin: 0,
		assignees: both,
	});
	const istItem = p.item("2027-11-05", {
		nodeId: ist.id,
		title: "Layover",
		durationMin: 0,
		assignees: both,
	});
	const ewrItem = p.item("2027-11-05", {
		nodeId: ewr.id,
		title: null,
		durationMin: 0,
		assignees: both,
	});
	const tk25 = p.leg(
		tpe2,
		istItem,
		"flight",
		flight({
			airline: { iata: "TK", name: "Turkish Airlines" },
			flightNumber: "TK25",
			from: p.airportRef("TPE"),
			to: p.airportRef("IST"),
			depLocal: "2027-11-04T23:25",
			arrLocal: "2027-11-05T07:35",
			cabin: "business",
		}),
		{ assignees: both },
	);
	const tk11 = p.leg(
		istItem,
		ewrItem,
		"flight",
		flight({
			airline: { iata: "TK", name: "Turkish Airlines" },
			flightNumber: "TK11",
			from: p.airportRef("IST"),
			to: p.airportRef("EWR"),
			depLocal: "2027-11-05T09:55",
			arrLocal: "2027-11-05T13:40",
			cabin: "business",
		}),
		{ assignees: both },
	);
	const connect = (
		leg: PlanLeg,
		c: { prevLegId?: string; nextLegId?: string },
	) => {
		if (leg.details.kind === "flight")
			leg.details = {
				...leg.details,
				flight: { ...leg.details.flight, connection: c },
			};
	};
	connect(tk25, { nextLegId: tk11.id });
	connect(tk11, { prevLegId: tk25.id });
	// SPEC §7.9: a layover lasts from the inbound arrival to the outbound
	// departure (IST 07:35 → 09:55 = 2h 20m), as `createFlightWithAirports`
	// writes it (QA TZ-06).
	if (tk25.arrAt && tk11.depAt)
		istItem.durationMin = Math.max(
			0,
			Math.round((Date.parse(tk11.depAt) - Date.parse(tk25.arrAt)) / 60_000),
		);

	// ---- the other inter-country flights (times invented) --------------------
	const kixItem = p.item("2027-10-14", {
		nodeId: kix.id,
		title: null,
		durationMin: 0,
		assignees: both,
	});
	const icnItem = p.item("2027-10-14", {
		nodeId: icn.id,
		title: null,
		durationMin: 0,
		assignees: both,
	});
	p.leg(
		kixItem,
		icnItem,
		"flight",
		flight({
			airline: { iata: "KE", name: "Korean Air" },
			flightNumber: "KE724",
			from: p.airportRef("KIX"),
			to: p.airportRef("ICN"),
			depLocal: "2027-10-14T13:05",
			arrLocal: "2027-10-14T15:00",
			cabin: "economy",
		}),
		{ assignees: both },
	);
	const pusItem = p.item("2027-10-19", {
		nodeId: pus.id,
		title: null,
		durationMin: 0,
		assignees: both,
	});
	const sgnItem = p.item("2027-10-19", {
		nodeId: sgn.id,
		title: null,
		durationMin: 0,
		assignees: both,
	});
	p.leg(
		pusItem,
		sgnItem,
		"flight",
		flight({
			airline: { iata: "VJ", name: "VietJet Air" },
			flightNumber: "VJ981",
			from: p.airportRef("PUS"),
			to: p.airportRef("SGN"),
			depLocal: "2027-10-19T13:10",
			arrLocal: "2027-10-19T16:25",
			cabin: "economy",
		}),
		{ assignees: both },
	);

	// Positions for every day a fixture touched (new items go last, in insertion order).
	for (const d of plan.days) {
		const dayItems = plan.items.filter((i) => i.dayId === d.id);
		if (!dayItems.some((i) => !i.position)) continue;
		let prev =
			dayItems
				.map((i) => i.position)
				.filter(Boolean)
				.sort()
				.at(-1) ?? null;
		for (const it of dayItems)
			if (!it.position) {
				it.position = generateKeyBetween(prev, null);
				prev = it.position;
			}
	}
	plan.report.notes.push(
		"QA fixtures (qa/SCENARIOS §1 F3/F4) applied on top of the import.",
	);
}

// ---------------------------------------------------------------------------
// EXTENSIONS §2.1: money and suggestions on top of the fixtures
// ---------------------------------------------------------------------------

/** ¥ → USD cents at the fixture rate (the demo's 1/150). */
const JPY_USD = 1 / 150;
const usdCents = (yen: number) => Math.round(yen * JPY_USD * 100);

export type QaMoneyRows = {
	expenses: (typeof expenses.$inferInsert)[];
	payments: (typeof expensePayments.$inferInsert)[];
	payers: (typeof expensePaymentPayers.$inferInsert)[];
	shares: (typeof expenseShares.$inferInsert)[];
};

/**
 * Three expenses (one private), home currency USD: the Kawaguchiko Ryokan
 * (¥60,000, Audrey paid a ¥10,000 deposit: partial, split equally), the
 * Fuji Excursion 7 seats (¥8,260 planned, on the leg) and Dennis's private
 * fountain pen at Itoya (¥18,000 planned, no split). Amounts and rates are
 * fixture values.
 */
export function qaMoney(
	plan: ImportPlan,
	o: { createdBy: string; newId?: () => string },
): QaMoneyRows {
	const newId = o.newId ?? uuidv7;
	const tripId = plan.trip.id;
	const member = (k: MemberKey) =>
		(plan.members.find((m) => m.key === k) as { id: string }).id;
	const dennis = member("owner");
	const audrey = member("audrey");
	const named = (name: string) => {
		const n = plan.nodes.find((x) => normName(x.name) === normName(name));
		if (!n) throw new Error(`QA money: no node "${name}"`);
		return n.id;
	};
	const fujiLeg = plan.legs.find(
		(l) => l.details.kind === "transit" && l.details.booking?.ref === "E7K2Q9",
	);
	if (!fujiLeg) throw new Error("QA money: no Fuji Excursion 7 leg");
	const fx = (yen: number, fxDate: string) => ({
		homeCurrency: "USD",
		homeAmountMinor: usdCents(yen),
		fxRate: JPY_USD,
		fxDate,
		fxSource: "currency-api",
		fxManual: false,
	});
	const base = {
		tripId,
		currency: "JPY",
		splitMode: "equal" as const,
		createdBy: o.createdBy,
	};
	const ryokan = newId();
	const seats = newId();
	const pen = newId();
	const deposit = newId();
	return {
		expenses: [
			{
				...base,
				id: ryokan,
				nodeId: named("Kawaguchiko Ryokan"),
				title: "Kawaguchiko Ryokan",
				category: "lodging",
				amountMinor: 60_000,
				...fx(60_000, "2026-09-22"),
				expectedOn: "2027-10-07",
				note: "Fuji-view room with a private onsen. The rest is due at check-in.",
			},
			{
				...base,
				id: seats,
				legId: fujiLeg.id,
				title: "Fuji Excursion 7 seats",
				category: "transport",
				amountMinor: 8_260,
				...fx(8_260, "2026-09-22"),
				expectedOn: "2027-09-07",
				note: "2 × ¥4,130 reserved seats, Shinjuku → Kawaguchiko.",
			},
			{
				...base,
				id: pen,
				nodeId: named("Itoya (G.Itoya)"),
				title: "Fountain pen (gift)",
				category: "shopping",
				amountMinor: 18_000,
				...fx(18_000, "2026-09-22"),
				isPrivate: true,
				note: "A surprise for Audrey.",
			},
		],
		payments: [
			{
				id: deposit,
				tripId,
				expenseId: ryokan,
				paidAt: new Date("2026-09-15T20:00:00-04:00"),
				paidTz: "America/New_York",
				currency: "JPY",
				amountMinor: 10_000,
				...fx(10_000, "2026-09-15"),
				method: "card",
				createdBy: o.createdBy,
			},
		],
		payers: [
			{ tripId, paymentId: deposit, memberId: audrey, amountMinor: 10_000 },
		],
		shares: [ryokan, seats].flatMap((expenseId) =>
			[dennis, audrey].map((memberId) => ({ tripId, expenseId, memberId })),
		),
	};
}

export type QaProposal = {
	op: "node.create" | "item.update";
	input: Record<string, unknown>;
	message: string;
	/** What the review UI should say (for the seed's report and tests). */
	about: string;
};

/**
 * Maya's two open suggestions, proposed through the real gate by
 * `scripts/seed-qa.ts`: a new Kyoto idea and a shorter Akihabara visit (an
 * Unscheduled backup item, so no day total or count the QA scenarios assert
 * changes).
 */
export function qaProposals(
	plan: ImportPlan,
	newId: () => string = uuidv7,
): QaProposal[] {
	const higashiyama = plan.nodes.find(
		(n) => n.type === "area" && normName(n.name) === "higashiyama",
	);
	if (!higashiyama) throw new Error("QA proposals: no Higashiyama area");
	const akihabara = plan.items.find(
		(i) =>
			i.dayId === null &&
			normName(plan.nodes.find((n) => n.id === i.nodeId)?.name ?? "") ===
				"akihabara",
	);
	if (!akihabara) throw new Error("QA proposals: no Akihabara backup item");
	return [
		{
			op: "node.create",
			input: {
				tripId: plan.trip.id,
				id: newId(),
				parentId: higashiyama.id,
				type: "place",
				category: "temple_shrine",
				name: "Tōfuku-ji",
				description:
					"Zen temple known for its maples seen from the Tsūten-kyō bridge",
				lat: 34.9767,
				lng: 135.7738,
			},
			message: "Early for the leaves, but the gardens are worth it.",
			about: "Tōfuku-ji under Kyoto › Higashiyama",
		},
		{
			op: "item.update",
			input: { itemId: akihabara.id, patch: { durationMin: 180 } },
			message: "3 h is plenty for Akihabara.",
			about: "Akihabara 4h → 3h",
		},
	];
}

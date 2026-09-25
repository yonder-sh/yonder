/**
 * COLLAB-R2-07: ProposalOverview's before → after for the nested `details.*`
 * fields. Hours and flight suggestions used to read "OpeningHours — → —" and
 * "Flight — —": the server's snapshot holds columns (so `before` came back
 * null) and the payload keeps the value under `hours` / `flight`.
 */
import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import type { TripGraph } from "@/lib/engine/types";
import { demo, demoGraph, N, scenario } from "@/lib/fixtures/demo";
import type { LegDetails } from "@/lib/schemas/legs";
import type { Json, ProposalDto } from "@/lib/schemas/proposals";
import { fieldRows } from "../proposal-view";

const flightSave = scenario.proposals.find(
	(p) => p.op === "flight.save",
) as ProposalDto;
const flightLeg = demoGraph.legs.find((l) => l.id === demo.L.flight);
if (flightLeg?.details.kind !== "flight") throw new Error("no demo flight");
const storedFlight = (
	flightLeg.details as Extract<LegDetails, { kind: "flight" }>
).flight;

const rowsOf = (p: ProposalDto, g: TripGraph = demoGraph) =>
	fieldRows(p, indexGraph(g)).map((r) => [r.label, r.before, r.after]);

/** Maya's `setOpeningHours` for a place, as the server hands it out. */
function hoursProposal(
	hours: Json,
	over: Partial<ProposalDto> = {},
): ProposalDto {
	return {
		...flightSave,
		id: "00000000-0000-7000-8000-00000000a001",
		op: "node.hours",
		entityKind: "node",
		entityId: N.itoya ?? null,
		summary: "updated hours of Itoya Ginza",
		fields: ["details.openingHours"],
		// The snapshot can't read a nested field: it comes back null.
		before: { "details.openingHours": null },
		payload: { nodeId: N.itoya ?? "", hours },
		...over,
	};
}

const benfiddich = {
	source: "manual",
	periods: [1, 2, 3, 4, 5, 6].map((day) => ({
		day,
		open: "19:00",
		close: "02:00",
	})),
	closedDays: [0],
	exceptions: [{ date: "2027-10-05", closed: true, label: "Private event" }],
	updatedAt: "2026-09-23T09:00:00.000Z",
} satisfies Json;

function withNodeHours(hours: unknown): TripGraph {
	return {
		...demoGraph,
		nodes: demoGraph.nodes.map((n) =>
			n.id === N.itoya
				? { ...n, details: { ...n.details, openingHours: hours } }
				: n,
		),
	} as TripGraph;
}

function withFlight(patch: Record<string, unknown>): TripGraph {
	return {
		...demoGraph,
		legs: demoGraph.legs.map((l) =>
			l.id === demo.L.flight
				? {
						...l,
						details: {
							kind: "flight",
							flight: { ...storedFlight, ...patch },
						},
					}
				: l,
		),
	} as TripGraph;
}

describe("fieldRows for opening hours (node.hours)", () => {
	it("reads the week and the special dates, never '— → —'", () => {
		expect(rowsOf(hoursProposal(benfiddich))).toEqual([
			["Opening hours", "No hours", "Mon–Sat 19:00–02:00 · Closed Sun"],
			["Special dates", "None", "Tue 5 Oct closed (Private event)"],
		]);
	});

	it("before is the place's hours now: only what differs gets a row", () => {
		const g = withNodeHours({
			...benfiddich,
			periods: benfiddich.periods.map((p) => ({ ...p, close: "01:00" })),
			exceptions: [],
		});
		expect(rowsOf(hoursProposal(benfiddich), g)).toEqual([
			[
				"Opening hours",
				"Mon–Sat 19:00–01:00 · Closed Sun",
				"Mon–Sat 19:00–02:00 · Closed Sun",
			],
			["Special dates", "None", "Tue 5 Oct closed (Private event)"],
		]);
		// Same week, new closure: the week stays as context (no strike-through).
		const same = withNodeHours({ ...benfiddich, exceptions: [] });
		const rows = fieldRows(hoursProposal(benfiddich), indexGraph(same));
		expect(rows[0]).toMatchObject({
			label: "Opening hours",
			before: null,
			after: "Mon–Sat 19:00–02:00 · Closed Sun",
		});
		expect(rows[1]?.after).toBe("Tue 5 Oct closed (Private event)");
	});

	it("removing hours, rules and a closed proposal (after-only)", () => {
		const g = withNodeHours(benfiddich);
		expect(rowsOf(hoursProposal(null), g)).toEqual([
			["Opening hours", "Mon–Sat 19:00–02:00 · Closed Sun", "No hours"],
		]);
		const rules = {
			...benfiddich,
			lastEntryBeforeCloseMin: 30,
			exceptions: [],
		};
		expect(rowsOf(hoursProposal(rules), g)).toContainEqual([
			"Rules",
			"None",
			"Last entry 30 min before close",
		]);
		// Accepted: today's hours are the result, not a "before".
		expect(
			rowsOf(hoursProposal(benfiddich, { status: "accepted" }), g),
		).toEqual([
			["Opening hours", null, "Mon–Sat 19:00–02:00 · Closed Sun"],
			["Special dates", null, "Tue 5 Oct closed (Private event)"],
		]);
	});
});

describe("fieldRows for holiday closures (OSM `PH off`)", () => {
	it("names a holiday closure on the week's line", () => {
		const g = withNodeHours({ ...benfiddich, exceptions: [] });
		expect(
			rowsOf(
				hoursProposal({
					...benfiddich,
					exceptions: [],
					closedOnHolidays: true,
				}),
				g,
			),
		).toEqual([
			[
				"Opening hours",
				"Mon–Sat 19:00–02:00 · Closed Sun",
				"Mon–Sat 19:00–02:00 · Closed Sun · Closed on holidays",
			],
		]);
	});
});

describe("fieldRows for a flight (flight.save)", () => {
	const save = (flight: Record<string, unknown>): ProposalDto => ({
		...flightSave,
		before: { "details.flight": null },
		payload: {
			target: {
				kind: "pair",
				fromItemId: flightLeg?.fromItemId ?? "",
				toItemId: flightLeg?.toItemId ?? "",
			},
			flight: { ...storedFlight, ...flight } as unknown as Json,
		},
	});

	it("one row per changed detail: 'Aircraft: Boeing 777-300ER → Airbus A380'", () => {
		const g = withFlight({ aircraft: "Boeing 777-300ER" });
		expect(fieldRows(save({ aircraft: "Airbus A380" }), indexGraph(g))).toEqual(
			[
				{
					field: "details.flight.aircraft",
					label: "Aircraft",
					before: "Boeing 777-300ER",
					after: "Airbus A380",
				},
			],
		);
	});

	it("times, number, cabin and seats read as people read them", () => {
		const rows = rowsOf(
			save({
				flightNumber: "KE722",
				depLocal: "2027-10-07T14:05",
				cabin: "premium_economy",
				seats: [{ memberId: demoGraph.me.memberId, seat: "32A" }],
			}),
		);
		expect(rows).toEqual([
			["Flight", "KE 724", "KE 722"],
			["Departs", "Thu 7 Oct 13:05", "Thu 7 Oct 14:05"],
			["Cabin", "—", "Premium economy"],
			["Seats", "—", expect.stringMatching(/^32A \S/)],
		]);
	});

	it("an unchanged save names the flight; a new flight lists what it sets", () => {
		expect(rowsOf(save({}))).toEqual([
			["Flight", null, "KE 724 · KIX→ICN · Thu 7 Oct 13:05"],
		]);
		// The form's input vs the server's normalised flight: not a change.
		const raw = save({
			flightNumber: "ke 0724",
			from: { ...storedFlight.from, name: "Kansai International" },
		});
		expect(rowsOf(raw)).toEqual([
			["Flight", null, "KE 724 · KIX→ICN · Thu 7 Oct 13:05"],
		]);
		expect(
			rowsOf(save({ from: { ...storedFlight.from, terminal: "1" } })),
		).toEqual([["From", "KIX", "KIX · T1"]]);
		const noFlight = {
			...demoGraph,
			legs: demoGraph.legs.map((l) =>
				l.id === demo.L.flight ? { ...l, details: { kind: "none" } } : l,
			),
		} as TripGraph;
		const rows = rowsOf(save({ aircraft: "Airbus A380" }), noFlight);
		expect(rows).toContainEqual(["Flight", null, "KE 724"]);
		expect(rows).toContainEqual(["Aircraft", null, "Airbus A380"]);
		expect(rows.every(([, before]) => before === null)).toBe(true);
	});
});

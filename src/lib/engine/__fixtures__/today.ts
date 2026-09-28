/**
 * Today's day on boards P15 and P18 (One Yonder phase 5): Tue 5 Oct in
 * Shinjuku and Nakano, with ideas nearby; and the same day as the imported
 * Asia 2027 trip has it (`importedDay`). Behind the engine's Today tests and
 * the Today screen's (`scenario` over the demo tree).
 */
import { DEMO_MEMBERS, type LocalAt, type Scenario, scenario } from "./demo";
import type { GraphNode } from "../types";

export type Hours = NonNullable<GraphNode["details"]["openingHours"]>;
export const daily = (open: string, close: string): Hours => ({
	source: "manual",
	periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open, close })),
	updatedAt: "2026-09-01T00:00:00.000Z",
});

/** Shinjuku and Nakano: the day on boards P15 and P18. */
export const NODES = [
	{
		key: "shinjuku",
		parent: "tokyo",
		type: "area" as const,
		name: "Shinjuku",
		at: [35.6938, 139.7034] as [number, number],
	},
	{
		key: "gracery",
		parent: "shinjuku",
		type: "place" as const,
		category: "lodging" as const,
		name: "Hotel Gracery",
		at: [35.6955, 139.702] as [number, number],
	},
	{
		key: "cha",
		parent: "shinjuku",
		type: "place" as const,
		category: "cafe" as const,
		name: "Cha no Ikedaya",
		at: [35.6905, 139.7005] as [number, number],
	},
	{
		key: "nakano",
		parent: "tokyo",
		type: "area" as const,
		name: "Nakano",
		at: [35.7074, 139.6638] as [number, number],
	},
	{
		key: "broadway",
		parent: "nakano",
		type: "place" as const,
		category: "shopping" as const,
		name: "Nakano Broadway",
		at: [35.709, 139.6655] as [number, number],
	},
	{
		key: "yodobashi",
		parent: "shinjuku",
		type: "place" as const,
		category: "shopping" as const,
		name: "Yodobashi Camera",
		at: [35.6905, 139.6975] as [number, number],
	},
	{
		key: "bic",
		parent: "shinjuku",
		type: "place" as const,
		category: "shopping" as const,
		name: "Bic Camera",
		at: [35.6918, 139.7006] as [number, number],
	},
	{
		key: "benfiddich",
		parent: "shinjuku",
		type: "place" as const,
		category: "bar" as const,
		name: "Bar Benfiddich",
		at: [35.6912, 139.6978] as [number, number],
	},
	{
		key: "gai",
		parent: "shinjuku",
		type: "place" as const,
		category: "nightlife" as const,
		name: "Golden Gai",
		at: [35.694, 139.7045] as [number, number],
	},
	// Ideas near Bic Camera.
	{
		key: "omoide",
		parent: "shinjuku",
		type: "place" as const,
		category: "restaurant" as const,
		name: "Omoide Yokocho",
		at: [35.6935, 139.6975] as [number, number],
	},
	{
		key: "donki",
		parent: "shinjuku",
		type: "place" as const,
		category: "shopping" as const,
		name: "Don Quijote",
		at: [35.6935, 139.7025] as [number, number],
	},
	{
		key: "ramen",
		parent: "shinjuku",
		type: "place" as const,
		category: "restaurant" as const,
		name: "Fuunji",
		at: [35.6925, 139.7] as [number, number],
	},
	{
		key: "karaoke",
		parent: "shinjuku",
		type: "place" as const,
		category: "activity" as const,
		name: "Karaoke Kan",
		at: [35.692, 139.7015] as [number, number],
	},
	{
		key: "museum",
		parent: "shinjuku",
		type: "place" as const,
		category: "museum" as const,
		name: "Samurai Museum",
		at: [35.6925, 139.701] as [number, number],
	},
	{
		key: "sunroute",
		parent: "shinjuku",
		type: "place" as const,
		category: "lodging" as const,
		name: "Hotel Sunroute",
		at: [35.692, 139.7] as [number, number],
	},
	{
		key: "notGoing",
		parent: "shinjuku",
		type: "place" as const,
		category: "bar" as const,
		name: "Bar Not Going",
		at: [35.6919, 139.7004] as [number, number],
		status: "dropped" as const,
	},
];

/**
 * Tue 5 Oct (Day 4 in the boards): Cha no Ikedaya 09:10–09:55, Nakano
 * Broadway 10:15–13:55, Yodobashi 14:05–16:05, Bic Camera 16:10–17:40,
 * Dinner 17:40–19:10 (no place yet: it floats), Bar Benfiddich booked for
 * 20:00 (40 min spare), Golden Gai 21:05–22:35; the night at Hotel Gracery.
 * Wed 6 Oct starts at Meiji Jingu.
 */
export function tokyoDay(marks: Record<string, LocalAt> = {}): Scenario {
	const s = scenario({
		firstDate: "2027-10-04",
		nodes: NODES,
		days: [
			{ k: "d0", night: "gracery", items: [] },
			{
				k: "d1",
				night: "gracery",
				items: [
					{ k: "cha", node: "cha", min: 45, done: marks.cha },
					{ k: "broadway", node: "broadway", min: 220, done: marks.broadway },
					{
						k: "yodobashi",
						node: "yodobashi",
						min: 120,
						done: marks.yodobashi,
					},
					{ k: "bic", node: "bic", min: 90, done: marks.bic },
					{
						k: "dinner",
						title: "Dinner",
						note: "near Shinjuku, or Omoide Yokocho",
						min: 90,
						done: marks.dinner,
					},
					{
						k: "bar",
						node: "benfiddich",
						min: 60,
						pin: "20:00",
						booked: true,
						done: marks.bar,
					},
					{ k: "gai", node: "gai", min: 90, done: marks.gai },
				],
			},
			{
				k: "d2",
				night: "gracery",
				items: [{ k: "meiji", node: "meijiJingu", min: 60 }],
			},
		],
		unscheduled: [{ k: "ramenStop", node: "ramen", min: 45 }],
		legs: [
			{
				stay: { day: "d1", end: "start" },
				anchor: "cha",
				mode: "walk",
				min: 10,
			},
			{ from: "cha", to: "broadway", mode: "transit", min: 20 },
			{ from: "broadway", to: "yodobashi", mode: "transit", min: 10 },
			{ from: "yodobashi", to: "bic", mode: "walk", min: 5 },
			{ from: "bic", to: "bar", mode: "walk", min: 10 },
			{ from: "bar", to: "gai", mode: "walk", min: 5 },
			{ stay: { day: "d1", end: "end" }, anchor: "gai", mode: "walk", min: 8 },
			{
				stay: { day: "d2", end: "start" },
				anchor: "meiji",
				mode: "transit",
				min: 25,
			},
		],
	});
	return withIdeas(s);
}

/**
 * Tue 5 Oct as the imported Asia 2027 trip has it (the lead's screenshots):
 * Breakfast 09:00–09:30 (no place), Cha no Ikedaya 09:30–10:00, Nakano
 * Broadway 10:15–12:45, Lunch 12:45–13:45 (no place), Yodobashi Camera
 * 14:05–16:05, Bic Camera 16:10–17:40, Dinner 17:40–19:10 (no place), Bar
 * Benfiddich at 20:00 (a set start time, not booked), Golden Gai
 * 21:05–22:35. No walk in the morning: Cha no Ikedaya starts as Breakfast
 * ends. The night at Hotel Gracery.
 */
export function importedDay(marks: Record<string, LocalAt> = {}): Scenario {
	const s = scenario({
		firstDate: "2027-10-04",
		nodes: NODES,
		days: [
			{ k: "d0", items: [] },
			{
				k: "d1",
				night: "gracery",
				items: [
					{
						k: "breakfast",
						title: "Breakfast",
						min: 30,
						done: marks.breakfast,
					},
					{ k: "cha", node: "cha", min: 30, done: marks.cha },
					{ k: "broadway", node: "broadway", min: 150, done: marks.broadway },
					{ k: "lunch", title: "Lunch", min: 60, done: marks.lunch },
					{
						k: "yodobashi",
						node: "yodobashi",
						min: 120,
						done: marks.yodobashi,
					},
					{ k: "bic", node: "bic", min: 90, done: marks.bic },
					{ k: "dinner", title: "Dinner", min: 90, done: marks.dinner },
					{
						k: "bar",
						node: "benfiddich",
						min: 60,
						pin: "20:00",
						done: marks.bar,
					},
					{ k: "gai", node: "gai", min: 90, done: marks.gai },
				],
			},
			{
				k: "d2",
				night: "gracery",
				items: [{ k: "meiji", node: "meijiJingu", min: 60 }],
			},
		],
		unscheduled: [{ k: "ramenStop", node: "ramen", min: 45 }],
		legs: [
			{ from: "cha", to: "broadway", mode: "transit", min: 15 },
			{ from: "broadway", to: "yodobashi", mode: "transit", min: 20 },
			{ from: "yodobashi", to: "bic", mode: "walk", min: 5 },
			{ from: "bic", to: "bar", mode: "walk", min: 10 },
			{ from: "bar", to: "gai", mode: "walk", min: 5 },
			{ stay: { day: "d1", end: "end" }, anchor: "gai", mode: "walk", min: 8 },
		],
	});
	return withIdeas(s);
}

/** The ideas nearby: the group's ratings and opening hours. */
function withIdeas(s: Scenario): Scenario {
	const { dennis, audrey } = DEMO_MEMBERS;
	const patch: Record<string, Partial<GraphNode>> = {
		[s.N.omoide as string]: {
			priorities: { [dennis]: "want" },
			details: { openingHours: daily("17:00", "24:00") },
		},
		[s.N.donki as string]: {
			priorities: { [dennis]: "sure_why_not" },
			details: {
				openingHours: {
					...daily("00:00", "24:00"),
					periods: [],
					alwaysOpen: true,
				},
			},
		},
		[s.N.ramen as string]: {
			priorities: { [dennis]: "must", [audrey]: "want" },
			details: { openingHours: daily("11:00", "21:00") },
		},
		[s.N.karaoke as string]: { priorities: { [dennis]: "meh" } },
		[s.N.museum as string]: {
			priorities: { [dennis]: "must" },
			details: { openingHours: daily("10:00", "17:00") },
		},
		[s.N.sunroute as string]: { priorities: { [dennis]: "must" } },
		[s.N.notGoing as string]: { priorities: { [dennis]: "must" } },
	};
	s.graph.nodes = s.graph.nodes.map((n) =>
		patch[n.id] ? { ...n, ...patch[n.id] } : n,
	);
	return s;
}

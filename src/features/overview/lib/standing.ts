/**
 * "Where things stand" (owner, 2026-09-25): the trip's progress as five
 * plain lines, each done or not, the first open one being what's next.
 *
 *   ✓ 48 places added
 *   ○ Rating: Dennis and Audrey are done. You and Maya haven't started.
 *   ○ How long in each city: not decided yet
 *   ○ What to do each day: 8 of 12 favourites have a day
 *   ○ Booking where you stay: 3 nights not booked yet
 *
 * The cities line is done once every night is in a city (`nightPlaces`); the
 * last one once every night has a booked place to stay.
 *
 * Favourites are the shortlist (on a day or not); people are those whose
 * ratings count; places marked decided are left to no one. Pure.
 */
import { decidedIds } from "@/features/places/lib/decided";
import { raters } from "@/features/places/lib/rate";
import { buildRows, openPlaces } from "@/features/places/tab/model";
import {
	nightsWithoutStay,
	unplacedNights,
} from "@/features/shell/still-to-plan";
import { nightPlaces } from "@/lib/engine/day-place";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphMember, ScheduleResult } from "@/lib/engine/types";

export type StandingKey = "places" | "rating" | "cities" | "days" | "stays";

export type RatingPerson = {
	member: GraphMember;
	rated: number;
	left: number;
};

export type StandingLine = {
	key: StandingKey;
	/** "Rating", "Booking where you stay"; null for the places line ("48 places added"). */
	label: string | null;
	/** "Dennis and Audrey are done. Maya has 12 left." */
	detail: string;
	done: boolean;
};

export type Standing = {
	lines: StandingLine[];
	/** The first line not done (what's next), or null when all are. */
	next: StandingKey | null;
	/** Everyone whose ratings count, with what they have left. */
	people: RatingPerson[];
	/** Places you have left to rate (null: you don't rate). */
	myLeft: number | null;
	places: number;
	favourites: number;
	/** Favourites on a day. */
	onDays: number;
	/** Some night is in a city (the route has begun). */
	citiesDecided: boolean;
};

export type StandingInput = {
	ix: GraphIndex;
	schedule: ScheduleResult | null;
	members: readonly GraphMember[];
	/** Your member id. */
	me: string | null;
	/** The shortlist bar (`useShortlistBar`). */
	bar: number;
	liveIds?: ReadonlySet<string>;
};

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/** "You", "You and Maya", "Dennis, Audrey and Sam". */
export function joinNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function firstName(m: GraphMember, me: string | null): string {
	if (m.id === me) return "You";
	return m.firstName ?? m.name.split(/\s+/)[0] ?? m.name;
}

/** You first, then the group's order. */
function youFirst<T extends { member: GraphMember }>(
	xs: readonly T[],
	me: string | null,
): T[] {
	return [...xs].sort(
		(a, b) => Number(b.member.id === me) - Number(a.member.id === me),
	);
}

/**
 * "Dennis and Audrey are done. Maya has 12 left. You haven't started." In
 * that order: done, partway, not started.
 */
export function ratingDetail(
	people: readonly RatingPerson[],
	me: string | null,
	places: number,
): string {
	if (!places) return "nothing to rate yet";
	if (people.every((p) => p.left === 0))
		return people.length === 1 && people[0]?.member.id === me
			? "you're done"
			: "everyone is done";
	const names = (xs: readonly RatingPerson[]) =>
		youFirst(xs, me).map((p) => firstName(p.member, me));
	const out: string[] = [];
	const done = names(people.filter((p) => p.left === 0));
	if (done.length)
		out.push(
			done.length === 1
				? done[0] === "You"
					? "You're done."
					: `${done[0]} is done.`
				: `${joinNames(done)} are done.`,
		);
	const partway = youFirst(
		people.filter((p) => p.left > 0 && p.rated > 0),
		me,
	);
	if (partway.length) {
		const [first, ...rest] = partway;
		const lead =
			first?.member.id === me
				? "You have"
				: `${firstName(first?.member as GraphMember, me)} has`;
		out.push(
			`${lead} ${first?.left} left${rest.map((p) => `, ${firstName(p.member, me)} ${p.left}`).join("")}.`,
		);
	}
	const none = names(people.filter((p) => p.rated === 0 && p.left > 0));
	if (none.length)
		out.push(
			none.length === 1 && none[0] !== "You"
				? `${none[0]} hasn't started.`
				: `${joinNames(none)} haven't started.`,
		);
	return out.join(" ");
}

/** "Tokyo 3 nights · Kyoto 3 · Osaka 2": the nights in each city, in trip order (three, then "…"). */
export function citiesDetail(
	nights: readonly (string | null)[],
	nameOf: (cityId: string) => string,
): string {
	const on = new Map<string, number>();
	for (const id of nights) if (id) on.set(id, (on.get(id) ?? 0) + 1);
	const parts = [...on]
		.slice(0, 3)
		.map(([id, n], i) =>
			i === 0 ? `${nameOf(id)} ${plural(n, "night")}` : `${nameOf(id)} ${n}`,
		);
	return on.size > 3 ? `${parts.join(" · ")} · …` : parts.join(" · ");
}

export function whereThingsStand(input: StandingInput): Standing {
	const { ix, me } = input;
	const places = openPlaces(ix, input.liveIds);
	const counted = raters(input.members, places);
	// Places marked decided ask no one: nobody has them left.
	const decided = decidedIds(ix, places);
	const people: RatingPerson[] = counted.map((m) => {
		const rated = places.filter((n) => n.priorities[m.id] != null).length;
		const left = places.filter(
			(n) => n.priorities[m.id] == null && !decided.has(n.id),
		).length;
		return { member: m, rated, left };
	});
	const mine = people.find((p) => p.member.id === me);
	const rows = buildRows(ix, places, {
		memberIds: counted.map((m) => m.id),
		threshold: input.bar,
	});
	const favourites = rows.filter(
		(r) => r.status === "shortlist" || r.status === "scheduled",
	).length;
	const onDays = rows.filter((r) => r.status === "scheduled").length;
	const hasDays = ix.days.length > 0;
	// Each day's night, as its place (null: none yet).
	const nightCities = nightPlaces(ix);
	const citiesDecided = nightCities.some((c) => c !== null);
	const unplaced = unplacedNights(ix);
	const nights = hasDays ? nightsWithoutStay(ix).length : 0;

	const lines: StandingLine[] = [
		{
			key: "places",
			label: null,
			detail: places.length
				? `${plural(places.length, "place")} added`
				: "No places added yet",
			done: places.length > 0,
		},
	];
	if (people.length)
		lines.push({
			key: "rating",
			label: "Rating",
			detail: ratingDetail(people, me, places.length),
			done: places.length > 0 && people.every((p) => p.left === 0),
		});
	lines.push({
		key: "cities",
		label: "How long in each city",
		// No dates needed: the nights and the day you arrive make them.
		detail: citiesDecided
			? `${citiesDetail(nightCities, (id) => ix.node(id)?.name ?? "")}${unplaced ? ` · ${plural(unplaced, "night")} in no city yet` : ""}`
			: "not decided yet",
		done: citiesDecided && unplaced === 0,
	});
	lines.push({
		key: "days",
		label: "What to do each day",
		detail: !hasDays
			? "Pick your dates first"
			: !favourites
				? "no favourites yet"
				: onDays === favourites
					? favourites === 1
						? "1 favourite has a day"
						: `all ${favourites} favourites have a day`
					: `${onDays} of ${plural(favourites, "favourite")} ${favourites === 1 ? "has" : "have"} a day`,
		done: hasDays && favourites > 0 && onDays === favourites,
	});
	lines.push({
		key: "stays",
		label: "Booking where you stay",
		detail: !hasDays
			? "Pick your dates first"
			: nights
				? `${plural(nights, "night")} not booked yet`
				: "every night is booked",
		done: hasDays && nights === 0,
	});
	return {
		lines,
		next: lines.find((l) => !l.done)?.key ?? null,
		people,
		myLeft: mine ? mine.left : null,
		places: places.length,
		favourites,
		onDays,
		citiesDecided,
	};
}

/**
 * "Where things stand" (owner, 2026-09-25): the trip's progress as five
 * plain lines, each done or not, the first open one being what's next.
 *
 *   ✓ 48 places added
 *   ○ Rating: Dennis and Audrey are done. You and Maya haven't started.
 *   ○ How long in each city: not decided yet
 *   ○ What to do each day: 8 of 12 favourites have a day
 *   ○ Hotels: 3 nights still need one
 *
 * Favourites are the shortlist (on a day or not); people are those whose
 * ratings count. Pure.
 */
import { cityDayTable, cityRowNodes } from "@/features/places/lib/days";
import { raters } from "@/features/places/lib/rate";
import { buildRows, openPlaces } from "@/features/places/tab/model";
import { nightsWithoutStay } from "@/features/shell/still-to-plan";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphMember, ScheduleResult } from "@/lib/engine/types";

export type StandingKey = "places" | "rating" | "cities" | "days" | "hotels";

export type RatingPerson = {
	member: GraphMember;
	rated: number;
	left: number;
};

export type StandingLine = {
	key: StandingKey;
	/** "Rating", "Hotels"; null for the places line ("48 places added"). */
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
	/** City days are set on the plan. */
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

/** "Tokyo 4 days · Kyoto 3 · Osaka 2", in trip order (at most three, then "…"). */
export function citiesDetail(
	rows: readonly { name: string; dayIds: readonly string[] }[],
	dayIndex: (dayId: string) => number,
): string {
	const on = rows
		.filter((r) => r.dayIds.length)
		.map((r) => ({
			name: r.name,
			days: r.dayIds.length,
			first: Math.min(...r.dayIds.map(dayIndex)),
		}))
		.sort((a, b) => a.first - b.first);
	const parts = on
		.slice(0, 3)
		.map((c, i) =>
			i === 0 ? `${c.name} ${plural(c.days, "day")}` : `${c.name} ${c.days}`,
		);
	return on.length > 3 ? `${parts.join(" · ")} · …` : parts.join(" · ");
}

export function whereThingsStand(input: StandingInput): Standing {
	const { ix, me } = input;
	const places = openPlaces(ix, input.liveIds);
	const counted = raters(input.members, places);
	const people: RatingPerson[] = counted.map((m) => {
		const rated = places.filter((n) => n.priorities[m.id] != null).length;
		return { member: m, rated, left: places.length - rated };
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
	const cityRows = cityRowNodes(ix, null);
	const citiesDecided = ix.days.some(
		(d) =>
			!!d.nightNodeId && cityRows.some((r) => ix.isWithin(d.nightNodeId, r.id)),
	);
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
		detail: !hasDays
			? "Pick your dates first"
			: citiesDecided
				? citiesDetail(cityDayTable(ix, input.schedule, null).rows, (id) =>
						ix.dayNumber(id),
					)
				: "not decided yet",
		done: citiesDecided,
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
		key: "hotels",
		label: "Hotels",
		detail: !hasDays
			? "Pick your dates first"
			: nights
				? `${plural(nights, "night")} still ${nights === 1 ? "needs" : "need"} one`
				: "every night has one",
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

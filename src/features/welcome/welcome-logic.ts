/**
 * The welcome's words and its one button (owner, 2026-09-25). Pure.
 *
 * The button, by where the trip is and what you can do:
 * - places you haven't rated → "Rate 48 places";
 * - nothing to rate yet and you can edit → "Add a place you want to go";
 * - otherwise (the days are decided, you only view, …) → "See the plan".
 */
import type { GraphMember } from "@/lib/engine/types";
import { formatDayDate } from "@/lib/format";

export type WelcomeAction =
	| { kind: "rate"; label: string }
	| { kind: "add"; label: string }
	| { kind: "plan"; label: string };

export function primaryAction(p: {
	/** You may rate (a member with the rate capability). */
	canRate: boolean;
	/** Places you have left to rate. */
	myLeft: number | null;
	/** You can add places (edit or suggest). */
	canEdit: boolean;
	/** Places on the trip. */
	places: number;
}): WelcomeAction {
	if (p.canRate && p.myLeft)
		return {
			kind: "rate",
			label: `Rate ${p.myLeft} ${p.myLeft === 1 ? "place" : "places"}`,
		};
	if (!p.places && p.canEdit)
		return { kind: "add", label: "Add a place you want to go" };
	return { kind: "plan", label: "See the plan" };
}

/** "Fri 2 – Thu 15 Oct", "Thu 30 Sep – Wed 6 Oct", or "No dates yet". */
export function datesLine(first: string | null, last: string | null): string {
	if (!first || !last) return "No dates yet";
	const a = formatDayDate(first);
	if (first === last) return a;
	const b = formatDayDate(last);
	return first.slice(0, 7) === last.slice(0, 7)
		? `${a.replace(/ \S+$/, "")} – ${b}`
		: `${a} – ${b}`;
}

const firstOf = (m: GraphMember) =>
	m.firstName ?? m.name.split(/\s+/)[0] ?? m.name;

/**
 * "Maya invited you · with Dennis, Audrey", "You're joining through the trip
 * link · with Dennis", "With Dennis and Audrey"; null when nobody else is in.
 */
export function whoLine(p: {
	members: readonly GraphMember[];
	me: string | null;
	meUserId: string;
	via: "invite" | "link" | null;
	invitedBy: string | null;
	inviterUserId?: string | null;
}): string | null {
	const others = p.members
		.filter(
			(m) =>
				(m.status === "active" || m.status === "placeholder") &&
				!m.mergedIntoId &&
				m.id !== p.me &&
				m.userId !== p.meUserId &&
				(!p.inviterUserId || m.userId !== p.inviterUserId),
		)
		.map(firstOf);
	const shown = others.length > 4 ? others.slice(0, 3) : others;
	const more = others.length - shown.length;
	const names = more
		? `${shown.join(", ")} and ${more} more`
		: shown.length > 1
			? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
			: (shown[0] ?? "");
	const lead =
		p.via === "invite" && p.invitedBy
			? `${p.invitedBy} invited you`
			: p.via === "link"
				? "You're joining through the trip link"
				: null;
	if (!lead) return names ? `With ${names}` : null;
	return names ? `${lead} · with ${names}` : lead;
}

/** What to send the owner: nothing is sent for you (there's no request inbox). */
export function accessRequest(p: {
	owner: string;
	trip: string;
	url: string;
}): string {
	return `Hi ${p.owner}, could you give me edit access to ${p.trip}? ${p.url}`;
}

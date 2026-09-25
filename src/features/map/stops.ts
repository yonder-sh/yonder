/**
 * The map's text alternative (QA A11Y-03, DESIGN §13): the stops in visit
 * order, with the same content as the numbered pins and the edges between
 * them. `StopsList` renders it inside the map region; each stop selects its
 * pin and each leg its edge, like a click on the map. Pure; unit-tested.
 */
import { type GraphIndex, pairKey } from "@/lib/engine/graph-index";
import type {
	ScheduleResult,
	Transition,
	WorkspaceModel,
} from "@/lib/engine/types";
import { formatDayDate, formatLeg, formatTime } from "@/lib/format";
import type { Sel } from "@/lib/workspace/search";

export type StopLeg = {
	/** "Walk · 3m to Shibuya Loft", "Travel to Kiyomizu-dera not set". */
	label: string;
	sel: Sel;
	/** `from>to` item ids: hovering it lights the edge on the map. */
	pairKey: string;
};

export type Stop = {
	/** The visit key (`repId#occurrence`). */
	key: string;
	repId: string;
	/** The number on the pin. */
	number: number;
	name: string;
	/** "21:05", or "Tue 5 Oct 21:05" when the stops span several days. */
	when: string | null;
	/** "Pin 6, Golden Gai, 21:05": the stop's accessible name. */
	label: string;
	/** The way on to the next stop, when the map draws one. */
	next: StopLeg | null;
};

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function legOf(ix: GraphIndex, t: Transition, toName: string): StopLeg {
	const pk = pairKey(t.fromItemId, t.toItemId);
	const pair: Sel = {
		kind: "leg",
		target: { kind: "pair", fromItemId: t.fromItemId, toItemId: t.toItemId },
	};
	if (t.via === "stay") {
		const dayId = ix.item(t.fromItemId)?.dayId;
		return {
			label: `Night at your stay, then to ${toName}`,
			sel: dayId
				? { kind: "leg", target: { kind: "stay", dayId, end: "end" } }
				: pair,
			pairKey: pk,
		};
	}
	if (t.via === "overnight")
		return { label: `Overnight, then to ${toName}`, sel: pair, pairKey: pk };
	return {
		label: t.leg?.mode
			? `${capitalise(formatLeg(t.leg))} to ${toName}`
			: `Travel to ${toName} not set`,
		sel: pair,
		pairKey: pk,
	};
}

export function buildStops(
	model: WorkspaceModel,
	ix: GraphIndex,
	schedule: Pick<ScheduleResult, "items">,
): Stop[] {
	const byKey = new Map(model.visits.map((v) => [v.key, v]));
	const onward = new Map(model.transitions.map((t) => [t.fromVisit, t]));
	const firstAt = (itemIds: readonly string[]) => {
		for (const id of itemIds) {
			const at = schedule.items[id];
			if (at) return { at, dayId: ix.item(id)?.dayId ?? null };
		}
		return null;
	};
	const dates = new Set(
		model.visits.flatMap((v) => v.dayIds.map((d) => ix.day(d)?.date ?? d)),
	);
	const manyDays = dates.size > 1;
	const nameOf = (repId: string) => ix.node(repId)?.name ?? "Untitled place";
	return [...model.visits]
		.sort((a, b) => a.ordinal - b.ordinal)
		.map((v) => {
			const name = nameOf(v.repId);
			const first = firstAt(v.itemIds);
			let when: string | null = null;
			if (first) {
				const time = formatTime(first.at.start, first.at.tz);
				const date = first.dayId ? ix.day(first.dayId)?.date : undefined;
				when = manyDays && date ? `${formatDayDate(date)} ${time}` : time;
			}
			const t = onward.get(v.key);
			const to = t ? byKey.get(t.toVisit) : undefined;
			return {
				key: v.key,
				repId: v.repId,
				number: v.pinNumber,
				name,
				when,
				label: [
					`Pin ${v.pinNumber}`,
					name,
					v.occurrence > 1 ? `visit ${v.occurrence}` : null,
					when,
				]
					.filter(Boolean)
					.join(", "),
				next: t && to ? legOf(ix, t, nameOf(to.repId)) : null,
			};
		});
}

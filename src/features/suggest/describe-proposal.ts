/**
 * `describeProposal(p, ix)` (EXTENSIONS §1.3): the one-line description of a
 * proposal for the ReviewDrawer, ProposalBar and toasts ("Move Itoya to
 * Day 7"). Uses current names when the entity is live, else the summary
 * (turned into the same imperative voice: "moved X" → "Move X").
 *
 * Payloads are the op's input as JSON, redacted for guests; every read is
 * shape-checked and anything unexpected falls back to the server summary.
 */
import { PRIORITIES } from "@/lib/domain/taxonomy";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { formatDuration } from "@/lib/format";
import type { ProposalDto } from "@/lib/schemas/proposals";
import {
	addDays,
	dayLabel,
	entityLive,
	entityName,
	imperative,
	legLabel,
	legOf,
	memberNames,
	nodeName,
	pArr,
	pNum,
	pObj,
	pStr,
	rangeText,
	targetLabel,
} from "./proposal-view";

const MODE_VERB: Record<string, string> = {
	walk: "Walk",
	transit: "Take transit",
	flight: "Fly",
	other: "Travel",
};

function signed(n: number) {
	return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

/**
 * The entity's name BEFORE the suggestion: a rename's snapshot wins (an
 * overlay index already carries the new name), else the current name.
 */
function nameBefore(p: ProposalDto, ix: GraphIndex): string | null {
	const b = p.before;
	if (p.entityKind === "node" && typeof b.name === "string" && b.name)
		return b.name;
	if (p.entityKind === "item" && typeof b.title === "string" && b.title)
		return b.title;
	return entityName(p, ix);
}

function describeLive(p: ProposalDto, ix: GraphIndex): string | null {
	const pay = p.payload;
	const name = nameBefore(p, ix);
	switch (p.op) {
		// ---- places --------------------------------------------------------
		case "node.create": {
			const n = pStr(pay, "name");
			if (!n) return null;
			const parent = nodeName(ix, pStr(pay, "parentId"));
			return parent ? `Add ${n} to ${parent}` : `Add ${n}`;
		}
		case "node.createPath": {
			const chain = pArr(pay, "chain") ?? [];
			const names = chain
				.map((c) =>
					c && typeof c === "object" && !Array.isArray(c)
						? typeof c.name === "string"
							? c.name
							: typeof c.id === "string"
								? nodeName(ix, c.id)
								: null
						: null,
				)
				.filter((x): x is string => !!x);
			return names.length ? `Add ${names.join(" › ")}` : null;
		}
		case "node.update": {
			if (!name) return null;
			const patch = pObj(pay, "patch") ?? {};
			if (typeof patch.name === "string" && patch.name !== name)
				return `Rename ${name} to ${patch.name}`;
			if (patch.status === "dropped" || patch.ideaStatus === "dropped")
				return `Drop ${name}`;
			if (patch.status === "active") return `Bring back ${name}`;
			if (patch.shortlistPin === "pinned")
				return `Pin ${name} to the shortlist`;
			if (patch.shortlistPin === "unpinned")
				return `Take ${name} off the shortlist`;
			if (patch.shortlistPin === "auto")
				return `Let the ratings decide on ${name}`;
			if (typeof patch.timeNeededMin === "number")
				return `Plan ${formatDuration(patch.timeNeededMin)} for ${name}`;
			return `Edit ${name}`;
		}
		case "node.move": {
			if (!name) return null;
			const parentId = pStr(pay, "parentId");
			const parent = nodeName(ix, parentId);
			if (!parentId) return `Move ${name} to the top level`;
			return parent ? `Move ${name} into ${parent}` : `Move ${name}`;
		}
		case "node.delete":
			return name ? `Delete ${name}` : null;
		case "node.priority": {
			if (!name) return null;
			const pr = pStr(pay, "priority");
			const label = pr
				? ((PRIORITIES as Record<string, { label: string }>)[pr]?.label ?? pr)
				: null;
			const memberId = pStr(pay, "memberId");
			const other =
				memberId && memberId !== ix.graph.me.memberId
					? memberNames(ix.graph, [memberId])[0]
					: null;
			if (other)
				return label
					? `Set ${other}'s rating of ${name} to ${label}`
					: `Clear ${other}'s rating of ${name}`;
			return label ? `Rate ${name}: ${label}` : `Clear the rating of ${name}`;
		}
		case "node.hours":
			return name ? `Set the opening hours of ${name}` : null;

		// ---- plan items ------------------------------------------------------
		case "item.create": {
			const label =
				pStr(pay, "title") ?? nodeName(ix, pStr(pay, "nodeId")) ?? null;
			if (!label) return null;
			const day = dayLabel(ix, pStr(pay, "dayId"));
			return day ? `Add ${label} to ${day}` : `Add ${label} to Unscheduled`;
		}
		case "item.update": {
			if (!name) return null;
			const patch = pObj(pay, "patch") ?? {};
			const keys = Object.keys(patch);
			if (keys.length === 1) {
				const k = keys[0];
				const v = patch[k as string];
				if (k === "durationMin" && typeof v === "number")
					return `Change ${name} to ${formatDuration(v)}`;
				if (k === "pinnedStart")
					return typeof v === "string"
						? `Start ${name} at ${v}`
						: `Unpin the time of ${name}`;
				if (k === "title")
					return typeof v === "string" && v
						? `Rename ${name} to ${v}`
						: `Clear the title of ${name}`;
				if (k === "note") return `Edit the note on ${name}`;
				if (k === "nodeId") {
					const place = nodeName(ix, typeof v === "string" ? v : null);
					return place
						? `Change ${name} to ${place}`
						: `Change the place of ${name}`;
				}
				if (k === "fixedDate")
					return v
						? `Mark ${name} booked for this date`
						: `Unmark ${name} as booked`;
			}
			return `Edit ${name}`;
		}
		case "item.move": {
			if (!name) return null;
			// The day it is on now: the snapshot first (an overlay index already
			// shows the move), else the index.
			const fromDay =
				"dayId" in p.before
					? (p.before.dayId as string | null)
					: (ix.item(p.entityId)?.dayId ?? null);
			const toDay = pay.dayId === null ? null : pStr(pay, "dayId");
			if (pay.dayId === null) return `Move ${name} to Unscheduled`;
			const label = dayLabel(ix, toDay);
			if (!label) return null;
			if (fromDay === toDay) return `Reorder ${name} on ${label}`;
			return `Move ${name} to ${label}`;
		}
		case "item.delete":
			return name ? `Remove ${name} from the plan` : null;
		case "item.assignees": {
			if (!name) return null;
			const names = memberNames(ix.graph, pArr(pay, "memberIds"));
			return names.length
				? `Assign ${name} to ${joinShort(names)}`
				: `Unassign everyone from ${name}`;
		}

		// ---- days and dates --------------------------------------------------
		case "day.update": {
			if (!name) return null;
			const start = pStr(pay, "startTime");
			if (start) return `Start ${name} at ${start}`;
			if ("title" in pay)
				return typeof pay.title === "string" && pay.title
					? `Call ${name} “${pay.title}”`
					: `Clear the title of ${name}`;
			return `Edit ${name}`;
		}
		case "day.stay": {
			const from = dayLabel(ix, pStr(pay, "fromDayId"));
			if (!from) return null;
			const to = dayLabel(ix, pStr(pay, "toDayId"));
			const nights =
				to && to !== from
					? `nights of ${from}–${to.replace("Day ", "")}`
					: `night of ${from}`;
			const place = nodeName(ix, pStr(pay, "nodeId"));
			if (pay.nodeId === null) return `Clear the stay on the ${nights}`;
			return place ? `Stay at ${place} on the ${nights}` : null;
		}
		case "day.insert": {
			const day = dayLabel(ix, pStr(pay, "dayId"));
			if (!day) return null;
			return `Insert a day ${pay.where === "before" ? "before" : "after"} ${day}`;
		}
		case "day.move": {
			const toDate = pStr(pay, "toDate");
			const target = toDate ? ix.dayOfDate(toDate) : undefined;
			if (!name) return null;
			return target
				? `Move ${name} to ${dayLabel(ix, target.id) ?? toDate}`
				: `Move ${name}`;
		}
		case "day.delete":
			return name ? `Delete ${name}` : null;
		case "trip.shift": {
			const d = pNum(pay, "deltaDays");
			if (d === null || d === 0) return null;
			const from = ix.trip.startDate;
			const to = ix.trip.endDate;
			const range =
				from && to ? ` (${rangeText(addDays(from, d), addDays(to, d))})` : "";
			return `Shift the trip ${signed(d)} ${Math.abs(d) === 1 ? "day" : "days"}${range}`;
		}
		case "trip.dates": {
			const a = pStr(pay, "startDate");
			const b = pStr(pay, "endDate");
			return a && b ? `Change the trip dates to ${rangeText(a, b)}` : null;
		}

		// ---- legs and transit ------------------------------------------------
		case "leg.set": {
			const label = legLabel(p, ix);
			if (!label) return null;
			const patch = pObj(pay, "patch") ?? {};
			const mode = typeof patch.mode === "string" ? patch.mode : null;
			if (mode && MODE_VERB[mode]) {
				const dur =
					typeof patch.durationMin === "number"
						? ` · ${formatDuration(patch.durationMin)}`
						: "";
				return `${MODE_VERB[mode]}: ${label}${dur}`;
			}
			if (typeof patch.durationMin === "number")
				return `Change ${label} to ${formatDuration(patch.durationMin)}`;
			return `Change the travel ${label}`;
		}
		case "leg.relink": {
			const label = legLabel(p, ix);
			return label ? `Relink the leg to ${label}` : null;
		}
		case "leg.delete": {
			const label = legLabel(p, ix);
			return label ? `Remove the leg ${label}` : null;
		}
		case "leg.assignees": {
			const label = legLabel(p, ix);
			if (!label) return null;
			const names = memberNames(ix.graph, pArr(pay, "memberIds"));
			return names.length
				? `Assign ${label} to ${joinShort(names)}`
				: `Unassign everyone from ${label}`;
		}
		case "leg.resetEstimate": {
			const label = legLabel(p, ix);
			return label ? `Reset the estimate for ${label}` : null;
		}
		case "transit.route.save": {
			const label = legLabel(p, ix);
			return label ? `Save a transit route for ${label}` : null;
		}
		case "transit.route.update": {
			const label = legLabel(p, ix);
			return label ? `Change the transit route for ${label}` : null;
		}
		case "transit.route.delete": {
			const label = legLabel(p, ix);
			return label ? `Remove the transit route for ${label}` : null;
		}
		case "transit.details": {
			const label = legLabel(p, ix);
			return label ? `Change the transit details for ${label}` : null;
		}
		case "flight.save": {
			const leg = legOf(p, ix);
			const d = leg ? ix.legDetails(leg) : null;
			const number = d?.kind === "flight" ? d.flight.flightNumber : null;
			if (number) return `Change flight ${number}`;
			const label = legLabel(p, ix);
			return label ? `Change the flight ${label}` : null;
		}
		case "flight.create":
			return null;

		// ---- notes -------------------------------------------------------------
		case "note.append": {
			const where = targetLabel(pObj(pay, "target"), ix);
			return where ? `Add to the notes of ${where}` : null;
		}
		default:
			// Lists and media aren't in the graph: their summaries are the best text.
			return null;
	}
}

function joinShort(names: string[]): string {
	if (names.length <= 2) return names.join(" and ");
	return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

export function describeProposal(p: ProposalDto, ix: GraphIndex): string {
	try {
		if (entityLive(p, ix) || p.createdIds.length > 0) {
			const text = describeLive(p, ix);
			if (text) return text;
		}
	} catch {
		// A payload shape we don't know: the summary still reads well.
	}
	return imperative(p.summary);
}

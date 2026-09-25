/**
 * Pure helpers behind the suggestion UI (EXTENSIONS §3.7): names, the scope
 * crumb, where "Show" goes, author batches for the ReviewDrawer, the
 * before → after rows of ProposalOverview, and conflict wording. No React,
 * no I/O; everything reads the CURRENT graph (the overlay is mark-only, so
 * `ix` is the trip as it is now).
 */
import {
	NODE_TYPES,
	PLACE_CATEGORIES,
	PRIORITIES,
} from "@/lib/domain/taxonomy";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { effectiveHours } from "@/lib/engine/hours";
import type { GraphLeg, TripGraph } from "@/lib/engine/types";
import { formatDateRange, formatDayDate, formatDuration } from "@/lib/format";
import type {
	Json,
	ProposalConflict,
	ProposalDto,
} from "@/lib/schemas/proposals";
import type { Sel } from "@/lib/workspace/search";
import {
	DETAIL_LABELS,
	detailRows,
	type FieldRow,
	proposedDetail,
} from "./detail-rows";

export type { FieldRow } from "./detail-rows";

// ---------------------------------------------------------------------------
// Payload access (payloads are JSON of the op's input; never trust shapes)
// ---------------------------------------------------------------------------

type Payload = ProposalDto["payload"];

export function pStr(payload: Payload, key: string): string | null {
	const v = payload[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}

export function pNum(payload: Payload, key: string): number | null {
	const v = payload[key];
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function pObj(
	payload: Payload,
	key: string,
): Record<string, Json> | null {
	const v = payload[key];
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, Json>)
		: null;
}

export function pArr(payload: Payload, key: string): Json[] | null {
	const v = payload[key];
	return Array.isArray(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export function nodeName(ix: GraphIndex, id: string | null | undefined) {
	return ix.node(id)?.name ?? null;
}

/** "Itoya Ginza", "Lunch"; null for an unknown item. */
export function itemLabel(
	ix: GraphIndex,
	id: string | null | undefined,
): string | null {
	const it = ix.item(id);
	if (!it) return null;
	return it.title ?? ix.node(it.nodeId)?.name ?? "Untitled stop";
}

/** "Day 7"; null for an unknown day. */
export function dayLabel(
	ix: GraphIndex,
	id: string | null | undefined,
): string | null {
	if (!id) return null;
	const n = ix.dayNumber(id);
	return n > 0 ? `Day ${n}` : null;
}

/** "Day 7 · Thu 9 Oct". */
export function dayLongLabel(
	ix: GraphIndex,
	id: string | null | undefined,
): string | null {
	const day = ix.day(id);
	const short = dayLabel(ix, id);
	if (!day || !short) return null;
	return `${short} · ${formatDayDate(day.date)}`;
}

/** First names, joined "Dennis", "Dennis and Maya", "Dennis, Maya and Kai". */
export function joinNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The people a suggester's changes go to: active owners and editors, by first name. */
export function reviewerFirstNames(graph: TripGraph): string[] {
	return graph.members
		.filter(
			(m) =>
				m.status === "active" &&
				(m.role === "owner" || m.role === "editor") &&
				m.userId !== graph.me.userId,
		)
		.sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : 0))
		.map((m) => m.firstName?.trim() || m.name.split(/\s+/)[0] || m.name);
}

/** "Your changes go to Dennis and Maya for review." */
export function reviewersLine(names: readonly string[]): string {
	return names.length
		? `Your changes go to ${joinNames(names)} for review.`
		: "Your changes go to the trip's editors for review.";
}

/** A member's name, following merged placeholders (like `resolveMember`). */
export function memberName(graph: TripGraph, id: string): string {
	let m = graph.members.find((x) => x.id === id);
	for (let hops = 0; m?.mergedIntoId && hops < 4; hops++) {
		const next = graph.members.find((x) => x.id === m?.mergedIntoId);
		if (!next) break;
		m = next;
	}
	return m?.name ?? "former member";
}

export function memberNames(
	graph: TripGraph,
	ids: readonly Json[] | null,
): string[] {
	return (ids ?? [])
		.filter((x): x is string => typeof x === "string")
		.map((id) => memberName(graph, id));
}

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

/** The leg row a proposal is about (by id, or by its pair/stay target). */
export function legOf(p: ProposalDto, ix: GraphIndex): GraphLeg | undefined {
	if (p.entityKind === "leg" && p.entityId) {
		const byId = ix.leg(p.entityId);
		if (byId) return byId;
	}
	const target = pObj(p.payload, "target");
	if (target?.kind === "pair") {
		const from = typeof target.fromItemId === "string" ? target.fromItemId : "";
		const to = typeof target.toItemId === "string" ? target.toItemId : "";
		return ix.legByPair.get(`${from}>${to}`);
	}
	if (target?.kind === "stay") {
		const day = typeof target.dayId === "string" ? target.dayId : "";
		const end = target.end === "end" ? "end" : "start";
		return ix.legByStay.get(`${day}:${end}`);
	}
	const legId = pStr(p.payload, "legId");
	return legId ? ix.leg(legId) : undefined;
}

/** "Itoya Ginza → Senso-ji" for a pair, "Morning of Day 3" for a stay. */
export function legLabel(p: ProposalDto, ix: GraphIndex): string | null {
	const target = pObj(p.payload, "target");
	if (target?.kind === "pair") {
		const a = itemLabel(ix, String(target.fromItemId ?? ""));
		const b = itemLabel(ix, String(target.toItemId ?? ""));
		if (a && b) return `${a} → ${b}`;
	}
	if (target?.kind === "stay") {
		const d = dayLabel(ix, String(target.dayId ?? ""));
		if (d) return `${target.end === "end" ? "Evening" : "Morning"} of ${d}`;
	}
	const from = pStr(p.payload, "fromItemId");
	const to = pStr(p.payload, "toItemId");
	if (from && to && p.op === "leg.relink") {
		const a = itemLabel(ix, from);
		const b = itemLabel(ix, to);
		if (a && b) return `${a} → ${b}`;
	}
	const leg = legOf(p, ix);
	if (!leg) return null;
	if (leg.kind === "pair") {
		const a = itemLabel(ix, leg.fromItemId);
		const b = itemLabel(ix, leg.toItemId);
		return a && b ? `${a} → ${b}` : null;
	}
	const d = dayLabel(ix, leg.stayDayId);
	return d
		? `${leg.kind === "stay_end" ? "Evening" : "Morning"} of ${d}`
		: null;
}

// ---------------------------------------------------------------------------
// The entity: is it live, what is it called, where is it, what does Show do
// ---------------------------------------------------------------------------

/** The note target (`note.append`) as a readable place: "Shibuya Sky", "Day 3", "the trip". */
export function targetLabel(
	target: Record<string, Json> | null,
	ix: GraphIndex,
): string | null {
	if (!target) return null;
	switch (target.kind) {
		case "trip":
			return "the trip";
		case "node":
			return nodeName(ix, String(target.nodeId ?? ""));
		case "item":
			return itemLabel(ix, String(target.itemId ?? ""));
		case "day":
			return dayLabel(ix, String(target.dayId ?? ""));
		case "leg": {
			const leg = ix.leg(String(target.legId ?? ""));
			if (!leg) return null;
			if (leg.kind === "pair") {
				const a = itemLabel(ix, leg.fromItemId);
				const b = itemLabel(ix, leg.toItemId);
				return a && b ? `${a} → ${b}` : null;
			}
			return dayLabel(ix, leg.stayDayId);
		}
		default:
			return null;
	}
}

/** Whether the thing the proposal touches exists right now (a create never does). */
export function entityLive(p: ProposalDto, ix: GraphIndex): boolean {
	if (
		p.createdIds.length > 0 &&
		p.entityId &&
		p.createdIds.includes(p.entityId)
	)
		return false;
	switch (p.entityKind) {
		case "node":
			return !!ix.node(p.entityId);
		case "item":
			return !!ix.item(p.entityId);
		case "day":
			return !!ix.day(p.entityId);
		case "leg":
			return !!legOf(p, ix) || legLabel(p, ix) !== null;
		case "trip":
			return true;
		case "note":
			return targetLabel(pObj(p.payload, "target"), ix) !== null;
		default:
			// list rows and attachments aren't in the graph: trust the summary.
			return true;
	}
}

/** The entity's current name ("Itoya Ginza", "Day 3", "the trip"), or null. */
export function entityName(p: ProposalDto, ix: GraphIndex): string | null {
	switch (p.entityKind) {
		case "node":
			return nodeName(ix, p.entityId) ?? pStr(p.payload, "name");
		case "item":
			return itemLabel(ix, p.entityId);
		case "day":
			return dayLabel(ix, p.entityId);
		case "leg":
			return legLabel(p, ix);
		case "trip":
			return ix.trip.name;
		case "note":
			return targetLabel(pObj(p.payload, "target"), ix);
		default:
			return null;
	}
}

/** Where the entity lives, root-most first: node ids for the crumb, plus a day label. */
export function scopeOf(
	p: ProposalDto,
	ix: GraphIndex,
): { nodeIds: string[]; day: string | null } {
	const pathOf = (nodeId: string | null | undefined) =>
		nodeId ? ix.path(nodeId).map((n) => n.id) : [];
	switch (p.entityKind) {
		case "node": {
			if (ix.node(p.entityId)) {
				const path = pathOf(p.entityId);
				return { nodeIds: path.slice(0, -1), day: null };
			}
			// A proposed create: its parent is in the payload.
			return { nodeIds: pathOf(pStr(p.payload, "parentId")), day: null };
		}
		case "item": {
			const it = ix.item(p.entityId);
			const nodeId = it?.nodeId ?? pStr(p.payload, "nodeId");
			const dayId = it?.dayId ?? pStr(p.payload, "dayId");
			const path = pathOf(nodeId);
			return { nodeIds: path.slice(0, -1), day: dayLongLabel(ix, dayId) };
		}
		case "day":
			return { nodeIds: [], day: dayLongLabel(ix, p.entityId) };
		case "leg": {
			const leg = legOf(p, ix);
			const from = ix.item(leg?.fromItemId);
			return {
				nodeIds: pathOf(from?.nodeId).slice(0, -1),
				day: dayLongLabel(ix, from?.dayId ?? leg?.stayDayId),
			};
		}
		case "note": {
			const t = pObj(p.payload, "target");
			if (t?.kind === "node")
				return { nodeIds: pathOf(String(t.nodeId)), day: null };
			if (t?.kind === "day")
				return { nodeIds: [], day: dayLongLabel(ix, String(t.dayId)) };
			if (t?.kind === "item") {
				const it = ix.item(String(t.itemId));
				return {
					nodeIds: pathOf(it?.nodeId),
					day: dayLongLabel(ix, it?.dayId),
				};
			}
			return { nodeIds: [], day: null };
		}
		default:
			return { nodeIds: [], day: null };
	}
}

/** The selection "Show" makes: the live entity, else the proposal itself (`p.<id>`). */
export function selFor(p: ProposalDto, ix: GraphIndex): Sel {
	if (entityLive(p, ix)) {
		switch (p.entityKind) {
			case "node":
				if (p.entityId) return { kind: "node", id: p.entityId };
				break;
			case "item":
				if (p.entityId) return { kind: "item", id: p.entityId };
				break;
			case "day":
				if (p.entityId) return { kind: "day", id: p.entityId };
				break;
			case "leg": {
				const leg = legOf(p, ix);
				if (leg?.kind === "pair" && leg.fromItemId && leg.toItemId)
					return {
						kind: "leg",
						target: {
							kind: "pair",
							fromItemId: leg.fromItemId,
							toItemId: leg.toItemId,
						},
					};
				if (leg?.stayDayId)
					return {
						kind: "leg",
						target: {
							kind: "stay",
							dayId: leg.stayDayId,
							end: leg.kind === "stay_end" ? "end" : "start",
						},
					};
				break;
			}
			case "note": {
				const t = pObj(p.payload, "target");
				if (t?.kind === "node") return { kind: "node", id: String(t.nodeId) };
				if (t?.kind === "item") return { kind: "item", id: String(t.itemId) };
				if (t?.kind === "day") return { kind: "day", id: String(t.dayId) };
				break;
			}
			default:
				break;
		}
	}
	return { kind: "proposal", id: p.id };
}

/** The id `useUi().flash` glows for "Show" (the entity's own id), or null. */
export function flashIdFor(p: ProposalDto, ix: GraphIndex): string | null {
	if (p.entityKind === "leg") return legOf(p, ix)?.id ?? null;
	if (p.entityKind === "trip" || p.entityKind === "note") return null;
	return p.entityId;
}

// ---------------------------------------------------------------------------
// People and batches
// ---------------------------------------------------------------------------

/** One author across proposals (user id, else the snapshot name). */
export function authorKey(p: ProposalDto): string {
	return p.author.userId ?? `name:${p.author.name}`;
}

/** The caller wrote it (matched by user id, never by name). */
export function isMine(p: ProposalDto, meUserId: string | null | undefined) {
	return !!meUserId && p.author.userId === meUserId;
}

export type Batch = {
	key: string;
	author: ProposalDto["author"];
	proposals: ProposalDto[];
	/** ISO of the first proposal. */
	startedAt: string;
};

const BATCH_GAP_MS = 10 * 60_000;

/**
 * Groups by author × 10-minute batch (EXTENSIONS §3.7): a batch is a run of
 * one author's proposals, each within 10 minutes of the previous one. Batches
 * are ordered by their first proposal, oldest first.
 */
export function batches(list: readonly ProposalDto[]): Batch[] {
	const sorted = [...list].sort((a, b) =>
		a.createdAt === b.createdAt
			? a.id.localeCompare(b.id)
			: a.createdAt.localeCompare(b.createdAt),
	);
	const open = new Map<string, Batch & { lastAt: number }>();
	const out: (Batch & { lastAt: number })[] = [];
	for (const p of sorted) {
		const k = authorKey(p);
		const at = Date.parse(p.createdAt);
		const cur = open.get(k);
		if (cur && at - cur.lastAt <= BATCH_GAP_MS) {
			cur.proposals.push(p);
			cur.lastAt = at;
			continue;
		}
		const b = {
			key: `${k}|${p.id}`,
			author: p.author,
			proposals: [p],
			startedAt: p.createdAt,
			lastAt: at,
		};
		open.set(k, b);
		out.push(b);
	}
	return out.map(({ lastAt: _l, ...b }) => b);
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const PAST_TO_IMPERATIVE: Record<string, string> = {
	added: "Add",
	moved: "Move",
	deleted: "Delete",
	removed: "Remove",
	changed: "Change",
	shifted: "Shift",
	renamed: "Rename",
	set: "Set",
	updated: "Update",
	scheduled: "Schedule",
	unscheduled: "Unschedule",
	assigned: "Assign",
	unassigned: "Unassign",
	linked: "Link",
	relinked: "Relink",
	inserted: "Insert",
	rated: "Rate",
	saved: "Save",
	created: "Create",
	edited: "Edit",
	reset: "Reset",
	marked: "Mark",
	suggested: "Suggest",
	dropped: "Drop",
	pinned: "Pin",
	unpinned: "Unpin",
};

/** "moved Itoya Ginza to Day 1" → "Move Itoya Ginza to Day 1". */
export function imperative(summary: string): string {
	const s = summary.trim();
	if (!s) return "Change something";
	const [first = "", ...rest] = s.split(" ");
	const verb = PAST_TO_IMPERATIVE[first.toLowerCase()];
	if (verb) return [verb, ...rest].join(" ");
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "5 min ago", "2 h ago", "3 d ago"; "just now" under a minute. */
export function timeAgo(iso: string, now = Date.now()): string {
	const ms = now - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 60_000) return "just now";
	const min = Math.round(ms / 60_000);
	if (min < 60) return `${min} min ago`;
	const h = Math.round(min / 60);
	if (h < 48) return `${h} h ago`;
	return `${Math.round(h / 24)} d ago`;
}

/** Why an accept failed, in one line ("Itoya Ginza was moved since"). */
export function conflictLine(
	p: ProposalDto,
	conflict: ProposalConflict,
	ix: GraphIndex,
): string {
	const name = entityName(p, ix) ?? "It";
	if (conflict.message && /[a-z]/.test(conflict.message)) {
		const m = conflict.message.trim();
		return /[.!?]$/.test(m) ? m : `${m}.`;
	}
	switch (conflict.reason) {
		case "gone":
			return `${name} was deleted since.`;
		case "changed":
			return `${name} was changed since.`;
		default:
			return "This can't be applied as it is.";
	}
}

/** `changed` conflicts can be accepted anyway; `gone` ones never. */
export function forceable(conflict: ProposalConflict | null | undefined) {
	return conflict?.reason === "changed";
}

// ---------------------------------------------------------------------------
// Before → after (ProposalOverview)
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
	dayId: "Day",
	parentId: "Inside",
	nodeId: "Place",
	durationMin: "Duration",
	pinnedStart: "Starts at",
	title: "Title",
	note: "Note",
	name: "Name",
	localName: "Local name",
	description: "Description",
	category: "Category",
	type: "Type",
	status: "Status",
	startDate: "Trip starts",
	endDate: "Trip ends",
	startTime: "Day starts",
	nightNodeId: "Stay",
	assigneeIds: "People",
	deletedAt: "",
	deleted: "",
	fixedDate: "Booked for this date",
	timeNeededMin: "Time needed",
	address: "Address",
	mode: "Mode",
	date: "Date",
	markdown: "Addition",
	fromItemId: "From",
	toItemId: "To",
};

function labelFor(field: string): string {
	if (field.startsWith("priority:")) return "Rating";
	if (field.startsWith("details.")) {
		const key = field.slice(8);
		return (
			DETAIL_LABELS[key] ??
			key
				.replace(/([A-Z])/g, " $1")
				.toLowerCase()
				.replace(/^./, (c) => c.toUpperCase())
		);
	}
	return (
		FIELD_LABELS[field] ??
		field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())
	);
}

function priorityLabel(v: Json | undefined): string {
	if (typeof v !== "string") return "Not rated";
	return (PRIORITIES as Record<string, { label: string }>)[v]?.label ?? v;
}

/** "temple_shrine" → "Temple shrine": the fallback for an enum with no label map. */
function humanizeEnum(v: string): string {
	return v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** An enum value through its taxonomy label ("Temple / Shrine", "Place"). */
function enumLabel(
	labels: Readonly<Record<string, { label: string }>>,
	v: Json,
): string {
	if (typeof v !== "string") return "—";
	return (Object.hasOwn(labels, v) && labels[v]?.label) || humanizeEnum(v);
}

/** One value as people read it: names for ids, "1h 30m", "Thu 9 Oct", "—". */
export function formatValue(
	field: string,
	value: Json | undefined,
	ix: GraphIndex,
): string {
	if (value === undefined || value === null || value === "") {
		if (field === "dayId") return "Unscheduled";
		if (field === "parentId") return "Top level";
		if (field === "pinnedStart") return "Not pinned";
		if (field === "nightNodeId") return "No stay";
		if (field.startsWith("priority:")) return "Not rated";
		return "—";
	}
	switch (field) {
		case "dayId":
			return dayLongLabel(ix, String(value)) ?? "Another day";
		case "parentId":
		case "nodeId":
		case "nightNodeId":
			return nodeName(ix, String(value)) ?? "Another place";
		case "fromItemId":
		case "toItemId":
			return itemLabel(ix, String(value)) ?? "Another stop";
		case "durationMin":
		case "timeNeededMin":
			return typeof value === "number" ? formatDuration(value) : String(value);
		case "startDate":
		case "endDate":
		case "date":
			return typeof value === "string"
				? formatDayDate(value, { year: true })
				: "—";
		case "assigneeIds":
			return Array.isArray(value)
				? value.length
					? memberNames(ix.graph, value).join(", ")
					: "Nobody"
				: "—";
		case "fixedDate":
			return value === true ? "Yes" : "No";
		case "type":
			return enumLabel(NODE_TYPES, value);
		case "category":
			return enumLabel(PLACE_CATEGORIES, value);
		case "status":
		case "mode":
			return typeof value === "string" ? humanizeEnum(value) : "—";
		default:
			break;
	}
	if (field.startsWith("priority:")) return priorityLabel(value);
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (typeof value === "number") return String(value);
	if (typeof value === "string")
		return value.length > 140 ? `${value.slice(0, 139)}…` : value;
	return "Changed";
}

/** The current value of a field on the live entity (when `before` is missing). */
function currentValue(
	p: ProposalDto,
	field: string,
	ix: GraphIndex,
): Json | undefined {
	const read = (row: object | undefined, key: string): Json | undefined => {
		if (!row) return undefined;
		const v = (row as Record<string, unknown>)[key];
		return v === undefined ? undefined : (v as Json);
	};
	if (field.startsWith("details.")) return currentDetail(p, field.slice(8), ix);
	switch (p.entityKind) {
		case "node": {
			const n = ix.node(p.entityId);
			if (field.startsWith("priority:"))
				return n?.priorities[field.slice(9)] ?? null;
			return read(n, field);
		}
		case "item":
			return read(ix.item(p.entityId), field);
		case "day":
			return read(ix.day(p.entityId), field);
		case "leg":
			return read(legOf(p, ix), field);
		case "trip":
			return read(ix.trip, field);
		default:
			return undefined;
	}
}

/**
 * The live value of `details.<key>`: a place's hours as the app shows them
 * (stored, else parsed from the sheet), a leg's flight/route/fixed/booking.
 * null = none; undefined = the entity isn't there.
 */
function currentDetail(
	p: ProposalDto,
	key: string,
	ix: GraphIndex,
): Json | undefined {
	if (p.entityKind === "node") {
		const n = ix.node(p.entityId);
		if (!n) return undefined;
		if (key === "openingHours")
			return (effectiveHours(n, ix.trip.settings)?.hours ?? null) as Json;
		const v = (n.details as Record<string, unknown> | null)?.[key];
		return v === undefined ? null : (v as Json);
	}
	if (p.entityKind === "leg") {
		const leg = legOf(p, ix);
		if (!leg) return null;
		const v = (ix.legDetails(leg) as Record<string, unknown>)[key];
		return v === undefined ? null : (v as Json);
	}
	return undefined;
}

/** The proposed value of a field, from the payload. */
function proposedValue(
	p: ProposalDto,
	field: string,
	ix: GraphIndex,
): Json | undefined {
	const patch = pObj(p.payload, "patch");
	if (patch && field in patch) return patch[field];
	if (field.startsWith("details."))
		return proposedDetail(p.op, p.payload, field.slice(8));
	if (field.startsWith("priority:")) return p.payload.priority;
	if (p.op === "trip.shift" && (field === "startDate" || field === "endDate")) {
		const delta = pNum(p.payload, "deltaDays") ?? 0;
		const cur = ix.trip[field];
		return cur ? addDays(cur, delta) : undefined;
	}
	if (field === "assigneeIds") return p.payload.memberIds;
	if (field === "nightNodeId") return p.payload.nodeId;
	if (field === "date") return p.payload.toDate;
	if (field === "deletedAt" || field === "deleted") return "deleted";
	return p.payload[field];
}

/** `YYYY-MM-DD` + n days. */
export function addDays(date: string, n: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

/** The field rows ProposalOverview shows (position and internal fields left out). */
export function fieldRows(p: ProposalDto, ix: GraphIndex): FieldRow[] {
	if (p.op === "note.append") return [];
	const kind = p.op.split(".").at(-1);
	if (kind === "create" || kind === "createPath" || kind === "link") {
		return createRows(p, ix);
	}
	const fields = p.fields.filter(
		(f) => f !== "position" && f !== "deletedAt" && f !== "deleted",
	);
	return fields.flatMap((field): FieldRow[] => {
		const before = beforeValue(p, field, ix);
		const after = proposedValue(p, field, ix);
		if (field.startsWith("details.")) {
			const rows = detailRows(field, before, after, (id) =>
				memberName(ix.graph, id),
			);
			if (rows) return rows;
		}
		return [
			{
				field,
				label: labelFor(field),
				before: before === undefined ? null : formatValue(field, before, ix),
				after: formatValue(field, after, ix),
			},
		];
	});
}

/**
 * The value before the proposal: the DTO's snapshot, else the live value.
 * The snapshot holds columns, so a nested `details.*` field comes back null
 * (COLLAB-R2-07): while the proposal is open the live value is what accepting
 * replaces; once it is closed the live value is no "before" at all (unknown).
 */
function beforeValue(
	p: ProposalDto,
	field: string,
	ix: GraphIndex,
): Json | undefined {
	const snap = field in p.before ? p.before[field] : undefined;
	if (field.startsWith("details.")) {
		if (snap !== undefined && snap !== null) return snap;
		return p.status === "open" ? currentValue(p, field, ix) : undefined;
	}
	return field in p.before ? snap : currentValue(p, field, ix);
}

function createRows(p: ProposalDto, ix: GraphIndex): FieldRow[] {
	const rows: FieldRow[] = [];
	const add = (field: string, value: Json | undefined) => {
		if (value === undefined || value === null || value === "") return;
		rows.push({
			field,
			label: labelFor(field),
			before: null,
			after: formatValue(field, value, ix),
		});
	};
	if (p.op === "node.createPath") {
		const chain = pArr(p.payload, "chain") ?? [];
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
		if (names.length)
			rows.push({
				field: "chain",
				label: "Path",
				before: null,
				after: names.join(" › "),
			});
		return rows;
	}
	add("name", p.payload.name);
	add("title", p.payload.title);
	add("type", p.payload.type);
	add("category", p.payload.category);
	add("parentId", p.payload.parentId);
	add("nodeId", p.payload.nodeId);
	if ("dayId" in p.payload) {
		rows.push({
			field: "dayId",
			label: labelFor("dayId"),
			before: null,
			after: formatValue("dayId", p.payload.dayId, ix),
		});
	}
	add("durationMin", p.payload.durationMin);
	add("pinnedStart", p.payload.pinnedStart);
	add("url", p.payload.url);
	return rows;
}

/** For `trip.*` proposals: the date change DateImpactList shows. */
export function dateChangeOf(
	p: ProposalDto,
): { deltaDays: number } | { startDate: string; endDate: string } | null {
	if (p.op === "trip.shift") {
		const deltaDays = pNum(p.payload, "deltaDays");
		return deltaDays === null ? null : { deltaDays };
	}
	if (p.op === "trip.dates") {
		const startDate = pStr(p.payload, "startDate");
		const endDate = pStr(p.payload, "endDate");
		return startDate && endDate ? { startDate, endDate } : null;
	}
	return null;
}

/** "3–20 Oct 2027". */
export function rangeText(from: string, to: string) {
	return formatDateRange(from, to, { year: true });
}

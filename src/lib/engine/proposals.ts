/**
 * E7 overlay (EXTENSIONS §3.6): open proposals drawn on top of the trip graph.
 * Pure: no React, no I/O; the input is never mutated.
 *
 * Every open proposal yields marks (with `from:` origin marks for moves and
 * `stacked` for later alternatives on the same (entity, field)). The
 * SIMULATING reducers then apply, in `createdAt` order, at most one open
 * proposal per (entity, field) — the oldest — to a copy of the graph:
 * creates are inserted after their anchor (a zone comes from the nearest
 * ancestor through the index), moves re-parent or re-day the row, updates
 * patch it (the mark keeps `before`), deletes keep the row (marked). Stacked
 * and conflicted proposals aren't applied; ops without a reducer (day
 * structure, trip dates, transit, lists, media, notes) are marks only.
 * With nothing to simulate the input graph is returned as is.
 */
import { defaultItemDuration, PLACE_CATEGORIES } from "@/lib/domain/taxonomy";
import type {
	Json,
	ProposalConflict,
	ProposalDto,
	ProposalOp,
} from "@/lib/schemas/proposals";
import { compareKeys } from "./graph-index";
import { categoryForType, slugify } from "./tree";
import type {
	GraphDay,
	GraphItem,
	GraphLeg,
	GraphNode,
	NodeType,
	PlaceCategory,
	Priority,
	TripGraph,
} from "./types";

/** Where a mark hangs. `from:` keys are the OLD container of a move (origin rows). */
export type MarkKey =
	| `node:${string}`
	| `item:${string}`
	| `leg:${string}`
	| `day:${string}`
	| `list:${string}`
	| `att:${string}`
	/** A note (`note.append`): the note's target id; never a trip-level mark. */
	| `note:${string}`
	| "trip"
	| `from:day:${string}`
	/** `from:node:root` = a move out of the trip's top level. */
	| `from:node:${string}`;

export type ProposalMarkKind =
	| "create"
	| "update"
	| "move"
	| "delete"
	| "other";

export type ProposalMark = {
	proposalId: string;
	op: ProposalOp;
	kind: ProposalMarkKind;
	author: {
		userId: string | null;
		memberId: string | null;
		name: string;
		color: number;
	};
	fields?: string[];
	before?: Record<string, Json>;
	/** Updates: the proposed value of each `before` field, when the payload has it. */
	after?: Record<string, Json>;
	/** The proposal's own summary ("moved Itoya to Tue 5 Oct"), for screen readers. */
	summary?: string;
	conflict?: "gone" | "changed";
	/** A later alternative on the same (entity, field): shown, not applied. */
	stacked?: true;
	/** On `from:` keys: the origin row ("Itoya → Day 7 · Maya"). */
	origin?: { entity: MarkKey; afterId: string | null; toLabel: string };
};

export type ProposalOverlay = {
	graph: TripGraph;
	marks: Map<MarkKey, ProposalMark[]>;
	conflicts: Map<string, ProposalConflict>;
};

/** The mark kind of an op (by its verb). */
export function markKindOf(op: ProposalOp): ProposalMarkKind {
	const verb = op.split(".").at(-1) ?? "";
	if (
		verb === "create" ||
		verb === "createPath" ||
		verb === "link" ||
		verb === "insert"
	)
		return "create";
	if (verb === "delete") return "delete";
	if (verb === "move" || verb === "relink") return "move";
	if (
		verb === "update" ||
		verb === "set" ||
		verb === "assignees" ||
		verb === "priority" ||
		verb === "hours" ||
		verb === "stay" ||
		verb === "status" ||
		verb === "targets" ||
		verb === "details" ||
		verb === "save"
	)
		return "update";
	return "other";
}

const ENTITY_PREFIX: Record<ProposalDto["entityKind"], string | null> = {
	node: "node",
	item: "item",
	leg: "leg",
	day: "day",
	list: "list",
	att: "att",
	trip: null,
	note: "note",
};

/** The mark key of a proposal's entity (`trip` for trip-wide and unknown targets). */
export function markKeyOf(
	p: Pick<ProposalDto, "entityKind" | "entityId">,
): MarkKey {
	const prefix = ENTITY_PREFIX[p.entityKind];
	return prefix && p.entityId ? (`${prefix}:${p.entityId}` as MarkKey) : "trip";
}

/**
 * The proposed values of an update's `before` fields: from `payload.patch`
 * (item/node/list updates), else the payload itself (day/trip updates).
 */
function afterOf(
	payload: Record<string, Json>,
	before: Record<string, Json>,
): Record<string, Json> {
	const patch = payload.patch;
	const src =
		patch && typeof patch === "object" && !Array.isArray(patch)
			? (patch as Record<string, Json>)
			: payload;
	const out: Record<string, Json> = {};
	for (const f of Object.keys(before)) if (f in src) out[f] = src[f] as Json;
	return out;
}

/** A payload string field, if present. */
function str(payload: Record<string, Json>, key: string): string | null {
	const v = payload[key];
	return typeof v === "string" ? v : null;
}

/**
 * Marks for the open proposals. Proposals are taken in `createdAt` order; per
 * (entity, field) the oldest applies and later ones are `stacked`. Closed
 * proposals are ignored; proposals with a `lastError` of `gone`/`changed` go
 * into `conflicts` (and still get a mark carrying `conflict`).
 */
export function applyProposals(
	graph: TripGraph,
	open: readonly ProposalDto[],
): ProposalOverlay {
	const marks = new Map<MarkKey, ProposalMark[]>();
	const conflicts = new Map<string, ProposalConflict>();
	const claimed = new Set<string>();
	const push = (key: MarkKey, mark: ProposalMark) => {
		const list = marks.get(key);
		if (list) list.push(mark);
		else marks.set(key, [mark]);
	};
	const itemDay = new Map(graph.items.map((i) => [i.id, i.dayId]));
	const nodeParent = new Map(graph.nodes.map((n) => [n.id, n.parentId]));
	const dayLabel = new Map(graph.days.map((d, i) => [d.id, `Day ${i + 1}`]));
	const nodeName = new Map(graph.nodes.map((n) => [n.id, n.name]));

	const ordered = [...open]
		.filter((p) => p.status === "open")
		.sort((a, b) =>
			a.createdAt === b.createdAt
				? a.id.localeCompare(b.id)
				: a.createdAt.localeCompare(b.createdAt),
		);
	const applied: ProposalDto[] = [];
	for (const p of ordered) {
		const key = markKeyOf(p);
		const kind = markKindOf(p.op);
		const fields = p.fields.length ? p.fields : ["*"];
		const stacked = fields.some((f) => claimed.has(`${key}|${f}`));
		for (const f of fields) claimed.add(`${key}|${f}`);
		const conflict =
			p.lastError?.reason === "gone" || p.lastError?.reason === "changed"
				? p.lastError.reason
				: undefined;
		if (p.lastError) conflicts.set(p.id, p.lastError);
		const after =
			kind === "update" && Object.keys(p.before).length
				? afterOf(p.payload, p.before)
				: {};
		const mark: ProposalMark = {
			proposalId: p.id,
			op: p.op,
			kind,
			author: {
				userId: p.author.userId,
				memberId: p.author.memberId,
				name: p.author.name,
				color: p.author.color,
			},
			...(p.fields.length ? { fields: p.fields } : {}),
			...(Object.keys(p.before).length ? { before: p.before } : {}),
			...(Object.keys(after).length ? { after } : {}),
			...(p.summary ? { summary: p.summary } : {}),
			...(conflict ? { conflict } : {}),
			...(stacked ? { stacked: true as const } : {}),
		};
		push(key, mark);
		if (!stacked && !p.lastError) applied.push(p);

		// Origin rows: a move leaves a trace at the OLD container (DESIGN §1.5).
		if (kind === "move" && p.entityId && !stacked) {
			if (p.op === "item.move") {
				const oldDay = itemDay.get(p.entityId);
				const toDay = str(p.payload, "dayId");
				if (oldDay && oldDay !== toDay)
					push(`from:day:${oldDay}`, {
						...mark,
						origin: {
							entity: key,
							afterId: null,
							toLabel: toDay
								? (dayLabel.get(toDay) ?? "another day")
								: "Unscheduled",
						},
					});
			} else if (p.op === "node.move") {
				// `undefined` = not in the graph (a ghost); `null` = the top level.
				const oldParent = nodeParent.get(p.entityId);
				const toParent = str(p.payload, "parentId");
				if (oldParent !== undefined && oldParent !== toParent)
					push(`from:node:${oldParent ?? "root"}`, {
						...mark,
						origin: {
							entity: key,
							afterId: null,
							toLabel: toParent
								? (nodeName.get(toParent) ?? "another place")
								: "the top level",
						},
					});
			}
		}
	}
	return { graph: simulate(graph, applied), marks, conflicts };
}

// ---------------------------------------------------------------------------
// Simulating reducers (display only: nothing here is ever written back)
// ---------------------------------------------------------------------------

/**
 * A sort key strictly between `a` and `b` (either may be null) under
 * `compareKeys`. Display only: real keys are generated on the server.
 */
export function keyBetween(a: string | null, b: string | null): string {
	if (a === null && b === null) return "a0";
	if (a === null) return (b as string).slice(0, -1);
	if (b?.startsWith(a)) return `${a}!`;
	return `${a}V`;
}

type Sim = {
	nodes: Map<string, GraphNode>;
	items: Map<string, GraphItem>;
	days: Map<string, GraphDay>;
	legs: Map<string, GraphLeg>;
};

const obj = (v: Json | undefined): Record<string, Json> =>
	v && typeof v === "object" && !Array.isArray(v) ? v : {};
const strOr = (v: Json | undefined, d: string | null): string | null =>
	typeof v === "string" ? v : v === null ? null : d;
const numOr = (v: Json | undefined, d: number | null): number | null =>
	typeof v === "number" ? v : v === null ? null : d;

/** The position after `afterId` (or before `beforeId`, else last) among `siblings`. */
function positionAmong(
	siblings: readonly { id: string; position: string }[],
	afterId: string | null,
	beforeId: string | null,
): string {
	const sorted = [...siblings].sort(
		(x, y) => compareKeys(x.position, y.position) || compareKeys(x.id, y.id),
	);
	const last = sorted.length - 1;
	// The index to insert after (-1 = first).
	let i = last;
	if (afterId) {
		const j = sorted.findIndex((s) => s.id === afterId);
		i = j < 0 ? last : j;
	} else if (beforeId) {
		const j = sorted.findIndex((s) => s.id === beforeId);
		i = j < 0 ? last : j - 1;
	}
	return keyBetween(
		sorted[i]?.position ?? null,
		sorted[i + 1]?.position ?? null,
	);
}

/** A known place category, else null (payloads are validated, but stay defensive). */
function asCategory(v: Json | undefined): PlaceCategory | null {
	return typeof v === "string" && v in PLACE_CATEGORIES
		? (v as PlaceCategory)
		: null;
}

const NODE_PATCH_KEYS = [
	"name",
	"localName",
	"description",
	"lat",
	"lng",
	"address",
	"googlePlaceId",
	"osmRef",
	"countryCode",
	"bbox",
	"timeNeededMin",
	"details",
	"status",
	"ideaStatus",
	"shortlistPin",
] as const;

function newNode(
	sim: Sim,
	id: string,
	parentId: string | null,
	seg: Record<string, Json>,
	at: string,
): GraphNode | null {
	if (sim.nodes.has(id) || typeof seg.name !== "string") return null;
	if (parentId && !sim.nodes.has(parentId)) return null;
	const type = (typeof seg.type === "string" ? seg.type : "place") as NodeType;
	const siblings = [...sim.nodes.values()].filter(
		(n) => n.parentId === parentId,
	);
	return {
		id,
		parentId,
		type,
		category: categoryForType(type, asCategory(seg.category)),
		status: "active",
		name: seg.name,
		localName: strOr(seg.localName, null),
		slug: slugify(seg.name, id),
		description: strOr(seg.description, null),
		position: positionAmong(siblings, strOr(seg.afterId, null), null),
		lat: numOr(seg.lat, null),
		lng: numOr(seg.lng, null),
		tz: null,
		countryCode: strOr(seg.countryCode, null),
		address: strOr(seg.address, null),
		googlePlaceId: strOr(seg.googlePlaceId, null),
		osmRef: strOr(seg.osmRef, null),
		bbox: (Array.isArray(seg.bbox) ? seg.bbox : null) as GraphNode["bbox"],
		timeNeededMin: numOr(seg.timeNeededMin, null),
		details: obj(seg.details) as GraphNode["details"],
		priorities: {},
		ratingComments: {},
		updatedAt: at,
	};
}

function reduce(sim: Sim, p: ProposalDto): void {
	const pl = p.payload;
	const at = p.createdAt;
	switch (p.op) {
		case "node.create": {
			const id = strOr(pl.id, null);
			const n = id ? newNode(sim, id, strOr(pl.parentId, null), pl, at) : null;
			if (n) sim.nodes.set(n.id, n);
			return;
		}
		case "node.createPath": {
			const chain = Array.isArray(pl.chain) ? pl.chain : [];
			const ids = Array.isArray(pl.ids) ? pl.ids : [];
			let parent: string | null = null;
			let k = 0;
			for (const raw of chain) {
				const seg = obj(raw);
				if (typeof seg.id === "string") {
					parent = seg.id;
					continue;
				}
				const id = ids[k++];
				if (typeof id !== "string") return;
				const n = newNode(sim, id, parent, seg, at);
				if (!n) return;
				sim.nodes.set(n.id, n);
				parent = n.id;
			}
			return;
		}
		case "node.update": {
			const n = sim.nodes.get(strOr(pl.nodeId, "") ?? "");
			if (!n) return;
			const patch = obj(pl.patch);
			const next: GraphNode = { ...n, updatedAt: at };
			for (const k of NODE_PATCH_KEYS)
				if (k in patch)
					(next as unknown as Record<string, unknown>)[k] = patch[k];
			// `details` merges like the server (a null value deletes that key).
			if ("details" in patch) {
				const merged: Record<string, unknown> = {
					...n.details,
					...obj(patch.details),
				};
				for (const [k, v] of Object.entries(merged))
					if (v === null) delete merged[k];
				next.details = merged as GraphNode["details"];
			}
			if (typeof patch.type === "string") {
				next.type = patch.type as NodeType;
				next.category = categoryForType(next.type, next.category);
			}
			if (asCategory(patch.category))
				next.category = categoryForType(next.type, asCategory(patch.category));
			sim.nodes.set(n.id, next);
			return;
		}
		case "node.move": {
			const n = sim.nodes.get(strOr(pl.nodeId, "") ?? "");
			const parentId = strOr(pl.parentId, null);
			if (!n || (parentId && !sim.nodes.has(parentId))) return;
			const siblings = [...sim.nodes.values()].filter(
				(x) => x.parentId === parentId && x.id !== n.id,
			);
			sim.nodes.set(n.id, {
				...n,
				parentId,
				position: positionAmong(
					siblings,
					strOr(pl.afterId, null),
					strOr(pl.beforeId, null),
				),
				updatedAt: at,
			});
			return;
		}
		case "node.priority": {
			const n = sim.nodes.get(strOr(pl.nodeId, "") ?? "");
			const memberId = strOr(pl.memberId, null);
			if (!n || !memberId) return;
			const priorities = { ...n.priorities };
			const ratingComments = { ...n.ratingComments };
			if (typeof pl.priority === "string")
				priorities[memberId] = pl.priority as Priority;
			else delete priorities[memberId];
			if (typeof pl.comment === "string") ratingComments[memberId] = pl.comment;
			else if (pl.comment === null) delete ratingComments[memberId];
			sim.nodes.set(n.id, { ...n, priorities, ratingComments });
			return;
		}
		case "item.create": {
			const id = strOr(pl.id, null);
			if (!id || sim.items.has(id)) return;
			const dayId = strOr(pl.dayId, null);
			const nodeId = strOr(pl.nodeId, null);
			if (dayId && !sim.days.has(dayId)) return;
			const node = nodeId ? sim.nodes.get(nodeId) : undefined;
			if (nodeId && !node) return;
			const siblings = [...sim.items.values()].filter((i) => i.dayId === dayId);
			sim.items.set(id, {
				id,
				dayId,
				nodeId,
				title: strOr(pl.title, null),
				note: strOr(pl.note, null),
				position: positionAmong(
					siblings,
					strOr(pl.afterItemId, null),
					strOr(pl.beforeItemId, null),
				),
				durationMin:
					numOr(pl.durationMin, null) ??
					(node ? defaultItemDuration(node) : 60),
				pinnedStart: strOr(pl.pinnedStart, null),
				fixedDate: false,
				assigneeIds: [],
				updatedAt: at,
			});
			return;
		}
		case "item.update": {
			const it = sim.items.get(strOr(pl.itemId, "") ?? "");
			if (!it) return;
			const patch = obj(pl.patch);
			const next: GraphItem = { ...it, updatedAt: at };
			if ("durationMin" in patch)
				next.durationMin = numOr(patch.durationMin, it.durationMin) ?? 0;
			if ("pinnedStart" in patch)
				next.pinnedStart = strOr(patch.pinnedStart, it.pinnedStart);
			if ("title" in patch) next.title = strOr(patch.title, it.title);
			if ("note" in patch) next.note = strOr(patch.note, it.note);
			if (typeof patch.fixedDate === "boolean")
				next.fixedDate = patch.fixedDate;
			if ("nodeId" in patch) {
				const nodeId = strOr(patch.nodeId, it.nodeId);
				if (nodeId && !sim.nodes.has(nodeId)) return;
				next.nodeId = nodeId;
			}
			sim.items.set(it.id, next);
			return;
		}
		case "item.move": {
			const it = sim.items.get(strOr(pl.itemId, "") ?? "");
			const dayId = strOr(pl.dayId, null);
			if (!it || (dayId && !sim.days.has(dayId))) return;
			const siblings = [...sim.items.values()].filter(
				(i) => i.dayId === dayId && i.id !== it.id,
			);
			sim.items.set(it.id, {
				...it,
				dayId,
				position: positionAmong(
					siblings,
					strOr(pl.afterItemId, null),
					strOr(pl.beforeItemId, null),
				),
				updatedAt: at,
			});
			return;
		}
		case "item.assignees": {
			const it = sim.items.get(strOr(pl.itemId, "") ?? "");
			if (!it || !Array.isArray(pl.memberIds)) return;
			sim.items.set(it.id, {
				...it,
				assigneeIds: pl.memberIds.filter(
					(m): m is string => typeof m === "string",
				),
			});
			return;
		}
		case "day.update": {
			const d = sim.days.get(strOr(pl.dayId, "") ?? "");
			if (!d) return;
			sim.days.set(d.id, {
				...d,
				startTime: strOr(pl.startTime, d.startTime) ?? d.startTime,
				title: "title" in pl ? strOr(pl.title, null) : d.title,
				updatedAt: at,
			});
			return;
		}
		case "day.stay": {
			const from = sim.days.get(strOr(pl.fromDayId, "") ?? "");
			const to = sim.days.get(strOr(pl.toDayId, null) ?? "") ?? from;
			const nodeId = strOr(pl.nodeId, null);
			if (!from || !to || (nodeId && !sim.nodes.has(nodeId))) return;
			for (const d of sim.days.values())
				if (d.date >= from.date && d.date <= to.date)
					sim.days.set(d.id, { ...d, nightNodeId: nodeId, updatedAt: at });
			return;
		}
		case "leg.set": {
			const target = obj(pl.target);
			const leg = [...sim.legs.values()].find((l) =>
				target.kind === "pair"
					? l.kind === "pair" &&
						l.fromItemId === target.fromItemId &&
						l.toItemId === target.toItemId
					: target.kind === "stay" &&
						l.stayDayId === target.dayId &&
						l.kind === (target.end === "start" ? "stay_start" : "stay_end"),
			);
			if (!leg) return;
			const patch = obj(pl.patch);
			const next: GraphLeg = { ...leg, updatedAt: at };
			if ("mode" in patch)
				next.mode = strOr(patch.mode, leg.mode) as GraphLeg["mode"];
			if ("durationMin" in patch)
				next.durationMin = numOr(patch.durationMin, leg.durationMin);
			if ("distanceM" in patch)
				next.distanceM = numOr(patch.distanceM, leg.distanceM);
			if (typeof patch.isEdited === "boolean") next.isEdited = patch.isEdited;
			sim.legs.set(leg.id, next);
			return;
		}
		case "leg.assignees": {
			const leg = sim.legs.get(strOr(pl.legId, "") ?? "");
			if (!leg || !Array.isArray(pl.memberIds)) return;
			sim.legs.set(leg.id, {
				...leg,
				assigneeIds: pl.memberIds.filter(
					(m): m is string => typeof m === "string",
				),
			});
			return;
		}
		default:
			// node.delete / item.delete keep the row (marked); the rest are marks only.
			return;
	}
}

/** The graph with `applied` simulated on a copy (the input is never mutated). */
function simulate(
	graph: TripGraph,
	applied: readonly ProposalDto[],
): TripGraph {
	const todo = applied.filter((p) => SIMULATED.has(p.op));
	if (!todo.length) return graph;
	const sim: Sim = {
		nodes: new Map(graph.nodes.map((n) => [n.id, n])),
		items: new Map(graph.items.map((i) => [i.id, i])),
		days: new Map(graph.days.map((d) => [d.id, d])),
		legs: new Map(graph.legs.map((l) => [l.id, l])),
	};
	for (const p of todo) reduce(sim, p);
	const same = <T extends { id: string }>(
		xs: readonly T[],
		m: Map<string, T>,
	) => xs.length === m.size && xs.every((x) => m.get(x.id) === x);
	if (
		same(graph.nodes, sim.nodes) &&
		same(graph.items, sim.items) &&
		same(graph.days, sim.days) &&
		same(graph.legs, sim.legs)
	)
		return graph;
	return {
		...graph,
		nodes: [...sim.nodes.values()],
		items: [...sim.items.values()],
		days: [...sim.days.values()],
		legs: [...sim.legs.values()],
	};
}

/** Ops with a reducer (the rest are marks only). */
export const SIMULATED: ReadonlySet<ProposalOp> = new Set<ProposalOp>([
	"node.create",
	"node.createPath",
	"node.update",
	"node.move",
	"node.priority",
	"item.create",
	"item.update",
	"item.move",
	"item.assignees",
	"day.update",
	"day.stay",
	"leg.set",
	"leg.assignees",
]);

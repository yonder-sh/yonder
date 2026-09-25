/**
 * The F-owned proposable defs (EXTENSIONS §3.3–§3.4): one per op, each an
 * input schema, a trip resolver, the entity it touches and a DB-only core
 * (`src/server/cores/*`). WP defs live in `src/features/<wp>/server/proposable.server.ts`.
 */
import type { Json } from "@/lib/schemas/proposals";
import { fail } from "@/server/authz/session.server";
import {
	DeleteDayInput,
	deleteDayCore,
	InsertDayInput,
	insertDayCore,
	MoveDayInput,
	moveDayCore,
	SetDayStayInput,
	setDayStayCore,
	UpdateDayInput,
	updateDayCore,
} from "@/server/cores/days.server";
import {
	CreateItemInput,
	createItemCore,
	DeleteItemInput,
	deleteItemCore,
	MoveItemInput,
	moveItemCore,
	SetItemAssigneesInput,
	setItemAssigneesCore,
	UpdateItemInput,
	updateItemCore,
} from "@/server/cores/items.server";
import {
	DeleteLegInput,
	deleteLegCore,
	RelinkLegInput,
	redactSetLeg,
	relinkLegCore,
	SetLegAssigneesInput,
	SetLegInput,
	setLegAssigneesCore,
	setLegCore,
} from "@/server/cores/legs.server";
import {
	CreateNodeInput,
	CreateNodePathInput,
	createNodeCore,
	createNodePathCore,
	DeleteNodeInput,
	deleteNodeCore,
	MoveNodeInput,
	moveNodeCore,
	SetNodePriorityInput,
	setNodePriorityCore,
	UpdateNodeInput,
	updateNodeCore,
} from "@/server/cores/nodes.server";
import {
	SetTripDatesInput,
	ShiftTripDatesInput,
	setTripDatesCore,
	shiftTripDatesCore,
} from "@/server/cores/trips.server";
import { legTargetTrip, rowTrip } from "./trip-of.server";
import { defineProposable } from "./types";

/** The trip of a trip-scoped create (`tripId` in the input); the gate checks access. */
const inputTrip = async (i: { tripId: string }) => i.tripId;

/**
 * Amends (EXTENSIONS §3.4 step 4): an edit of the author's OWN proposed create
 * folds into that create's payload. A result the create's strict schema
 * refuses (e.g. a field the create can't carry) makes the gate chain a new
 * proposal instead.
 */
function asObject(v: Json): Record<string, Json> {
	return v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {};
}
/** `{ ...create, ...patch }`, where a null in the patch removes the key. */
function mergeInto(create: Json, patch: Record<string, unknown>): Json {
	const out = asObject(create);
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		if (v === null) delete out[k];
		else out[k] = v as Json;
	}
	return out;
}

const patchFields = (i: { patch: object }) => Object.keys(i.patch);

export const defs = {
	// ---- nodes ---------------------------------------------------------------
	"node.create": defineProposable({
		input: CreateNodeInput,
		tripIdOf: inputTrip,
		entityOf: (i) => ({ kind: "node", id: i.id ?? null }),
		fields: () => [],
		core: createNodeCore,
	}),
	"node.createPath": defineProposable({
		input: CreateNodePathInput,
		tripIdOf: inputTrip,
		entityOf: (i) => ({ kind: "node", id: i.ids?.at(-1) ?? null }),
		fields: () => [],
		core: createNodePathCore,
	}),
	"node.update": defineProposable({
		input: UpdateNodeInput,
		tripIdOf: (i, exec) => rowTrip(exec, "nodes", i.nodeId),
		entityOf: (i) => ({ kind: "node", id: i.nodeId }),
		fields: patchFields,
		amend: { merge: (create, i) => mergeInto(create, i.patch) },
		core: updateNodeCore,
	}),
	"node.move": defineProposable({
		input: MoveNodeInput,
		tripIdOf: (i, exec) => rowTrip(exec, "nodes", i.nodeId),
		entityOf: (i) => ({ kind: "node", id: i.nodeId }),
		fields: () => ["parentId", "position"],
		amend: {
			merge: (create, i) =>
				mergeInto(create, { parentId: i.parentId, afterId: i.afterId ?? null }),
		},
		core: moveNodeCore,
	}),
	"node.delete": defineProposable({
		input: DeleteNodeInput,
		tripIdOf: (i, exec) => rowTrip(exec, "nodes", i.nodeId),
		entityOf: (i) => ({ kind: "node", id: i.nodeId }),
		fields: () => ["deletedAt"],
		core: deleteNodeCore,
	}),
	"node.priority": defineProposable({
		input: SetNodePriorityInput,
		tripIdOf: (i, exec) => rowTrip(exec, "nodes", i.nodeId),
		entityOf: (i) => ({ kind: "node", id: i.nodeId }),
		fields: (i) => [`priority:${i.memberId}`],
		// A suggester sets THEIR OWN priority (and comment) directly
		// (EXTENSIONS §3.3 note ²); so does a rater, who can do nothing else
		// (PLACES §1c: anyone else's rating is FORBIDDEN for them). Plain
		// viewers have neither `propose` nor `rate`: FORBIDDEN.
		directIf: async (i, access) =>
			access.memberId !== null && access.memberId === i.memberId,
		directCap: "rate",
		core: setNodePriorityCore,
	}),

	// ---- items ---------------------------------------------------------------
	"item.create": defineProposable({
		input: CreateItemInput,
		tripIdOf: inputTrip,
		entityOf: (i) => ({ kind: "item", id: i.id ?? null }),
		fields: () => [],
		core: createItemCore,
	}),
	"item.update": defineProposable({
		input: UpdateItemInput,
		tripIdOf: (i, exec) => rowTrip(exec, "items", i.itemId),
		entityOf: (i) => ({ kind: "item", id: i.itemId }),
		fields: patchFields,
		amend: { merge: (create, i) => mergeInto(create, i.patch) },
		core: updateItemCore,
	}),
	"item.move": defineProposable({
		input: MoveItemInput,
		tripIdOf: (i, exec) => rowTrip(exec, "items", i.itemId),
		entityOf: (i) => ({ kind: "item", id: i.itemId }),
		fields: () => ["dayId", "position"],
		amend: {
			merge: (create, i) => {
				const out = asObject(create);
				out.dayId = i.dayId;
				delete out.afterItemId;
				delete out.beforeItemId;
				if (i.afterItemId) out.afterItemId = i.afterItemId;
				if (i.beforeItemId) out.beforeItemId = i.beforeItemId;
				return out;
			},
		},
		core: moveItemCore,
	}),
	"item.delete": defineProposable({
		input: DeleteItemInput,
		tripIdOf: (i, exec) => rowTrip(exec, "items", i.itemId),
		entityOf: (i) => ({ kind: "item", id: i.itemId }),
		fields: () => ["deletedAt"],
		core: deleteItemCore,
	}),
	"item.assignees": defineProposable({
		input: SetItemAssigneesInput,
		tripIdOf: (i, exec) => rowTrip(exec, "items", i.itemId),
		entityOf: (i) => ({ kind: "item", id: i.itemId }),
		fields: () => ["assigneeIds"],
		core: setItemAssigneesCore,
	}),

	// ---- days and trip dates -------------------------------------------------
	"day.update": defineProposable({
		input: UpdateDayInput,
		tripIdOf: (i, exec) => rowTrip(exec, "trip_days", i.dayId),
		entityOf: (i) => ({ kind: "day", id: i.dayId }),
		fields: (i) =>
			(["startTime", "title"] as const).filter((k) => i[k] !== undefined),
		core: updateDayCore,
	}),
	"day.stay": defineProposable({
		input: SetDayStayInput,
		tripIdOf: (i, exec) => rowTrip(exec, "trip_days", i.fromDayId),
		entityOf: (i) => ({ kind: "day", id: i.fromDayId }),
		fields: () => ["nightNodeId"],
		core: setDayStayCore,
	}),
	"day.insert": defineProposable({
		input: InsertDayInput,
		tripIdOf: async (i, exec) => {
			const tripId = await rowTrip(exec, "trip_days", i.dayId);
			if (tripId !== i.tripId) fail("NOT_FOUND");
			return tripId;
		},
		entityOf: (i) => ({ kind: "day", id: i.ids?.[0] ?? null }),
		fields: () => [],
		core: insertDayCore,
	}),
	"day.move": defineProposable({
		input: MoveDayInput,
		tripIdOf: (i, exec) => rowTrip(exec, "trip_days", i.dayId),
		entityOf: (i) => ({ kind: "day", id: i.dayId }),
		fields: () => ["date"],
		core: moveDayCore,
	}),
	"day.delete": defineProposable({
		input: DeleteDayInput,
		tripIdOf: (i, exec) => rowTrip(exec, "trip_days", i.dayId),
		entityOf: (i) => ({ kind: "day", id: i.dayId }),
		fields: () => ["deleted"],
		core: deleteDayCore,
	}),
	"trip.dates": defineProposable({
		input: SetTripDatesInput,
		tripIdOf: inputTrip,
		entityOf: () => ({ kind: "trip", id: null }),
		fields: () => ["startDate", "endDate"],
		core: setTripDatesCore,
	}),
	"trip.shift": defineProposable({
		input: ShiftTripDatesInput,
		tripIdOf: inputTrip,
		entityOf: () => ({ kind: "trip", id: null }),
		fields: () => ["startDate", "endDate"],
		core: shiftTripDatesCore,
	}),

	// ---- legs ----------------------------------------------------------------
	"leg.set": defineProposable({
		input: SetLegInput,
		tripIdOf: (i, exec) => legTargetTrip(exec, i.target),
		entityOf: () => ({ kind: "leg", id: null }),
		fields: (i) => Object.keys(i.patch),
		redact: redactSetLeg,
		core: setLegCore,
	}),
	"leg.relink": defineProposable({
		input: RelinkLegInput,
		tripIdOf: (i, exec) => rowTrip(exec, "legs", i.legId),
		entityOf: (i) => ({ kind: "leg", id: i.legId }),
		fields: () => ["fromItemId", "toItemId"],
		core: relinkLegCore,
	}),
	"leg.delete": defineProposable({
		input: DeleteLegInput,
		tripIdOf: (i, exec) => rowTrip(exec, "legs", i.legId),
		entityOf: (i) => ({ kind: "leg", id: i.legId }),
		fields: () => ["deleted"],
		core: deleteLegCore,
	}),
	"leg.assignees": defineProposable({
		input: SetLegAssigneesInput,
		tripIdOf: (i, exec) => rowTrip(exec, "legs", i.legId),
		entityOf: (i) => ({ kind: "leg", id: i.legId }),
		fields: () => ["assigneeIds"],
		core: setLegAssigneesCore,
	}),
};

/** The F ops, for tests (every one must be in the registry). */
export const F_OPS = Object.keys(defs) as (keyof typeof defs)[];

/**
 * Every proposable op → its capability and its def (EXTENSIONS §3.4; the
 * capability is `editTripDates` for `trip.dates`/`trip.shift`, `edit` for
 * everything else, footnote ³ of §3.3). Typed
 * `satisfies Record<ProposalOp, …>`, so an op can't be missing. Defs load
 * lazily: one fixed file per owner (F: `defs.server.ts`; WPs:
 * `src/features/<wp>/server/proposable.server.ts`).
 */
import type { Capability } from "@/lib/auth/roles";
import type { ProposalOp } from "@/lib/schemas/proposals";
import type { ProposableDef } from "./types";

const f = () => import("./defs.server").then((m) => m.defs);
const transit = () =>
	import("@/features/transit/server/proposable.server").then((m) => m.defs);
const lists = () =>
	import("@/features/lists/server/proposable.server").then((m) => m.defs);
const media = () =>
	import("@/features/media/server/proposable.server").then((m) => m.defs);
const insights = () =>
	import("@/features/insights/server/proposable.server").then((m) => m.defs);
const suggest = () =>
	import("@/features/suggest/server/proposable.server").then((m) => m.defs);

export const REGISTRY = {
	// F
	"node.create": {
		capability: "edit",
		load: () => f().then((d) => d["node.create"]),
	},
	"node.createPath": {
		capability: "edit",
		load: () => f().then((d) => d["node.createPath"]),
	},
	"node.update": {
		capability: "edit",
		load: () => f().then((d) => d["node.update"]),
	},
	"node.move": {
		capability: "edit",
		load: () => f().then((d) => d["node.move"]),
	},
	"node.delete": {
		capability: "edit",
		load: () => f().then((d) => d["node.delete"]),
	},
	"node.priority": {
		capability: "edit",
		load: () => f().then((d) => d["node.priority"]),
	},
	"item.create": {
		capability: "edit",
		load: () => f().then((d) => d["item.create"]),
	},
	"item.update": {
		capability: "edit",
		load: () => f().then((d) => d["item.update"]),
	},
	"item.move": {
		capability: "edit",
		load: () => f().then((d) => d["item.move"]),
	},
	"item.delete": {
		capability: "edit",
		load: () => f().then((d) => d["item.delete"]),
	},
	"item.assignees": {
		capability: "edit",
		load: () => f().then((d) => d["item.assignees"]),
	},
	"day.update": {
		capability: "edit",
		load: () => f().then((d) => d["day.update"]),
	},
	"day.stay": {
		capability: "edit",
		load: () => f().then((d) => d["day.stay"]),
	},
	"day.insert": {
		capability: "edit",
		load: () => f().then((d) => d["day.insert"]),
	},
	"day.move": {
		capability: "edit",
		load: () => f().then((d) => d["day.move"]),
	},
	"day.delete": {
		capability: "edit",
		load: () => f().then((d) => d["day.delete"]),
	},
	"trip.dates": {
		capability: "editTripDates",
		load: () => f().then((d) => d["trip.dates"]),
	},
	"trip.shift": {
		capability: "editTripDates",
		load: () => f().then((d) => d["trip.shift"]),
	},
	"leg.set": { capability: "edit", load: () => f().then((d) => d["leg.set"]) },
	"leg.relink": {
		capability: "edit",
		load: () => f().then((d) => d["leg.relink"]),
	},
	"leg.delete": {
		capability: "edit",
		load: () => f().then((d) => d["leg.delete"]),
	},
	"leg.assignees": {
		capability: "edit",
		load: () => f().then((d) => d["leg.assignees"]),
	},
	// WP-Transit
	"leg.resetEstimate": {
		capability: "edit",
		load: () => transit().then((d) => d["leg.resetEstimate"]),
	},
	"transit.route.save": {
		capability: "edit",
		load: () => transit().then((d) => d["transit.route.save"]),
	},
	"transit.route.update": {
		capability: "edit",
		load: () => transit().then((d) => d["transit.route.update"]),
	},
	"transit.route.delete": {
		capability: "edit",
		load: () => transit().then((d) => d["transit.route.delete"]),
	},
	"transit.details": {
		capability: "edit",
		load: () => transit().then((d) => d["transit.details"]),
	},
	"flight.save": {
		capability: "edit",
		load: () => transit().then((d) => d["flight.save"]),
	},
	"flight.create": {
		capability: "edit",
		load: () => transit().then((d) => d["flight.create"]),
	},
	// WP-Insights
	"node.hours": {
		capability: "edit",
		load: () => insights().then((d) => d["node.hours"]),
	},
	// WP-Lists
	"list.create": {
		capability: "edit",
		load: () => lists().then((d) => d["list.create"]),
	},
	"list.update": {
		capability: "edit",
		load: () => lists().then((d) => d["list.update"]),
	},
	"list.move": {
		capability: "edit",
		load: () => lists().then((d) => d["list.move"]),
	},
	"list.status": {
		capability: "edit",
		load: () => lists().then((d) => d["list.status"]),
	},
	"list.targets": {
		capability: "edit",
		load: () => lists().then((d) => d["list.targets"]),
	},
	"list.assignees": {
		capability: "edit",
		load: () => lists().then((d) => d["list.assignees"]),
	},
	"list.delete": {
		capability: "edit",
		load: () => lists().then((d) => d["list.delete"]),
	},
	// WP-Media
	"attachment.link": {
		capability: "edit",
		load: () => media().then((d) => d["attachment.link"]),
	},
	"attachment.update": {
		capability: "edit",
		load: () => media().then((d) => d["attachment.update"]),
	},
	"attachment.delete": {
		capability: "edit",
		load: () => media().then((d) => d["attachment.delete"]),
	},
	// WP-Suggest
	"note.append": {
		capability: "edit",
		load: () => suggest().then((d) => d["note.append"]),
	},
} as const;

/**
 * Compile-time completeness check: every ProposalOp has an entry with a
 * capability and a def (checked here instead of with `satisfies`, which
 * would widen each loader's inferred def type).
 */
type RegistryEntry = {
	capability: Capability;
	// biome-ignore lint/suspicious/noExplicitAny: defs differ per op; each entry keeps its exact type.
	load: () => Promise<ProposableDef<any, any>>;
};
const _complete: Record<ProposalOp, RegistryEntry> = REGISTRY;
void _complete;

/** The def type of one op (exact input and result types). */
export type DefOf<Op extends ProposalOp> = Awaited<
	ReturnType<(typeof REGISTRY)[Op]["load"]>
>;

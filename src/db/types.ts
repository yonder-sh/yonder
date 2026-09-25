/**
 * Row types for every table (`X` = a selected row, `NewX` = an insert), plus the
 * enum unions and JSONB shapes, so feature code has one import for data types.
 * Type-only: safe to import from client code (nothing here pulls in `pg`).
 */
import type {
	account,
	activityLog,
	attachments,
	itemAssignees,
	items,
	legAssignees,
	legs,
	listItemAssignees,
	listItems,
	listItemTargets,
	mentions,
	nodePriorities,
	nodes,
	session,
	shareGrants,
	shareLinks,
	tripDays,
	tripMembers,
	trips,
	user,
	verification,
	yjsDocuments,
} from "./schema";

export type { AttachmentMeta } from "../lib/schemas/attachments";
export type {
	AttachmentKind,
	AttachmentStatus,
	LegKind,
	LegMode,
	LegSource,
	ListItemStatus,
	ListKind,
	MemberStatus,
	NodeStatus,
	NodeType,
	PlaceCategory,
	Priority,
	ShareRole,
	TripRole,
} from "../lib/schemas/enums";
export type {
	FlightDetails,
	LegDetails,
	StoredLegDetails,
	TransitRoute,
} from "../lib/schemas/legs";
export type { BBox, NodeDetails } from "../lib/schemas/nodes";
export type { BundleTarget, LegTarget } from "../lib/schemas/targets";
export type { TripSettings } from "../lib/schemas/trips";

// Better Auth
export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type Session = typeof session.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Verification = typeof verification.$inferSelect;

// Trips and access
export type Trip = typeof trips.$inferSelect;
export type NewTrip = typeof trips.$inferInsert;
export type TripMember = typeof tripMembers.$inferSelect;
export type NewTripMember = typeof tripMembers.$inferInsert;
export type ShareLink = typeof shareLinks.$inferSelect;
export type NewShareLink = typeof shareLinks.$inferInsert;
export type ShareGrant = typeof shareGrants.$inferSelect;
export type NewShareGrant = typeof shareGrants.$inferInsert;

// Hierarchy
/** Named TripNode, not Node, to avoid shadowing the DOM `Node` type. */
export type TripNode = typeof nodes.$inferSelect;
export type NewTripNode = typeof nodes.$inferInsert;
export type NodePriority = typeof nodePriorities.$inferSelect;
export type NewNodePriority = typeof nodePriorities.$inferInsert;

// Timeline
export type TripDay = typeof tripDays.$inferSelect;
export type NewTripDay = typeof tripDays.$inferInsert;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type ItemAssignee = typeof itemAssignees.$inferSelect;
export type Leg = typeof legs.$inferSelect;
export type NewLeg = typeof legs.$inferInsert;
export type LegAssignee = typeof legAssignees.$inferSelect;

// Bundles
export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
export type ListItem = typeof listItems.$inferSelect;
export type NewListItem = typeof listItems.$inferInsert;
export type ListItemTarget = typeof listItemTargets.$inferSelect;
export type ListItemAssignee = typeof listItemAssignees.$inferSelect;
export type YjsDocument = typeof yjsDocuments.$inferSelect;
export type NewYjsDocument = typeof yjsDocuments.$inferInsert;
export type Mention = typeof mentions.$inferSelect;
export type NewMention = typeof mentions.$inferInsert;

// Misc
export type ActivityLogEntry = typeof activityLog.$inferSelect;
export type NewActivityLogEntry = typeof activityLog.$inferInsert;

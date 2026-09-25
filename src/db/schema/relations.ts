/**
 * Drizzle relations for `db.query.*` (relational queries) and Better Auth's
 * adapter joins. The app's own code uses the core query builder (D1); these
 * mirror the composite, trip-isolating FKs, so a relation never crosses trips.
 */
import { relations } from "drizzle-orm";
import { user } from "./auth";
import {
	attachments,
	listItemAssignees,
	listItems,
	listItemTargets,
	mentions,
	yjsDocuments,
} from "./bundle";
import { activityLog, tripSeen } from "./misc";
import {
	budgetLines,
	expenseFees,
	expenseLineMembers,
	expenseLines,
	expensePaymentPayers,
	expensePayments,
	expenseShares,
	expenses,
	settlements,
} from "./money";
import { nodePriorities, nodes } from "./nodes";
import { proposals } from "./proposals";
import { itemAssignees, items, legAssignees, legs, tripDays } from "./timeline";
import { shareGrants, shareLinks, tripMembers, trips } from "./trips";

export const tripsRelations = relations(trips, ({ one, many }) => ({
	createdByUser: one(user, {
		fields: [trips.createdBy],
		references: [user.id],
	}),
	members: many(tripMembers),
	shareLinks: many(shareLinks),
	days: many(tripDays),
	nodes: many(nodes),
	items: many(items),
	legs: many(legs),
	attachments: many(attachments),
	listItems: many(listItems),
	notes: many(yjsDocuments),
	mentions: many(mentions),
	activity: many(activityLog),
	proposals: many(proposals),
	expenses: many(expenses),
	settlements: many(settlements),
	budgetLines: many(budgetLines),
	seen: many(tripSeen),
}));

export const tripMembersRelations = relations(tripMembers, ({ one }) => ({
	trip: one(trips, { fields: [tripMembers.tripId], references: [trips.id] }),
	user: one(user, { fields: [tripMembers.userId], references: [user.id] }),
}));

export const shareLinksRelations = relations(shareLinks, ({ one, many }) => ({
	trip: one(trips, { fields: [shareLinks.tripId], references: [trips.id] }),
	grants: many(shareGrants),
}));

export const shareGrantsRelations = relations(shareGrants, ({ one }) => ({
	link: one(shareLinks, {
		fields: [shareGrants.tripId, shareGrants.shareLinkId],
		references: [shareLinks.tripId, shareLinks.id],
	}),
	user: one(user, { fields: [shareGrants.userId], references: [user.id] }),
}));

export const nodesRelations = relations(nodes, ({ one, many }) => ({
	trip: one(trips, { fields: [nodes.tripId], references: [trips.id] }),
	parent: one(nodes, {
		fields: [nodes.tripId, nodes.parentId],
		references: [nodes.tripId, nodes.id],
		relationName: "nodeTree",
	}),
	children: many(nodes, { relationName: "nodeTree" }),
	priorities: many(nodePriorities),
	items: many(items),
	attachments: many(attachments),
	listItems: many(listItems),
	notes: many(yjsDocuments),
}));

export const nodePrioritiesRelations = relations(nodePriorities, ({ one }) => ({
	node: one(nodes, {
		fields: [nodePriorities.tripId, nodePriorities.nodeId],
		references: [nodes.tripId, nodes.id],
	}),
	member: one(tripMembers, {
		fields: [nodePriorities.tripId, nodePriorities.memberId],
		references: [tripMembers.tripId, tripMembers.id],
	}),
}));

export const tripDaysRelations = relations(tripDays, ({ one, many }) => ({
	trip: one(trips, { fields: [tripDays.tripId], references: [trips.id] }),
	nightNode: one(nodes, {
		fields: [tripDays.tripId, tripDays.nightNodeId],
		references: [nodes.tripId, nodes.id],
	}),
	items: many(items),
	stayLegs: many(legs),
	attachments: many(attachments),
	notes: many(yjsDocuments),
}));

export const itemsRelations = relations(items, ({ one, many }) => ({
	trip: one(trips, { fields: [items.tripId], references: [trips.id] }),
	day: one(tripDays, {
		fields: [items.tripId, items.dayId],
		references: [tripDays.tripId, tripDays.id],
	}),
	node: one(nodes, {
		fields: [items.tripId, items.nodeId],
		references: [nodes.tripId, nodes.id],
	}),
	assignees: many(itemAssignees),
	legsFrom: many(legs, { relationName: "legFrom" }),
	legsTo: many(legs, { relationName: "legTo" }),
	attachments: many(attachments),
	listItems: many(listItems),
	notes: many(yjsDocuments),
}));

export const itemAssigneesRelations = relations(itemAssignees, ({ one }) => ({
	item: one(items, {
		fields: [itemAssignees.tripId, itemAssignees.itemId],
		references: [items.tripId, items.id],
	}),
	member: one(tripMembers, {
		fields: [itemAssignees.tripId, itemAssignees.memberId],
		references: [tripMembers.tripId, tripMembers.id],
	}),
}));

export const legsRelations = relations(legs, ({ one, many }) => ({
	trip: one(trips, { fields: [legs.tripId], references: [trips.id] }),
	fromItem: one(items, {
		fields: [legs.tripId, legs.fromItemId],
		references: [items.tripId, items.id],
		relationName: "legFrom",
	}),
	toItem: one(items, {
		fields: [legs.tripId, legs.toItemId],
		references: [items.tripId, items.id],
		relationName: "legTo",
	}),
	stayDay: one(tripDays, {
		fields: [legs.tripId, legs.stayDayId],
		references: [tripDays.tripId, tripDays.id],
	}),
	assignees: many(legAssignees),
	attachments: many(attachments),
	listItems: many(listItems),
	notes: many(yjsDocuments),
}));

export const legAssigneesRelations = relations(legAssignees, ({ one }) => ({
	leg: one(legs, {
		fields: [legAssignees.tripId, legAssignees.legId],
		references: [legs.tripId, legs.id],
	}),
	member: one(tripMembers, {
		fields: [legAssignees.tripId, legAssignees.memberId],
		references: [tripMembers.tripId, tripMembers.id],
	}),
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
	trip: one(trips, { fields: [attachments.tripId], references: [trips.id] }),
	node: one(nodes, {
		fields: [attachments.tripId, attachments.nodeId],
		references: [nodes.tripId, nodes.id],
	}),
	leg: one(legs, {
		fields: [attachments.tripId, attachments.legId],
		references: [legs.tripId, legs.id],
	}),
	item: one(items, {
		fields: [attachments.tripId, attachments.itemId],
		references: [items.tripId, items.id],
	}),
	day: one(tripDays, {
		fields: [attachments.tripId, attachments.dayId],
		references: [tripDays.tripId, tripDays.id],
	}),
}));

export const listItemsRelations = relations(listItems, ({ one, many }) => ({
	trip: one(trips, { fields: [listItems.tripId], references: [trips.id] }),
	node: one(nodes, {
		fields: [listItems.tripId, listItems.nodeId],
		references: [nodes.tripId, nodes.id],
	}),
	leg: one(legs, {
		fields: [listItems.tripId, listItems.legId],
		references: [legs.tripId, legs.id],
	}),
	item: one(items, {
		fields: [listItems.tripId, listItems.itemId],
		references: [items.tripId, items.id],
	}),
	day: one(tripDays, {
		fields: [listItems.tripId, listItems.dayId],
		references: [tripDays.tripId, tripDays.id],
		relationName: "listItemDay",
	}),
	dueDay: one(tripDays, {
		fields: [listItems.tripId, listItems.dueDayId],
		references: [tripDays.tripId, tripDays.id],
		relationName: "listItemDueDay",
	}),
	targets: many(listItemTargets),
	assignees: many(listItemAssignees),
}));

export const listItemTargetsRelations = relations(
	listItemTargets,
	({ one }) => ({
		listItem: one(listItems, {
			fields: [listItemTargets.tripId, listItemTargets.listItemId],
			references: [listItems.tripId, listItems.id],
		}),
		node: one(nodes, {
			fields: [listItemTargets.tripId, listItemTargets.nodeId],
			references: [nodes.tripId, nodes.id],
		}),
	}),
);

export const listItemAssigneesRelations = relations(
	listItemAssignees,
	({ one }) => ({
		listItem: one(listItems, {
			fields: [listItemAssignees.tripId, listItemAssignees.listItemId],
			references: [listItems.tripId, listItems.id],
		}),
		member: one(tripMembers, {
			fields: [listItemAssignees.tripId, listItemAssignees.memberId],
			references: [tripMembers.tripId, tripMembers.id],
		}),
	}),
);

export const yjsDocumentsRelations = relations(
	yjsDocuments,
	({ one, many }) => ({
		trip: one(trips, {
			fields: [yjsDocuments.tripId],
			references: [trips.id],
		}),
		node: one(nodes, {
			fields: [yjsDocuments.tripId, yjsDocuments.nodeId],
			references: [nodes.tripId, nodes.id],
		}),
		leg: one(legs, {
			fields: [yjsDocuments.tripId, yjsDocuments.legId],
			references: [legs.tripId, legs.id],
		}),
		item: one(items, {
			fields: [yjsDocuments.tripId, yjsDocuments.itemId],
			references: [items.tripId, items.id],
		}),
		day: one(tripDays, {
			fields: [yjsDocuments.tripId, yjsDocuments.dayId],
			references: [tripDays.tripId, tripDays.id],
		}),
		mentions: many(mentions),
	}),
);

export const mentionsRelations = relations(mentions, ({ one }) => ({
	trip: one(trips, { fields: [mentions.tripId], references: [trips.id] }),
	member: one(tripMembers, {
		fields: [mentions.tripId, mentions.memberId],
		references: [tripMembers.tripId, tripMembers.id],
	}),
	doc: one(yjsDocuments, {
		fields: [mentions.docName],
		references: [yjsDocuments.name],
	}),
	listItem: one(listItems, {
		fields: [mentions.tripId, mentions.listItemId],
		references: [listItems.tripId, listItems.id],
	}),
	noteItem: one(items, {
		fields: [mentions.tripId, mentions.noteItemId],
		references: [items.tripId, items.id],
	}),
}));

export const activityLogRelations = relations(activityLog, ({ one }) => ({
	trip: one(trips, { fields: [activityLog.tripId], references: [trips.id] }),
}));

// ---- F-ext0 (EXTENSIONS §3.2, §8.1; ADDENDUM §6–§7) ----

export const tripSeenRelations = relations(tripSeen, ({ one }) => ({
	trip: one(trips, { fields: [tripSeen.tripId], references: [trips.id] }),
	user: one(user, { fields: [tripSeen.userId], references: [user.id] }),
}));

export const proposalsRelations = relations(proposals, ({ one }) => ({
	trip: one(trips, { fields: [proposals.tripId], references: [trips.id] }),
	author: one(user, {
		fields: [proposals.authorUserId],
		references: [user.id],
	}),
}));

export const expensesRelations = relations(expenses, ({ one, many }) => ({
	trip: one(trips, { fields: [expenses.tripId], references: [trips.id] }),
	payments: many(expensePayments),
	shares: many(expenseShares),
	lines: many(expenseLines),
	fees: many(expenseFees),
}));

export const expensePaymentsRelations = relations(
	expensePayments,
	({ one, many }) => ({
		expense: one(expenses, {
			fields: [expensePayments.tripId, expensePayments.expenseId],
			references: [expenses.tripId, expenses.id],
		}),
		payers: many(expensePaymentPayers),
	}),
);

export const expensePaymentPayersRelations = relations(
	expensePaymentPayers,
	({ one }) => ({
		payment: one(expensePayments, {
			fields: [expensePaymentPayers.tripId, expensePaymentPayers.paymentId],
			references: [expensePayments.tripId, expensePayments.id],
		}),
		member: one(tripMembers, {
			fields: [expensePaymentPayers.tripId, expensePaymentPayers.memberId],
			references: [tripMembers.tripId, tripMembers.id],
		}),
	}),
);

export const expenseSharesRelations = relations(expenseShares, ({ one }) => ({
	expense: one(expenses, {
		fields: [expenseShares.tripId, expenseShares.expenseId],
		references: [expenses.tripId, expenses.id],
	}),
	member: one(tripMembers, {
		fields: [expenseShares.tripId, expenseShares.memberId],
		references: [tripMembers.tripId, tripMembers.id],
	}),
}));

export const expenseLinesRelations = relations(
	expenseLines,
	({ one, many }) => ({
		expense: one(expenses, {
			fields: [expenseLines.tripId, expenseLines.expenseId],
			references: [expenses.tripId, expenses.id],
		}),
		members: many(expenseLineMembers),
	}),
);

export const expenseLineMembersRelations = relations(
	expenseLineMembers,
	({ one }) => ({
		line: one(expenseLines, {
			fields: [expenseLineMembers.tripId, expenseLineMembers.lineId],
			references: [expenseLines.tripId, expenseLines.id],
		}),
		member: one(tripMembers, {
			fields: [expenseLineMembers.tripId, expenseLineMembers.memberId],
			references: [tripMembers.tripId, tripMembers.id],
		}),
	}),
);

export const expenseFeesRelations = relations(expenseFees, ({ one }) => ({
	expense: one(expenses, {
		fields: [expenseFees.tripId, expenseFees.expenseId],
		references: [expenses.tripId, expenses.id],
	}),
}));

export const settlementsRelations = relations(settlements, ({ one }) => ({
	trip: one(trips, { fields: [settlements.tripId], references: [trips.id] }),
}));

export const budgetLinesRelations = relations(budgetLines, ({ one }) => ({
	trip: one(trips, { fields: [budgetLines.tripId], references: [trips.id] }),
	node: one(nodes, {
		fields: [budgetLines.tripId, budgetLines.nodeId],
		references: [nodes.tripId, nodes.id],
	}),
	member: one(tripMembers, {
		fields: [budgetLines.tripId, budgetLines.memberId],
		references: [tripMembers.tripId, tripMembers.id],
	}),
}));

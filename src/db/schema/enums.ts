/**
 * Postgres enums (SPEC §6.3). The value lists live in `src/lib/schemas/enums.ts`
 * so client code can use them without importing Drizzle. Append-only: never
 * reorder, rename or remove a value (SPEC §0 rule 15).
 */
import { pgEnum } from "drizzle-orm/pg-core";
import {
	ATTACHMENT_KIND_VALUES,
	ATTACHMENT_STATUS_VALUES,
	ATTACHMENT_VISIBILITY_VALUES,
	BUDGET_KIND_VALUES,
	DUE_KIND_VALUES,
	EXPENSE_CATEGORY_VALUES,
	FEE_KIND_VALUES,
	IDEA_STATUS_VALUES,
	LEG_KIND_VALUES,
	LEG_MODE_VALUES,
	LEG_SOURCE_VALUES,
	LIST_ITEM_STATUS_VALUES,
	LIST_KIND_VALUES,
	MEMBER_STATUS_VALUES,
	NODE_STATUS_VALUES,
	NODE_TYPE_VALUES,
	PLACE_CATEGORY_VALUES,
	PRIORITY_VALUES,
	PROPOSAL_STATUS_VALUES,
	SHARE_ROLE_VALUES,
	SHORTLIST_PIN_VALUES,
	SPLIT_MODE_VALUES,
	TRIP_ROLE_VALUES,
} from "../../lib/schemas/enums";

export const nodeType = pgEnum("node_type", NODE_TYPE_VALUES);
export const placeCategory = pgEnum("place_category", PLACE_CATEGORY_VALUES);
export const nodeStatus = pgEnum("node_status", NODE_STATUS_VALUES);
export const tripRole = pgEnum("trip_role", TRIP_ROLE_VALUES);
export const memberStatus = pgEnum("member_status", MEMBER_STATUS_VALUES);
export const shareRole = pgEnum("share_role", SHARE_ROLE_VALUES);
export const legKind = pgEnum("leg_kind", LEG_KIND_VALUES);
export const legMode = pgEnum("leg_mode", LEG_MODE_VALUES);
export const legSource = pgEnum("leg_source", LEG_SOURCE_VALUES);
export const attachmentKind = pgEnum("attachment_kind", ATTACHMENT_KIND_VALUES);
export const attachmentStatus = pgEnum(
	"attachment_status",
	ATTACHMENT_STATUS_VALUES,
);
export const listKind = pgEnum("list_kind", LIST_KIND_VALUES);
export const listItemStatus = pgEnum(
	"list_item_status",
	LIST_ITEM_STATUS_VALUES,
);
export const priorityLevel = pgEnum("priority_level", PRIORITY_VALUES);

// F-ext0 (EXTENSIONS §2.1, ADDENDUM §6–§7).
export const dueKind = pgEnum("due_kind", DUE_KIND_VALUES);
export const proposalStatus = pgEnum("proposal_status", PROPOSAL_STATUS_VALUES);
export const expenseCategory = pgEnum(
	"expense_category",
	EXPENSE_CATEGORY_VALUES,
);
export const splitMode = pgEnum("split_mode", SPLIT_MODE_VALUES);
export const feeKind = pgEnum("fee_kind", FEE_KIND_VALUES);
export const budgetKind = pgEnum("budget_kind", BUDGET_KIND_VALUES);
export const attachmentVisibility = pgEnum(
	"attachment_visibility",
	ATTACHMENT_VISIBILITY_VALUES,
);

// docs/PLACES.md §7: the places lifecycle.
export const ideaStatus = pgEnum("idea_status", IDEA_STATUS_VALUES);
export const shortlistPin = pgEnum("shortlist_pin", SHORTLIST_PIN_VALUES);

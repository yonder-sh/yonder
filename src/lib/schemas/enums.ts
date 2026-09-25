/**
 * Enum value lists shared by the database (`src/db/schema/enums.ts` builds the
 * Postgres enums from these), the zod input schemas and the client. Isomorphic:
 * no drizzle or node imports, so client code can use them freely.
 *
 * Values follow SPEC §6.3 (revision 3); categories and priorities come from
 * spikes/research/CATEGORIES.md (D22). Labels, icons and colours live in
 * `src/lib/domain/taxonomy.ts`, not here. Postgres enums are append-only
 * (SPEC §0 rule 15): never reorder or remove a value.
 */
import { z } from "zod";

export const NODE_TYPE_VALUES = [
	"country",
	"region",
	"city",
	"area",
	"place",
] as const;
export const NodeType = z.enum(NODE_TYPE_VALUES);
export type NodeType = z.infer<typeof NodeType>;

export const PLACE_CATEGORY_VALUES = [
	"sight",
	"temple_shrine",
	"museum",
	"viewpoint",
	"nature",
	"park",
	"beach",
	"onsen",
	"food_drink",
	"restaurant",
	"cafe",
	"market",
	"bar",
	"nightlife",
	"shopping",
	"activity",
	"event",
	"lodging",
	"station",
	"airport",
	"port",
	"other",
] as const;
export const PlaceCategory = z.enum(PLACE_CATEGORY_VALUES);
export type PlaceCategory = z.infer<typeof PlaceCategory>;

export const NODE_STATUS_VALUES = ["active", "dropped"] as const;
export const NodeStatus = z.enum(NODE_STATUS_VALUES);
export type NodeStatus = z.infer<typeof NodeStatus>;

/**
 * Places lifecycle (docs/PLACES.md §3, §7): a place outside the plan is an
 * Idea, on the Shortlist or Dropped; Scheduled is derived (it is on a day).
 * `idea_status` is the explicit decision the server keeps in step with
 * `shortlist_pin` and the node's `status` (`updateNodeCore`): `dropped` ⇔
 * `status = 'dropped'`, `shortlist` ⇔ pinned.
 */
export const IDEA_STATUS_VALUES = ["idea", "shortlist", "dropped"] as const;
export const IdeaStatus = z.enum(IDEA_STATUS_VALUES);
export type IdeaStatus = z.infer<typeof IdeaStatus>;

/**
 * The shortlist override: `auto` follows the group score (≥ the trip's
 * `shortlistMinScore` is "suggested"), `pinned` stays on whatever the
 * ratings, `unpinned` stays off until the ratings change.
 */
export const SHORTLIST_PIN_VALUES = ["auto", "pinned", "unpinned"] as const;
export const ShortlistPin = z.enum(SHORTLIST_PIN_VALUES);
export type ShortlistPin = z.infer<typeof ShortlistPin>;

/**
 * Membership role. Ranking (owner > editor > suggester > rater > viewer) lives
 * ONLY in `RANK` (src/lib/auth/roles.ts), never in this order: `suggester`
 * (EXTENSIONS §3.1) and `rater` (PLACES §1c "Can rate") were appended. No SQL
 * migration may use the literals 'suggester' or 'rater' (they are added with
 * ALTER TYPE … ADD VALUE inside the migration transaction).
 */
export const TRIP_ROLE_VALUES = [
	"owner",
	"editor",
	"viewer",
	"suggester",
	"rater",
] as const;
export const TripRole = z.enum(TRIP_ROLE_VALUES);
export type TripRole = z.infer<typeof TripRole>;

/**
 * `removed` (F-ext0): a removed or departed member whose row is kept so their
 * tags, money rows and mentions still resolve to "Kai Viewer (former member)"
 * (QA TAG-04, A-26). Removed members are never assignable, never in pickers or
 * the `who` filter, and hold no access. `retireMember` sets it.
 */
export const MEMBER_STATUS_VALUES = [
	"active",
	"invited",
	"placeholder",
	"removed",
] as const;
export const MemberStatus = z.enum(MEMBER_STATUS_VALUES);
export type MemberStatus = z.infer<typeof MemberStatus>;

/** A share link grants at most editor; ownership is never shareable. */
export const SHARE_ROLE_VALUES = [
	"editor",
	"viewer",
	"suggester",
	"rater",
] as const;
export const ShareRole = z.enum(SHARE_ROLE_VALUES);
export type ShareRole = z.infer<typeof ShareRole>;

export const LEG_KIND_VALUES = ["pair", "stay_start", "stay_end"] as const;
export const LegKind = z.enum(LEG_KIND_VALUES);
export type LegKind = z.infer<typeof LegKind>;

export const LEG_MODE_VALUES = ["walk", "transit", "flight", "other"] as const;
export const LegMode = z.enum(LEG_MODE_VALUES);
export type LegMode = z.infer<typeof LegMode>;

export const LEG_SOURCE_VALUES = [
	"manual",
	"google",
	"osrm",
	"navitime",
	"estimate",
] as const;
export const LegSource = z.enum(LEG_SOURCE_VALUES);
export type LegSource = z.infer<typeof LegSource>;

/** `pdf` (ADDENDUM §9): booking confirmations, e-tickets, vouchers, receipts, guides. */
export const ATTACHMENT_KIND_VALUES = [
	"photo",
	"video",
	"embed",
	"link",
	"pdf",
] as const;
export const AttachmentKind = z.enum(ATTACHMENT_KIND_VALUES);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

/** `processing` = a worker job (variants, poster, link preview) is running. */
export const ATTACHMENT_STATUS_VALUES = [
	"pending",
	"processing",
	"ready",
	"failed",
] as const;
export const AttachmentStatus = z.enum(ATTACHMENT_STATUS_VALUES);
export type AttachmentStatus = z.infer<typeof AttachmentStatus>;

export const LIST_KIND_VALUES = ["todo", "shopping"] as const;
export const ListKind = z.enum(LIST_KIND_VALUES);
export type ListKind = z.infer<typeof ListKind>;

export const LIST_ITEM_STATUS_VALUES = ["open", "done", "skipped"] as const;
export const ListItemStatus = z.enum(LIST_ITEM_STATUS_VALUES);
export type ListItemStatus = z.infer<typeof ListItemStatus>;

/** Highest first. `null` (no row) means "not rated", never a tier. */
export const PRIORITY_VALUES = [
	"must",
	"really_want",
	"want",
	"sure_why_not",
	"meh",
	"nah",
] as const;
export const Priority = z.enum(PRIORITY_VALUES);
export type Priority = z.infer<typeof Priority>;

// ---------------------------------------------------------------------------
// F-ext0 (EXTENSIONS §2.1, ADDENDUM §6–§7)
// ---------------------------------------------------------------------------

/** E4: `due` = deadline; `opens` = a booking window opens; `on` = do it that day. */
export const DUE_KIND_VALUES = ["due", "opens", "on"] as const;
export const DueKind = z.enum(DUE_KIND_VALUES);
export type DueKind = z.infer<typeof DueKind>;

/** E7 (EXTENSIONS §3.2). */
export const PROPOSAL_STATUS_VALUES = [
	"open",
	"accepted",
	"rejected",
	"withdrawn",
] as const;
export const ProposalStatus = z.enum(PROPOSAL_STATUS_VALUES);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

/**
 * E5 categories, as the owner listed them (ADDENDUM §6 "Categories", which
 * overrides EXTENSIONS §8.1): lodging, transport, food & drink,
 * activities/tickets, shopping, fees & other.
 */
export const EXPENSE_CATEGORY_VALUES = [
	"lodging",
	"transport",
	"food_drink",
	"activities",
	"shopping",
	"fees_other",
] as const;
export const ExpenseCategory = z.enum(EXPENSE_CATEGORY_VALUES);
export type ExpenseCategory = z.infer<typeof ExpenseCategory>;

/** Owner-chosen split methods (ADDENDUM §6): no shares / percent modes. */
export const SPLIT_MODE_VALUES = ["equal", "exact"] as const;
export const SplitMode = z.enum(SPLIT_MODE_VALUES);
export type SplitMode = z.infer<typeof SplitMode>;

/**
 * ADDENDUM §6 / §7.3: an expense is planned until payments cover it. Derived
 * from its payments, never stored: no payment = `planned`, some = `partial`
 * ("¥10k of ¥60k"; the unpaid remainder counts as planned), all = `paid`.
 * "Mark paid" records one payment for the remainder.
 */
export const EXPENSE_STATUS_VALUES = ["planned", "partial", "paid"] as const;
export const ExpenseStatus = z.enum(EXPENSE_STATUS_VALUES);
export type ExpenseStatus = z.infer<typeof ExpenseStatus>;

/** A fee on an itemized expense: a percentage of the subtotal, or a fixed amount. */
export const FEE_KIND_VALUES = ["percent", "fixed"] as const;
export const FeeKind = z.enum(FEE_KIND_VALUES);
export type FeeKind = z.infer<typeof FeeKind>;

/** ADDENDUM §7.1: a budget line is a `total` or a `per_day` amount. */
export const BUDGET_KIND_VALUES = ["total", "per_day"] as const;
export const BudgetKind = z.enum(BUDGET_KIND_VALUES);
export type BudgetKind = z.infer<typeof BudgetKind>;

/**
 * ADDENDUM §9: who sees an attachment. `members` hides it from link guests
 * (booking confirmations, e-tickets); `everyone` is the default for photos,
 * videos, embeds, links and general PDFs. Receipts are money: never guests.
 */
export const ATTACHMENT_VISIBILITY_VALUES = ["everyone", "members"] as const;
export const AttachmentVisibility = z.enum(ATTACHMENT_VISIBILITY_VALUES);
export type AttachmentVisibility = z.infer<typeof AttachmentVisibility>;

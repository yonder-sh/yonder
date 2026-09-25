/**
 * Trip roles and the permission matrix (SPEC §11.3, EXTENSIONS §3.1). Isomorphic:
 * the server enforces with it (src/server/authz, the proposal gate) and the UI
 * uses the same table to decide which affordances to disable, so the two can
 * never disagree.
 *
 * Role order is owner > editor > suggester > rater > viewer. Ranking goes ONLY
 * through `RANK`, never through the Postgres enum order (`suggester` and
 * `rater` were appended to `trip_role` / `share_role` after the fact,
 * EXTENSIONS X5, PLACES §1c).
 */
import { type SHARE_ROLE_VALUES, TRIP_ROLE_VALUES } from "@/lib/schemas/enums";

/** One list: `isTripRole` admits every role the database can hold. */
export const TRIP_ROLES = TRIP_ROLE_VALUES;
export type TripRole = (typeof TRIP_ROLES)[number];
/** Share links never grant ownership. */
export type ShareRole = (typeof SHARE_ROLE_VALUES)[number];

/** A total record: adding a role without ranking it fails to compile. */
const RANK: Record<TripRole, number> = {
	viewer: 1,
	rater: 2,
	suggester: 3,
	editor: 4,
	owner: 5,
};

export function isTripRole(v: unknown): v is TripRole {
	return typeof v === "string" && (TRIP_ROLES as readonly string[]).includes(v);
}

/** True when `role` is at least `min` (viewer < rater < suggester < editor < owner). */
export function roleAtLeast(role: TripRole, min: TripRole): boolean {
	return RANK[role] >= RANK[min];
}

/** The stronger of the roles, or null for none. */
export function maxRole(
	roles: Iterable<TripRole | null | undefined>,
): TripRole | null {
	let best: TripRole | null = null;
	for (const r of roles) {
		if (r && (best === null || RANK[r] > RANK[best])) best = r;
	}
	return best;
}

/** "Can view" / "Can rate" / "Can suggest" / "Can edit" / "Owner" (sharing UI, dashboard). */
export function roleLabel(role: TripRole): string {
	switch (role) {
		case "owner":
			return "Owner";
		case "editor":
			return "Can edit";
		case "suggester":
			return "Can suggest";
		case "rater":
			return "Can rate";
		case "viewer":
			return "Can view";
		default: {
			const _exhaustive: never = role;
			return _exhaustive;
		}
	}
}

/**
 * What a user may do on one trip. `isGuest` is true when access comes only from
 * a share link (no active membership), whether or not the user is signed in.
 */
export interface TripAccess {
	tripId: string;
	slug: string;
	role: TripRole;
	/** The active `trip_members.id`, or null for guests. */
	memberId: string | null;
	isGuest: boolean;
	/** Presence colour index 0..7 (member row, else the grant). */
	color: number;
}

export const CAPABILITIES = [
	"read",
	"seeBookingDetails",
	"edit",
	"editTripDates",
	"beMentioned",
	"manageMembers",
	"manageShareLinks",
	"tripSettings",
	"changeSlug",
	"deleteTrip",
	"seeMemberEmails",
	"leaveTrip",
	"uploadMedia",
	// EXTENSIONS §3.1
	"editNotes",
	"propose",
	"reviewProposals",
	"searchPlaces",
	"manageExpenses",
	// ADDENDUM §7.1: trip-default budget lines (members set their own lines under manageExpenses).
	"manageBudgets",
	// ADDENDUM §9: "Hide from guests" on an attachment (any member, never a guest).
	"setMediaVisibility",
	// ADDENDUM §8: typing a new name in a people picker creates a placeholder.
	"addPeople",
	// ADDENDUM §10: editors/owners assign a placeholder to a member or an invite email.
	"linkPeople",
	// PLACES §1c: set your OWN rating and rating comment (members only: a
	// rating belongs to a member row, and link guests have none).
	"rate",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

type Who =
	| TripRole
	| "guestEditor"
	| "guestSuggester"
	| "guestRater"
	| "guestViewer";

/**
 * SPEC §11.3 + EXTENSIONS §3.1, row by row. "Rename self" is account-level, not
 * per trip. PLACES §1c: a rater is a viewer who may also rate (`rate`); every
 * other row lists `rater` exactly where it lists `viewer`.
 */
const MATRIX: Record<Capability, readonly Who[]> = {
	read: [
		"owner",
		"editor",
		"suggester",
		"rater",
		"viewer",
		"guestEditor",
		"guestSuggester",
		"guestRater",
		"guestViewer",
	],
	// Refs, seats, costs and money: never for guests of any kind.
	seeBookingDetails: ["owner", "editor", "suggester", "rater", "viewer"],
	edit: ["owner", "editor", "guestEditor"],
	editNotes: ["owner", "editor", "guestEditor"],
	editTripDates: ["owner", "editor", "guestEditor"],
	beMentioned: ["owner", "editor", "suggester", "rater", "viewer"],
	manageMembers: ["owner"],
	manageShareLinks: ["owner"],
	tripSettings: ["owner", "editor", "guestEditor"],
	changeSlug: ["owner"],
	deleteTrip: ["owner"],
	seeMemberEmails: ["owner"],
	// The owner must transfer first (not in v1); guests simply close the tab.
	leaveTrip: ["editor", "suggester", "rater", "viewer"],
	// QA MED-* lets link editors upload; viewers, raters and suggesters never can.
	uploadMedia: ["owner", "editor", "guestEditor"],
	// Editors propose only in suggest mode (the x-yonder-mode header); the gate decides.
	propose: ["owner", "editor", "suggester", "guestEditor", "guestSuggester"],
	reviewProposals: ["owner", "editor", "guestEditor"],
	searchPlaces: [
		"owner",
		"editor",
		"suggester",
		"guestEditor",
		"guestSuggester",
	],
	// Money is a ledger, not a plan: suggester members write it directly (X5).
	manageExpenses: ["owner", "editor", "suggester"],
	manageBudgets: ["owner", "editor"],
	setMediaVisibility: ["owner", "editor", "suggester", "rater", "viewer"],
	// Link guests are never taggable and never add people to a trip.
	addPeople: ["owner", "editor", "suggester"],
	linkPeople: ["owner", "editor"],
	// Plain viewers never rate: sharing "just to look" stays view-only.
	rate: ["owner", "editor", "suggester", "rater"],
};

/**
 * The matrix column for an access. Exhaustive on purpose: a ternary would turn
 * a guest suggester into a guestEditor, escalating a public link to edit.
 */
function who(access: Pick<TripAccess, "role" | "isGuest">): Who {
	const guest = access.isGuest;
	switch (access.role) {
		case "owner":
		case "editor":
			return guest ? "guestEditor" : access.role;
		case "suggester":
			return guest ? "guestSuggester" : "suggester";
		case "rater":
			return guest ? "guestRater" : "rater";
		case "viewer":
			return guest ? "guestViewer" : "viewer";
		default: {
			const _x: never = access.role;
			throw new Error(`unknown trip role ${String(_x)}`);
		}
	}
}

/** Whether the access allows the capability. */
export function can(
	access: Pick<TripAccess, "role" | "isGuest"> | null | undefined,
	capability: Capability,
): boolean {
	if (!access) return false;
	return MATRIX[capability].includes(who(access));
}

/**
 * Whether the access may set its OWN rating (PLACES §1c): the `rate`
 * capability and a member row to rate as (link guests have none).
 */
export function canRateOwn(
	access:
		| (Pick<TripAccess, "role" | "isGuest"> & { memberId: string | null })
		| null
		| undefined,
): boolean {
	return !!access?.memberId && can(access, "rate");
}

/** Guests never see booking refs, seats, costs, points or fees (§6.6 redaction). */
export function mustRedact(access: Pick<TripAccess, "role" | "isGuest">) {
	return !can(access, "seeBookingDetails");
}

/**
 * The workspace's edit mode (EXTENSIONS §2.3): `edit` applies directly,
 * `suggest` turns changes into proposals, `read` shows everything disabled.
 * `suggesting` is the editor's own "Suggesting" toggle.
 */
export type EditMode = "edit" | "suggest" | "read";
export function editModeOf(
	access: Pick<TripAccess, "role" | "isGuest"> | null | undefined,
	suggesting = false,
): EditMode {
	if (can(access, "edit")) return suggesting ? "suggest" : "edit";
	if (can(access, "propose")) return "suggest";
	return "read";
}

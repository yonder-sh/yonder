/**
 * MUTATION_POLICY (EXTENSIONS §3.3): how every POST server function is
 * authorized. One table, so the gate and the direct functions can't disagree,
 * and `policy.test.ts` fails on any POST server function missing here.
 *
 * - `proposable`: runs through `proposable.run(op)` (apply, propose or 403).
 * - `edit-only`: only callers with `edit` (uploads, provider fetches, restores).
 * - `{ direct: cap }`: the function checks that one capability itself
 *   (`requireDirect(name, …)`); never a proposal.
 * - `account`: not trip-scoped (the session middleware is the check).
 *
 * Isomorphic (no server imports): the UI reads it for `useEditGuard`.
 */
import type { Capability } from "@/lib/auth/roles";

export type MutationPolicy =
	| "proposable"
	| "edit-only"
	| { direct: Capability }
	| "account";

export const MUTATION_POLICY = {
	// ---- auth / account (not trip-scoped) ----
	redeemShareLink: "account",
	renameGuest: "account",
	createTrip: "account",
	setUserPrefs: "account",
	/** ADDENDUM §10 one inbox: the caller's own read state (checked per row). */
	markInboxRead: "account",
	/** Owner FB-16: the caller's own profile picture. */
	createAvatarUpload: "account",
	commitAvatar: "account",
	removeAvatar: "account",

	// ---- trips (F) ----
	updateTrip: { direct: "tripSettings" },
	setTripDates: "proposable",
	shiftTripDates: "proposable",
	previewTripDates: { direct: "propose" },
	deleteTrip: { direct: "deleteTrip" },

	// ---- nodes (F) ----
	createNode: "proposable",
	createNodePath: "proposable",
	updateNode: "proposable",
	moveNode: "proposable",
	deleteNode: "proposable",
	restoreNode: "edit-only",
	setNodePriority: "proposable",

	// ---- items (F) ----
	createItem: "proposable",
	updateItem: "proposable",
	moveItem: "proposable",
	deleteItem: "proposable",
	restoreItem: "edit-only",
	setItemAssignees: "proposable",

	// ---- days (F) ----
	insertDay: "proposable",
	moveDay: "proposable",
	deleteDay: "proposable",
	updateDay: "proposable",
	setDayStay: "proposable",

	// ---- legs (F) ----
	/** Idempotent, structural: a suggester needs the row before a link or an expense on a leg. */
	ensureLeg: { direct: "propose" },
	setLeg: "proposable",
	relinkLeg: "proposable",
	deleteLeg: "proposable",
	setLegAssignees: "proposable",

	// ---- proposals + digest (F; bodies F-ext1) ----
	resolveProposal: { direct: "reviewProposals" },
	resolveProposals: { direct: "reviewProposals" },
	/** The author only (matched by user id inside). */
	withdrawProposal: { direct: "propose" },
	markTripSeen: { direct: "read" },

	// ---- WP-Transit ----
	estimateWalk: "edit-only",
	getTransitOptions: "edit-only",
	/** Not proposable: it references a cached option id that expires (§3.3). */
	chooseTransitOption: { direct: "edit" },
	saveCustomRoute: "proposable",
	updateCustomRoute: "proposable",
	deleteCustomRoute: "proposable",
	saveTransitDetails: "proposable",
	lockTransitTimes: "edit-only",
	saveFlight: "proposable",
	createFlightWithAirports: "proposable",
	resetLegEstimate: "proposable",

	// ---- WP-Places ----
	searchPlaces: { direct: "searchPlaces" },
	getPlacePreview: { direct: "searchPlaces" },
	reverseGeocode: { direct: "searchPlaces" },
	/** Writes Google hours/details onto the node. */
	getPlaceMoreDetails: "edit-only",

	// ---- WP-Media ----
	/** Receipts on an expense need `manageExpenses` instead (checked inside). */
	createUpload: "edit-only",
	createPosterUpload: "edit-only",
	/** Multipart part URLs and cancel: the uploader's own pending upload. */
	signUploadParts: "edit-only",
	abortUpload: "edit-only",
	completeUpload: "edit-only",
	addLink: "proposable",
	refreshLinkMeta: "edit-only",
	updateAttachment: "proposable",
	deleteAttachment: "proposable",
	/** ADDENDUM §9 "Hide from guests": any member. */
	setAttachmentVisibility: { direct: "setMediaVisibility" },
	restoreAttachment: "edit-only",

	// ---- WP-Lists ----
	createListItem: "proposable",
	updateListItem: "proposable",
	setListItemStatus: "proposable",
	moveListItem: "proposable",
	setListItemTargets: "proposable",
	setListItemAssignees: "proposable",
	deleteListItem: "proposable",
	restoreListItem: "edit-only",
	markMentionsRead: { direct: "read" },

	// ---- WP-Home (sharing) ----
	inviteMember: { direct: "manageMembers" },
	/** ADDENDUM §10: editors too (it auto-claims on sign-up). */
	linkPlaceholder: { direct: "linkPeople" },
	/** ADDENDUM §8: free-text names in any people picker. */
	addPlaceholder: { direct: "addPeople" },
	updateMemberRole: { direct: "manageMembers" },
	removeMember: { direct: "manageMembers" },
	promoteGuest: { direct: "manageMembers" },
	/** FB-13: the trip's one link (on/off and its role). */
	setShareLink: { direct: "manageShareLinks" },
	resetShareLink: { direct: "manageShareLinks" },
	extendShareLink: { direct: "manageShareLinks" },
	removeGuest: { direct: "manageShareLinks" },
	/** ADDENDUM §10: the caller's own access to the trip is checked inside. */
	claimPlaceholder: "account",
	/** ADDENDUM §9: needs a non-guest membership of the source (checked inside). */
	duplicateTrip: "account",
	leaveTrip: { direct: "leaveTrip" },

	// ---- WP-Insights ----
	setOpeningHours: "proposable",
	fetchOpeningHours: "edit-only",

	// ---- WP-Money (a ledger, not a plan: suggester members write directly) ----
	createExpense: { direct: "manageExpenses" },
	updateExpense: { direct: "manageExpenses" },
	markExpensePaid: { direct: "manageExpenses" },
	setExpenseRate: { direct: "manageExpenses" },
	deleteExpense: { direct: "manageExpenses" },
	restoreExpense: { direct: "manageExpenses" },
	createSettlement: { direct: "manageExpenses" },
	deleteSettlement: { direct: "manageExpenses" },
	/** Trip-default lines also need `manageBudgets` (checked inside). */
	setBudgetLine: { direct: "manageExpenses" },
	deleteBudgetLine: { direct: "manageExpenses" },
	setBudgetPrivate: { direct: "manageExpenses" },

	// ---- WP-Suggest ----
	proposeNoteAppend: "proposable",
} as const satisfies Record<string, MutationPolicy>;

export type MutationFnName = keyof typeof MUTATION_POLICY;

/** The functions that only ever apply for `edit` (`useEditGuard('edit-only')`). */
export function isEditOnly(name: MutationFnName): boolean {
	return MUTATION_POLICY[name] === "edit-only";
}

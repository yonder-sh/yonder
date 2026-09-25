/**
 * WP-Home DTOs shared by the dashboard functions, the server reads and the
 * UI (isomorphic: types only).
 */
import type { TripRole } from "@/lib/auth/roles";
import type { DueKind } from "@/lib/schemas/enums";

export type MyTripMember = {
	id: string;
	name: string;
	color: number;
	image: string | null;
};

export type MyTrip = {
	id: string;
	slug: string;
	name: string;
	startDate: string | null;
	endDate: string | null;
	role: TripRole;
	/** Access only through a share link. */
	viaLink: boolean;
	/** Up to 5 active members, owner first. */
	members: MyTripMember[];
	memberCount: number;
	countryCodes: string[];
	coverUrl: string | null;
	/** City-level route points `[lng, lat]` in trip order, for the RouteSketch. */
	routePoints: [number, number][];
	unreadMentions: number;
	updatedAt: string;
	/** E6: activity by others since I last looked (capped at 100). */
	changesSince?: number;
	/** E7: open suggestions by others, for reviewers only (else 0). */
	openProposals?: number;
	/** E4: my overdue todos (assigned to me or to nobody). */
	overdue?: number;
	/** The owner's name, for "Shared with you" cards ("by Audrey"). */
	ownerName?: string | null;
	/** Day count of the trip (inclusive), when dated. */
	dayCount?: number | null;
};

export type MyDeadline = {
	listItemId: string;
	tripId: string;
	tripSlug: string;
	tripName: string;
	text: string;
	dueDate: string;
	dueTime: string | null;
	dueTz: string | null;
	sel: string | null;
	/** E4 kind: `due`, `opens` (booking window) or `on`. */
	dueKind?: DueKind;
	/** The effective instant (ms). */
	at?: number;
	/** `overdue` (past), `open_now` (an opened window, < 72 h), `soon` (≤ 7 days), `later`. */
	state?: "overdue" | "open_now" | "soon" | "later";
	/** Assigned to me (true) or to nobody (false). */
	mine?: boolean;
	/** I may tick it done (members with edit access, or its assignee). */
	canComplete?: boolean;
};

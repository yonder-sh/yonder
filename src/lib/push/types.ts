/**
 * Web Push notifications: the types a person can switch off, the coalescing
 * groups they send through, and the payload the service worker shows.
 * Isomorphic and pure (the settings UI, the server functions and the worker
 * all read it).
 *
 * On by default, opt-out: a type is on unless the person switched it off
 * (`notification_prefs.off_types`), and a muted trip sends nothing.
 */

export const PUSH_TYPES = [
	"booking",
	"mention",
	"review",
	"result",
	"assigned",
	"membership",
	"countdown",
	"today",
	"changes",
] as const;
export type PushType = (typeof PUSH_TYPES)[number];

export function isPushType(v: unknown): v is PushType {
	return typeof v === "string" && (PUSH_TYPES as readonly string[]).includes(v);
}

/** The settings dialog's switches, in this order. */
export const PUSH_TYPE_INFO: Record<PushType, { label: string; hint: string }> =
	{
		booking: {
			label: "Booking windows",
			hint: "A day before and 15 minutes before a booking opens.",
		},
		mention: {
			label: "Mentions",
			hint: "Someone @mentions you in a note, to-do or rating.",
		},
		review: {
			label: "Suggestions to review",
			hint: "Someone suggests a change you can accept or reject.",
		},
		result: {
			label: "Your suggestions",
			hint: "Your suggestion is accepted or rejected.",
		},
		assigned: {
			label: "Assigned to you",
			hint: "A plan or to-do is assigned to you, and your to-dos come due.",
		},
		membership: {
			label: "Trip access",
			hint: "You're added to or removed from a trip, or your role changes.",
		},
		countdown: {
			label: "Trip countdown",
			hint: "A week before and the day before a trip starts.",
		},
		today: {
			label: "Today on the trip",
			hint: "A morning note on each trip day.",
		},
		changes: {
			label: "Changes that affect you",
			hint: "A flight, booked or pinned plan of yours moves, or the trip's dates shift.",
		},
	};

/**
 * What one notification is about. Events of one group for the same person
 * and trip are coalesced into one notification ("Maya made 5 suggestions").
 * `due` (a to-do of yours coming due) is switched with `assigned`.
 */
export const PUSH_GROUPS = [...PUSH_TYPES, "due"] as const;
export type PushGroup = (typeof PUSH_GROUPS)[number];

export function typeOfGroup(group: PushGroup): PushType {
	return group === "due" ? "assigned" : group;
}

/** Reminders fire at a planned instant; everything else follows someone's change. */
export const REMINDER_GROUPS = [
	"booking",
	"due",
	"countdown",
	"today",
] as const satisfies readonly PushGroup[];

export function isReminderGroup(g: PushGroup): boolean {
	return (REMINDER_GROUPS as readonly string[]).includes(g);
}

/**
 * One thing to tell a person, before coalescing: what the notification
 * would say if it were alone.
 */
export type PushItem = {
	/** Stable per thing (dedupe; the tag of a lone notification). */
	key: string;
	/** Epoch ms when it happened (or the reminder's instant). */
	at: number;
	/** First name of who caused it; null for reminders and unknown actors. */
	actor: string | null;
	/** One line, without the trip name ("Maya mentioned you in Kyoto"). */
	headline: string;
	/** A short second line. */
	body?: string;
	/** A same-origin path (`/t/<slug>?sel=…`). */
	url: string;
	/** Group-specific facts the summary reads (e.g. a suggestion's decision). */
	meta?: Record<string, string | number | boolean | null>;
};

/** What the worker sends and `src/sw.ts` shows. */
export type PushPayload = {
	title: string;
	body: string;
	/** Same-origin path the click opens. */
	url: string;
	/** Notifications with the same tag replace each other. */
	tag: string;
	/** Epoch ms of the newest thing in it. */
	ts: number;
};

/** The payload's size limits (a push message carries at most ~4 KB). */
export const PUSH_TITLE_MAX = 120;
export const PUSH_BODY_MAX = 240;

/**
 * The shortlist level, leaving out ratings and "Remind": `data-testid`
 * values. Import-free, so e2e specs can import this file by relative path.
 * Never rename an id.
 */
export const RATING_TESTID = {
	/** "On the shortlist: the group gave it +7, …" in a place's details. */
	reason: "places-shortlist-reason",
	/** The shortlist level choices (the Review step's settings). */
	level: "places-shortlist-level",
	levelOption: "places-shortlist-level-option",
	/** One person in the rating progress (`data-member`, `data-counted`). */
	person: "rating-person",
	personMenu: "rating-person-menu",
	leaveOut: "rating-leave-out",
	countAgain: "rating-count-again",
	/** "Maya's ratings aren't counted" under their name in the Share dialog. */
	shareNotCounted: "share-ratings-not-counted",
	/** "Remind" / "Reminded" next to someone with places left. */
	remind: "rating-remind",
	/** "Dennis reminded you to rate 12 places" in the trip. */
	reminderLine: "rating-reminder-line",
	reminderRate: "rating-reminder-rate",
	reminderClose: "rating-reminder-close",
} as const;

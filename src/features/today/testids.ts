/**
 * Today's own `data-testid` values (One Yonder phase 5). Import-free, so e2e
 * specs can import this file by relative path. Never rename an id.
 */
export const TODAY_TESTID = {
	/** `data-state`: starting · underway · ended · empty. */
	page: "today",
	header: "today-header",
	/** `data-pace`: on_time · behind · ahead. */
	pace: "today-pace",
	/** The Now row; `data-item`. */
	now: "today-now",
	/** Done on the Now row, on a floating Next card, or on the check-in. */
	done: "today-done",
	/** "Tap Done when you leave…", until the day's first Done. */
	hint: "today-hint",
	/** "Still at Yodobashi Camera?" (a Done likely forgotten); `data-item`. */
	checkIn: "today-check-in",
	/** "Bic Camera · done 17:10 · Undo"; `data-item`. */
	doneRow: "today-done-row",
	undo: "today-undo",
	/** The Next card; `data-item`. */
	next: "today-next",
	directions: "today-directions",
	address: "today-address",
	/** A risk card; `data-item` (the fixed stop). */
	risk: "today-risk",
	/** A fix button; `data-kind`: shorten · skip. */
	fix: "today-fix",
	free: "today-free",
	/** "Leave for Bar Benfiddich by 19:50 (booked for 20:00, 10 min walk)". */
	leave: "today-leave",
	/** `data-node`. */
	idea: "today-idea",
	ideaAdd: "today-idea-add",
	rest: "today-rest",
	/** `data-item`, `data-moved` when re-timed. */
	restRow: "today-rest-row",
	tonight: "today-tonight",
	ended: "today-ended",
	tomorrow: "today-tomorrow",
	empty: "today-empty",
	openPlan: "today-open-plan",
	overviewLink: "today-overview-link",
	/** "Use my location"; `aria-pressed`. */
	locate: "today-locate",
	/** "Looks like you're at Bic Camera?"; `data-item`. */
	here: "today-here",
	hereYes: "today-here-yes",
	/** "Show this to the driver". */
	driver: "today-driver",
	driverLocal: "today-driver-local",
	driverCopy: "today-driver-copy",
	driverDirections: "today-driver-directions",
	tonightDirections: "today-tonight-directions",
	tonightAddress: "today-tonight-address",
	/** A stop's details while the trip is on (P11). */
	stopDirections: "today-stop-directions",
	stopAddress: "today-stop-address",
} as const;

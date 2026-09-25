/**
 * How long in each city: its test ids (the first ones began on the Places
 * tab, hence their values). Import-free, so e2e specs can import it by
 * relative path. Never rename an id.
 */
export const SPLIT_TESTID = {
	split: "places-split",
	splitRow: "places-split-row",
	splitRate: "places-split-rate",
	splitOver: "places-split-over",
	splitUnused: "places-split-unused",
	splitMinus: "places-split-minus",
	splitPlus: "places-split-plus",
	splitUse: "places-split-use",
	splitDays: "places-split-days",
	splitChange: "places-split-change",
	splitApply: "places-split-apply",
	splitCancel: "places-split-cancel",
	splitConfirm: "places-split-confirm",
	splitExpand: "places-split-expand",
	splitPlaces: "places-split-places",
	splitPlace: "places-split-place",
	// the Plan's own (owner, 2026-09-25)
	heading: "split-heading",
	stop: "split-stop",
	handle: "split-handle",
	menu: "split-menu",
	moveUp: "split-move-up",
	moveDown: "split-move-down",
	area: "split-area",
	tripDays: "split-trip-days",
	start: "split-start",
	suggestNote: "split-suggest-note",
} as const;

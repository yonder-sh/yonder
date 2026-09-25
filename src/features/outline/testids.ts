/**
 * WP-Outline's own test ids (CONTRACTS §1 rule 8). Import-free, so e2e specs
 * can import it by relative path. The shared ones (`outline`, `outline-row`,
 * `ideas-bin`, `outline-popover`, `outline-popover-button`) stay in
 * `src/lib/testids.ts`. Never rename an id.
 */
export const OUTLINE_TESTID = {
	/** The row's ⋯ button (opens the same menu as right-click). */
	rowMenu: "outline-row-menu",
	/** The Outline header's ⋯ (level, expand/collapse). */
	headerMenu: "outline-header-menu",
	/** Inline rename / add-child input. */
	inlineInput: "outline-inline-input",
	addChildType: "outline-add-child-type",
	/** The level filter's hidden-place count on a row ("Uji · 1 place"). */
	hiddenCount: "outline-hidden-count",
	/** The "Dropped · N" group header. */
	droppedGroup: "outline-dropped",
	/** A proposed place (E7 create ghost). */
	ghostRow: "outline-ghost-row",
	/** "Itoya → Kyoto · Maya" (E7 origin row). */
	originRow: "outline-origin-row",
	/** Polite live region (keyboard drag, A, deletes). */
	live: "outline-live",
	deleteDialog: "outline-delete-dialog",
	deleteConfirm: "outline-delete-confirm",
	moveDialog: "outline-move-dialog",
	/** The shared filter (ADDENDUM §10). */
	filterButton: "place-filter-button",
	filterPanel: "place-filter-panel",
	filterGroup: "place-filter-group",
	filterMinPriority: "place-filter-min-priority",
	filterPriorityOf: "place-filter-priority-of",
	filterUnratedBy: "place-filter-unrated-by",
	filterNotScheduled: "place-filter-not-scheduled",
	filterClear: "place-filter-clear",
	/** The one-line summary under the Outline header when a filter is on. */
	filterSummary: "place-filter-summary",
	/** Ideas. */
	ideaRow: "idea-row",
	ideasSort: "ideas-sort",
	ideasCount: "ideas-count",
	/** FB-05: the Ideas header's "Rate ideas →" (to `/t/<trip>/rate`). */
	rateIdeas: "ideas-rate-link",
} as const;

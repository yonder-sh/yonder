/** WP-Lists' own test ids (CONTRACTS §1 rule 8). Import-free. */
export const LISTS_TESTID = {
	/** Todo | Shopping segmented control items. */
	kindTodo: "lists-kind-todo",
	kindShopping: "lists-kind-shopping",
	/** The View select trigger (Due / Place / Person / Recent / By day). */
	view: "lists-view",
	/** The person filter select trigger. */
	who: "lists-who",
	/** "Near Shibuya" toggle (shopping). */
	near: "lists-near",
	/** A group (`data-group` = its key) and its sticky head. */
	group: "lists-group",
	groupHead: "lists-group-head",
	/** A row (`data-id`, `data-status`, `data-state` = due state, `data-private`). */
	row: "list-row",
	rowCheck: "list-row-check",
	rowText: "list-row-text",
	/** The text and its marks ("Only you", "skipped", "· note"); they wrap. */
	rowTextLine: "list-row-text-line",
	rowMenu: "list-row-menu",
	rowAssign: "list-row-assign",
	/** The source crumb under a row (outside Place view); it jumps there. */
	rowSource: "list-row-source",
	/** The drag handle (Place view). */
	rowGrip: "list-row-grip",
	/** The due chip (`data-state`). */
	dueChip: "list-due-chip",
	/** "Day 3 · Kappabashi 14:10" / "Not on the plan" / "Closed Day 3". */
	shopPlan: "list-shop-plan",
	/** The lock shown on a private row. */
	privateMark: "list-private",
	/** "3 done" fold button. */
	doneFold: "list-done-fold",
	/** The add row's input wrapper, its target chip and its private toggle. */
	add: "list-add",
	addTarget: "list-add-target",
	addPrivate: "list-add-private",
	/** The date editor popover and its parts. */
	dueEditor: "list-due-editor",
	dueSave: "list-due-save",
	dueClear: "list-due-clear",
	dueRelative: "list-due-relative",
	/** The inspector's "This visit only" / "Everything that day" / "Only …" switch. */
	panelScope: "lists-panel-scope",
	/** "2 on dropped places · Show" / "Hide dropped places" (QA ROLL-12). */
	dropped: "lists-dropped",
	/** A Place group's own "+ Add to Kappabashi" and its input. */
	groupAdd: "lists-group-add",
	groupAddInput: "lists-group-add-input",
	/** "Add expense" offered right after a shopping row is ticked. */
	boughtExpense: "list-bought-expense",
} as const;

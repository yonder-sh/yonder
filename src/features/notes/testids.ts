/** WP-Lists' note test ids (CONTRACTS §1 rule 8). Import-free. */
export const NOTES_TESTID = {
	/** The live editor's content element (`data-doc` = the Yjs doc name, `data-editable`). */
	editor: "note-editor",
	/** The static render of a saved copy ("Saved copy · editing paused"). */
	savedCopy: "note-saved-copy",
	/** Shared ↔ "Only me" switch (ADDENDUM §7.2 private notes). */
	privateToggle: "note-private-toggle",
	/** The inspector's "<Place> | This visit only" switch on a located visit. */
	visitScope: "note-visit-scope",
	/** A section of the Notes tab (`data-target`). */
	section: "note-section",
	sectionEdit: "note-section-edit",
	/** The @-mention popup and its rows. */
	mentionPopup: "mention-popup",
	mentionOption: "mention-option",
	mentionAdd: "mention-add",
	/** Why the editor is read-only ("View only", "Suggesters propose additions"). */
	readOnlyNote: "note-read-only",
} as const;

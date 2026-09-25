/**
 * WP-Home's own `data-testid`s (CONTRACTS §1 rule 8). Import-free. The shared
 * ones (dashboard, tripCard, shareDialog, …) stay in `src/lib/testids.ts`.
 * Never rename an id.
 */
export const HOME_TESTID = {
	// Dashboard
	heroCard: "home-hero",
	heroWhen: "home-hero-when",
	deadlines: "home-deadlines",
	deadlinesEveryone: "home-deadlines-everyone",
	deadlineRow: "home-deadline-row",
	deadlineCheck: "home-deadline-check",
	deadlineTrip: "home-deadline-trip",
	tripCardMenu: "home-trip-card-menu",
	/** FB-05: "Rate places" in a trip card's ⋯ menu. */
	tripCardRate: "home-trip-card-rate",
	tripCardChip: "home-trip-card-chip",
	offlineChip: "home-offline-chip",
	sharedWaiting: "home-shared-waiting",
	newTripDates: "home-new-trip-dates",
	// Duplicate…
	duplicateDialog: "home-duplicate-dialog",
	duplicateName: "home-duplicate-name",
	duplicateStart: "home-duplicate-start",
	duplicateSubmit: "home-duplicate-submit",
	duplicateOption: "home-duplicate-option",
	// Share dialog
	inviteEmail: "home-invite-email",
	inviteRole: "home-invite-role",
	/** The invite's optional note (the welcome's quote). */
	inviteNote: "home-invite-note",
	inviteSubmit: "home-invite-submit",
	memberRow: "home-member-row",
	memberRole: "home-member-role",
	memberMenu: "home-member-menu",
	addPerson: "home-add-person",
	addPersonName: "home-add-person-name",
	placeholderLinkEmail: "home-placeholder-link-email",
	placeholderClaim: "home-placeholder-claim",
	guestRow: "home-guest-row",
	guestPromote: "home-guest-promote",
	guestPromoteTwin: "home-guest-promote-twin",
	guestRemove: "home-guest-remove",
	resetConfirm: "home-share-reset-confirm",
	linkCreated: "home-share-link-created",
	/** FB-13: the one link's role Select. */
	linkRole: "home-share-link-role",
	/** The link's optional note for people who join. */
	linkNote: "home-share-link-note",
	// Trip settings
	settingsName: "home-settings-name",
	settingsSlug: "home-settings-slug",
	/** The address's random tail beside the Address input (read-only). */
	settingsSlugTail: "home-settings-slug-tail",
	settingsDates: "home-settings-dates",
	settingsCurrency: "home-settings-currency",
	settingsSave: "home-settings-save",
	settingsTryDates: "home-settings-try-dates",
	settingsDuplicate: "home-settings-duplicate",
	settingsLeave: "home-settings-leave",
	settingsDelete: "home-settings-delete",
	datesConfirm: "home-settings-dates-confirm",
	// Profile
	profileFirst: "home-profile-first",
	profileLast: "home-profile-last",
	profileCurrency: "home-profile-currency",
	profileSave: "home-profile-save",
	/** ADDENDUM §12: "1.2 GB of 5 GB used". */
	profileStorage: "home-profile-storage",
	// Profile picture (FB-16)
	avatarEdit: "home-avatar-edit",
	avatarFile: "home-avatar-file",
	avatarRemove: "home-avatar-remove",
	avatarCropper: "home-avatar-cropper",
	avatarZoom: "home-avatar-zoom",
	avatarSave: "home-avatar-save",
	// Guest nudge / claim
	guestRename: "home-guest-rename",
	claimPrompt: "home-claim-prompt",
	claimButton: "home-claim-button",
	/** FB-15: "Are you Audrey?" confirmation before a claim. */
	claimConfirm: "home-claim-confirm",
	claimConfirmYes: "home-claim-confirm-yes",
	// Offline + PWA
	updateToast: "home-update-toast",
	// Share target (E8)
	shareSave: "home-share-save",
	shareTrip: "home-share-trip",
	shareName: "home-share-name",
	sharePaste: "home-share-paste",
	shareDone: "home-share-done",
	shareSaved: "home-share-saved",
	shareParent: "home-share-parent",
	shareDuplicate: "home-share-duplicate",
	shareTodo: "home-share-todo",
} as const;

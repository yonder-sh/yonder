/**
 * Web Push UI `data-testid` values. Import-free, so e2e specs can import
 * this file by relative path. Never rename an id.
 */
export const PUSH_TESTID = {
	card: "push-card",
	cardEnable: "push-card-enable",
	cardDismiss: "push-card-dismiss",
	accountItem: "push-account-item",
	dialog: "push-dialog",
	device: "push-device",
	deviceNote: "push-device-note",
	type: "push-type",
	mutedTrip: "push-muted-trip",
	muteItem: "push-mute-item",
} as const;

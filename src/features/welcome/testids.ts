/**
 * The welcome's `data-testid` values. Import-free, so e2e specs can import
 * this file by relative path. Never rename an id.
 */
export const WELCOME_TESTID = {
	dialog: "welcome",
	/** The name step for guests without an account. */
	nameStep: "welcome-name",
	nameInput: "welcome-name-input",
	nameContinue: "welcome-name-continue",
	signIn: "welcome-sign-in",
	note: "welcome-note",
	who: "welcome-who",
	dates: "welcome-dates",
	/** `data-kind`: rate · add · plan. */
	primary: "welcome-primary",
	lookAround: "welcome-look-around",
	askAccess: "welcome-ask-access",
	askText: "welcome-ask-text",
	notify: "welcome-notify",
	/** The trip menu's "How this trip works". */
	menuItem: "welcome-menu-item",
} as const;

/**
 * "Where things stand" `data-testid` values. Import-free, so e2e specs can
 * import this file by relative path. Never rename an id.
 */
export const STANDING_TESTID = {
	card: "standing",
	/** `data-key` (places · rating · cities · days · stays), `data-done`, `data-next`. */
	line: "standing-line",
	/** The next line's action ("Rate 12 places", "Schedule"). */
	action: "standing-action",
} as const;

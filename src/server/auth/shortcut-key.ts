/**
 * The iPhone Shortcut's two kinds of Better Auth API key
 * (src/server/shortcut.server.ts):
 *
 * - `shortcut`: a connected phone's key. It may only save a link.
 * - `shortcut-pair`: the setup code the app copies. Usable once, for 5
 *   minutes, only to make a `shortcut` key.
 */
export const SHORTCUT_KEY = {
	config: "shortcut",
	prefix: "ysk_",
	permissions: { shortcut: ["save"] },
	windowMs: 3_600_000,
	perWindow: 60,
} as const;

export const SHORTCUT_PAIR = {
	config: "shortcut-pair",
	prefix: "yonder-pair_",
	permissions: { shortcut: ["pair"] },
	seconds: 300,
} as const;

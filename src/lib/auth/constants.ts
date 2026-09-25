import { BRAND } from "@/lib/brand";

/**
 * Auth-related names (SPEC §4.3). `src/lib/brand.ts` is the single source;
 * this is the subset the auth layer reads, kept under its original name so
 * no import changes.
 */
export const AUTH_BRAND = {
	name: BRAND.name,
	/** Better Auth anonymous users get `temp-<id>@<this>` emails (never deliverable). */
	guestEmailDomain: BRAND.guestEmailDomain,
	/** Browser storage keys (query persister, offline index, grants, layout, theme). */
	storage: BRAND.storage,
} as const;

/** Where the sign-in page lives, and the onboarding (names) step. */
export const LOGIN_PATH = "/login";
export const WELCOME_PATH = "/welcome";
/** The share-link landing route. The token travels in the URL fragment: `/join#t=<token>`. */
export const JOIN_PATH = "/join";

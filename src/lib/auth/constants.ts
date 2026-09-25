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
/** The signed-in home: your trips. `/` is the public landing page. */
export const DASHBOARD_PATH = "/dashboard";
export const WELCOME_PATH = "/welcome";

/**
 * The only place a product name appears (SPEC §4.3, ADDENDUM §1). UI copy,
 * titles, the manifest (hard-coded, checked by a test) and emails read it.
 *
 * `src/lib/auth/constants.ts` (`AUTH_BRAND`) re-exports the auth subset.
 */
export const BRAND = {
	/** Server-rendered strings may use env APP_NAME, which defaults to this. */
	name: "Yonder",
	slug: "yonder",
	tagline: "Plan trips together.",
	/** Better Auth anonymous users. */
	guestEmailDomain: "guest.yonder.invalid",
	/** env REDIS_PREFIX overrides it (per agent: yonder-a<n>). */
	redisDefaultPrefix: "yonder",
	storage: {
		/** idb-keyval keys of the query persister. */
		queryPrefix: "yonder-q",
		/** localStorage index read by public/offline.html. */
		savedTrips: "yonder:saved-trips",
		/** localStorage [slug]: trips this browser opened as a link guest (§11.2). */
		grants: "yonder:grants",
		/** localStorage [slug]: links turned off or replaced while this guest had them (QA LINK-04). */
		grantsGone: "yonder:grants-gone",
		/** Pane sizes. */
		layout: "yonder:layout",
		/** The scaffold's existing theme key (kept). */
		theme: "yonder-theme",
	},
	/** Light and dark app grounds (DESIGN §2.1), for `<meta name="theme-color">`. */
	themeColor: { light: "#f9fafd", dark: "#0a0a0a" },
	userAgent: (appUrl: string, contact: string) =>
		`Yonder/1.0 (+${appUrl}; ${contact})`,
} as const;

/** `Page · Yonder` for document titles. */
export function pageTitle(page?: string | null): string {
	return page ? `${page} · ${BRAND.name}` : BRAND.name;
}

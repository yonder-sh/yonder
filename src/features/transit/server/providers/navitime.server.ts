/**
 * NAVITIME (SPEC §14.2.3): dropped with Q1 = no (ADDENDUM §5, JAPAN_TRANSIT
 * §1). The provider stays in the chain as an empty stub that never applies.
 */
import type { TransitProvider } from "./types.server";

export const navitimeProvider: TransitProvider = {
	id: "navitime",
	supports: () => false,
	fetch: async () => ({ routes: [] }),
};

/**
 * The first name of `LegMapsLink` (ADDENDUM §5 asked for "Open in Google
 * Maps" on every Japan transit row). Since FB-03 it covers every non-flight
 * leg with two located ends, in the leg's own travel mode (walking, driving,
 * transit…), in Japan and everywhere else. Kept so existing rows
 * (`src/features/plan/LegRow.tsx`) pick up the change unchanged; new code
 * imports `LegMapsLink` from `@/features/transit/LegMapsLink`.
 */
export { LegMapsLink as JapanTransitLink } from "./LegMapsLink";

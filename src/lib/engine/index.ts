/**
 * The zoom engine (SPEC §8–§9): pure, isomorphic, framework-agnostic trip
 * logic. Plain data in, plain data out; no React, database or I/O.
 *
 * App entry points:
 * - `indexGraph(graph)` → `GraphIndex` (§8.1)
 * - `repAt`, `lensOptions`, `defaultLens`, `stepLens`, … (§8.2, §8.5)
 * - `buildModel(ix, scopeId, lens, dayRange?)` → `WorkspaceModel` (§8.3)
 * - `rollup(ix, options, entries)` → grouped bundle entries (§8.4)
 * - `computeSchedule(ix)` → `ScheduleResult` (§9)
 * - `suggestPair`, `railEstimateMin`, `conflictFixes` (§9.3)
 * - zone arithmetic: `time.ts` only (§0 rule 10)
 *
 * Ported from `spikes/core` (D21): `hierarchy`, `timeline` (`computeTimeline`),
 * `route` (`collapseRoute`), `collect` (the spike's rollups) and `time`.
 */

export {
	type Attachable,
	collectInScope,
	type DayScope,
	type EntityRef,
	type EntityType,
	entityOf,
	groupRollupByNode,
	type ItemScope,
	type LegScope,
	type NodeScope,
	type RollupContext,
	type RollupGroup as CollectGroup,
	type RollupMatch,
	type RollupResult,
	type RollupScope,
	type RollupTimeline,
	resolveScope,
	type ScopeMembers,
	type TripScope,
} from "./collect";
export * from "./flights";
export * from "./geo";
export * from "./graph-index";
export * from "./hierarchy";
export * from "./lens";
export * from "./rollup";
export {
	type CollapseOptions,
	collapseRoute,
	type EdgePairSummary,
	groupEdgesByPair,
	type MapEdge as RouteEdge,
	type MapGraph,
	type MapPin as RoutePin,
	type MapVisit as RouteVisit,
	pairKey as nodePairKey,
	type RouteInput,
	type RouteIssue,
	type RouteIssueCode,
	type RouteLeg,
	type RouteStop,
	routeFromTimeline,
} from "./route";
export * from "./schedule";
export * from "./suggest";
export * from "./time";
export * from "./timeline";
export * from "./tree";
export * from "./types";
export * from "./visits";

/**
 * The foundation's queries (SPEC §12.2): session, capabilities, slug → id,
 * graph, counts, activity, one leg, and (F-ext0) proposals, the digest
 * snapshot and the user's synced prefs. Feature packages keep their own
 * `queryOptions` in `src/features/<x>/queries.ts`, built on `tripKeys`, so the
 * live invalidation (§10.5) reaches them by key.
 */
import { queryOptions } from "@tanstack/react-query";
import { type Digest, getDigest } from "@/functions/activity.functions";
import {
	type Capabilities,
	getCapabilities,
	getTripCounts,
	getTripGraph,
	listActivity,
} from "@/functions/graph.functions";
import { listInbox } from "@/functions/inbox.functions";
import { getLeg } from "@/functions/legs.functions";
import { getUserPrefs } from "@/functions/prefs.functions";
import { listProposals } from "@/functions/proposals.functions";
import { resolveTripSlug } from "@/functions/trips.functions";
import { getSessionFn } from "@/lib/auth/session.functions";
import type { Viewer } from "@/lib/auth/viewer";
import type { TripCounts, TripGraph } from "@/lib/engine/types";
import type { InboxDto } from "@/lib/schemas/inbox";
import type { UserPrefs } from "@/lib/schemas/misc";
import type { ProposalDto } from "@/lib/schemas/proposals";
import type { LegTarget } from "@/lib/schemas/targets";
import {
	capabilitiesKey,
	meKeys,
	sessionKey,
	tripKeys,
	tripSlugKey,
} from "./keys";
import { persistedQuery } from "./persister";

/** `sel`-style stable key of a leg target (`l.<from>.<to>` / `s.<day>.<end>`). */
export function legTargetKey(t: LegTarget): string {
	return t.kind === "pair"
		? `l.${t.fromItemId}.${t.toItemId}`
		: `s.${t.dayId}.${t.end}`;
}

export const sessionQuery = () =>
	persistedQuery({
		queryKey: sessionKey,
		queryFn: (): Promise<Viewer | null> => getSessionFn(),
	});

export const capabilitiesQuery = () =>
	persistedQuery({
		queryKey: capabilitiesKey,
		queryFn: (): Promise<Capabilities> => getCapabilities(),
		staleTime: 60 * 60 * 1000,
	});

/** A trip's id from its slug; slugs rarely change, so it never goes stale. */
export const tripSlugQuery = (slug: string) =>
	persistedQuery({
		queryKey: tripSlugKey(slug),
		queryFn: (): Promise<{ tripId: string }> =>
			resolveTripSlug({ data: { slug } }),
		staleTime: Number.POSITIVE_INFINITY,
	});

/** The whole trip for the zoom engine. `trip.version` feeds the missed-event check. */
export const tripGraphQuery = (tripId: string) =>
	persistedQuery({
		queryKey: tripKeys.graph(tripId),
		// The wire type only loosens `nodes[].details` for Start's serializer check.
		queryFn: async (): Promise<TripGraph> =>
			(await getTripGraph({ data: { tripId } })) as unknown as TripGraph,
	});

/**
 * E7 open proposals (`listProposals`, F-ext1 fills the recent/closed ones).
 * `[]` for viewers and guest viewers; the route only enables it for callers
 * who can propose or review.
 */
export const tripProposalsQuery = (tripId: string) =>
	persistedQuery({
		queryKey: tripKeys.proposals(tripId),
		queryFn: (): Promise<ProposalDto[]> => listProposals({ data: { tripId } }),
	});

/** E6 digest: snapshotted once per trip open, never refetched mid-session. */
export const tripDigestQuery = (tripId: string) =>
	queryOptions({
		queryKey: tripKeys.digest(tripId),
		queryFn: (): Promise<Digest> => getDigest({ data: { tripId } }),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});

/**
 * ADDENDUM §10 one inbox (the bell). `tripId` = the workspace's trip;
 * omitted = every trip (dashboard). Not persisted offline (read state moves).
 */
export const inboxQuery = (tripId?: string) =>
	queryOptions({
		queryKey: tripId ? [...meKeys.inbox, tripId] : meKeys.inbox,
		queryFn: (): Promise<InboxDto> =>
			listInbox({ data: tripId ? { tripId } : {} }),
		staleTime: 60_000,
	});

/** ADDENDUM §7.2: view settings synced to the account. */
export const userPrefsQuery = () =>
	queryOptions({
		queryKey: meKeys.prefs,
		queryFn: (): Promise<UserPrefs> => getUserPrefs(),
		staleTime: 5 * 60_000,
	});

export const tripCountsQuery = (tripId: string) =>
	persistedQuery({
		queryKey: tripKeys.counts(tripId),
		queryFn: (): Promise<TripCounts> => getTripCounts({ data: { tripId } }),
	});

export type ActivityTarget = {
	nodeId?: string;
	legId?: string;
	itemId?: string;
	dayId?: string;
};

export const activityQuery = (tripId: string, target: ActivityTarget = {}) =>
	queryOptions({
		queryKey: tripKeys.activity(
			tripId,
			Object.entries(target)
				.map(([k, v]) => `${k}:${v}`)
				.join(",") || "trip",
		),
		queryFn: () => listActivity({ data: { tripId, limit: 20, ...target } }),
	});

/** One leg including its transit alternatives (the leg inspector). */
export const legQuery = (tripId: string, target: LegTarget) =>
	queryOptions({
		queryKey: tripKeys.leg(tripId, legTargetKey(target)),
		queryFn: () => getLeg({ data: { target } }),
	});

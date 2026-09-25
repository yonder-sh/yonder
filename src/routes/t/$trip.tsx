import {
	useQuery,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	notFound,
	Outlet,
	useNavigate,
	useParams,
	useRouter,
} from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { YonderMark } from "@/components/common/yonder-mark";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	isNetworkFailure,
	markTripSaved,
	readSavedTrips,
	removeTripOffline,
	removeTripPageOffline,
} from "@/features/offline/saved-trips";
import { Workspace } from "@/features/shell/Workspace";
import { JOIN_PATH, LOGIN_PATH } from "@/lib/auth/constants";
import { lostLinkFor, markGrantGone } from "@/lib/auth/grants";
import { requireTripViewer } from "@/lib/auth/guards";
import { requestReauth } from "@/lib/auth/reauth";
import { can } from "@/lib/auth/roles";
import type { Viewer } from "@/lib/auth/viewer";
import { pageTitle } from "@/lib/brand";
import { errorCode, isAccessDenied } from "@/lib/errors";
import { sessionKey } from "@/lib/query/keys";
import {
	tripCountsQuery,
	tripDigestQuery,
	tripGraphQuery,
	tripProposalsQuery,
	tripSlugQuery,
} from "@/lib/query/trip-queries";
import { useConnectionStatus } from "@/lib/realtime/connection";
import { AUTH_FAILURE, type JobEvent } from "@/lib/realtime/protocol";
import { TripChannelProvider } from "@/lib/realtime/trip-channel";
import {
	WorkspaceModelProvider,
	type WorkspaceRouteBinding,
} from "@/lib/workspace/model-context";
import type { NavTarget } from "@/lib/workspace/nav";
import { WorkspaceSearch } from "@/lib/workspace/search";
import { useUi } from "@/lib/workspace/ui-store";

/**
 * `/t/$trip/…` — the trip workspace (SPEC §12.1, D5: `ssr: false`). The scope
 * is the URL tail (`/t/asia-2027/japan/tokyo`, the `$` child route); lens,
 * tab, days, sel, only, list, mf and who are search params (§12.1).
 *
 * The guard signs a returning link guest back in; the loader resolves the
 * slug and loads the graph (from IndexedDB first when offline, §16.4). The
 * component mounts the live trip channel (invalidation + presence, §10.5)
 * around the workspace model and WP-Shell's `<Workspace/>`.
 */
export const Route = createFileRoute("/t/$trip")({
	ssr: false,
	validateSearch: WorkspaceSearch,
	beforeLoad: ({ params, location, context }) =>
		requireTripViewer(params.trip, location.href, {
			queryClient: context.queryClient,
		}),
	loader: async ({ context, params }) => {
		let tripId: string | undefined;
		try {
			({ tripId } = await context.queryClient.ensureQueryData(
				tripSlugQuery(params.trip),
			));
			const graph = await context.queryClient.ensureQueryData(
				tripGraphQuery(tripId),
			);
			// EXTENSIONS §9: the digest snapshot comes with the trip bootstrap (not
			// awaited; the banner takes it if it lands within 1.5 s of first paint).
			if (typeof navigator === "undefined" || navigator.onLine !== false)
				void context.queryClient
					.prefetchQuery(tripDigestQuery(tripId))
					.catch(() => undefined);
			return { tripId, name: graph.trip.name };
		} catch (e) {
			const code = errorCode(e);
			if (code === "NOT_FOUND" || code === "FORBIDDEN") {
				// SPEC §16.4: a trip that is gone (or no longer ours) leaves the device.
				const saved =
					tripId ??
					readSavedTrips().find((t) => t.slug === params.trip)?.tripId;
				if (saved) void removeTripOffline(saved);
				// An expected answer, not a crash: the not-found view, no error boundary.
				throw notFound();
			}
			throw e;
		}
	},
	head: ({ loaderData }) => ({
		meta: [{ title: pageTitle(loaderData?.name) }],
	}),
	pendingComponent: WorkspacePending,
	errorComponent: TripError,
	notFoundComponent: TripNotFound,
	component: TripRoute,
});

function TripRoute() {
	const { tripId } = Route.useLoaderData();
	const { trip: slug } = Route.useParams();
	return (
		<>
			<TripWorkspace tripId={tripId} slug={slug} />
			<Outlet />
		</>
	);
}

/** Progress toast for background jobs (autofill, media, link previews). */
function jobToast(e: JobEvent) {
	const label = {
		autofill: "Filling in travel times",
		media: "Processing media",
		links: "Fetching link previews",
	}[e.kind];
	const id = `job-${e.tripId}-${e.kind}`;
	if (e.remaining === 0) toast.dismiss(id);
	else toast.loading(`${label}… ${e.total - e.remaining}/${e.total}`, { id });
}

function TripWorkspace({ tripId, slug }: { tripId: string; slug: string }) {
	const { data: graph, error: graphError } = useSuspenseQuery(
		tripGraphQuery(tripId),
	);
	const counts = useQuery(tripCountsQuery(tripId)).data;
	const search = Route.useSearch();
	const splat = useParams({ strict: false })._splat ?? "";
	const navigate = useNavigate();
	const router = useRouter();
	const qc = useQueryClient();
	const connection = useConnectionStatus();
	const flash = useUi((s) => s.flash);
	const mayProposals =
		can(graph.me, "propose") || can(graph.me, "reviewProposals");
	const proposals = useQuery({
		...tripProposalsQuery(tripId),
		enabled: mayProposals,
	}).data;

	useEffect(() => {
		void markTripSaved(slug, tripId, graph.trip.name);
	}, [slug, tripId, graph.trip.name]);
	// A live rename reaches the tab title too (QA TRIP-04); `head()` only sees
	// the loader's snapshot.
	useEffect(() => {
		document.title = pageTitle(graph.trip.name);
	}, [graph.trip.name]);
	// Per-trip UI state: the remembered suggest mode on open, a reset on leave.
	useEffect(() => {
		useUi.getState().loadSuggesting(tripId);
		return () => useUi.getState().resetUi();
	}, [tripId]);

	const go = useCallback(
		(t: NavTarget, opts?: { replace?: boolean }) => {
			const replace = opts?.replace ?? false;
			if (t.splat)
				void navigate({
					to: "/t/$trip/$",
					params: { trip: slug, _splat: t.splat },
					search: t.search,
					replace,
				});
			else
				void navigate({
					to: "/t/$trip",
					params: { trip: slug },
					search: t.search,
					replace,
				});
		},
		[navigate, slug],
	);
	const href = useCallback(
		(t: NavTarget) =>
			t.splat
				? router.buildLocation({
						to: "/t/$trip/$",
						params: { trip: slug, _splat: t.splat },
						search: t.search,
					}).href
				: router.buildLocation({
						to: "/t/$trip",
						params: { trip: slug },
						search: t.search,
					}).href,
		[router, slug],
	);
	const route = useMemo<WorkspaceRouteBinding>(
		() => ({ splat, search, go, href }),
		[splat, search, go, href],
	);

	const isGuest = graph.me.isGuest;
	const onAccessLost = useCallback(
		(reason?: string) => {
			// The session ended (expired, revoked elsewhere), not the access: sign
			// in again in place and keep the page (QA ERR-07).
			if (reason === AUTH_FAILURE.unauthorized) {
				requestReauth();
				return;
			}
			void removeTripOffline(tripId);
			qc.removeQueries({ queryKey: ["trip", tripId] });
			if (isGuest) {
				// QA LINK-04/05: the link was turned off or replaced. A guest has no
				// dashboard to go back to: the page says the link no longer works
				// (and says so again on reload), never the account sign-in.
				markGrantGone(slug);
				void navigate({ href: JOIN_PATH, replace: true });
				return;
			}
			toast("You no longer have access to this trip.");
			void navigate({ to: "/dashboard" });
		},
		[tripId, slug, isGuest, qc, navigate],
	);
	// QA SEC-R2-04 / PWA-08: the graph came from this device's saved copy and
	// its revalidation says the trip is gone for us (a link turned off while
	// the live channel was down, so no socket close told us): the same exit
	// as a live access loss, purge included.
	const revalidationDenied = isAccessDenied(graphError);
	useEffect(() => {
		if (revalidationDenied) onAccessLost();
	}, [revalidationDenied, onAccessLost]);

	return (
		<TripChannelProvider
			tripId={tripId}
			baseVersion={graph.trip.version}
			onFlash={(hint, actor) => actor && flash(hint.id, actor)}
			onJob={jobToast}
			onAccessLost={onAccessLost}
		>
			<WorkspaceModelProvider
				graph={graph}
				counts={counts}
				mode="live"
				connection={connection}
				route={route}
				proposals={proposals}
			>
				<Workspace />
			</WorkspaceModelProvider>
		</TripChannelProvider>
	);
}

/** The workspace's shape while the graph loads (no spinner in the middle of nothing). */
function WorkspacePending() {
	return (
		<div className="flex h-svh flex-col">
			<div className="flex h-[52px] items-center gap-3 border-b px-3">
				<YonderMark className="size-5 text-primary" />
				<Skeleton className="h-5 w-40" />
				<Skeleton className="ml-6 h-5 w-56" />
			</div>
			<div className="flex min-h-0 flex-1">
				<div className="hidden w-[264px] border-r bg-sidebar xl:block" />
				<div className="w-full max-w-[520px] space-y-3 border-r p-4">
					<Skeleton className="h-6 w-48" />
					<Skeleton className="h-14 w-full" />
					<Skeleton className="h-14 w-full" />
					<Skeleton className="h-14 w-full" />
				</div>
				<div className="hidden flex-1 bg-basemap-land md:block" />
			</div>
		</div>
	);
}

/** NOT_FOUND / FORBIDDEN from the loader (`notFound()`): expected, so no error boundary. */
function TripNotFound() {
	return <TripError error={new Error("NOT_FOUND")} />;
}

/** The trip's path segment in the address bar (as the service worker keys it). */
function urlSlug(): string {
	return typeof window === "undefined"
		? ""
		: (window.location.pathname.split("/")[2] ?? "");
}

function plainSlug(slug: string): string {
	try {
		return decodeURIComponent(slug);
	} catch {
		return slug;
	}
}

/** Real failures (network, server errors). Access problems land in TripNotFound. */
function TripError({ error }: { error: unknown }) {
	const code = errorCode(error);
	const noAccess = code === "NOT_FOUND" || code === "FORBIDDEN";
	const slug = urlSlug();
	// A link guest (anonymous session) whose link to THIS trip was turned off
	// or replaced: say that it no longer works (QA LINK-04 on reload). A trip
	// they never had a link to is the plain "no access" page, and the link
	// they do hold stays remembered (QA LINK-07).
	const viewer = useQueryClient().getQueryData<Viewer | null>(sessionKey);
	const linkGone =
		noAccess &&
		viewer?.isAnonymous === true &&
		!!slug &&
		lostLinkFor(plainSlug(slug));
	// Offline on a trip this device doesn't keep (QA PWA-05/08): the service
	// worker can still hold a page shell for it (a visit that ended here), but
	// the shell alone can't open the trip. Say what offline.html says, and
	// offer the trip that is kept.
	const saved = readSavedTrips();
	const notKept =
		!noAccess &&
		isNetworkFailure(error) &&
		!saved.some((t) => t.slug === plainSlug(slug));
	const keptTrip = notKept ? saved[0] : undefined;
	useEffect(() => {
		// The no-access answer is never kept as this trip's offline copy: drop
		// the page shell the worker just cached for it, even when the saved
		// copy is already gone (PWA-08, LINK-04), and the saved copy if not.
		if (!noAccess || !slug) return;
		void removeTripPageOffline(slug);
		if (linkGone) markGrantGone(plainSlug(slug));
	}, [noAccess, linkGone, slug]);
	return (
		<main className="flex min-h-svh flex-col items-center justify-center gap-6 p-8">
			<YonderMark className="size-8 text-primary" />
			<EmptyState
				line={
					linkGone
						? "This link is no longer active."
						: noAccess
							? "This trip doesn't exist or you don't have access."
							: notKept
								? "Not available offline. Open this trip once while you're online to keep a copy."
								: "We couldn't open this trip."
				}
				action={
					linkGone ? (
						<Link
							to={LOGIN_PATH}
							className={buttonVariants({ variant: "outline" })}
						>
							Sign in
						</Link>
					) : keptTrip ? (
						// A full load, like offline.html: the worker serves its shell.
						<a
							href={`/t/${encodeURIComponent(keptTrip.slug)}?from=offline`}
							className={buttonVariants({ variant: "outline" })}
						>
							Open {keptTrip.name || "your saved trip"}
						</a>
					) : (
						<Link
							to="/dashboard"
							className={buttonVariants({ variant: "outline" })}
						>
							Go to your trips
						</Link>
					)
				}
			/>
		</main>
	);
}

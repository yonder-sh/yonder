import { hashKey, type QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { sessionKey } from "@/lib/query/keys";
import { queryPersister } from "@/lib/query/persister";
import { authClient } from "./auth-client";
import { JOIN_PATH, LOGIN_PATH, WELCOME_PATH } from "./constants";
import { forgetGrant, grantFor } from "./grants";
import { getSessionFn } from "./session.functions";
import { redeemShareLink } from "./share.functions";
import { purgePreviousUserData } from "./sign-out";
import type { Viewer } from "./viewer";

/**
 * `beforeLoad` guards for other routes (SPEC §11.2 flow 3). They are UX only:
 * every server function enforces the same rules itself.
 *
 *   // routes/_authed.tsx
 *   beforeLoad: ({ location }) => requireAccountViewer(location.href)
 *
 *   // routes/t/$trip.tsx (ssr: false)
 *   beforeLoad: ({ params, location }) => requireTripViewer(params.trip, location.href)
 */

const withNext = (path: string, next: string) =>
	`${path}?${new URLSearchParams({ next })}`;

export type GuardOptions = {
	/**
	 * The router's QueryClient. With it, a session that loads is kept as the
	 * persisted `['session']` query, and a NETWORK failure (offline) falls back
	 * to that saved session instead of failing the route (SPEC §16.4 "Session
	 * offline"). Server answers (401, …) never fall back.
	 */
	queryClient?: QueryClient;
};

/** A fetch that never reached the server (offline, DNS, a dropped socket). */
function isNetworkFailure(e: unknown): boolean {
	if (typeof navigator !== "undefined" && navigator.onLine === false)
		return true;
	return e instanceof TypeError;
}

/** The last saved session: in memory first, then IndexedDB. `undefined` = none. */
async function savedSession(
	qc: QueryClient,
): Promise<Viewer | null | undefined> {
	const cached = qc.getQueryData<Viewer | null>(sessionKey);
	if (cached !== undefined) return cached;
	try {
		return await queryPersister.retrieveQuery<Viewer | null>(
			hashKey(sessionKey),
		);
	} catch {
		return undefined;
	}
}

/** Whose data this page's QueryClient holds (the last signed-in viewer). */
const cachedFor = new WeakMap<QueryClient, string>();

/**
 * Whose data this DEVICE holds (QA SEC-R3-03): the last viewer adopted on
 * any page load. A fresh page has no in-memory answer, so without it a
 * session that ended without a sign-out left the previous person's
 * persisted queries and cached pages for the next one.
 */
const DEVICE_VIEWER_KEY = "yonder:viewer";

function deviceViewer(): string | undefined {
	try {
		return window.localStorage.getItem(DEVICE_VIEWER_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

function rememberDeviceViewer(id: string): void {
	try {
		window.localStorage.setItem(DEVICE_VIEWER_KEY, id);
	} catch {
		// storage disabled: the in-memory check still works for this page
	}
}

/**
 * Someone else signed in on this page (a link guest who signed in to keep the
 * trip, or another account after a session ended): nothing cached for the
 * previous identity may show, so every query but the session goes, in memory
 * and in IndexedDB, and the collab socket reopens with the new cookie
 * (SECURITY §11; QA COLLAB-R2-06: the workspace kept "Guest Ibis" as
 * `graph.me` until a reload). The previous viewer comes from memory, else
 * from this device's marker (a fresh page load after a session ended without
 * a sign-out, QA SEC-R3-03).
 */
async function adoptViewer(qc: QueryClient, viewer: Viewer): Promise<void> {
	const before =
		cachedFor.get(qc) ??
		qc.getQueryData<Viewer | null>(sessionKey)?.id ??
		deviceViewer();
	cachedFor.set(qc, viewer.id);
	rememberDeviceViewer(viewer.id);
	if (!before || before === viewer.id) return;
	await qc.cancelQueries();
	qc.removeQueries({ predicate: (q) => q.queryKey[0] !== sessionKey[0] });
	await queryPersister.removeQueries().catch(() => undefined);
	await import("@/lib/realtime/collab-client")
		.then((m) => m.resetCollabClient())
		.catch(() => undefined);
	// Every other layer's copy of the previous person: the sign-out teardown,
	// minus the sign-out. On a fresh page this guard runs before the layers
	// mount and register theirs, so WP-Home's (SW pages cache with the
	// `/share` shell, offline docs, share inbox, saved-trips index) runs here.
	await Promise.allSettled([
		purgePreviousUserData(),
		import("@/features/offline/app-lifecycle").then((h) =>
			h.homeSignOutCleanup(),
		),
	]);
}

/** `getSessionFn()`, saved for offline use, with the offline fallback. */
async function loadViewer(opts: GuardOptions): Promise<Viewer | null> {
	const qc = opts.queryClient;
	try {
		const viewer = await getSessionFn();
		if (qc && typeof window !== "undefined") {
			if (viewer) await adoptViewer(qc, viewer);
			qc.setQueryData(sessionKey, viewer);
			void queryPersister
				.persistQueryByKey(sessionKey, qc)
				.catch(() => undefined);
		}
		return viewer;
	} catch (e) {
		if (!qc || typeof window === "undefined" || !isNetworkFailure(e)) throw e;
		const saved = await savedSession(qc);
		if (saved === undefined) throw e;
		return saved;
	}
}

/**
 * The dashboard's guard: a named, non-anonymous account. Signed out or guest
 * → /login?next=…; blank names → /welcome?next=…. Returns `{ viewer }` so it
 * can be spread into the route context.
 */
export async function requireAccountViewer(
	href: string,
	opts: GuardOptions = {},
): Promise<{ viewer: Viewer }> {
	const viewer = await loadViewer(opts);
	if (!viewer || viewer.isAnonymous)
		throw redirect({ href: withNext(LOGIN_PATH, href) });
	if (!viewer.named) throw redirect({ href: withNext(WELCOME_PATH, href) });
	return { viewer };
}

/**
 * The workspace's guard. With no session but a remembered share token for
 * this slug (`yonder:grants`), it silently re-enters as a guest and re-redeems
 * the link; a dead link is forgotten and falls through to /login. Accounts
 * with blank names go to /welcome. Whether the viewer may see this trip is
 * decided by the trip queries (NOT_FOUND → "no access" screen).
 *
 * Client-only (reads localStorage): use it on `ssr: false` routes.
 */
export async function requireTripViewer(
	slug: string,
	href: string,
	opts: GuardOptions = {},
): Promise<{ viewer: Viewer }> {
	let viewer = await loadViewer(opts);
	if (!viewer) {
		const token = typeof window === "undefined" ? null : grantFor(slug);
		if (token) {
			const { error } = await authClient.signIn.anonymous();
			if (!error) {
				try {
					await redeemShareLink({ data: { token } });
					viewer = await getSessionFn();
					if (viewer && opts.queryClient)
						await adoptViewer(opts.queryClient, viewer);
				} catch {
					forgetGrant(slug);
					await authClient.deleteAnonymousUser().catch(() => undefined);
					// QA LINK-05: a remembered link that was turned off or replaced
					// says so ("This link no longer works."), not the sign-in page.
					throw redirect({ href: JOIN_PATH, replace: true });
				}
			}
		}
	}
	if (!viewer) throw redirect({ href: withNext(LOGIN_PATH, href) });
	if (!viewer.named) throw redirect({ href: withNext(WELCOME_PATH, href) });
	return { viewer };
}

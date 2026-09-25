import type pg from "pg";
import { hasFullName } from "@/lib/auth/names";
import { can, type TripAccess } from "@/lib/auth/roles";
import {
	AUTH_FAILURE,
	type AuthFailure,
	COOKIE_TOKEN,
	type DocRef,
} from "@/lib/realtime/protocol";
import { parseAvatarImageUrl } from "@/lib/schemas/avatar";
import { type AccessRow, resolveAccess } from "@/server/authz/resolve";

/**
 * Who may open which collab document (SPEC §10.3, D3; SECURITY §4).
 *
 * 1. Identity: the Better Auth session of the WebSocket upgrade (same-origin cookie),
 *    or `Authorization: Bearer <session token>` for Node clients. Checked with the
 *    collab process's own `betterAuth(authOptions())`, never the cookie cache, so a
 *    signed-out or revoked session fails on the very next connect.
 * 2. Role: read from Postgres on EVERY connect (membership, or a grant on a live
 *    share link), never cached, so a removed member / reset link / downgraded
 *    editor is refused (or read-only) as soon as the socket reconnects.
 * 3. Target: a note's node/item/leg/day must exist, be live and belong to the trip.
 * 4. Private notes (`…/u/<userId>`, ADDENDUM §7.2): only that user, and only as
 *    a member (never a guest), may open one; for its owner it is writable.
 * 5. Writes: shared notes are writable only with `editNotes` (EXTENSIONS §3.1:
 *    suggesters and viewers are read-only, members and guests alike). The
 *    decision is re-checked on open connections (`app.ts` beforeHandleMessage).
 */

/** Thrown from `onAuthenticate`; Hocuspocus sends `reason` to the provider. */
export class CollabAuthError extends Error {
	constructor(readonly reason: AuthFailure) {
		super(reason);
		this.name = "CollabAuthError";
	}
}

/** The identity part of a Better Auth session that collab needs. */
export type SessionUser = {
	id: string;
	name: string;
	image?: string | null;
	isAnonymous?: boolean | null;
	firstName?: string | null;
	lastName?: string | null;
};

/** Resolves request headers to the signed-in user, or null. */
export type SessionLookup = (headers: Headers) => Promise<SessionUser | null>;

/** The slice of a Better Auth instance collab uses. */
export type SessionApi = {
	api: {
		getSession(ctx: {
			headers: Headers;
			query?: { disableCookieCache?: boolean };
		}): Promise<{ user: SessionUser } | null>;
	};
};

/** A SessionLookup backed by Better Auth (`betterAuth(authOptions())`). */
export function betterAuthSessionLookup(auth: SessionApi): SessionLookup {
	return async (headers) => {
		try {
			const session = await auth.api.getSession({
				headers,
				query: { disableCookieCache: true },
			});
			return session?.user ?? null;
		} catch (e) {
			// A DB/Redis hiccup must refuse the connection, not crash the hook chain.
			console.error(
				"[collab] session lookup failed:",
				e instanceof Error ? e.message : e,
			);
			return null;
		}
	};
}

/**
 * Headers for the session lookup: the upgrade's own headers (cookie), plus the
 * provider's token as a bearer token unless it is the `'cookie'` placeholder.
 */
export function sessionHeaders(
	requestHeaders: Headers,
	token: string,
): Headers {
	const headers = new Headers(requestHeaders);
	if (token && token !== COOKIE_TOKEN)
		headers.set("authorization", `Bearer ${token}`);
	else headers.delete("authorization");
	return headers;
}

/** The connection context every later hook sees (`connection.context`). */
export type CollabContext = {
	userId: string;
	tripId: string;
	slug: string;
	role: TripAccess["role"];
	memberId: string | null;
	guest: boolean;
	/** Presence colour index 0..7. */
	color: number;
	name: string;
	/** FB-16: `user.image` when it is our own avatar URL (presence shows it). */
	image?: string | null;
	docKind: DocRef["kind"];
	/** Set by the server: finds this connection's admission for access re-checks. Never sent to clients. */
	admissionKey?: string;
};

/**
 * The user's access to a trip: an active membership, or a grant on an enabled,
 * unrevoked, unexpired share link of a live trip. Null = no access.
 */
export async function loadTripAccess(
	pool: pg.Pool,
	tripId: string,
	userId: string,
): Promise<TripAccess | null> {
	const { rows } = await pool.query<AccessRow>(
		`select 'member' as via, m.role::text as role, m.id::text as "memberId", m.color, t.slug
		   from trip_members m
		   join trips t on t.id = m.trip_id and t.deleted_at is null
		  where m.trip_id = $1 and m.user_id = $2 and m.status = 'active'
		 union all
		 select 'grant', l.role::text, null, g.color, t.slug
		   from share_grants g
		   join share_links l on l.id = g.share_link_id and l.trip_id = g.trip_id
		   join trips t on t.id = l.trip_id and t.deleted_at is null
		  where g.trip_id = $1 and g.user_id = $2
		    and l.enabled and l.revoked_at is null
		    and (l.expires_at is null or l.expires_at > now())`,
		[tripId, userId],
	);
	return resolveAccess(tripId, rows);
}

const TARGET_SQL = {
	node: "select 1 from nodes where id = $2 and trip_id = $1 and deleted_at is null",
	item: "select 1 from items where id = $2 and trip_id = $1 and deleted_at is null",
	leg: "select 1 from legs where id = $2 and trip_id = $1",
	day: "select 1 from trip_days where id = $2 and trip_id = $1",
} as const;

/** True when the document's note target exists, is live and belongs to its trip. */
export async function targetInTrip(
	pool: pg.Pool,
	doc: DocRef,
): Promise<boolean> {
	if (doc.kind === "channel" || doc.target.kind === "root") return true;
	const { rowCount } = await pool.query(TARGET_SQL[doc.target.kind], [
		doc.tripId,
		doc.target.id,
	]);
	return (rowCount ?? 0) > 0;
}

/**
 * The whole `onAuthenticate` decision, minus Hocuspocus. Throws CollabAuthError
 * with the reason the client sees; returns the context and whether the connection
 * is read-only (the channel doc always is; viewers are on notes too).
 */
export async function authorizeConnection(
	deps: { pool: pg.Pool; lookupSession: SessionLookup },
	input: { doc: DocRef | null; requestHeaders: Headers; token: string },
): Promise<{ context: CollabContext; readOnly: boolean }> {
	const { doc } = input;
	if (!doc) throw new CollabAuthError(AUTH_FAILURE.badDoc);
	const user = await deps.lookupSession(
		sessionHeaders(input.requestHeaders, input.token),
	);
	if (!user) throw new CollabAuthError(AUTH_FAILURE.unauthorized);
	if (!user.isAnonymous && !hasFullName(user)) {
		throw new CollabAuthError(AUTH_FAILURE.nameRequired);
	}
	const access = await loadTripAccess(deps.pool, doc.tripId, user.id);
	if (!access) throw new CollabAuthError(AUTH_FAILURE.forbidden);
	if (!mayOpen(doc, access, user.id))
		throw new CollabAuthError(AUTH_FAILURE.forbidden);
	// The caller may read this trip: saying the target isn't in it reveals
	// nothing, and lets an open editor tell "this day was removed" (QA P1).
	if (!(await targetInTrip(deps.pool, doc)))
		throw new CollabAuthError(AUTH_FAILURE.gone);
	return {
		context: {
			userId: user.id,
			tripId: doc.tripId,
			slug: access.slug,
			role: access.role,
			memberId: access.memberId,
			guest: access.isGuest,
			color: access.color,
			name: user.name,
			...(parseAvatarImageUrl(user.image) ? { image: user.image } : {}),
			docKind: doc.kind,
		},
		readOnly: readOnlyFor(doc, access),
	};
}

/** Whether this access may open the document at all (private notes: owner members only). */
export function mayOpen(
	doc: DocRef,
	access: Pick<TripAccess, "isGuest">,
	userId: string,
): boolean {
	if (doc.kind === "note" && doc.ownerUserId)
		return doc.ownerUserId === userId && !access.isGuest;
	return true;
}

/**
 * Read-only unless the access may write this document: the channel doc never,
 * a private note always for its owner, a shared note with `editNotes`.
 */
export function readOnlyFor(
	doc: DocRef,
	access: Pick<TripAccess, "role" | "isGuest">,
): boolean {
	if (doc.kind === "channel") return true;
	if (doc.ownerUserId) return false;
	return !can(access, "editNotes");
}

/**
 * Cross-site WebSocket hijacking guard (SECURITY §4): CORS does not apply to
 * WebSockets and the session cookie rides along, so a browser upgrade must come
 * from an app origin. Requests without an Origin (Node clients) pass; they can't
 * borrow a victim's cookie. Outside production any localhost port is allowed
 * (every agent / Vite instance has its own).
 */
export function createOriginCheck(opts: {
	allowedOrigins: readonly string[];
	allowAnyLocalhost: boolean;
}): (origin: string | null | undefined) => boolean {
	const allowed = new Set(opts.allowedOrigins);
	return (origin) => {
		if (!origin) return true;
		if (allowed.has(origin)) return true;
		if (!opts.allowAnyLocalhost) return false;
		try {
			const u = new URL(origin);
			return (
				(u.protocol === "http:" || u.protocol === "https:") &&
				(u.hostname === "localhost" ||
					u.hostname === "127.0.0.1" ||
					u.hostname === "[::1]")
			);
		} catch {
			return false;
		}
	};
}

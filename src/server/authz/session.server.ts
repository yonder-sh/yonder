import { getRequest, setResponseStatus } from "@tanstack/react-start/server";
import { type AuthSession, type AuthUser, auth } from "@/server/auth.server";
import { AppError, type ErrorCode } from "./errors";
import { assertAccount, assertNamedUser, assertUser } from "./policy";

/**
 * Session access for server functions and API routes.
 *
 * The session is read once per request (memoized on the Request object) and
 * never from Better Auth's cookie cache: Redis-backed lookups are cheap, and
 * this makes sign-out and session revocation immediate for every server
 * function (QA AUTH-12), not "within 5 minutes".
 */
const perRequest = new WeakMap<Request, Promise<AuthSession | null>>();

/** Loads the session for `headers` (Better Auth cookie or `Authorization: Bearer`). */
export function loadSession(headers: Headers): Promise<AuthSession | null> {
	return auth.api.getSession({ headers, query: { disableCookieCache: true } });
}

/** The current request's session, or null. Only valid inside a request. */
export function getSession(): Promise<AuthSession | null> {
	const request = getRequest();
	let session = perRequest.get(request);
	if (!session) {
		session = loadSession(request.headers);
		perRequest.set(request, session);
	}
	return session;
}

/** The current user, or null. */
export async function getUser(): Promise<AuthUser | null> {
	return (await getSession())?.user ?? null;
}

/**
 * Sets the HTTP status that matches the error's code, then returns the error
 * for the caller to throw. TanStack Start answers a thrown server-function
 * error with the response's current status (200 unless set), so without this
 * a 403 would travel as a 200 (spikes/auth gotcha 13).
 */
export function withStatus<E extends Error>(e: E): E {
	if (e instanceof AppError) {
		try {
			setResponseStatus(e.status);
		} catch {
			// Outside a request (scripts, tests): nothing to set.
		}
	}
	return e;
}

/** Throws an AppError with the matching HTTP status. */
export function fail(code: ErrorCode, detail?: string): never {
	throw withStatus(new AppError(code, detail));
}

/** Runs a policy assertion, mapping its AppError onto the response status. */
export function enforce<T>(check: () => T): T {
	try {
		return check();
	} catch (e) {
		throw e instanceof Error ? withStatus(e) : e;
	}
}

/** A signed-in user (anonymous guests included), else UNAUTHORIZED (401). */
export async function requireUser(): Promise<AuthUser> {
	const user = await getUser();
	return enforce(() => assertUser(user));
}

/** Signed in with both names set (guests pass). Use for every mutation. */
export async function requireNamedUser(): Promise<AuthUser> {
	const user = await getUser();
	return enforce(() => assertNamedUser(user));
}

/** A named, non-anonymous account. */
export async function requireAccount(): Promise<AuthUser> {
	const user = await getUser();
	return enforce(() => assertAccount(user));
}

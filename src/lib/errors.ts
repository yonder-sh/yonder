import {
	AppError,
	type ErrorCode,
	errorCode,
	errorDetail,
} from "@/server/authz/errors";

/**
 * Client-side error helpers (SPEC §12.3). The error class and code parsing live
 * in the isomorphic `@/server/authz/errors` (no server imports), re-exported
 * here so UI code has one import path.
 */
export { AppError, type ErrorCode, errorCode, errorDetail };

const MESSAGES: Record<ErrorCode, string> = {
	UNAUTHORIZED: "You're signed out. Sign in again to continue.",
	FORBIDDEN: "You don't have permission to do that.",
	NOT_FOUND: "That no longer exists.",
	CONFLICT: "Someone changed this at the same time. Try again.",
	VALIDATION: "That doesn't look right. Check the value and try again.",
	RATE_LIMITED: "Too many tries. Wait a moment, then try again.",
	PROVIDER: "The service didn't answer. Try again in a moment.",
	OFFLINE: "You're offline. Editing is paused.",
	STORAGE_QUOTA: "You're out of storage space. Delete some uploads first.",
};

/** Detail strings the server sends that read well as they are. */
const READABLE_DETAIL = /^[A-Z][^:]{3,160}[.!?]$/;

/**
 * One short sentence for a toast. Uses the server's detail when it is already a
 * sentence ("A city can't go inside a place."), else the code's message, else a
 * network hint for fetch failures.
 */
export function humanError(e: unknown): string {
	const code = errorCode(e);
	if (code) {
		const detail = errorDetail(e);
		if (detail && READABLE_DETAIL.test(detail)) return detail;
		if (code === "FORBIDDEN" && detail === "name required")
			return "Add your name before editing.";
		return MESSAGES[code];
	}
	if (
		e instanceof TypeError ||
		(typeof navigator !== "undefined" && navigator.onLine === false)
	)
		return "Can't reach the server. Check your connection.";
	return "Something went wrong. Try again.";
}

/**
 * A save that failed for a reason a plain retry can fix (QA ERR-03): the
 * server broke (5xx, no app error code), the service behind it didn't answer
 * (`PROVIDER`), or the request never arrived while the browser is online.
 * Access, validation, conflicts and being offline (edits paused) are not.
 */
export function isRetryableError(e: unknown): boolean {
	const code = errorCode(e);
	if (code) return code === "PROVIDER";
	if (typeof navigator !== "undefined" && navigator.onLine === false)
		return false;
	return true;
}

/**
 * A server answer that the trip (or row) is gone or no longer the caller's:
 * `NOT_FOUND` / `FORBIDDEN`, never a network failure or an outage.
 */
export function isAccessDenied(e: unknown): boolean {
	if (!e) return false;
	const code = errorCode(e);
	return code === "NOT_FOUND" || code === "FORBIDDEN";
}

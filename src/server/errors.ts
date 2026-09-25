/**
 * The app's error type at its SPEC §12.3 path. There is exactly one class; it
 * lives in `authz/errors.ts` (isomorphic) and is re-exported here. Throw through
 * `fail(code, detail)` (`@/server/authz/session.server`) inside requests, so the
 * HTTP status matches the code.
 */
export {
	AppError,
	ERROR_CODES,
	ERROR_STATUS,
	type ErrorCode,
	errorCode,
	errorDetail,
} from "./authz/errors";

/**
 * The app's error type (SPEC §12.3). Isomorphic, no server imports.
 *
 * TanStack Start serializes thrown errors with seroval, which keeps `message`
 * but drops custom fields, so the code travels at the start of the message:
 * `"FORBIDDEN"` or `"FORBIDDEN: name required"`. `errorCode(e)` reads it back
 * on the client.
 *
 * NOTE: SPEC §4.1 places this class in `src/server/errors.ts` (F0). That file
 * did not exist when the auth layer was written; it should re-export from here
 * (or this file from it) so there is exactly one class.
 */
export const ERROR_CODES = [
	"UNAUTHORIZED",
	"FORBIDDEN",
	"NOT_FOUND",
	"CONFLICT",
	"VALIDATION",
	"RATE_LIMITED",
	"PROVIDER",
	"OFFLINE",
	/** ADDENDUM §12: an upload would take its account over its storage quota. */
	"STORAGE_QUOTA",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status used for each code on server-function and API responses. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	VALIDATION: 400,
	RATE_LIMITED: 429,
	PROVIDER: 502,
	OFFLINE: 503,
	STORAGE_QUOTA: 413,
};

export class AppError extends Error {
	readonly code: ErrorCode;
	readonly detail: string | undefined;

	constructor(code: ErrorCode, detail?: string) {
		super(detail ? `${code}: ${detail}` : code);
		this.name = "AppError";
		this.code = code;
		this.detail = detail;
	}

	get status(): number {
		return ERROR_STATUS[this.code];
	}
}

const CODE_RE = new RegExp(`^(${ERROR_CODES.join("|")})(?::|$)`);

/** The ErrorCode carried by an error (or its message), else null. */
export function errorCode(e: unknown): ErrorCode | null {
	if (e instanceof AppError) return e.code;
	const message =
		e instanceof Error
			? e.message
			: typeof e === "object" && e !== null && "message" in e
				? String((e as { message: unknown }).message)
				: typeof e === "string"
					? e
					: "";
	const m = CODE_RE.exec(message);
	return (m?.[1] as ErrorCode | undefined) ?? null;
}

type Issue = { message: string; path?: PropertyKey[] };

const isIssue = (v: unknown): v is Issue =>
	typeof v === "object" &&
	v !== null &&
	typeof (v as Issue).message === "string" &&
	(!("path" in v) || Array.isArray((v as Issue).path));

/**
 * A server function's input validator failing (TanStack Start throws a plain
 * Error whose message is the Standard Schema issues as JSON) as a VALIDATION
 * AppError, else null.
 */
export function validatorError(e: unknown): AppError | null {
	if (!(e instanceof Error) || e instanceof AppError) return null;
	if (!e.message.startsWith("[")) return null;
	let issues: unknown;
	try {
		issues = JSON.parse(e.message);
	} catch {
		return null;
	}
	if (!Array.isArray(issues) || issues.length === 0 || !issues.every(isIssue))
		return null;
	const detail = issues
		.map((i) =>
			i.path?.length ? `${i.path.join(".")}: ${i.message}` : i.message,
		)
		.join("; ");
	return new AppError("VALIDATION", detail);
}

/** The detail after "CODE: ", if any. */
export function errorDetail(e: unknown): string | null {
	const message =
		e instanceof Error ? e.message : typeof e === "string" ? e : "";
	const i = message.indexOf(": ");
	return errorCode(e) && i > 0 ? message.slice(i + 2) : null;
}

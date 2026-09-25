/**
 * Copy for Better Auth errors on the sign-in screens (SPEC §11.2 flow 1,
 * QA AUTH-06/07/08/14). Never says whether an email has an account.
 */
export interface AuthErrorLike {
	code?: string | null;
	message?: string | null;
	status?: number | null;
}

export type AuthErrorKind =
	| "invalid-email"
	| "invalid-code"
	| "expired"
	| "too-many-attempts"
	| "locked"
	| "rate-limited"
	| "send-failed"
	| "invalid-name"
	| "captcha"
	| "captcha-pending"
	| "network"
	| "unknown";

export function authErrorKind(
	e: AuthErrorLike | null | undefined,
): AuthErrorKind {
	if (!e) return "unknown";
	switch (e.code) {
		case "INVALID_EMAIL":
			return "invalid-email";
		case "INVALID_OTP":
			return "invalid-code";
		case "OTP_EXPIRED":
			return "expired";
		case "TOO_MANY_ATTEMPTS":
			return "too-many-attempts";
		case "OTP_LOCKED":
			return "locked";
		case "EMAIL_SEND_FAILED":
			return "send-failed";
		case "INVALID_NAME":
			return "invalid-name";
		// Better Auth's captcha plugin (Turnstile): a refused or missing token.
		case "VERIFICATION_FAILED":
		case "MISSING_RESPONSE":
			return "captcha";
		// Client-side: no Turnstile token came in time.
		case "CAPTCHA_PENDING":
			return "captcha-pending";
	}
	if (e.status === 429) return "rate-limited";
	if (e.status === 0 || e.status === undefined) return "network";
	return "unknown";
}

function waitText(seconds: number | null | undefined): string {
	if (!seconds || seconds <= 0) return "in a moment";
	if (seconds < 90) return `in ${seconds}s`;
	return `in ${Math.ceil(seconds / 60)} min`;
}

/** One sentence for the inline error under a field. */
export function authErrorMessage(
	e: AuthErrorLike | null | undefined,
	retryAfterSeconds?: number | null,
): string {
	switch (authErrorKind(e)) {
		case "invalid-email":
			return "Enter a valid email address.";
		case "invalid-code":
			return "Incorrect code. Check it or request a new one.";
		case "expired":
			return "Code expired. Send a new code to continue.";
		case "too-many-attempts":
			return "Too many attempts, request a new code.";
		case "locked":
			return `Too many incorrect codes. Try again ${waitText(retryAfterSeconds)}.`;
		case "rate-limited":
			return `Too many requests. Try again ${waitText(retryAfterSeconds)}.`;
		case "send-failed":
			return "We couldn't send the code, try again.";
		case "invalid-name":
			return "Enter your first and last name.";
		case "captcha":
			return "The security check didn't pass. Try again.";
		case "captcha-pending":
			return "Finish the security check, then try again.";
		case "network":
			return "You seem to be offline. Check your connection and try again.";
		default:
			return "Something went wrong. Try again.";
	}
}

/** Whether the code step should offer "Send a new code" as the fix. */
export function needsNewCode(e: AuthErrorLike | null | undefined): boolean {
	const kind = authErrorKind(e);
	return kind === "expired" || kind === "too-many-attempts";
}

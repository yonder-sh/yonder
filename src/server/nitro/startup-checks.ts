/**
 * Start-up checks of the built app server (`pnpm start`, the `app` image): a
 * misconfigured PRODUCTION server refuses to start (exit 1) instead of
 * failing its first sign-in. In development the problems are only logged.
 *
 * - `getEnv()`: the app's environment parses.
 * - `authEnv()`: a real BETTER_AUTH_SECRET, no DEV_FIXED_OTP, the test
 *   hatches only on localhost (`src/server/auth/env.server.ts`).
 * - An email transport: Resend (RESEND_API_KEY) or SMTP (SMTP_HOST).
 */
import { definePlugin } from "nitro";
import { authEnv, emailTransportProblem } from "@/server/auth/env.server";
import { getEnv } from "@/server/env.server";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every configuration problem the server can see before its first request. */
export function startupProblems(): string[] {
	const out: string[] = [];
	try {
		getEnv();
	} catch (e) {
		out.push(`[env] ${message(e)}`);
	}
	try {
		const problem = emailTransportProblem(authEnv());
		if (problem) out.push(problem);
	} catch (e) {
		out.push(message(e));
	}
	return out;
}

export default definePlugin(() => {
	const problems = startupProblems();
	if (!problems.length) return;
	for (const p of problems) console.error(p);
	if (process.env.NODE_ENV === "production") {
		console.error("[startup] refusing to start: fix the configuration above");
		process.exit(1);
	}
});

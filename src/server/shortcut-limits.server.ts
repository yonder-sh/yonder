import { authEnv } from "./auth/env.server";
import { rateLimitPer } from "./cache.server";

/**
 * The Shortcut endpoints' limits: true when `name` is over `points` in
 * `windowSec`. Fails open when Redis is down (codes and keys can't be
 * guessed; the limits only stop floods). Off with AUTH_RATE_LIMIT=off on
 * localhost, like the sign-in limits.
 */
export async function shortcutOverLimit(
	name: string,
	points: number,
	windowSec: number,
): Promise<boolean> {
	if (authEnv().rateLimitOff) return false;
	try {
		await rateLimitPer(`shortcut:${name}`, points, windowSec);
		return false;
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("RATE_LIMITED")) return true;
		console.error(
			"[shortcut] rate limit unavailable:",
			e instanceof Error ? e.message : e,
		);
		return false;
	}
}

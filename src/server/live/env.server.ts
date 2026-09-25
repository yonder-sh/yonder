import { z } from "zod";

/**
 * The realtime/jobs slice of `process.env` (SPEC §5.1 Redis block). Parsed lazily
 * and memoized, so importing this module never throws or connects.
 */
const blankToUndefined = (v: unknown) =>
	typeof v === "string" && v.trim() === "" ? undefined : v;

const Schema = z.object({
	REDIS_URL: z.preprocess(
		blankToUndefined,
		z.string().default("redis://localhost:6379"),
	),
	/**
	 * Every key, channel and queue starts with `${REDIS_PREFIX}:` (SPEC §0 rule 19).
	 * Parallel agents sharing one Redis each use their own (`yonder-a<n>`), because
	 * pub/sub ignores the database number in the URL.
	 */
	REDIS_PREFIX: z.preprocess(
		blankToUndefined,
		z
			.string()
			.regex(/^[A-Za-z0-9_.-]{1,64}$/, "REDIS_PREFIX: letters, digits, _ . -")
			.default("yonder"),
	),
});

export type LiveEnv = z.output<typeof Schema>;

let memo: LiveEnv | undefined;

export function liveEnv(): LiveEnv {
	memo ??= Schema.parse(process.env);
	return memo;
}

/** Tests only: forget the parsed env so a changed `process.env` is read again. */
export function resetLiveEnv(): void {
	memo = undefined;
}

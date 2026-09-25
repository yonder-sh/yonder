import { z } from "zod";

/**
 * Environment of the collab and worker processes (SPEC §5.1). Parsed once at
 * start-up: a misconfigured process should fail loudly before it listens.
 */
const blank = (v: unknown) =>
	typeof v === "string" && v.trim() === "" ? undefined : v;

const Schema = z.object({
	NODE_ENV: z.string().default("development"),
	HOCUSPOCUS_PORT: z.preprocess(
		blank,
		z.coerce.number().int().min(0).max(65535).default(1234),
	),
	/**
	 * Bind address. Default: loopback in dev (the Vite proxy sits in front), all
	 * interfaces in production (the `collab` pod, reached only through the
	 * gateway's `/collab` route; the port is never exposed).
	 */
	HOCUSPOCUS_HOST: z.preprocess(blank, z.string().optional()),
	DATABASE_URL: z.preprocess(
		blank,
		z.string().default("postgres://trip:trip@localhost:5432/trip"),
	),
	APP_URL: z.preprocess(blank, z.url().default("http://localhost:3000")),
	BETTER_AUTH_URL: z.preprocess(blank, z.url().optional()),
	BETTER_AUTH_SECRET: z.preprocess(blank, z.string().optional()),
	/** Extra browser origins allowed to open the socket (comma list, like Better Auth's). */
	TRUSTED_ORIGINS: z.preprocess(blank, z.string().default("")),
	/**
	 * Run the BullMQ worker inside the collab process too. Off by default because
	 * `pnpm dev` starts `collab/worker.ts` separately (SPEC §5.3); both at once is
	 * harmless (BullMQ workers are competing consumers).
	 */
	COLLAB_RUN_WORKER: z.preprocess(blank, z.enum(["0", "1"]).default("0")),
});

export type CollabEnv = Omit<z.output<typeof Schema>, "HOCUSPOCUS_HOST"> & {
	HOCUSPOCUS_HOST: string;
	isProduction: boolean;
	/** Origins a browser may open the collab socket from. */
	allowedOrigins: string[];
};

export function parseCollabEnv(
	source: Record<string, string | undefined> = process.env,
): CollabEnv {
	const env = Schema.parse(source);
	const isProduction = env.NODE_ENV === "production";
	if (isProduction && !env.BETTER_AUTH_SECRET) {
		throw new Error("BETTER_AUTH_SECRET is required in production");
	}
	const allowedOrigins = [
		new URL(env.APP_URL).origin,
		...(env.BETTER_AUTH_URL ? [new URL(env.BETTER_AUTH_URL).origin] : []),
		...env.TRUSTED_ORIGINS.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => new URL(s).origin),
	];
	return {
		...env,
		HOCUSPOCUS_HOST:
			env.HOCUSPOCUS_HOST ?? (isProduction ? "0.0.0.0" : "127.0.0.1"),
		isProduction,
		allowedOrigins: [...new Set(allowedOrigins)],
	};
}

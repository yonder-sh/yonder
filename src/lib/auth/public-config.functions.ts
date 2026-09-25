import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { publicConfigKey } from "@/lib/query/keys";
import { authEnv } from "@/server/auth/env.server";

/**
 * Settings the browser needs that differ per deployment. Read from the
 * server's environment at RUNTIME (one image serves every environment), never
 * inlined at build time like `VITE_*`. Nothing secret goes here.
 */
export type PublicConfig = {
	/** Cloudflare Turnstile on the sign-in email step, or null when it is off. */
	turnstileSiteKey: string | null;
};

export const getPublicConfig = createServerFn({ method: "GET" }).handler(
	async (): Promise<PublicConfig> => ({
		turnstileSiteKey: authEnv().turnstile?.siteKey ?? null,
	}),
);

export const publicConfigQuery = () =>
	queryOptions({
		queryKey: publicConfigKey,
		queryFn: (): Promise<PublicConfig> => getPublicConfig(),
		staleTime: Number.POSITIVE_INFINITY,
	});

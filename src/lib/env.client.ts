/**
 * Build-time values the browser bundle may read (SPEC §5.1): only `VITE_*`
 * variables reach the client, inlined by `vite build`. Never put a secret here.
 */
export const clientEnv = {
	/** Empty = same-origin `/collab` (Vite proxy in dev, the ingress in prod). */
	collabUrl: (import.meta.env.VITE_COLLAB_URL as string | undefined) || "",
	/** "1" exposes `window.__yonder` / `window.__tripMap` for e2e specs. */
	e2e: import.meta.env.VITE_E2E === "1",
	/** Changes every build; the service worker's "update ready" toast compares it. */
	buildId: (import.meta.env.VITE_BUILD_ID as string | undefined) ?? "dev",
	dev: import.meta.env.DEV === true,
} as const;

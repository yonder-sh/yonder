/**
 * DEV/E2E-ONLY (never imported by the app): the running app's QueryClient,
 * found through React's fiber tree (the `QueryClientProvider` above the
 * workspace). The harness renders with it, so WP-Suggest's mutations refresh
 * the app's queries exactly as a real mount does (a tab never gets its own
 * live event), and specs can refresh after a direct server call.
 */
import type { QueryClient } from "@tanstack/react-query";

type Fiber = { return: Fiber | null; memoizedProps?: { client?: unknown } };

function isQueryClient(v: unknown): v is QueryClient {
	return (
		!!v &&
		typeof v === "object" &&
		typeof (v as QueryClient).invalidateQueries === "function" &&
		typeof (v as QueryClient).getQueryCache === "function"
	);
}

export function appQueryClient(): QueryClient | null {
	const el =
		document.querySelector('[data-testid="workspace"]') ??
		document.body.firstElementChild;
	if (!el) return null;
	const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
	let f = key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
	while (f) {
		const client = f.memoizedProps?.client;
		if (isQueryClient(client)) return client;
		f = f.return;
	}
	return null;
}

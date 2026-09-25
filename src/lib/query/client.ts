/**
 * The QueryClient (SPEC §12.2): one per request on the server (created in
 * `getRouter()`), one per page in the browser.
 *
 * - `staleTime: 30 s`; live invalidation (§10.5) keeps trip data fresh anyway.
 * - Mutation errors toast `humanError(e)` unless the mutation opts out with
 *   `meta: { silent: true }` (it shows its own inline error). A failure a
 *   retry can fix (5xx, network) says "Couldn't save." with a Retry that runs
 *   the same mutation again, optimistic update included (QA ERR-03).
 * - UNAUTHORIZED (the session expired or was revoked mid-edit) opens the
 *   in-place sign-in prompt; the failed save runs again once the same
 *   account is back (QA ERR-07, `requestReauth`).
 * - Query errors are shown where the data is used, never as global toasts;
 *   only UNAUTHORIZED for someone who WAS signed in opens the same prompt.
 */
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { requestReauth } from "@/lib/auth/reauth";
import { errorCode, humanError, isRetryableError } from "@/lib/errors";
import { sessionKey } from "./keys";

declare module "@tanstack/react-query" {
	interface Register {
		mutationMeta: {
			silent?: boolean;
			/** No Retry / no re-run after re-auth: the UI gave the input back. */
			manualResubmit?: boolean;
		};
	}
}

export function makeQueryClient(): QueryClient {
	const client: QueryClient = new QueryClient({
		queryCache: new QueryCache({
			onError: (error, query) => {
				// Browser only (the server's store is shared by every request), and
				// only when a session was known: a signed-out visitor isn't re-authing.
				if (typeof window === "undefined") return;
				if (errorCode(error) !== "UNAUTHORIZED") return;
				if (query.queryKey[0] === sessionKey[0]) return;
				if (!client.getQueryData(sessionKey)) return;
				requestReauth();
			},
		}),
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				retry: (count, error) => {
					// Access and validation errors never get better by retrying.
					const m = error instanceof Error ? error.message : "";
					if (/^(UNAUTHORIZED|FORBIDDEN|NOT_FOUND|VALIDATION)\b/.test(m))
						return false;
					return count < 2;
				},
			},
		},
		mutationCache: new MutationCache({
			onError: (error, vars, _ctx, mutation) => {
				const silent = mutation.meta?.silent === true;
				const manual = mutation.meta?.manualResubmit === true;
				const retry = manual
					? undefined
					: () => {
							void mutation.execute(vars).catch(() => undefined);
						};
				if (errorCode(error) === "UNAUTHORIZED") {
					requestReauth(retry);
					if (!silent) toast.error(humanError(error), { id: "signed-out" });
					return;
				}
				if (silent) return;
				if (isRetryableError(error)) {
					const message =
						errorCode(error) || error instanceof TypeError
							? humanError(error)
							: "Couldn't save.";
					toast.error(
						message,
						retry ? { action: { label: "Retry", onClick: retry } } : undefined,
					);
				} else toast.error(humanError(error));
			},
		}),
	});
	return client;
}

/**
 * React glue for Web Push: the settings query, the account check, and the
 * bridge that turns a notification click (the service worker's `push-open`
 * message) into an in-app navigation.
 */
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { getPushSettings } from "@/functions/push.functions";
import { onSignOut } from "@/lib/auth/sign-out";
import { sessionQuery } from "@/lib/query/trip-queries";
import { currentSubscription, dropPushOnSignOut } from "./push-client";

export const pushSettingsKey = ["me", "push"] as const;

/** Signed in with an account (not a link guest without one). */
export function useHasAccount(enabled = true): boolean {
	const session = useQuery({ ...sessionQuery(), enabled });
	return !!session.data && !session.data.isAnonymous;
}

export function usePushSettings(enabled: boolean) {
	return useQuery({
		queryKey: pushSettingsKey,
		enabled,
		staleTime: 60_000,
		queryFn: async () => {
			const sub = await currentSubscription();
			return getPushSettings({ data: sub ? { endpoint: sub.endpoint } : {} });
		},
	});
}

/** Same-origin app paths only (a message could come from an old worker). */
function safePath(url: unknown): string | null {
	return typeof url === "string" && /^\/(?!\/)[^\s\\]*$/.test(url) ? url : null;
}

/**
 * Mounted once (the root layout): a click on a notification focuses this
 * window and the worker posts `{ type: 'push-open', url }`; the router goes
 * there without reloading. Also drops the device's subscription at sign-out.
 */
export function usePushBridge(): void {
	const router = useRouter();
	useEffect(() => {
		const off = onSignOut(() => dropPushOnSignOut());
		const sw =
			typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
		const onMessage = (e: MessageEvent) => {
			const data = e.data as { type?: string; url?: unknown } | null;
			if (data?.type !== "push-open") return;
			const href = safePath(data.url);
			if (href) void router.navigate({ href });
		};
		sw?.addEventListener("message", onMessage);
		return () => {
			off();
			sw?.removeEventListener("message", onMessage);
		};
	}, [router]);
}

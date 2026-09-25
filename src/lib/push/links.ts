/**
 * Deep links for notifications: the same `InboxLink` shape the in-app inbox
 * uses, validated by the inbox's own `inboxSearch` (so a push opens exactly
 * where the bell row would), turned into a same-origin path.
 */
import { inboxSearch } from "@/features/shell/inbox-model";
import type { InboxLink } from "@/lib/schemas/inbox";

/** `/t/<slug>` plus the workspace search the link names (`?sel=…&tab=…`). */
export function tripUrl(
	slug: string,
	link: Omit<InboxLink, "tripSlug"> = {},
): string {
	const search = inboxSearch({ ...link, tripSlug: slug });
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(search))
		if (v !== undefined && v !== null) params.set(k, String(v));
	const qs = params.toString();
	return `/t/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`;
}

/** Only same-origin paths ever leave the worker (the service worker checks again). */
export function isSafePushUrl(url: string): boolean {
	return /^\/(?!\/)[^\s\\]*$/.test(url);
}

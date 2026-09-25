/**
 * A random id for this browser tab (page load). `src/start.ts` sends it as the
 * `x-tab-id` header on every server-function call; the server copies it into the
 * `by` field of the trip events it publishes, and this tab skips events it caused
 * itself (its own mutation already updated or invalidated the cache) — SPEC §10.5.
 *
 * Not stored anywhere: a reload is a new tab. On the server it returns a fixed
 * value so SSR never pretends to be a tab.
 */
let tabId: string | undefined;

export function getTabId(): string {
	if (typeof window === "undefined") return "server";
	if (!tabId) {
		tabId =
			typeof crypto !== "undefined" && "randomUUID" in crypto
				? crypto.randomUUID()
				: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	}
	return tabId;
}

/** The header name the tab id travels in. */
export const TAB_ID_HEADER = "x-tab-id";

/** Reads and sanitizes a tab id from request headers (server side). */
export function tabIdFromHeaders(
	headers: Pick<Headers, "get"> | null | undefined,
): string | undefined {
	const v = headers?.get(TAB_ID_HEADER)?.trim();
	return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined;
}

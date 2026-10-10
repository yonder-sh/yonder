/** Saved's query: the account's saved links (kept for offline like the trip list). */
import { meKeys } from "@/lib/query/keys";
import { persistedQuery } from "@/lib/query/persister";
import { listSavedLinks } from "./saved.functions";
import type { SavedLink } from "./types";

export const savedQuery = () =>
	persistedQuery({
		queryKey: meKeys.saved,
		queryFn: (): Promise<SavedLink[]> => listSavedLinks(),
	});

/** While a fresh link's preview is on its way, ask again every few seconds. */
export function savedPolling(list: readonly SavedLink[] | undefined) {
	return list?.some(
		(l) => l.status === "pending" && Date.now() - l.createdAt < 2 * 60_000,
	)
		? 2500
		: false;
}

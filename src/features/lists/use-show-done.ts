/**
 * Whether done rows start unfolded ("N done ▸"), remembered per user (QA
 * ROLL-08): the `listsShowDone` key of the account's view settings
 * (ADDENDUM §7.2 `user_prefs`, through WP-Shell's `useViewPrefs`, whose
 * localStorage copy is only the fast cache). `enabled: false` (the fixture
 * preview) keeps it in this browser.
 */
import { useCallback } from "react";
import { useViewPrefs } from "@/features/shell/view-prefs";

export function useShowDone(
	opts: { enabled?: boolean } = {},
): [boolean, (v: boolean) => void] {
	const { prefs, setPrefs } = useViewPrefs(opts);
	const set = useCallback(
		(v: boolean) => setPrefs({ listsShowDone: v }),
		[setPrefs],
	);
	return [prefs.listsShowDone ?? false, set];
}

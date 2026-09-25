/**
 * EXTENSIONS §7 "Overdue signal": whether the current scope has overdue
 * to-dos (or booking windows opened more than 72 h ago), for the amber 6px
 * dot on the Lists tab label. The tab bar is WP-Shell's; it mounts this hook
 * (CONTRACT_REQUESTS.md). Private rows count only for their author, like
 * every read.
 */
import { useMemo } from "react";
import { dueCtxOf, dueState, effectiveDue } from "@/lib/engine/due";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { rollupRows } from "./list-model";
import { useListItems } from "./queries";
import { useNow } from "./use-now";

export function useListsOverdue(): boolean {
	const { ix, schedule, scope, lens, only, days, model } = useWorkspace();
	const { items } = useListItems();
	const now = useNow();
	return useMemo(() => {
		const ctx = dueCtxOf(ix, schedule);
		const groups = rollupRows(ix, items, {
			scopeId: scope?.id ?? null,
			lens,
			includeDescendants: !only,
			dayRange: days,
			model,
		});
		return groups.some((g) =>
			g.subs.some((s) =>
				s.rows.some(
					(r) =>
						r.status === "open" &&
						dueState(effectiveDue(r, ctx), now, r.status) === "overdue",
				),
			),
		);
	}, [ix, schedule, items, scope, lens, only, days, model, now]);
}

/**
 * Publishes where I am (scope, lens, tab, days, sel, path) on the trip's
 * channel awareness (SPEC §10.7), debounced, with my ephemeral view state
 * beyond the URL (`view.ui`, FB-21: plan folds, sub-views…). Rendered in
 * live mode only.
 */
import { useMemo } from "react";
import { useMyAwarenessSync } from "@/lib/realtime/presence";
import type { AwarenessView } from "@/lib/realtime/protocol";
import { fitViewUi } from "@/lib/realtime/view-protocol";
import { useMyViewUi } from "@/lib/realtime/view-ui";
import { useWorkspace } from "@/lib/workspace/use-workspace";

export function LivePresence() {
	const { graph, scope, scopePath, lens, tab, search } = useWorkspace();
	const values = useMyViewUi((s) => s.values);
	const at = useMyViewUi((s) => s.at);
	const view = useMemo<AwarenessView>(() => {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(search))
			if (v !== undefined) qs.set(k, String(v));
		const tail = scopePath.map((n) => n.slug).join("/");
		const q = qs.toString();
		const ui = fitViewUi(values, at);
		return {
			scopeId: scope?.id ?? null,
			scopeName: scope?.name ?? graph.trip.name,
			lens,
			tab,
			days: search.days ?? null,
			sel: search.sel ?? null,
			path: `/t/${graph.trip.slug}${tail ? `/${tail}` : ""}${q ? `?${q}` : ""}`,
			...(Object.keys(ui).length ? { ui } : {}),
		};
	}, [
		graph.trip.slug,
		graph.trip.name,
		scope,
		scopePath,
		lens,
		tab,
		search,
		values,
		at,
	]);
	useMyAwarenessSync(view);
	return null;
}
